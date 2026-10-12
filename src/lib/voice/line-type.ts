import "server-only";

/**
 * Line type — is the number on the other end a mobile, a landline, a VoIP
 * number, or something we cannot tell?
 *
 * ## Why this is a risk control and not an address-book nicety
 *
 * Two facts about a caller decide how this platform should behave on the very
 * first turn of a fraud intervention:
 *
 *  1. **A landline cannot receive an SMS.** The SMS confirmation fallback
 *     (`src/lib/elevenlabs/sms-fallback.ts`) silently delivers nothing to a
 *     fixed line. An institution that sees "confirmation SMS sent" and reads
 *     that as "the customer was reached" has been told a falsehood by a
 *     delivery API, on a fraud call, about the one channel that would have
 *     caught it. `supportsSmsConfirmation` is the predicate that stops that.
 *
 *  2. **VoIP is over-represented in SIM-swap and account-takeover fraud.**
 *     An internet number is cheap, instant, anonymous, disposable, and can be
 *     ported. It is also disproportionately where the caller behind a
 *     spoofed bank number actually sits. Flagging it does not block the call —
 *     a legitimate customer has plenty of reasons to have one — it changes what
 *     the institution is told about the person it is talking to.
 *
 * ## WHAT THIS MODULE IS NOT — read this before trusting an answer
 *
 * **This is a heuristic prefix table, not carrier truth.** It says: "in this
 * numbering plan, this digit block is allocated to line types X". It does NOT
 * say: "this specific number is currently a mobile on Etisalat". Between those
 * two statements is a porting database, a live carrier feed, or a commercial
 * HLR — and **the repository contains none of them.** That was searched for:
 * `.env.example` carries no number-intelligence key, there is no Lookups
 * client, no portability (NMC/NAM) feed, and the only E.164-aware module on
 * this plane, `src/lib/abuse/geo.ts`, resolves country from a CALLING CODE and
 * explicitly refuses to embed numbering-plan metadata ("not a full
 * numbering-plan library"). So the table below is what can honestly be built
 * from first principles today, and it is deliberately small.
 *
 * Three specific honesty rules are load-bearing:
 *
 *  - **Anything not in the table is `"unknown"`, never a guess.** There is no
 *    default type. A module that answered "mobile" for an unrecognised number
 *    would turn a missing signal into a confident wrong one, and every caller
 *    downstream would stop checking.
 *  - **No rule claims to separate business from consumer.** In the NANP, in
 *    the UAE plan, and in the ITU ranges, a prefix carries no information about
 *    whether the subscriber is a company. `class` is therefore `"unknown"` for
 *    EVERY prefix-derived classification — by construction, not by oversight,
 *    which is why `PrefixRule` has no `class` field to fill in wrongly.
 *  - **The NANP does not identify VoIP at all.** Area codes in the NANP are
 *    geographic (or toll-free, or premium); they are not allocated per carrier,
 *    so "+1 415 555 0100" is a mobile, a landline or a VoIP number and a prefix
 *    rule genuinely cannot say. The only NANP facts derivable here are the
 *    toll-free and 900 blocks. `+1 976` is deliberately NOT treated as premium:
 *    it overlaps live geographic area codes (713/210/954), and calling it
 *    premium would mislabel real Houston and San Diego customers.
 *
 * ## Upgrading this to a real lookup
 *
 * The upgrade path is already wired and is a data change, not a rewrite:
 * inject a `lookup` into `classifyLine` (or set the env vars below) and the
 * prefix table becomes the FALLBACK instead of the answer. A real provider is
 * then given a hard timeout, and any failure degrades to the table — it never
 * blocks a live call and never throws into a caller.
 *
 *   LINE_TYPE_LOOKUP_URL          provider endpoint (HTTPS); unset = no lookup
 *   LINE_TYPE_LOOKUP_TOKEN        bearer token / API key; unset = unauthenticated
 *   LINE_TYPE_LOOKUP_TIMEOUT_MS   per-request budget, default 1500 ms
 *
 * The timeout default is deliberately short. This runs while a customer is on
 * the line waiting to hear a sentence; a number-enrichment service that is
 * having a bad minute must cost the caller a fraction of a second, not the
 * dead air that `src/lib/voice/first-audio-deadline.ts` exists to bound.
 */

import { z } from "zod";
import { normaliseE164 } from "@/lib/abuse/geo";

/* ── The vocabulary ─────────────────────────────────────────────────────────── */

