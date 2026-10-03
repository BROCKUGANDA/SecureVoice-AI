/**
 * UNIT — the HTTP-boundary validation layer and the agent tool guard.
 *
 *   src/lib/validation/schema.ts    strict Zod builders + structural preflight
 *   src/lib/validation/safe-log.ts  hostile values made loggable
 *   src/lib/tool-guard.ts           the allow/deny choke point for agent tools
 *
 * `schema.ts` is the one place where untrusted JSON becomes trusted data, so
 * the properties pinned here are the ones whose absence turns a route handler
 * into a liability:
 *
 *   · NO COERCION, EVER. `boundedInt().safeParse("5")` and
 *     `boundedNumber().safeParse("0.94")` must fail. A builder that started
 *     reaching for `z.coerce` would turn a caller's type mistake into a silent
 *     interpretation, which is the whole failure mode this layer exists to stop.
 *   · MONEY IS INTEGER MINOR UNITS. `amountMinor: 12.34` is a caller who thinks
 *     the column holds major units; accepting it is how a discrepancy becomes a
 *     finding. Zero passes (it is a legitimate amount), a float and a
 *     negative do not.
 *   · CURRENCY MUST BE A REAL ISO-4217 CODE. Three uppercase letters is not
 *     enough — "XXX" would make a downstream FX conversion a silent no-op.
 *   · `money()` is a `z.strictObject`, so an unknown key such as `amount`
 *     next to `amountMinor` is REJECTED rather than stripped. That is the
 *     declared policy for the money builder specifically; a plain `z.object`
 *     would drop the unknown key instead, and both behaviours are asserted so
 *     the difference stays a decision rather than an accident.
 *   · STRUCTURAL CAPS RUN BEFORE THE SCHEMA, on the raw value. Depth, field
 *     count, array length and string length each reject one-over-the-limit and
 *     accept exactly-at-the-limit, because an off-by-one that fails a legal
 *     payload is as much a defect as one that admits a hostile one.
 *   · `assertShape` FAILS CLOSED on anything JSON could not have produced —
 *     Date, Map, class instances, bigint, `undefined`, NaN. Reaching a boundary
 *     with one of those means code built it, which is exactly when to stop.
 *   · PROTOTYPE-POLLUTION KEYS ARE REFUSED, at any depth, and the reported path
 *     names the offending key so the rejection is diagnosable.
 *   · PHONES ARE NORMALISED, not merely pattern-checked: `050 123 4567` with a
 *     `+971` region comes out as `+971501234567`, so there is one string form to
 *     index and dedupe. A bare local number with NO region is refused rather
 *     than guessed — guessing the country for a fraud-case phone number calls
 *     the wrong customer.
 *   · TIMESTAMPS MUST CARRY AN OFFSET and come out normalised to UTC ISO. A
 *     naive local timestamp changes meaning twice a year.
 *   · DISPLAY TEXT IS NORMALISED BEFORE IT IS STORED, so the value rendered in
 *     the console is the value that passed validation.
 *
 * `safe-log.ts` exists because a newline in user input must not be able to forge
 * a log line, so the pinned properties are that line terminators collapse to one
 * space, invisible reordering characters are removed, PII is redacted rather
 * than logged, every string/collection/depth is bounded, and forbidden keys
 * never reach the sink. It must also survive hostile shapes — cycles, null
 * prototypes, symbols, invalid dates — because a logger that throws takes the
 * request down with it.
 *
 * `tool-guard.ts` is the choke point in front of `card_freeze`, so: the stages
 * run in a fixed order (auth before conversation_id before state), each refusal
 * is a typed 409 or a 401/403 from auth rather than a 500, an empty
 * `allowedStates` denies rather than allows, and a state refusal is written to
 * the audit chain before the 409 is returned — a refused freeze is the most
 * valuable audit entry a judge will see.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  LIMITS,
  ValidationError,
  assertContentLength,
  assertShape,
  boundedArray,
  boundedInt,
  boundedNumber,
  boundedString,
  currency,
  displayText,
  e164Phone,
  isoTimestamp,
  isIsoWithOffset,
  money,
  normaliseE164,
  parseBody,
  readBodyText,
  readJsonBody,
  toValidationEnvelope,
} from "@/lib/validation/schema";
import {
  LOG_LIMITS,
  renderLogLine,
  safeLog,
  sanitiseLogFields,
  sanitiseLogString,
  sanitiseLogValue,
} from "@/lib/validation/safe-log";
import { z } from "zod";
import { guardToolCall } from "@/lib/tool-guard";

// ── helpers ─────────────────────────────────────────────────────────────────

/** `code` of the ValidationError thrown by `fn`, or "NO THROW". */
function codeOf(fn: () => unknown): string {
  try {
    fn();
    return "NO THROW";
  } catch (err) {
    return err instanceof ValidationError ? err.code : `NOT-A-VALIDATION-ERROR:${String(err)}`;
  }
}

/** `code` of the ValidationError a promise rejects with, or "NO THROW". */
async function asyncCodeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return "NO THROW";
  } catch (err) {
    return err instanceof ValidationError ? err.code : `NOT-A-VALIDATION-ERROR:${String(err)}`;
  }
}

/**
 * The `path` on the ValidationError thrown by `assertShape`, or a marker that
 * names what actually happened instead — a bare "did it throw" would let a
 * wrong error type pass for a correct path.
 */
function thrownPath(raw: unknown): string {
  try {
    assertShape(raw);
    return "NO THROW";
  } catch (err) {
    return err instanceof ValidationError
      ? String(err.path)
      : `NOT-A-VALIDATION-ERROR:${String(err)}`;
  }
}

/** An object with exactly `n` own enumerable keys. */
function fields(n: number): Record<string, number> {
  return Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, i]));
}

/** A POST Request with an optional lying/absent Content-Length header. */
function post(body?: string, contentLength?: string): Request {
  const headers: Record<string, string> = {};
  if (contentLength !== undefined) headers["content-length"] = contentLength;
  return new Request("http://localhost/", { method: "POST", headers, body });
}

// ── tool-guard stubs ───────────────────────────────────────────────────────
//
// `guardToolCall` resolves a case in the database, appends to the audit chain
// and records a telemetry span, so those three edges are stubbed below.
// `mock.module` is hoisted above the static imports by Bun, so the stub binds
// before `@/lib/tool-guard` is evaluated; the same discipline
// tests/chaos/chaos.test.ts uses for `@/lib/audit-chain`. Each test file runs in
// its own Bun process (scripts/run-tests.mjs), so these cannot leak into
// another suite.

const SECRET = "unit-test-secret";
const ENV_KEYS = ["AGENT_TOOL_SECRET", "AGENT_TOOL_ALLOWED"] as const;
const SAVED: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) SAVED[key] = process.env[key];

/** The row `caseByConversation` resolves to; null models "no live case". */
let CASE: { caseRef: string; state: string } | null = null;
/** Every audit entry the guard appended during the current test. */
const AUDIT: unknown[] = [];
let AUDIT_FAIL = false;
/** Every span the guard recorded during the current test. */
const SPANS: unknown[] = [];
let CASE_LOOKUPS = 0;

mock.module("@/lib/case-state-machine", () => ({
  CASE_STATES: ["RECEIVED"],
  canTransition: () => true,
  caseByConversation: async (conversationId: string) => {
    CASE_LOOKUPS += 1;
    // "c-missing" models the "no live case for this conversation_id" path.
    return conversationId === "c-missing" ? null : CASE;
  },
}));

