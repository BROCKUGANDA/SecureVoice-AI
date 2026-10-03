/**
 * Strict-schema helper layer for HTTP boundaries (WP-22).
 *
 * Every route in this app receives JSON from someone we do not control: a
 * bank's fraud engine, a webhook sender, a cardholder typing into a form.
 * That makes the route handler the single choke point where untrusted data
 * becomes trusted data, and this module is that choke point.
 *
 * The rules it enforces, and why each one exists:
 *
 *   - UNKNOWN FIELDS ARE REJECTED, not stripped. A `z.object()` default drops
 *     unknown keys silently, which means `{"amount": 10, "amountMinor": 99999}`
 *     parses to whichever the code reads first. Strict objects fail closed.
 *   - NO TYPE COERCION. `z.coerce.number()` turns the string "5" into 5 and
 *     `z.coerce.boolean()` turns "false" into TRUE. A caller sending a string
 *     where a number belongs has made a mistake; we surface it as a 422 rather
 *     than guessing. Nothing in this file calls a coerce helper.
 *   - STRUCTURAL CAPS (depth, field count, array length, string length, body
 *     bytes) are checked on the RAW value BEFORE the schema runs. A validator
 *     that walks a 40-deep, 200k-key payload is itself a denial-of-service
 *     surface, so the cheap O(n) guard runs first.
 *   - MONEY IS INTEGER MINOR UNITS PLUS AN ISO-4217 CODE. Floats are rejected at
 *     the schema, not in code review: 0.1 + 0.2 !== 0.3 is not a rounding
 *     curiosity when the number decides whether a card gets frozen.
 *   - PHONES ARE E.164. Normalised, not merely pattern-checked.
 *   - TIMESTAMPS MUST CARRY AN OFFSET. A naive local timestamp is interpreted in
 *     whatever timezone the server happens to be in, so "the fraud happened at
 *     03:00" silently changes meaning twice a year.
 *
 * Isomorphic on purpose: no `server-only`, no Node built-ins. The same schema
 * can validate a request body on the server and pre-validate a form in the
 * browser, so client and server can never disagree about what is valid.
 */

import { z } from "zod";
import { countGraphemes, normalizeHostileText } from "./unicode";

// ── Limits ──────────────────────────────────────────────────────────────────

export interface Limits {
  /** Maximum object/array nesting depth. The top-level value is depth 1. */
  maxDepth?: number;
  /** Maximum total object keys across the whole payload. */
  maxFields?: number;
  /** Maximum elements in any single array. */
  maxArrayItems?: number;
  /** Absolute cap on any single string value, in UTF-16 code units. */
  maxStringLength?: number;
  /** Default cap on a raw request body, in bytes. */
  maxBodyBytes?: number;
}

export const LIMITS = {
  maxDepth: 8,
  maxFields: 64,
  maxArrayItems: 100,
  maxStringLength: 2048,
  maxBodyBytes: 64 * 1024,
} satisfies Required<Limits>;

/** Keys that must never appear in a parsed body — prototype-pollution vectors. */
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

// ── Errors ──────────────────────────────────────────────────────────────────

export type ValidationCode =
  | "invalid_json"
  | "body_too_large"
  | "too_deep"
  | "too_many_fields"
  | "too_many_items"
  | "string_too_long"
  | "unsupported_type"
  | "forbidden_key"
  | "invalid";

/**
 * Thrown by every helper in this module. Carries a `status` so route handlers
 * can hand `message` straight to `unprocessable()` from `@/lib/api-errors`
 * without this module importing `next/server` (which would make it
 * server-only and break browser-side pre-validation).
 */
export class ValidationError extends Error {
  readonly status = 422;

  constructor(
    readonly code: ValidationCode,
    message: string,
    readonly path?: string,
  ) {
    super(message);
    this.name = "ValidationError";
  }
}

/**
 * Convert a thrown value into the `{ status, error }` envelope expected by
 * `unprocessable()` / `badRequest()` from `@/lib/api-errors`. Returns null for
 * anything that is not a validation failure, so callers can rethrow the rest.
 */
export function toValidationEnvelope(err: unknown): { status: number; error: string } | null {
  if (err instanceof ValidationError) return { status: err.status, error: err.message };
  return null;
}

// ── Structural preflight ────────────────────────────────────────────────────