export const LINE_TYPES = [
  "mobile",
  "landline",
  "voip",
  "toll_free",
  "premium",
  "shared_cost",
  "personal_number",
  "unknown",
] as const;

export type LineType = (typeof LINE_TYPES)[number];

export const LINE_CLASSES = ["consumer", "business", "unknown"] as const;

export type LineClass = (typeof LINE_CLASSES)[number];

/**
 * How sure we are. `"low"` is a real value and it means "this range is
 * allocated to this type, but the assignment inside it is not ours to know" —
 * an ITU service range whose subscriber length is not fixed, for instance.
 */
export type LineConfidence = "high" | "low" | "unknown";

/** Which mechanism produced the answer. Carried so the audit trail can say. */
export type LineSource = "lookup" | "prefix" | "unknown";

export type LineClassification = {
  type: LineType;
  class: LineClass;
  confidence: LineConfidence;
  source: LineSource;
};

export const UNKNOWN_LINE: LineClassification = Object.freeze({
  type: "unknown",
  class: "unknown",
  confidence: "unknown",
  source: "unknown",
});

/* ── E.164 ──────────────────────────────────────────────────────────────────── */

/**
 * The shape a carrier will actually dial, which is `isE164` in
 * `@/lib/twilio.ts` and the pattern `@/lib/adapters/telecom-adapter.ts` uses.
 *
 * Canonicalisation itself is NOT re-implemented: `normaliseE164` is imported
 * from `@/lib/abuse/geo`, so "strip what people type, drop the `00` prefix,
 * require `+`" has exactly one definition in this repository. That module's own
 * regex allows one fewer digit than this one (`\d{6,14}` vs `\d{7,14}`); the
 * stricter gate is applied here because anything shorter is a number Twilio
 * will refuse, and classifying a number the carrier cannot call would be a
 * classification about nothing.
 */
export const CALLER_E164_RE = /^\+[1-9]\d{7,14}$/;

/* ── The prefix table ───────────────────────────────────────────────────────── */

/**
 * A digit-block rule.
 *
 * There is deliberately no `class` field. See the module header: a prefix is
 * not evidence about the subscriber's business/consumer status in any plan we
 * cover, and a field that could be filled in wrongly is a field that will be.
 */
export type PrefixRule = {
  /** Literal digits after the `+`, matched with `startsWith`. */
  readonly prefix: string;
  /** When set, the whole digit run must be exactly this long. */
  readonly length?: number;
  /** Upper bound when the plan does not fix a subscriber length. */
  readonly maxLength?: number;
  readonly type: LineType;
  readonly confidence: LineConfidence;
  /** What the block is, for the human auditing this table. */
  readonly note: string;
};

/**
 * Blocks that say something, and nothing else.
 *
 * Ordering in the source is for reading; `ORDERED_RULES` re-sorts by prefix
 * length so a broad rule can never shadow a specific one added later. Every
 * rule is a ALLOCATION claim about a block, never a claim about a subscriber.
 */