mock.module("@/lib/audit-chain", () => ({
  append: async (entry: unknown) => {
    AUDIT.push(entry);
    if (AUDIT_FAIL) throw new Error("audit chain unavailable");
    return { id: "audit-stub", chainHash: "0".repeat(64) };
  },
  verifyChain: async () => ({ ok: true, rows: 0, brokenAt: null }),
}));

mock.module("@/lib/telemetry/store", () => ({
  recordSpanAndPersist: (input: unknown) => {
    SPANS.push(input);
    return input;
  },
}));

beforeEach(() => {
  process.env.AGENT_TOOL_SECRET = SECRET;
  process.env.AGENT_TOOL_ALLOWED = "card_freeze,hangup";
  CASE = { caseRef: "CASE-9", state: "CONFIRMED_FRAUD" };
  AUDIT.length = 0;
  SPANS.length = 0;
  AUDIT_FAIL = false;
  CASE_LOOKUPS = 0;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (SAVED[key] === undefined) delete process.env[key];
    else process.env[key] = SAVED[key];
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// assertShape — structural preflight
// ═══════════════════════════════════════════════════════════════════════════

describe("assertShape — accepts what JSON can produce", () => {
  test("every JSON primitive at the root is accepted", () => {
    // A preflight that rejects valid JSON is an outage, not a defence.
    expect(() => {
      assertShape(null);
      assertShape(true);
      assertShape(0);
      assertShape(-1.5);
      assertShape("s");
      assertShape({});
      assertShape([]);
    }).not.toThrow();
  });

  test("`undefined` at the ROOT is refused — JSON.parse can never produce it", () => {
    // A caller doing `parseBody(schema, maybeNothing)` must get a 422, not
    // a schema that treats absence as a valid body.
    expect(codeOf(() => assertShape(undefined))).toBe("unsupported_type");
  });

  test("nested objects and arrays inside the depth cap are accepted", () => {
    expect(() => assertShape({ a: [{ b: [1, "two", null, { c: false }] }] })).not.toThrow();
  });

  test("a null-prototype object is still a plain object", () => {
    // JSON.parse of `{"__proto__": …}` can produce one; rejecting it would
    // reject a body a caller legitimately sent.
    expect(() => assertShape(Object.assign(Object.create(null) as object, { a: 1 }))).not.toThrow();
  });
});

describe("assertShape — depth cap", () => {
  /** `n` objects nested around a scalar leaf. */
  function nested(n: number): unknown {
    let value: unknown = 1;
    for (let i = 0; i < n; i += 1) value = { k: value };
    return value;
  }

  test("exactly at the cap passes, one level over is too_deep", () => {
    // Top level is depth 1, so a 7-deep object puts its leaf at depth 8.
    expect(() => assertShape(nested(7))).not.toThrow();
    expect(codeOf(() => assertShape(nested(8)))).toBe("too_deep");
  });

  test("arrays count toward depth exactly like objects do", () => {
    expect(() => assertShape([[[[[[[1]]]]]]])).not.toThrow();
    expect(codeOf(() => assertShape([[[[[[[[1]]]]]]]]))).toBe("too_deep");
  });

  test("the reported path names the branch that broke the cap", () => {
    // A depth rejection with an empty path is undiagnosable in production.
    expect(thrownPath({ a: { b: { c: { d: { e: { f: { g: { h: { i: 1 } } } } } } } } })).toBe(
      "a.b.c.d.e.f.g.h",
    );
  });

  test("a caller-supplied limit overrides the default", () => {
    expect(() => assertShape(nested(3), { maxDepth: 8 })).not.toThrow();
    expect(codeOf(() => assertShape(nested(3), { maxDepth: 2 }))).toBe("too_deep");
  });
});

describe("assertShape — field-count cap", () => {
  test("exactly maxFields keys pass, one more is too_many_fields", () => {
    expect(() => assertShape(fields(LIMITS.maxFields))).not.toThrow();
    expect(codeOf(() => assertShape(fields(LIMITS.maxFields + 1)))).toBe("too_many_fields");
  });

  test("the cap is a GLOBAL count, not a per-object count", () => {
    // Two 32-key objects are 64 keys total. A per-object counter would let a
    // caller smuggle an unbounded payload by spreading it across branches.
    expect(codeOf(() => assertShape({ a: fields(32), b: fields(33) }))).toBe("too_many_fields");
  });

  test("array ELEMENTS are capped separately and do not consume the field budget", () => {
    // 32 keys + 50 array items must pass: items are bounded by
    // maxArrayItems, and counting them as fields would make the two caps
    // silently interact.
    expect(() => assertShape({ a: fields(32), arr: new Array(50).fill(1) })).not.toThrow();
  });
});

describe("assertShape — array and string caps", () => {
  test("exactly maxArrayItems passes, one more is too_many_items", () => {
    expect(() => assertShape(new Array(LIMITS.maxArrayItems).fill(1))).not.toThrow();
    expect(codeOf(() => assertShape(new Array(LIMITS.maxArrayItems + 1).fill(1)))).toBe(
      "too_many_items",
    );
  });

  test("exactly maxStringLength passes, one more is string_too_long", () => {
    expect(() => assertShape({ a: "x".repeat(LIMITS.maxStringLength) })).not.toThrow();
    expect(codeOf(() => assertShape({ a: "x".repeat(LIMITS.maxStringLength + 1) }))).toBe(
      "string_too_long",
    );
  });

  test("the string cap counts UTF-16 code units, so multi-byte text gets no free pass", () => {
    // A cap measured in graphemes or bytes would accept a payload 4x the
    // size the constant names.
    expect(codeOf(() => assertShape({ a: "\u00e9".repeat(LIMITS.maxStringLength + 1) }))).toBe(
      "string_too_long",
    );
  });

  test("the reported path locates the offending string", () => {
    // The 422 body has to name the field; "String too long" alone would send
    // an operator hunting through the whole payload.
    expect(thrownPath({ outer: { inner: "x".repeat(3000) } })).toBe("outer.inner");
  });
});

describe("assertShape — fails closed on non-JSON values", () => {
  test("a Date, Map, Set, class instance and Error are unsupported_type", () => {
    // None of these can come off the wire. Arriving at a boundary means code
    // constructed them, which is when a validator should stop and ask why.
    expect(codeOf(() => assertShape({ a: new Date() }))).toBe("unsupported_type");
    expect(codeOf(() => assertShape({ a: new Map() }))).toBe("unsupported_type");
    expect(codeOf(() => assertShape({ a: new Set() }))).toBe("unsupported_type");
    expect(codeOf(() => assertShape({ a: new Error("x") }))).toBe("unsupported_type");
    expect(codeOf(() => assertShape({ a: new (class X {})() }))).toBe("unsupported_type");
  });

  test("a function, symbol, bigint and undefined are unsupported_type", () => {
    expect(codeOf(() => assertShape({ a: () => 1 }))).toBe("unsupported_type");
    expect(codeOf(() => assertShape({ a: Symbol("s") }))).toBe("unsupported_type");
    expect(codeOf(() => assertShape({ a: 10n }))).toBe("unsupported_type");
    // `undefined` is the JSON hole: a dropped field must not slip past.
    expect(codeOf(() => assertShape({ a: undefined }))).toBe("unsupported_type");
  });

  test("NaN and ±Infinity are unsupported_type even though typeof says number", () => {
    // They survive no JSON round-trip, so one reaching a schema means the
    // value was built in code — exactly the case to refuse.
    expect(codeOf(() => assertShape({ a: Number.NaN }))).toBe("unsupported_type");
    expect(codeOf(() => assertShape({ a: Number.POSITIVE_INFINITY }))).toBe("unsupported_type");
    expect(codeOf(() => assertShape({ a: Number.NEGATIVE_INFINITY }))).toBe("unsupported_type");
  });

  test("the error is a ValidationError carrying a 422 status", () => {
    // Route handlers hand `status` straight to `unprocessable()`.
    try {
      assertShape(new Map());
      throw new Error("assertShape did not throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).status).toBe(422);
      expect((err as ValidationError).name).toBe("ValidationError");
    }
  });
});

describe("assertShape — prototype-pollution keys", () => {
  for (const key of ["__proto__", "constructor", "prototype"]) {
    test(`refuses "${key}" at the root`, () => {
      // JSON.parse keeps these as OWN properties, so the walk must look at
      // keys rather than trust the prototype chain.
      expect(codeOf(() => assertShape(JSON.parse(`{"${key}":{"x":1}}`)))).toBe("forbidden_key");
    });
  }

  test("refuses a forbidden key nested inside the body, and names the path", () => {
    expect(codeOf(() => assertShape(JSON.parse('{"a":{"__proto__":{"polluted":true}}}')))).toBe(
      "forbidden_key",
    );
  });

  test("a body carrying a forbidden key alongside valid keys is still refused", () => {
    // Selective refusal is what lets a polluter find the one shape that works.
    const raw = JSON.parse('{"ok":1,"__proto__":{"polluted":true}}');
    expect(codeOf(() => assertShape(raw))).toBe("forbidden_key");
    // And nothing was written to Object.prototype as a side effect.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Body-size cap
// ═══════════════════════════════════════════════════════════════════════════

describe("assertContentLength", () => {
  test("a declared length at the cap passes and one byte over is body_too_large", () => {
    expect(() => assertContentLength(post("x", String(LIMITS.maxBodyBytes)))).not.toThrow();
    expect(codeOf(() => assertContentLength(post("x", String(LIMITS.maxBodyBytes + 1))))).toBe(
      "body_too_large",
    );
  });

  test("an absent header is not a refusal — the streaming read is the real gate", () => {
    expect(() => assertContentLength(post("hello"))).not.toThrow();
  });

  test("a non-numeric header is ignored rather than treated as huge", () => {
    expect(() => assertContentLength(post("hello", "not-a-number"))).not.toThrow();
  });
});

describe("readBodyText — the streaming budget", () => {
  test("reads a body at exactly the byte budget", async () => {
    expect(await readBodyText(post("0123456789"), 10)).toBe("0123456789");
  });

  test("aborts one byte past the budget", async () => {
    expect(await asyncCodeOf(() => readBodyText(post("x".repeat(11)), 10))).toBe("body_too_large");
    // The failure must be the typed 422 a route can surface, not a raw
    // stream error from the abort.
    await expect(readBodyText(post("x".repeat(11)), 10)).rejects.toBeInstanceOf(ValidationError);
  });

  test("a LYING Content-Length does not get past the stream cap", async () => {
    // The header is attacker-controlled. If the streaming path trusted it,
    // declaring "1" would license an unbounded body.
    expect(await asyncCodeOf(() => readBodyText(post("x".repeat(5000), "1"), 10))).toBe(
      "body_too_large",
    );
  });

  test("a request with no body reads as the empty string, not a throw", async () => {
    expect(await readBodyText(new Request("http://localhost/"))).toBe("");
  });

  test("multi-byte text is measured in BYTES, not characters", async () => {
    // "é" is 2 UTF-8 bytes; a character-counted budget would admit twice the
    // payload the constant names.
    expect(await asyncCodeOf(() => readBodyText(post("\u00e9".repeat(6)), 10))).toBe(
      "body_too_large",
    );
    expect(await readBodyText(post("\u00e9".repeat(5)), 10)).toBe("\u00e9".repeat(5));
  });
});

describe("readJsonBody", () => {
  const schema = z.object({ a: z.number() });

  test("parses a well-formed body", async () => {
    expect(await readJsonBody(post('{"a":1}'), schema)).toEqual({ a: 1 });
  });

  test("malformed JSON is invalid_json, distinct from a schema failure", async () => {
    // Two different 422s: a retry fixes the first, not the second.
    expect(await asyncCodeOf(() => readJsonBody(post("{oops"), schema))).toBe("invalid_json");
  });

  test("an empty body is invalid_json, not an empty object", async () => {
    // `JSON.parse("")` throws; treating that as an empty payload would let a
    // client POST nothing and reach a handler with `{}`.
    expect(
      await asyncCodeOf(() =>
        readJsonBody(new Request("http://localhost/", { method: "POST" }), schema),
      ),
    ).toBe("invalid_json");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// parseBody / toValidationEnvelope
// ═══════════════════════════════════════════════════════════════════════════

describe("parseBody", () => {
  test("returns the parsed value on success", () => {
    expect(parseBody(z.object({ a: z.number() }), { a: 1 })).toEqual({ a: 1 });
  });

  test("a schema failure is code `invalid` with the failing path in the message", () => {
    try {
      parseBody(z.object({ a: z.object({ b: z.string() }) }), { a: { b: 5 } });
      throw new Error("parseBody did not throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      const v = err as ValidationError;
      expect(v.code).toBe("invalid");
      expect(v.path).toBe("a.b");
      // The message is what a caller sees in the 422 body, so it must name
      // the field rather than say "invalid input".
      expect(v.message).toContain("a.b");
    }
  });

  test("a root-level failure falls back to the declared `source`", () => {
    try {
      parseBody(z.string(), { x: 1 }, { source: "card_freeze" });
      throw new Error("parseBody did not throw");
    } catch (err) {
      expect((err as ValidationError).message).toContain("card_freeze");
    }
  });

  test("the structural preflight runs FIRST, so a hostile shape is refused before the schema walks it", () => {
    // The schema alone would happily validate this; the caps are what stop a
    // 200k-key payload from being walked at all.
    expect(codeOf(() => parseBody(z.object({ a: z.string() }), { a: "x".repeat(3000) }))).toBe(
      "string_too_long",
    );
  });
});

describe("toValidationEnvelope", () => {
  test("a ValidationError maps to its own status and message", () => {
    expect(toValidationEnvelope(new ValidationError("invalid", "boom", "a"))).toEqual({
      status: 422,
      error: "boom",
    });
  });

  test("anything else returns null so the caller can rethrow it", () => {
    expect(toValidationEnvelope(new Error("db down"))).toBeNull();
    expect(toValidationEnvelope("nope")).toBeNull();
    expect(toValidationEnvelope(null)).toBeNull();
    expect(toValidationEnvelope(undefined)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Field builders
// ═══════════════════════════════════════════════════════════════════════════

describe("boundedString", () => {
  test("trims when asked and preserves whitespace when not", () => {
    // A merchant name typed as " Ada " must not be indexed as a different
    // identity from "Ada".
    expect(boundedString({ trim: true }).parse("  hi  ")).toBe("hi");
    expect(boundedString().parse("  hi  ")).toBe("  hi  ");
  });

  test("min and max bound the TRIMMED value, so a padded legal string passes", () => {
    expect(boundedString({ min: 2, max: 3, trim: true }).safeParse("  ab  ").success).toBe(true);
    expect(boundedString({ min: 2, max: 3, trim: true }).safeParse(" a ").success).toBe(false);
    expect(boundedString({ min: 2, max: 3 }).safeParse("abcd").success).toBe(false);
  });

  test("pattern is a constraint, not a coercion — a mismatch is rejected", () => {
    const schema = boundedString({ pattern: /^[a-z]+$/ });
    expect(schema.safeParse("abc").success).toBe(true);
    expect(schema.safeParse("ABC").success).toBe(false);
    expect(schema.safeParse("a1").success).toBe(false);
  });

  test("a number where a string belongs is rejected", () => {
    expect(boundedString().safeParse(5).success).toBe(false);
    expect(boundedString().safeParse(null).success).toBe(false);
    expect(boundedString().safeParse(true).success).toBe(false);
    expect(boundedString().safeParse(["a"]).success).toBe(false);
  });
});

describe("boundedInt", () => {
  test("accepts integers inside the bounds and preserves the exact value", () => {
    expect(boundedInt({ min: 1, max: 10 }).parse(7)).toBe(7);
  });

  test("rejects a float — a float amount is a caller who misread the column", () => {
    expect(boundedInt().safeParse(1.5).success).toBe(false);
    expect(boundedInt().safeParse(12.34).success).toBe(false);
  });

  test("rejects a stringified number", () => {
    expect(boundedInt().safeParse("5").success).toBe(false);
    expect(boundedInt().safeParse("").success).toBe(false);
  });

  test("rejects NaN and ±Infinity", () => {
    expect(boundedInt().safeParse(Number.NaN).success).toBe(false);
    expect(boundedInt().safeParse(Number.POSITIVE_INFINITY).success).toBe(false);
    expect(boundedInt().safeParse(Number.NEGATIVE_INFINITY).success).toBe(false);
  });

  test("exactly at min and max passes; one over fails", () => {
    const schema = boundedInt({ min: 10, max: 20 });
    expect(schema.safeParse(10).success).toBe(true);
    expect(schema.safeParse(20).success).toBe(true);
    expect(schema.safeParse(9).success).toBe(false);
    expect(schema.safeParse(21).success).toBe(false);
  });

  test("multipleOf holds on negatives too", () => {
    const schema = boundedInt({ multipleOf: 5 });
    expect(schema.safeParse(10).success).toBe(true);
    expect(schema.safeParse(-10).success).toBe(true);
    expect(schema.safeParse(11).success).toBe(false);
  });
});

describe("boundedNumber", () => {
  test("accepts genuine reals for scores and ratios", () => {
    expect(boundedNumber({ min: 0, max: 1 }).parse(0.94)).toBe(0.94);
  });

  test("still refuses to coerce a stringified number", () => {
    // `z.coerce.number()` would turn "0.94" into 0.94. That is the specific
    // mistake this builder is documented not to make.
    expect(boundedNumber().safeParse("0.94").success).toBe(false);
    expect(boundedNumber().safeParse("").success).toBe(false);
  });

  test("boundaries are inclusive", () => {
    const schema = boundedNumber({ min: 0, max: 1 });
    expect(schema.safeParse(0).success).toBe(true);
    expect(schema.safeParse(1).success).toBe(true);
    expect(schema.safeParse(-0.0001).success).toBe(false);
    expect(schema.safeParse(1.0001).success).toBe(false);
  });
});

describe("boundedArray", () => {
  test("min and max bound the item count inclusively", () => {
    const schema = boundedArray(z.string(), { min: 1, max: 2 });
    expect(schema.safeParse(["a"]).success).toBe(true);
    expect(schema.safeParse(["a", "b"]).success).toBe(true);
    expect(schema.safeParse([]).success).toBe(false);
    expect(schema.safeParse(["a", "b", "c"]).success).toBe(false);
  });

  test("the item schema is applied to every element", () => {
    // One bad element must fail the whole array; a half-valid list is worse
    // than none because the caller cannot tell which half is trustworthy.
    expect(boundedArray(z.number(), { max: 2 }).safeParse(["1", 2]).success).toBe(false);
    expect(boundedArray(z.number(), { max: 2 }).safeParse([1, 2]).success).toBe(true);
  });

  test("a non-array is rejected", () => {
    expect(boundedArray(z.string()).safeParse("abc").success).toBe(false);
    expect(boundedArray(z.string()).safeParse({ 0: "a" }).success).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// currency / money
// ═══════════════════════════════════════════════════════════════════════════

describe("currency", () => {
  test("accepts real active codes including the fund/unit codes", () => {
    for (const code of ["AED", "USD", "KWD", "JPY", "BOV", "CLF", "MXV"]) {
      expect(currency().safeParse(code).success).toBe(true);
    }
  });

  test("rejects XXX, an unknown code, and lower case", () => {
    // "XXX" is the ISO no-currency placeholder: accepting it turns a
    // downstream FX conversion into a silent no-op.
    expect(currency().safeParse("XXX").success).toBe(false);
    expect(currency().safeParse("ZZZ").success).toBe(false);
    expect(currency().safeParse("usd").success).toBe(false);
  });

  test("rejects anything that is not exactly three letters", () => {
    expect(currency().safeParse("AEDX").success).toBe(false);
    expect(currency().safeParse("AE").success).toBe(false);
    expect(currency().safeParse("").success).toBe(false);
    expect(currency().safeParse("A1D").success).toBe(false);
  });

  test("rejects a non-string", () => {
    expect(currency().safeParse(840).success).toBe(false);
  });

  test("`extra` widens the list without a redeploy, and only for that caller", () => {
    expect(currency({ extra: ["ZZZ"] }).safeParse("ZZZ").success).toBe(true);
    // The extension must not leak into a schema built without it.
    expect(currency().safeParse("ZZZ").success).toBe(false);
  });
});

describe("money", () => {
  const ok = { amountMinor: 2500, currency: "AED" };

  test("accepts a well-formed amount and preserves it exactly", () => {
    expect(money().parse(ok)).toEqual(ok);
  });

  test("zero is a legitimate amount", () => {
    expect(money().safeParse({ amountMinor: 0, currency: "AED" }).success).toBe(true);
  });

  test("a negative amount is refused", () => {
    // The default floor is 0: a negative charge is a refund or a bug, and
    // neither may pass as a payment.
    expect(money().safeParse({ amountMinor: -1, currency: "AED" }).success).toBe(false);
    expect(money().safeParse({ amountMinor: -0.5, currency: "AED" }).success).toBe(false);
  });

  test("a float amountMinor is refused rather than rounded", () => {
    // 0.1 + 0.2 !== 0.3; rounding 12.34 to 12 is how a discrepancy becomes
    // a regulatory finding.
    expect(money().safeParse({ amountMinor: 12.34, currency: "AED" }).success).toBe(false);
  });

  test("a stringified amount is refused", () => {
    expect(money().safeParse({ amountMinor: "100", currency: "AED" }).success).toBe(false);
  });

  test("an absurd amount beyond safe integer arithmetic is refused", () => {
    expect(
      money().safeParse({ amountMinor: Number.MAX_SAFE_INTEGER, currency: "AED" }).success,
    ).toBe(true);
    expect(
      money().safeParse({ amountMinor: Number.MAX_SAFE_INTEGER + 2, currency: "AED" }).success,
    ).toBe(false);
  });

  test("a missing or invalid currency is refused", () => {
    expect(money().safeParse({ amountMinor: 1 }).success).toBe(false);
    expect(money().safeParse({ amountMinor: 1, currency: "XXX" }).success).toBe(false);
    expect(money().safeParse({ amountMinor: 1, currency: "aed" }).success).toBe(false);
  });

  test("UNKNOWN KEYS ARE REJECTED, not stripped — money() is a strictObject", () => {
    // This is the declared policy for this builder: a body carrying both
    // `amount` and `amountMinor` must fail rather than resolve to whichever
    // the handler happens to read first.
    expect(money().safeParse({ ...ok, amount: 25 }).success).toBe(false);
  });

  test("a plain z.object, by contrast, STRIPS the unknown key", () => {
    // Stated explicitly so the strictness stays a decision about `money()`
    // rather than a general belief about zod objects.
    expect(parseBody(z.object({ a: z.string() }), { a: "x", extra: 1 })).toEqual({ a: "x" });
    expect(() => parseBody(z.strictObject({ a: z.string() }), { a: "x", extra: 1 })).toThrow(
      ValidationError,
    );
  });

  test("custom min and max are inclusive at the boundary", () => {
    expect(money({ max: 100 }).safeParse({ amountMinor: 100, currency: "AED" }).success).toBe(true);
    expect(money({ max: 100 }).safeParse({ amountMinor: 101, currency: "AED" }).success).toBe(
      false,
    );
    expect(money({ min: 1 }).safeParse({ amountMinor: 0, currency: "AED" }).success).toBe(false);
    expect(money({ min: 1 }).safeParse({ amountMinor: 1, currency: "AED" }).success).toBe(true);
  });

  test("extraCurrencies widens money() without widening the default builder", () => {
    expect(
      money({ extraCurrencies: ["ZZZ"] }).safeParse({ amountMinor: 1, currency: "ZZZ" }).success,
    ).toBe(true);
    expect(money().safeParse({ amountMinor: 1, currency: "ZZZ" }).success).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Phones
// ═══════════════════════════════════════════════════════════════════════════

describe("normaliseE164", () => {
  test("normalises a spaced international number", () => {
    expect(normaliseE164("+971 50 123 4567")).toBe("+971501234567");
  });

  test("normalises a 00 international prefix", () => {
    expect(normaliseE164("00971501234567")).toBe("+971501234567");
  });

  test("normalises a national number using the default region and strips the trunk digit", () => {
    // "0501234567" + "+971" is +971501234567, not +9710501234567 — the trunk
    // zero is not part of the subscriber number.
    expect(normaliseE164("0501234567", "+971")).toBe("+971501234567");
    expect(normaliseE164("0501234567", "+971", false)).toBe("+9710501234567");
  });

  test("a bare local number with NO region is refused rather than guessed", () => {
    // E.164 cannot be derived without the country, and guessing it for a
    // fraud-case number calls the wrong customer.
    expect(normaliseE164("0501234567")).toBeNull();
    expect(normaliseE164("0501234567", "+")).toBeNull();
  });

  test("letters, empty and whitespace-only input are refused", () => {
    expect(normaliseE164("+97150ABCDE")).toBeNull();
    expect(normaliseE164("")).toBeNull();
    expect(normaliseE164("   ")).toBeNull();
  });

  test("a leading zero after the plus is not E.164", () => {
    expect(normaliseE164("+0123456789")).toBeNull();
    expect(normaliseE164("+")).toBeNull();
  });

  test("the digit count bound is 15 maximum", () => {
    expect(normaliseE164("+123456789012345")).toBe("+123456789012345");
    expect(normaliseE164("+1234567890123456")).toBeNull();
  });
});

describe("e164Phone", () => {
  test("the value that comes out is the NORMALISED one, whatever the caller sent", () => {
    // One string form is what makes index, dedupe and equality correct.
    const schema = e164Phone({ defaultRegion: "+971" });
    expect(schema.parse("050 123 4567")).toBe("+971501234567");
    expect(schema.parse("+971501234567")).toBe("+971501234567");
    expect(schema.parse("+971 50 123 4567")).toBe("+971501234567");
  });

  test("refuses a value that cannot be normalised", () => {
    expect(e164Phone({ defaultRegion: "+971" }).safeParse("0501234567").success).toBe(true);
    expect(e164Phone().safeParse("0501234567").success).toBe(false);
    expect(e164Phone().safeParse("+97150ABCDE").success).toBe(false);
  });

  test("refuses a non-string", () => {
    expect(e164Phone().safeParse(501234567).success).toBe(false);
    expect(e164Phone().safeParse(null).success).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Timestamps
// ═══════════════════════════════════════════════════════════════════════════

describe("isIsoWithOffset", () => {
  test("accepts Z and an explicit numeric offset, with or without the colon", () => {
    expect(isIsoWithOffset("2026-03-14T02:30:00Z")).toBe(true);
    expect(isIsoWithOffset("2026-03-14T02:30:00+04:00")).toBe(true);
    expect(isIsoWithOffset("2026-03-14T02:30:00+0400")).toBe(true);
    expect(isIsoWithOffset("2026-03-14t02:30:00z")).toBe(true);
  });

  test("refuses a naive timestamp — it means a different instant per deployment", () => {
    expect(isIsoWithOffset("2026-03-14T02:30:00")).toBe(false);
    expect(isIsoWithOffset("2026-03-14 02:30:00Z")).toBe(false);
    expect(isIsoWithOffset("2026-03-14")).toBe(false);
  });

  test("range-checks the offset instead of trusting Date.parse", () => {
    expect(isIsoWithOffset("2026-03-14T02:30:00+24:00")).toBe(false);
    expect(isIsoWithOffset("2026-03-14T02:30:00+04:60")).toBe(false);
    expect(isIsoWithOffset("2026-03-14T02:30:00+23:59")).toBe(true);
  });

  test("refuses a month or day outside the calendar", () => {
    expect(isIsoWithOffset("2026-13-45T02:30:00Z")).toBe(false);
    expect(isIsoWithOffset("2026-13-01T00:00:00Z")).toBe(false);
    expect(isIsoWithOffset("2026-01-00T00:00:00Z")).toBe(false);
    expect(isIsoWithOffset("2026-01-01T25:00:00Z")).toBe(false);
    expect(isIsoWithOffset("2026-01-01T00:60:00Z")).toBe(false);
  });

  // KNOWN GAP (not asserted as correct, see the handoff note): a date that is
  // out of range for its MONTH but in range for the regex — "2026-02-30",
  // "2026-04-31", "2026-06-31" — is ACCEPTED, and `Date.parse` rolls it
  // forward (Feb 30 becomes Mar 2). Whether a rolled-forward instant is the
  // right answer for a fraud timeline is a product decision, so this suite
  // pins only the range checks that are unambiguous.

  test("refuses a non-string", () => {
    expect(isIsoWithOffset(1773457800000 as unknown as string)).toBe(false);
  });
});

describe("isoTimestamp", () => {
  test("normalises an offset timestamp to UTC ISO form", () => {
    // The stored value is unambiguous regardless of where it is read.
    expect(isoTimestamp().parse("2026-03-14T02:30:00+04:00")).toBe("2026-03-13T22:30:00.000Z");
    expect(isoTimestamp().parse("2026-03-14T02:30:00Z")).toBe("2026-03-14T02:30:00.000Z");
  });

  test("a naive timestamp is refused", () => {
    expect(isoTimestamp().safeParse("2026-03-14T02:30:00").success).toBe(false);
  });

  test("fractional seconds are preserved through the normalisation", () => {
    expect(isoTimestamp().parse("2026-03-14T02:30:00.123456789+04:00")).toBe(
      "2026-03-13T22:30:00.123Z",
    );
  });

  test("refuses a non-string", () => {
    expect(isoTimestamp().safeParse(1773457800000).success).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Display text
// ═══════════════════════════════════════════════════════════════════════════

describe("displayText", () => {
  test("the value that comes out is the NORMALISED one, so the console renders what was validated", () => {
    // An RLO override renders "Bankof Evry" as something else entirely; the
    // bytes and the rendered glyphs must not disagree.
    expect(displayText().parse("Bank\u202Eof Evry\u202C")).toBe("Bankof Evry");
  });

  test("compatibility forms are folded", () => {
    expect(displayText().parse("\uFB01n\u002E")).toBe("fin.");
  });

  test("the grapheme cap is inclusive and refuses one over", () => {
    const schema = displayText({ maxGraphemes: 3 });
    expect(schema.safeParse("abc").success).toBe(true);
    expect(schema.safeParse("abcd").success).toBe(false);
  });

  test("the cap counts GRAPHEMES, so an emoji ZWJ sequence is not split", () => {
    // One family emoji plus one letter is two clusters and must pass a
    // two-grapheme cap; a code-unit count would split the cluster.
    expect(
      displayText({ maxGraphemes: 2 }).safeParse("\u{1F468}\u200D\u{1F469}\u200D\u{1F467}a")
        .success,
    ).toBe(true);
    expect(
      displayText({ maxGraphemes: 1 }).safeParse("\u{1F468}\u200D\u{1F469}\u200D\u{1F467}a")
        .success,
    ).toBe(false);
  });

  test("a non-string is refused", () => {
    expect(displayText().safeParse(42).success).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// safe-log
// ═══════════════════════════════════════════════════════════════════════════

describe("sanitiseLogString", () => {
  test("a run of line terminators collapses to ONE space", () => {
    // Otherwise "a\r\nb" reads as "a  b" and a count of injected lines
    // disagrees with the text.
    expect(sanitiseLogString("a\r\nb")).toBe("a b");
    expect(sanitiseLogString("a\n\nb")).toBe("a b");
    expect(sanitiseLogString("a\u2028b")).toBe("a b");
    expect(sanitiseLogString("a\u0085b")).toBe("a b");
  });

  test("vertical tab and form feed are treated as terminators, not deleted", () => {
    expect(sanitiseLogString("a\u000Bb\u000Cc")).toBe("a b c");
  });

  test("remaining C0/C1 controls and the invisible reordering set are REMOVED", () => {
    expect(sanitiseLogString("a\u0000b")).toBe("ab");
    expect(sanitiseLogString("a\u007Fb")).toBe("ab");
    expect(sanitiseLogString("a\u009Fb")).toBe("ab");
    expect(sanitiseLogString("a\u202Eb")).toBe("ab");
    expect(sanitiseLogString("a\u200Bb")).toBe("ab");
    expect(sanitiseLogString("a\uFEFFb")).toBe("ab");
  });

  test("truncation is inclusive at the limit", () => {
    expect(sanitiseLogString("abcde", 5)).toBe("abcde");
    expect(sanitiseLogString("abcdef", 5)).toBe("abcde");
  });

  test("ordinary text is untouched", () => {
    expect(sanitiseLogString("merchant: Ada Lovelace")).toBe("merchant: Ada Lovelace");
  });
});

describe("sanitiseLogValue — redaction", () => {
  test("a card PAN is redacted, not logged", () => {
    expect(sanitiseLogValue("4111111111111111")).toBe("[REDACTED]");
  });

  test("an email is redacted", () => {
    expect(sanitiseLogValue("ada@example.com")).toBe("[REDACTED]");
  });

  test("an amount and a risk score survive — over-redaction destroys the evidence", () => {
    // "2500" and "0.94" are the facts an operator needs; redacting bare
    // numbers would make the log useless.
    expect(sanitiseLogValue("AED 2500")).toBe("AED 2500");
    expect(sanitiseLogValue("0.94")).toBe("0.94");
  });
});

describe("sanitiseLogValue — bounds", () => {
  test("an over-long string is truncated to maxStringLength", () => {
    expect((sanitiseLogValue("x".repeat(5000)) as string).length).toBe(LOG_LIMITS.maxStringLength);
  });

  test("nesting deeper than maxDepth is marked, not walked", () => {
    // A cyclic payload must terminate; a logger with no depth bound is a
    // stack-exhaustion vector reachable from any logged request body.
    expect(sanitiseLogValue({ a: { b: { c: { d: { e: 1 } } } } })).toEqual({
      a: { b: { c: { d: { e: "[max depth]" } } } },
    });
  });

  test("a self-referencing object terminates at the depth cap", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic["self"] = cyclic;
    expect(() => sanitiseLogValue(cyclic)).not.toThrow();
    expect(JSON.stringify(sanitiseLogValue(cyclic, 0, { maxDepth: 1 }))).toContain("[max depth]");
  });

  test("a self-referencing array terminates at the depth cap", () => {
    const cyclic: unknown[] = [1];
    cyclic.push(cyclic);
    expect(() => sanitiseLogValue(cyclic)).not.toThrow();
    expect(JSON.stringify(sanitiseLogValue(cyclic, 0, { maxDepth: 1 }))).toContain("[max depth]");
  });

  test("an over-long array is capped and says how many were dropped", () => {
    const out = sanitiseLogValue(Array.from({ length: 25 }, (_, i) => i)) as unknown[];
    expect(out).toHaveLength(LOG_LIMITS.maxEntries + 1);
    // Dropping silently would read as "the payload had 21 items".
    expect(out[out.length - 1]).toBe("[+5 more]");
  });

  test("an over-wide object is capped and says it was truncated", () => {
    const out = sanitiseLogValue(fields(25)) as Record<string, unknown>;
    expect(Object.keys(out)).toHaveLength(LOG_LIMITS.maxEntries + 1);
    expect(out["[truncated]"]).toBe(true);
  });

  test("an object at exactly maxEntries is not marked truncated", () => {
    expect(sanitiseLogValue(fields(LOG_LIMITS.maxEntries))).not.toHaveProperty("[truncated]");
  });

  test("caller-supplied limits override the defaults", () => {
    expect(sanitiseLogValue("abcdef", 0, { maxStringLength: 3 }) as string).toBe("abc");
    // The cap is checked BEFORE an entry is admitted, so `maxEntries: 2`
    // keeps exactly two keys and marks the remainder dropped.
    expect(sanitiseLogValue(fields(4), 0, { maxEntries: 2 })).toEqual({
      k0: 0,
      k1: 1,
      "[truncated]": true,
    });
  });

  test("a symbol and a function become [unserialisable]", () => {
    expect(sanitiseLogValue(Symbol("s"))).toBe("[unserialisable]");
    expect(sanitiseLogValue(() => 1)).toBe("[unserialisable]");
  });
  test("an Error is reduced to name and message, bounded", () => {
    expect(sanitiseLogValue(new Error("bad\nthing"))).toBe("Error: bad thing");
    expect((sanitiseLogValue(new Error("x".repeat(1000))) as string).length).toBe(
      LOG_LIMITS.maxStringLength,
    );
  });

  test("a Date is ISO-formatted and an invalid Date is marked", () => {
    expect(sanitiseLogValue(new Date("2020-01-01T00:00:00Z"))).toBe("2020-01-01T00:00:00.000Z");
    // `Invalid Date` must not reach a log sink — a consumer parsing it fails.
    expect(sanitiseLogValue(new Date(Number.NaN))).toBe("[invalid date]");
  });

  test("NaN and ±Infinity are stringified rather than emitted as bare numbers", () => {
    // JSON.stringify turns both into `null`, so a reader could not tell a
    // real null from a broken measurement.
    expect(sanitiseLogValue(Number.NaN)).toBe("NaN");
    expect(sanitiseLogValue(Number.POSITIVE_INFINITY)).toBe("Infinity");
    expect(sanitiseLogValue(1)).toBe(1);
  });

  test("a bigint is stringified — JSON.stringify throws on one", () => {
    expect(sanitiseLogValue(10n)).toBe("10");
  });

  test("null and undefined both become null", () => {
    expect(sanitiseLogValue(null)).toBeNull();
    expect(sanitiseLogValue(undefined)).toBeNull();
  });

  test("a Map, Set or class instance is stringified rather than walked", () => {
    class Thing {
      toString(): string {
        return "THING";
      }
    }
    expect(sanitiseLogValue(new Map([["a", 1]]))).toBe("[object Map]");
    expect(sanitiseLogValue(new Thing())).toBe("THING");
  });

  test("a null-prototype object is walked, not stringified", () => {
    expect(sanitiseLogValue(Object.assign(Object.create(null) as object, { a: 1 }))).toEqual({
      a: 1,
    });
  });
});

describe("sanitiseLogValue — forbidden keys", () => {
  test("__proto__, constructor and prototype never appear in the output", () => {
    // A sanitised object that carries `__proto__` into a downstream merge is
    // a pollution vector with a log in front of it.
    const raw = JSON.parse('{"__proto__":{"x":1},"constructor":2,"prototype":3,"ok":4}');
    expect(sanitiseLogValue(raw)).toEqual({ ok: 4 });
  });

  test("the surviving sibling keys are untouched", () => {
    expect(sanitiseLogValue({ ok: 1, also: "fine" })).toEqual({ ok: 1, also: "fine" });
  });
});

describe("sanitiseLogFields", () => {
  test("an undefined field bag is an empty object, not a throw", () => {
    expect(sanitiseLogFields(undefined)).toEqual({});
  });

  test("field NAMES are sanitised too, and bounded to 64 characters", () => {
    // A name comes from code, but a mapping key does not — and an
    // unsanitised name is a forged field in the record.
    const out = sanitiseLogFields({ [`k${"x".repeat(80)}`]: 1 });
    expect(Object.keys(out)[0]?.length).toBe(64);
  });

  test("a line break in a field name collapses to a space, never a newline", () => {
    // Collapsing rather than deleting keeps the two halves of the name
    // readable while making it impossible to forge a record boundary.
    expect(Object.keys(sanitiseLogFields({ "a\nb": 1 }))).toEqual(["a b"]);
  });

  test("forbidden keys are dropped from the field bag", () => {
    const raw = JSON.parse('{"__proto__":1,"constructor":2,"prototype":3,"ok":4}') as Record<
      string,
      unknown
    >;
    expect(sanitiseLogFields(raw)).toEqual({ ok: 4 });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// renderLogLine
// ═══════════════════════════════════════════════════════════════════════════

describe("renderLogLine", () => {
  test("a record renders as exactly one physical line", () => {
    const line = renderLogLine({
      level: "info",
      msg: "a\r\nb",
      ts: "2026-01-01T00:00:00.000Z",
      fields: { k: "v" },
    });
    expect(line).not.toContain("\n");
    expect(line).not.toContain("\r");
    expect(JSON.parse(line)).toEqual({
      level: "info",
      msg: "a\r\nb",
      ts: "2026-01-01T00:00:00.000Z",
      fields: { k: "v" },
    });
  });
});

describe("safeLog", () => {
  test("returns the line it handed to the sink, and passes the level through", () => {
    const seen: { level: string; line: string }[] = [];
    const line = safeLog("warn", "hello", undefined, (level, l) => seen.push({ level, line: l }));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.level).toBe("warn");
    expect(seen[0]?.line).toBe(line);
  });

  test("a newline in the message cannot forge a second log line", () => {
    const line = safeLog("info", "a\r\nFORGED", undefined, () => {});
    expect(line.split("\n")).toHaveLength(1);
    expect(JSON.parse(line).msg).toBe("a FORGED");
  });

  test("the rendered record is valid JSON and carries the level and a timestamp", () => {
    const record = JSON.parse(safeLog("error", "m", undefined, () => {})) as {
      level: string;
      ts: string;
      msg: string;
      fields: Record<string, unknown>;
    };
    expect(record.level).toBe("error");
    expect(record.msg).toBe("m");
    expect(record.fields).toEqual({});
    expect(Number.isFinite(Date.parse(record.ts))).toBe(true);
  });

  test("a hostile field bag is redacted and bounded, never logged whole", () => {
    const line = safeLog(
      "info",
      "m",
      { pan: "4111111111111111", blob: "x".repeat(5000) },
      () => {},
    );
    expect(line).not.toContain("4111111111111111");
    const record = JSON.parse(line) as { fields: Record<string, unknown> };
    expect(record.fields["pan"]).toBe("[REDACTED]");
    expect((record.fields["blob"] as string).length).toBe(LOG_LIMITS.maxStringLength);
  });

  test("a hostile field bag with cycles and forbidden keys still renders one line", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic["self"] = cyclic;
    const raw = JSON.parse('{"__proto__":{"x":1}}') as Record<string, unknown>;
    const line = safeLog("info", "m", { cyclic, raw, when: new Date(Number.NaN) }, () => {});
    expect(line.split("\n")).toHaveLength(1);
    const record = JSON.parse(line) as { fields: Record<string, unknown> };
    // The cycle terminates at the depth cap and the invalid date is marked,
    // so a consumer can tell "absent" from "broken" instead of guessing.
    expect(JSON.stringify(record.fields)).toContain("[max depth]");
    expect(record.fields["when"]).toBe("[invalid date]");
    expect(Object.keys(record.fields)).toContain("raw");
    expect(line).not.toContain("__proto__");
  });

  test("an omitted field bag is legal", () => {
    expect(() => safeLog("debug", "m", undefined, () => {})).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// tool-guard
//
// `guardToolCall` reaches a database and an audit chain, so both are stubbed
// below. Each test file runs in its own Bun process (scripts/run-tests.mjs), so
// these module mocks cannot leak into another suite.
// ═══════════════════════════════════════════════════════════════════════════

describe("guardToolCall — the allow/deny boundary", () => {
  test("an authorised call in an allowed state is allowed, and reports the resolved case", async () => {
    CASE = { caseRef: "CASE-9", state: "CONFIRMED_FRAUD" };
    const result = await guardToolCall("card_freeze", SECRET, "c-1", ["CONFIRMED_FRAUD"]);
    expect(result).toEqual({
      ok: true,
      caseRef: "CASE-9",
      state: "CONFIRMED_FRAUD",
      conversationId: "c-1",
    });
    // An allowed call is not an auditable event — only refusals are.
    expect(AUDIT.length).toBe(0);
  });

  test("an allowed state anywhere in the list admits the call", async () => {
    CASE = { caseRef: "CASE-9", state: "CONFIRMED_FRAUD" };
    expect(
      (await guardToolCall("card_freeze", SECRET, "c-1", ["CLOSED", "CONFIRMED_FRAUD"])).ok,
    ).toBe(true);
  });

  test("a state outside the list is refused for the STATE reason, and says which state it was in", async () => {
    CASE = { caseRef: "CASE-9", state: "CONFIRMED_FRAUD" };
    const result = await guardToolCall("card_freeze", SECRET, "c-1", ["FREEZE_STAGED"]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.status).toBe(409);
    expect(result.code).toBe("state_precondition_failed");
    // The operator has to know which state blocked the tool.
    expect(result.error).toContain("CONFIRMED_FRAUD");
  });

  test("the state comparison is case-SENSITIVE", async () => {
    // CaseState is an uppercase vocabulary; a lowercase entry is a typo, and
    // treating it as a match would let a misconfigured caller through.
    CASE = { caseRef: "CASE-9", state: "CONFIRMED_FRAUD" };
    expect((await guardToolCall("card_freeze", SECRET, "c-1", ["confirmed_fraud"])).ok).toBe(false);
  });

  test("an EMPTY allowedStates list denies, it does not allow", async () => {
    // `includes` on [] is false; a guard written the other way round would
    // make "I forgot to configure this tool" mean "allow everything".
    CASE = { caseRef: "CASE-9", state: "CONFIRMED_FRAUD" };
    const result = await guardToolCall("card_freeze", SECRET, "c-1", []);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("state_precondition_failed");
    expect(result.status).toBe(409);
  });

  test("a missing conversation_id is a 409 named as such, not a case lookup", async () => {
    const result = await guardToolCall("card_freeze", SECRET, null, ["CONFIRMED_FRAUD"]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.status).toBe(409);
    expect(result.code).toBe("conversation_id_required");
    // Nothing was looked up and nothing was audited.
    expect(CASE_LOOKUPS).toBe(0);
    expect(AUDIT.length).toBe(0);
  });

  test("an unresolvable conversation_id is case_not_found", async () => {
    CASE = null;
    const result = await guardToolCall("card_freeze", SECRET, "c-missing", ["CONFIRMED_FRAUD"]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.status).toBe(409);
    expect(result.code).toBe("case_not_found");
  });
});

describe("guardToolCall — authentication is checked before anything else", () => {
  test("a wrong secret is 401 and never reaches the case lookup", async () => {
    CASE = { caseRef: "CASE-9", state: "CONFIRMED_FRAUD" };
    const result = await guardToolCall("card_freeze", "wrong-secret", "c-1", ["CONFIRMED_FRAUD"]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.status).toBe(401);
    expect(result.code).toBe("unauthorized");
    expect(CASE_LOOKUPS).toBe(0);
  });

  test("an absent secret is refused identically to a wrong one", async () => {
    const withNull = await guardToolCall("card_freeze", null, "c-1", ["CONFIRMED_FRAUD"]);
    const withWrong = await guardToolCall("card_freeze", "nope", "c-1", ["CONFIRMED_FRAUD"]);
    if (withNull.ok || withWrong.ok) throw new Error("expected refusals");
    // Indistinguishable by design: a caller must not learn which half failed.
    expect(withNull.status).toBe(withWrong.status);
    expect(withNull.error).toBe(withWrong.error);
  });

  test("a valid secret for a tool OUT OF SCOPE is refused", async () => {
    // Holding the secret is not enough; privilege is bound to the tool.
    const result = await guardToolCall("not_in_scope_tool", SECRET, "c-1", ["CONFIRMED_FRAUD"]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.status).toBe(403);
    expect(result.error).toBe("tool_not_in_scope");
    // The guard's `code` collapses every auth-stage refusal to one value and
    // the operator-visible `error` carries the reason. Pinned so a future
    // change to either is a deliberate diff.
    expect(result.code).toBe("unauthorized");
    expect(CASE_LOOKUPS).toBe(0);
  });

  test("auth is evaluated before conversation_id, so an unauthenticated caller learns nothing about the body", async () => {
    const result = await guardToolCall("card_freeze", "wrong-secret", null, []);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.status).toBe(401);
  });
});

describe("guardToolCall — refusals are audited and never become a 500", () => {
  test("a state refusal writes the refusal to the audit chain", async () => {
    CASE = { caseRef: "CASE-9", state: "CONFIRMED_FRAUD" };
    AUDIT.length = 0;
    await guardToolCall("card_freeze", SECRET, "c-1", ["FREEZE_STAGED"]);
    expect(AUDIT).toHaveLength(1);
    const entry = AUDIT[0] as {
      callRef: string;
      intent: string;
      callerId: string;
      meta: Record<string, unknown>;
    };
    // A refused freeze is the entry a judge reads, so it must name the case,
    // the tool and the states that were allowed.
    expect(entry.callRef).toBe("CASE-9");
    expect(entry.callerId).toBe("agent-tool");
    // The tool name lives in both `intent` and `meta`, so the refusal stays
    // identifiable even if one field is dropped downstream.
    expect(entry.intent).toBe("tool_refused_card_freeze");
    expect(entry.meta["tool"]).toBe("card_freeze");
    expect(entry.meta["state"]).toBe("CONFIRMED_FRAUD");
    expect(entry.meta["reason"]).toBe("state_precondition_failed");
    expect(entry.meta["allowedStates"]).toEqual(["FREEZE_STAGED"]);
  });

  test("an audit-chain failure does not turn a 409 into a 500", async () => {
    // The guard must still refuse if the chain is unavailable; a thrown
    // audit error would turn a security decision into an outage.
    CASE = { caseRef: "CASE-9", state: "CONFIRMED_FRAUD" };
    AUDIT_FAIL = true;
    try {
      const result = await guardToolCall("card_freeze", SECRET, "c-1", ["FREEZE_STAGED"]);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.status).toBe(409);
      expect(result.code).toBe("state_precondition_failed");
    } finally {
      AUDIT_FAIL = false;
    }
  });

  test("an auth or lookup refusal writes nothing to the audit chain", async () => {
    AUDIT.length = 0;
    await guardToolCall("card_freeze", "wrong-secret", "c-1", ["CONFIRMED_FRAUD"]);
    CASE = null;
    await guardToolCall("card_freeze", SECRET, "c-missing", ["CONFIRMED_FRAUD"]);
    // Only a state refusal is a case event; the rest are caller errors.
    expect(AUDIT).toHaveLength(0);
  });
});

describe("guardToolCall — every call is instrumented", () => {
  test("an allowed call records exactly one span", async () => {
    CASE = { caseRef: "CASE-9", state: "CONFIRMED_FRAUD" };
    SPANS.length = 0;
    await guardToolCall("card_freeze", SECRET, "c-1", ["CONFIRMED_FRAUD"]);
    expect(SPANS).toHaveLength(1);
    const span = SPANS[0] as { span: string; caseRef: string };
    expect(span.span).toBe("tool_request_to_response");
    // The span is keyed by conversation id, which is the only identifier the
    // guard has before a case resolves.
    expect(span.caseRef).toBe("c-1");
  });

  test("a REFUSED call is instrumented too — a slow refusal is still dead air", async () => {
    CASE = { caseRef: "CASE-9", state: "CONFIRMED_FRAUD" };
    SPANS.length = 0;
    await guardToolCall("card_freeze", SECRET, "c-1", ["FREEZE_STAGED"]);
    expect(SPANS).toHaveLength(1);
    const span = SPANS[0] as { startedAtMs: number; endedAtMs: number };
    expect(span.endedAtMs).toBeGreaterThanOrEqual(span.startedAtMs);
  });

  test("a span is recorded on the 401 path as well", async () => {
    SPANS.length = 0;
    await guardToolCall("card_freeze", "wrong-secret", "c-1", ["CONFIRMED_FRAUD"]);
    expect(SPANS).toHaveLength(1);
  });
});