/**
 * Walk a raw parsed JSON value and enforce the structural caps. Runs before any
 * schema so a hostile payload is rejected by O(n) code that never allocates a
 * zod schema, never builds an issue list, and never recurses deeper than
 * `maxDepth` — the walk itself cannot be used to blow the stack.
 *
 * Fails closed on anything that JSON could not have produced (Date, Map, class
 * instances, functions, symbols, bigint). If such a value reaches a boundary,
 * something built it in code rather than parsing it off the wire, and that is
 * exactly when we want to stop and ask why.
 */
export function assertShape(raw: unknown, limits: Limits = {}): void {
  const maxDepth = limits.maxDepth ?? LIMITS.maxDepth;
  const maxFields = limits.maxFields ?? LIMITS.maxFields;
  const maxArrayItems = limits.maxArrayItems ?? LIMITS.maxArrayItems;
  const maxStringLength = limits.maxStringLength ?? LIMITS.maxStringLength;

  let fieldCount = 0;

  const walk = (value: unknown, depth: number, path: string): void => {
    if (depth > maxDepth) {
      throw new ValidationError("too_deep", `Body nests deeper than ${maxDepth} levels`, path);
    }
    if (value === null) return;

    switch (typeof value) {
      case "boolean":
        return;
      case "number":
        // NaN / ±Infinity survive no JSON round-trip but survive `z.number()`
        // in some configurations; reject here so no schema can be fooled by one.
        if (!Number.isFinite(value)) {
          throw new ValidationError(
            "unsupported_type",
            `Non-finite number at ${path || "body"}`,
            path,
          );
        }
        return;
      case "string":
        if (value.length > maxStringLength) {
          throw new ValidationError(
            "string_too_long",
            `String longer than ${maxStringLength} characters at ${path || "body"}`,
            path,
          );
        }
        return;
      case "object":
        break;
      default:
        // function, undefined, symbol, bigint
        throw new ValidationError(
          "unsupported_type",
          `Unsupported value type "${typeof value}" at ${path || "body"}`,
          path,
        );
    }

    if (Array.isArray(value)) {
      if (value.length > maxArrayItems) {
        throw new ValidationError(
          "too_many_items",
          `Array longer than ${maxArrayItems} items at ${path || "body"}`,
          path,
        );
      }
      value.forEach((item, i) => walk(item, depth + 1, `${path}[${i}]`));
      return;
    }

    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new ValidationError(
        "unsupported_type",
        `Expected a plain JSON object at ${path || "body"}`,
        path,
      );
    }

    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_KEYS.has(key)) {
        throw new ValidationError(
          "forbidden_key",
          `Forbidden key "${key}" in body`,
          path ? `${path}.${key}` : key,
        );
      }
      fieldCount += 1;
      if (fieldCount > maxFields) {
        throw new ValidationError(
          "too_many_fields",
          `Body carries more than ${maxFields} fields`,
          path ? `${path}.${key}` : key,
        );
      }
      walk(child, depth + 1, path ? `${path}.${key}` : key);
    }
  };

  walk(raw, 1, "");
}

// ── Body-size cap ───────────────────────────────────────────────────────────

/**
 * Reject on the declared Content-Length before reading a single byte. Cheap
 * early-out for the common case (most clients send the header). The streaming
 * read below is the real enforcement for clients that do not.
 */
export function assertContentLength(req: Request, maxBytes = LIMITS.maxBodyBytes): void {
  const declared = req.headers.get("content-length");
  if (declared === null) return;
  const n = Number(declared);
  if (Number.isFinite(n) && n > maxBytes) {
    throw new ValidationError("body_too_large", `Body exceeds ${maxBytes} bytes`);
  }
}

/**
 * Read a request body as text, aborting the moment the byte budget is
 * exceeded. A trailing `await req.text()` would let an attacker stream an
 * unbounded body into memory before we ever got to measure it.
 */