export const PREFIX_RULES: readonly PrefixRule[] = Object.freeze([
  /* — UAE (+971): the deployment's own market, and the best-covered plan — */
  {
    prefix: "971800",
    maxLength: 13,
    type: "toll_free",
    confidence: "low",
    note: "UAE 800 numbers. Block is unambiguous; subscriber length is not uniform, hence low confidence.",
  },
  {
    prefix: "9715",
    length: 12,
    type: "mobile",
    confidence: "high",
    note: "UAE mobile. National numbers begin 05 (50/52/54/55/56/58, Etisalat and Du); E.164 drops the leading 0, leaving 9 national digits.",
  },
  {
    prefix: "9712",
    length: 11,
    type: "landline",
    confidence: "high",
    note: "Dubai area code 02, 7 subscriber digits. Cannot receive SMS.",
  },
  {
    prefix: "9714",
    length: 11,
    type: "landline",
    confidence: "high",
    note: "Sharjah / Ajman / Umm Al Quwain area code 04. Cannot receive SMS.",
  },
  {
    prefix: "9716",
    length: 11,
    type: "landline",
    confidence: "high",
    note: "Abu Dhabi area code 06. Cannot receive SMS.",
  },
  {
    prefix: "9717",
    length: 11,
    type: "landline",
    confidence: "high",
    note: "Al Ain area code 07. Cannot receive SMS.",
  },
  {
    prefix: "9719",
    length: 11,
    type: "landline",
    confidence: "high",
    note: "Ruwais area code 09. Cannot receive SMS.",
  },

  /* — NANP (+1): only the non-geographic blocks are knowable from a prefix — */
  {
    prefix: "1800",
    length: 11,
    type: "toll_free",
    confidence: "high",
    note: "NANP toll-free 800.",
  },
  {
    prefix: "1833",
    length: 11,
    type: "toll_free",
    confidence: "high",
    note: "NANP toll-free 833.",
  },
  {
    prefix: "1844",
    length: 11,
    type: "toll_free",
    confidence: "high",
    note: "NANP toll-free 844.",
  },
  {
    prefix: "1855",
    length: 11,
    type: "toll_free",
    confidence: "high",
    note: "NANP toll-free 855.",
  },
  {
    prefix: "1866",
    length: 11,
    type: "toll_free",
    confidence: "high",
    note: "NANP toll-free 866.",
  },
  {
    prefix: "1877",
    length: 11,
    type: "toll_free",
    confidence: "high",
    note: "NANP toll-free 877.",
  },
  {
    prefix: "1888",
    length: 11,
    type: "toll_free",
    confidence: "high",
    note: "NANP toll-free 888.",
  },
  {
    prefix: "1900",
    length: 11,
    type: "premium",
    confidence: "high",
    note: "NANP premium rate. Carries charges; never a residential customer.",
  },

  /* — ITU non-geographic service codes — */
  {
    prefix: "800",
    maxLength: 12,
    type: "toll_free",
    confidence: "low",
    note: "ITU international toll-free 800.",
  },
  {
    prefix: "808",
    maxLength: 12,
    type: "shared_cost",
    confidence: "low",
    note: "ITU shared-cost 808.",
  },
  {
    prefix: "870",
    maxLength: 12,
    type: "shared_cost",
    confidence: "low",
    note: "ITU shared-cost / INternational 870.",
  },
  {
    prefix: "878",
    maxLength: 13,
    type: "personal_number",
    confidence: "low",
    note: "ITU Universal Personal Telecommunications 878.",
  },
  {
    prefix: "881",
    maxLength: 12,
    type: "shared_cost",
    confidence: "low",
    note: "ITU shared-cost 881.",
  },
  {
    prefix: "882",
    maxLength: 12,
    type: "voip",
    confidence: "low",
    note: "ITU international networks 882.",
  },
  {
    prefix: "883",
    maxLength: 12,
    type: "voip",
    confidence: "low",
    note: "ITU international networks 883.",
  },
  {
    prefix: "888",
    maxLength: 12,
    type: "shared_cost",
    confidence: "low",
    note: "ITU shared-cost / disaster relief 888.",
  },
  {
    prefix: "979",
    maxLength: 12,
    type: "premium",
    confidence: "low",
    note: "ITU international premium rate 979.",
  },

  /* — Blocks that are known-fraud-heavy, and knowable — */
  {
    prefix: "4456",
    length: 12,
    type: "voip",
    confidence: "low",
    note: "UK 056 VoIP block (Numberscope and successors). Allocation is real; the subscriber behind it is unconstrained.",
  },
  {
    prefix: "4474",
    length: 12,
    type: "personal_number",
    confidence: "low",
    note: "UK 074 personal numbers, reserved for fictional/drama use and heavily abused by UK SMS fraud.",
  },
  {
    prefix: "614",
    length: 11,
    type: "mobile",
    confidence: "high",
    note: "Australian 04 mobile block.",
  },

  /* — Deliberately absent, and why — */
  // * +971 3  — unallocated/reserved in the UAE plan. Left out so it reads
  //   "unknown" rather than asserting a landline that may not exist.
  // * +1 976  — overlaps live geographic area codes (713/210/954). Calling it
  //   premium would mislabel real customers.
  // * Every geographic NANP area code — a US/Canadian geographic number is a
  //   mobile, a landline or a VoIP number and the prefix cannot say which.
  // * Every UK geographic (01/02) and mobile (07) block — separable from a
  //   prefix, but out of scope for a UAE deployment; each one omitted is a
  //   number this module reports as "unknown", which is the safe answer.
]);

/** Longest prefix first, so a specific rule can never be shadowed by a broad one. */
const ORDERED_RULES: readonly PrefixRule[] = Object.freeze(
  [...PREFIX_RULES].sort((a, b) => b.prefix.length - a.prefix.length),
);

/**
 * The prefix verdict for canonical digits (no `+`). `null` when no block in the
 * table applies — and `null` is a real answer, meaning "this table has nothing
 * to say", not "this failed".
 */