export async function readBodyText(req: Request, maxBytes = LIMITS.maxBodyBytes): Promise<string> {
  assertContentLength(req, maxBytes);

  const body = req.body;
  if (!body) return "";

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new ValidationError("body_too_large", `Body exceeds ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Already released by cancel() — nothing to do.
    }
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8").decode(merged);
}

// ── Parse entry points ──────────────────────────────────────────────────────

/**
 * Validate an already-parsed value. Preflight (structural caps) runs first,
 * then the schema. Throws `ValidationError` on any failure.
 */
export function parseBody<T>(
  schema: z.ZodType<T>,
  raw: unknown,
  opts: { limits?: Limits; source?: string } = {},
): T {
  assertShape(raw, opts.limits);
  const result = schema.safeParse(raw);
  if (result.success) return result.data;

  const issue = result.error.issues[0];
  const path = issue ? issue.path.map(String).join(".") : "";
  const where = path || opts.source || "body";
  throw new ValidationError("invalid", `${where}: ${issue?.message ?? "failed validation"}`, path);
}

/** Read + JSON.parse + `parseBody`, with the body-size cap applied. */
export async function readJsonBody<T>(
  req: Request,
  schema: z.ZodType<T>,
  opts: { limits?: Limits; maxBytes?: number } = {},
): Promise<T> {
  const raw = await readBodyText(
    req,
    opts.maxBytes ?? opts.limits?.maxBodyBytes ?? LIMITS.maxBodyBytes,
  );
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new ValidationError("invalid_json", "Body is not valid JSON");
  }
  return parseBody(schema, data, { limits: opts.limits });
}

// ── Field builders ──────────────────────────────────────────────────────────
//
// Every builder is strict by construction. There is no `coerce` option, and
// adding one is a security change that must be argued for in review, not a
// convenience that gets reached for on a deadline.

/**
 * Bounded string. Pass `{ trim: true }` to strip surrounding whitespace;
 * pass `pattern` to require a shape (a regex is a constraint, not a coercion).
 */
export function boundedString(
  opts: { min?: number; max?: number; pattern?: RegExp; trim?: boolean; message?: string } = {},
): z.ZodString {
  let schema = z.string();
  if (opts.trim) schema = schema.trim();
  if (opts.min !== undefined) schema = schema.min(opts.min);
  if (opts.max !== undefined) schema = schema.max(opts.max);
  if (opts.pattern) schema = schema.regex(opts.pattern);
  return schema;
}

/** Bounded integer. Rejects floats, string numbers, NaN and ±Infinity. */
export function boundedInt(
  opts: { min?: number; max?: number; multipleOf?: number } = {},
): z.ZodNumber {
  let schema = z.number().int("must be an integer");
  if (opts.min !== undefined) schema = schema.min(opts.min);
  if (opts.max !== undefined) schema = schema.max(opts.max);
  if (opts.multipleOf !== undefined) schema = schema.multipleOf(opts.multipleOf);
  return schema;
}

/** Bounded number for genuine reals (risk scores, ratios). Still no coercion. */
export function boundedNumber(opts: { min?: number; max?: number } = {}): z.ZodNumber {
  let schema = z.number();
  if (opts.min !== undefined) schema = schema.min(opts.min);
  if (opts.max !== undefined) schema = schema.max(opts.max);
  return schema;
}

/** Bounded array. `max` is enforced by the schema; the raw preflight also caps it. */
export function boundedArray<T extends z.ZodType>(
  item: T,
  opts: { min?: number; max?: number } = {},
): z.ZodArray<T> {
  let schema = z.array(item);
  if (opts.min !== undefined) schema = schema.min(opts.min);
  if (opts.max !== undefined) schema = schema.max(opts.max);
  return schema;
}

// ── ISO-4217 ────────────────────────────────────────────────────────────────

/**
 * Active ISO-4217 alphabetic codes, including the fund/unit codes (BOV, CHE,
 * CHW, CLF, COU, MXV, USN, UYI, UYW). A three-letter uppercase string is not
 * enough: "XXX" and "ZZZ" are not currencies, and accepting them means a
 * downstream FX conversion quietly becomes a no-op.
 *
 * Pass `extra` to `currency()` when a corridor adds a code this snapshot lacks,
 * so the fix is a one-line argument and not a redeploy of the whole list.
 */
export const ISO_4217_CODES: ReadonlySet<string> = new Set([
  "AED",
  "AFN",
  "ALL",
  "AMD",
  "ANG",
  "AOA",
  "ARS",
  "AUD",
  "AWG",
  "AZN",
  "BAM",
  "BBD",
  "BDT",
  "BGN",
  "BHD",
  "BIF",
  "BMD",
  "BND",
  "BOB",
  "BOV",
  "BRL",
  "BSD",
  "BTN",
  "BWP",
  "BYN",
  "BZD",
  "CAD",
  "CDF",
  "CHE",
  "CHF",
  "CHW",
  "CLF",
  "CLP",
  "CNY",
  "COP",
  "COU",
  "CRC",
  "CUP",
  "CVE",
  "CZK",
  "DJF",
  "DKK",
  "DOP",
  "DZD",
  "EGP",
  "ERN",
  "ETB",
  "EUR",
  "FJD",
  "FKP",
  "GBP",
  "GEL",
  "GHS",
  "GIP",
  "GMD",
  "GNF",
  "GTQ",
  "GYD",
  "HKD",
  "HNL",
  "HTG",
  "HUF",
  "IDR",
  "ILS",
  "INR",
  "IQD",
  "IRR",
  "ISK",
  "JMD",
  "JOD",
  "JPY",
  "KES",
  "KGS",
  "KHR",
  "KMF",
  "KPW",
  "KRW",
  "KWD",
  "KYD",
  "KZT",
  "LAK",
  "LBP",
  "LKR",
  "LRD",
  "LSL",
  "LYD",
  "MAD",
  "MDL",
  "MGA",
  "MKD",
  "MMK",
  "MNT",
  "MOP",
  "MRU",
  "MUR",
  "MVR",
  "MWK",
  "MXN",
  "MXV",
  "MYR",
  "MZN",
  "NAD",
  "NGN",
  "NIO",
  "NOK",
  "NPR",
  "NZD",
  "OMR",
  "PAB",
  "PEN",
  "PGK",
  "PHP",
  "PKR",
  "PLN",
  "PYG",
  "QAR",
  "RON",
  "RSD",
  "RUB",
  "RWF",
  "SAR",
  "SBD",
  "SCR",
  "SDG",
  "SEK",
  "SGD",
  "SHP",
  "SLE",
  "SOS",
  "SRD",
  "SSP",
  "STN",
  "SVC",
  "SYP",
  "SZL",
  "THB",
  "TJS",
  "TMT",
  "TND",
  "TOP",
  "TRY",
  "TTD",
  "TWD",
  "TZS",
  "UAH",
  "UGX",
  "USD",
  "USN",
  "UYI",
  "UYU",
  "UYW",
  "UZS",
  "VED",
  "VES",
  "VND",
  "VUV",
  "WST",
  "XAF",
  "XCD",
  "XCG",
  "XOF",
  "XPF",
  "YER",
  "ZAR",
  "ZMW",
  "ZWG",
]);

export const CURRENCY_MESSAGE = "currency must be an active ISO-4217 alphabetic code";

/** An ISO-4217 alphabetic currency code, upper-case. */
export function currency(opts: { extra?: readonly string[] } = {}): z.ZodType<string> {
  const extra = opts.extra ?? [];
  return z
    .string()
    .regex(/^[A-Z]{3}$/, CURRENCY_MESSAGE)
    .refine((code) => ISO_4217_CODES.has(code) || extra.includes(code), CURRENCY_MESSAGE);
}

/**
 * Money as `{ amountMinor, currency }`.
 *
 * `amountMinor` is an integer count of minor units (fils, cents, dirhams) and
 * `currency` is the ISO-4217 code those units belong to. Storing the code
 * alongside the amount is what makes the integer meaningful — 2500 minor units
 * is 25.00 AED and 25.00 is ambiguous USD, JPY or KWD (KWD has three decimal
 * places, so "1000 minor units" is not one dinar).
 *
 * A float is rejected here rather than rounded: `money({ amountMinor: 12.34 })`
 * is a caller who believes the column holds major units, and quietly rounding
 * it to 12 is how a 12.34-unit discrepancy becomes a regulatory finding.
 */
export function money(
  opts: { min?: number; max?: number; extraCurrencies?: readonly string[] } = {},
): z.ZodType<{ amountMinor: number; currency: string }> {
  return z.strictObject({
    amountMinor: boundedInt({
      min: opts.min ?? 0,
      max: opts.max ?? Number.MAX_SAFE_INTEGER,
    }),
    currency: currency({ extra: opts.extraCurrencies }),
  });
}

export const E164_MESSAGE = "phone must be E.164 with a country code, e.g. +971501234567";

/** Digits after the leading `+`, per E.164: 2–15, no leading zero. */
const E164_RE = /^\+[1-9]\d{1,14}$/;
/** Everything a human might type that we are willing to discard as formatting. */
const PHONE_NOISE_RE = /[\s().\-‐-―−]/g;
/** Anything else that is not a digit or a plus is a hard reject, not noise. */
const PHONE_ALLOWED_RE = /^[+\d\s().\-‐-―−]+$/;

/**
 * Normalise a phone number to E.164, or return null if it cannot be.
 *
 * Accepts `+971 50 123 4567`, `00971501234567`, and (with `defaultRegion`) the
 * national form `0501234567`. Rejects anything with letters, and rejects a bare
 * local number when no default region is supplied — E.164 cannot be derived
 * from a local number without knowing the country, and guessing the country for
 * a phone number attached to a fraud case is how you call the wrong customer.
 *
 * `stripTrunkPrefix` handles the national trunk digit ("0" in the UAE, the UK,
 * India and most other plans): `0501234567` + region `+971` yields
 * `+971501234567`, not `+9710501234567`. This is a single-digit heuristic, NOT
 * libphonenumber — it is right for the majority of national plans and wrong for
 * the minority (Italy has no trunk prefix, some NANP countries use 1). A caller
 * that needs per-country correctness should normalise upstream and pass an
 * already-E.164 value; set `stripTrunkPrefix: false` to disable the heuristic.
 */
export function normaliseE164(
  raw: string,
  defaultRegion?: string,
  stripTrunkPrefix = true,
): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (!PHONE_ALLOWED_RE.test(trimmed)) return null;

  let digits = trimmed.replace(PHONE_NOISE_RE, "");
  if (digits.startsWith("00")) {
    digits = `+${digits.slice(2)}`;
  } else if (!digits.startsWith("+")) {
    if (!defaultRegion) return null;
    const region = defaultRegion.replace(/\D/g, "");
    if (!region) return null;
    const national = stripTrunkPrefix ? digits.replace(/^0(?=\d)/, "") : digits;
    if (!national) return null;
    digits = `+${region}${national}`;
  }
  return E164_RE.test(digits) ? digits : null;
}

/**
 * E.164 phone. Validates, then NORMALISES — the value that comes out of
 * `parseBody` is always `+<country><subscriber>`, whatever the caller sent, so
 * there is exactly one string form to index, dedupe and compare.
 */
export function e164Phone(
  opts: { defaultRegion?: string; stripTrunkPrefix?: boolean } = {},
): z.ZodType<string> {
  const normalise = (value: string) =>
    normaliseE164(value, opts.defaultRegion, opts.stripTrunkPrefix);
  return z
    .string()
    .refine((value) => normalise(value) !== null, E164_MESSAGE)
    .transform((value) => normalise(value) ?? value);
}

export const TIMESTAMP_MESSAGE = "timestamp must be ISO-8601 with an explicit offset (Z or ±HH:MM)";

/** RFC 3339 shape with a MANDATORY offset. The `T` is required; no space form. */
const ISO_OFFSET_RE =
  /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:[Zz]|[+-]\d{2}:?\d{2})$/;
/** Trailing offset, so we can range-check it rather than trusting Date.parse. */
const OFFSET_TAIL_RE = /([+-])(\d{2}):?(\d{2})$/;

/** True when the string is a real ISO-8601 instant carrying an explicit offset. */
export function isIsoWithOffset(value: string): boolean {
  if (!ISO_OFFSET_RE.test(value)) return false;
  const tail = OFFSET_TAIL_RE.exec(value);
  if (tail) {
    const hours = Number(tail[2]);
    const minutes = Number(tail[3]);
    if (hours > 23 || minutes > 59) return false;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed);
}

/**
 * ISO-8601 timestamp that MUST carry an offset, normalised to UTC ISO form.
 *
 * A naive `2026-03-14T02:30:00` is rejected rather than assumed to be UTC: it
 * means a different instant depending on where the server is deployed, and a
 * fraud case timeline that shifts by an hour twice a year is not evidence.
 */
export function isoTimestamp(): z.ZodType<string> {
  return z
    .string()
    .refine(isIsoWithOffset, TIMESTAMP_MESSAGE)
    .transform((value) => new Date(value).toISOString());
}

// ── Unicode-safe display text ───────────────────────────────────────────────

/**
 * A free-text display field (merchant name, agent name) that must survive
 * bidi/zero-width/homoglyph normalisation and a grapheme cap. The validated
 * value is the normalised one — the console renders and stores exactly what
 * this returns, so there is no second, unvalidated copy in the database.
 */
export function displayText(opts: { maxGraphemes?: number } = {}): z.ZodType<string> {
  const max = opts.maxGraphemes;
  return z
    .string()
    .refine(
      (value) => countGraphemes(value.normalize("NFKC")) <= (max ?? Number.MAX_SAFE_INTEGER),
      `display text must be at most ${max ?? LIMITS.maxStringLength} characters`,
    )
    .transform((value) => normalizeHostileText(value, { maxGraphemes: max }).value);
}