export function matchPrefixRule(digits: string): PrefixRule | null {
  for (const rule of ORDERED_RULES) {
    if (!digits.startsWith(rule.prefix)) continue;
    if (rule.length !== undefined && digits.length !== rule.length) continue;
    if (rule.maxLength !== undefined && digits.length > rule.maxLength) continue;
    return rule;
  }
  return null;
}

/** Synchronous prefix-only classification — no network, no env, no throw. */
export function classifyByPrefix(e164: string): LineClassification {
  const norm = normaliseE164(e164);
  if (!norm || !CALLER_E164_RE.test(norm)) return UNKNOWN_LINE;
  const rule = matchPrefixRule(norm.slice(1));
  if (!rule) return UNKNOWN_LINE;
  return {
    type: rule.type,
    // Structural, not an oversight: a prefix cannot tell a business line from a
    // consumer line in any plan this table covers.
    class: "unknown",
    confidence: rule.confidence,
    source: "prefix",
  };
}

/* ── The optional lookup ────────────────────────────────────────────────────── */

/**
 * Vendor response. Tolerates the field names the common providers actually use
 * and ignores every other key, because a number-enrichment vendor adding a
 * field must not be an outage here. Values are strings we re-validate; nothing
 * from this object is trusted as an enum member until it has been through
 * `toLineType` / `toLineClass`.
 */
const LookupBodySchema = z.object({
  line_type: z.string().optional(),
  lineType: z.string().optional(),
  type: z.string().optional(),
  carrier_category: z.string().optional(),
  caller_type: z.string().optional(),
});

const LINE_TYPE_ALIASES: Readonly<Record<string, LineType>> = Object.freeze({
  mobile: "mobile",
  cell: "mobile",
  cellular: "mobile",
  mobile_or_landline: "unknown",
  landline: "landline",
  fixed_line: "landline",
  fixedline: "landline",
  fixed: "landline",
  voip: "voip",
  virtual: "voip",
  toll_free: "toll_free",
  tollfree: "toll_free",
  freephone: "toll_free",
  premium: "premium",
  premium_rate: "premium",
  shared_cost: "shared_cost",
  sharedcost: "shared_cost",
  shared: "shared_cost",
  personal_number: "personal_number",
  personal: "personal_number",
});

/** Substring-matched because vendors disagree on spelling far more than on meaning. */
const BUSINESS_HINTS = ["business", "enterprise", "corporate", "organization", "organisation"];

function toLineType(value: string | undefined): LineType | null {
  if (!value) return null;
  const key = value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return LINE_TYPE_ALIASES[key] ?? null;
}

function toLineClass(values: (string | undefined)[]): LineClass {
  for (const value of values) {
    if (!value) continue;
    const key = value.trim().toLowerCase();
    if (BUSINESS_HINTS.some((hint) => key.includes(hint))) return "business";
    if (key === "consumer" || key === "residential" || key === "personal") return "consumer";
  }
  return "unknown";
}

export type LineLookupOptions = {
  /** Provider endpoint. Defaults to `LINE_TYPE_LOOKUP_URL`; unset means no lookup. */
  endpoint?: string | null;
  /** Bearer token / API key. Defaults to `LINE_TYPE_LOOKUP_TOKEN`. */
  token?: string | null;
  /** Extra headers merged over the defaults. */
  headers?: Record<string, string>;
  /** Injected fetch, so the path is testable with no network. */
  fetchImpl?: typeof fetch;
  /** Hard per-request budget. Defaults to `LINE_TYPE_LOOKUP_TIMEOUT_MS` or 1500 ms. */
  timeoutMs?: number;
};

export type ClassifyLineOptions = {
  /** Pass `null` to force the prefix table even when env configures a lookup. */
  lookup?: LineLookupOptions | null;
  /**
   * Called when a configured lookup fails, so the caller can log or alert.
   * Injected rather than logged here: this module runs inside a live call and
   * has no business owning the platform's logging policy.
   */
  onLookupFailure?: (detail: string) => void;
};

/** Default budget. Short on purpose — see the timeout note in the header. */
export const DEFAULT_LOOKUP_TIMEOUT_MS = 1_500;

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= min && raw <= max ? raw : fallback;
}

/**
 * Ask a provider. Returns `null` for EVERY failure — network error, timeout,
 * non-2xx, non-JSON body, a type string we do not recognise — so the caller
 * falls through to the prefix table instead of deciding anything on a bad
 * answer. There is no code path here that throws.
 */
async function runLookup(
  e164: string,
  opts: ClassifyLineOptions,
  lookup: LineLookupOptions,
): Promise<LineClassification | null> {
  const endpoint = lookup.endpoint?.trim() ?? "";
  if (!endpoint) return null;

  const doFetch = lookup.fetchImpl ?? fetch;
  const timeoutMs =
    lookup.timeoutMs ??
    envInt("LINE_TYPE_LOOKUP_TIMEOUT_MS", DEFAULT_LOOKUP_TIMEOUT_MS, 50, 10_000);
  const token = lookup.token ?? process.env.LINE_TYPE_LOOKUP_TOKEN ?? "";

  const signal =
    typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(timeoutMs)
      : undefined;

  const url = `${endpoint.replace(/\/+$/, "")}/v1/line-type/${encodeURIComponent(e164)}`;

  let body: unknown;
  try {
    const res = await doFetch(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(lookup.headers ?? {}),
      },
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) {
      lookupFailure(opts, `lookup responded ${res.status}`);
      return null;
    }
    body = await res.json();
  } catch (err) {
    lookupFailure(opts, err instanceof Error ? err.message : "lookup failed");
    return null;
  }

  const parsed = LookupBodySchema.safeParse(body);
  if (!parsed.success) {
    lookupFailure(opts, "lookup body did not match the expected shape");
    return null;
  }

  const type = toLineType(parsed.data.line_type ?? parsed.data.lineType ?? parsed.data.type);
  if (type === null) {
    // A provider that answers "we do not know" is not a provider outage, and
    // treating it as one would page somebody every time a number is simply
    // absent from their database. Degrade quietly to the prefix table.
    return null;
  }

  return {
    type,
    class: toLineClass([parsed.data.caller_type, parsed.data.carrier_category]),
    confidence: "high",
    source: "lookup",
  };
}

function lookupFailure(opts: ClassifyLineOptions, detail: string): void {
  try {
    opts.onLookupFailure?.(detail);
  } catch {
    // An alerting callback that throws must not take the call with it.
  }
}

/* ── The control ────────────────────────────────────────────────────────────── */

/**
 * Classify the line a caller is on.
 *
 * Order: normalise → (lookup if configured) → prefix table → unknown. Every
 * branch is total. `classifyLine` never throws and never rejects: it is called
 * while a customer is on the line, and an enrichment service having a bad day
 * must cost the caller nothing but accuracy.
 */
export async function classifyLine(
  e164: string,
  opts: ClassifyLineOptions = {},
): Promise<LineClassification> {
  const norm = normaliseE164(e164);
  if (!norm || !CALLER_E164_RE.test(norm)) return UNKNOWN_LINE;

  if (opts.lookup !== null) {
    const endpoint = opts.lookup?.endpoint ?? process.env.LINE_TYPE_LOOKUP_URL ?? null;
    if (endpoint) {
      const resolved = { ...(opts.lookup ?? {}), endpoint };
      const looked = await runLookup(norm, opts, resolved);
      if (looked) return looked;
    }
  }

  return classifyByPrefix(norm);
}

/**
 * Can we expect an SMS to reach this line type?
 *
 * FALSE for landline, toll-free, premium and shared-cost (they do not have a
 * handset to receive on), and FALSE for `"unknown"` — which is the decision
 * worth arguing for, so: an unknown number is one where we cannot assert the
 * SMS will arrive, and the failure mode this guard exists to prevent is an SMS
 * that silently delivers to nothing and is then read downstream as "the
 * customer was reached and did not object". A silent delivery and a customer
 * who ignored a warning look identical from the institution's side, and on a
 * fraud call that is exactly the confusion that lets a transfer stand.
 *
 * So an unclassifiable number does not get an SMS treated as evidence. Callers
 * who want "send it anyway, just don't rely on it" should branch on
 * `LineClassification.type` rather than on this boolean; this function answers
 * one question only — may this channel be relied upon as proof of reach?
 *
 * TRUE for mobile, VoIP and personal numbers: all three are reachable by SMS
 * in practice. VoIP being `true` is deliberate and is the honest answer even
 * though it is a fraud-over-represented type — reachability is not
 * trustworthiness, and conflating them would suppress the SMS fallback exactly
 * where a VoIP customer needs it most.
 */
export function supportsSmsConfirmation(type: LineType): boolean {
  return type === "mobile" || type === "voip" || type === "personal_number";
}

/** Is this a VoIP (internet) number? A risk signal, never a block. */
export function isVoip(type: LineType): boolean {
  return type === "voip";
}
