import "server-only";
/**
 * Shared ElevenLabs API egress guard.
 *
 * Every upstream call to api.elevenlabs.io runs through ONE guarded core, so a
 * call site cannot reinvent — or forget — a resilience layer. The audit that
 * produced this file found raw `fetch("https://api.elevenlabs.io/...")` in the
 * buffered TTS client, the streaming TTS route, STT, signed-url and the outbound
 * dial, with no retry, no backoff, no breaker and no account budget. A single
 * scraped loop against any of them drains the whole ElevenLabs quota.
 *
 * Layers, in the order applied:
 *   1. Per-caller egress throttle — a request-rate ceiling, so a loop is
 *      refused before it reaches the vendor.
 *   2. Monthly character budget — the account-level ceiling (10k on this tier).
 *      Reserved BEFORE dispatch and refunded when the vendor rejects the
 *      request, so a bad key or a 5xx outage does not consume the demo quota.
 *      Fail-closed: a meter that cannot be read refuses the request.
 *   3. Circuit breaker for `conversation_plane` — when ElevenLabs is gone the
 *      caller takes its declared fallback (continuity pipeline / SMS) instead of
 *      hammering a dead vendor.
 *   4. Retry with equal-jitter exponential backoff on 429/5xx and on network or
 *      timeout errors, honouring a bounded `Retry-After`. A 4xx other than 429
 *      is our bug rather than the vendor's, so it returns immediately and does
 *      not move the breaker.
 *
 * Deliberately NOT here: dry-run. Whether a call is simulated is the caller's
 * policy (the dial route, the TTS client and the stream route each decide). A
 * guard that silently short-circuits the vendor call makes every route
 * untestable and every fallback path unreachable.
 */

import { env } from "@/lib/config";
import {
  createBreaker,
  fallbackFor,
  IN_PROCESS_LIMIT_CEILING,
  type Breaker,
  withDeclaredFallback,
} from "@/lib/failures/breaker";
import { consume as consumeRateLimit } from "@/lib/ratelimit";
import { degradedMeter, type Meter, redis, sharedMeterConfigured } from "@/lib/redis";

const log = (...a: unknown[]) => console.error("[elevenlabs/egress]", ...a);

/** Base URL — overridable via ELEVENLABS_API_BASE_URL so a gateway/proxy can sit
 * in front of the vendor. Read per call so a redeploy-free config change works. */
function baseUrl(): string {
  return env.elevenLabsBaseUrl;
}

/* ── Monthly account budget (10,000 chars/month on the demo tier) ─────────── */

const thisMonth = () => new Date().toISOString().slice(0, 7);
const budgetKey = (month: string) => `elevenlabs:monthly_chars:${month}`;

/** Which counter answered: the durable one, or this process's. */
export type MeterMode = "shared" | "local";

const meterFor = (mode: MeterMode): Meter => (mode === "shared" ? redis : degradedMeter);

/**
 * Read at call time, not once at import. A ceiling frozen at import is correct
 * only while the process lives as long as the config, and it makes the boundary
 * untestable without a second process: whichever suite imports the guard first
 * fixes the number for every later one in the same registry.
 */
export const monthlyCharLimit = (): number =>
  Number(process.env.ELEVENLABS_MONTHLY_CHAR_LIMIT ?? 10_000);

/**
 * The ceiling that actually applies. On the degraded in-process meter it is
 * tightened by `IN_PROCESS_LIMIT_CEILING`, because a per-process count under-
 * reports by the number of processes and matching the shared number would admit
 * N× what the account can pay for.
 */
export function effectiveCharLimit(mode: MeterMode): number {
  const limit = monthlyCharLimit();
  if (mode === "shared" || !sharedMeterConfigured()) return limit;
  return Math.max(1, Math.floor(limit * IN_PROCESS_LIMIT_CEILING));
}

/** When the meter rolls over; the counter key expires one day after this.
 *  Exported for the arithmetic pin in the egress tests. */
export function cycleEndMs(month: string): number {
  const [y = 0, m = 0] = month.split("-").map(Number);
  // `m` is the HUMAN month (1-12) straight out of "2026-10"; Date months are
  // 0-indexed, so `m` used directly IS next month. Adding 1 again reported
  // December as the end of the October cycle (correct only in December).
  return new Date(y, m, 1).getTime();
}

export type BudgetCheck =
  | {
      ok: true;
      used: number;
      remaining: number;
      /** Which meter answered. `local` under a shared ceiling is a degraded read. */
      via: MeterMode;
      degraded: boolean;
    }
  | {
      ok: false;
      reason: "exhausted" | "meter-unavailable";
      retryAfterSec: number;
    };

/**
 * Reserve `chars` against the shared monthly budget before dispatching.
 *
 * The counter is a single INCRBY, so two concurrent syntheses cannot both read
 * the same total and both pass: a read-then-write of an absolute value loses one
 * request's chars, which against a 10k ceiling means real spend is unbounded.
 *
 * When the durable meter cannot be reached, `FALLBACKS.redis` decides what
 * happens — conservative in-process limits, logged as degraded — and the
 * in-process ceiling is deliberately tighter, because per-process counters
 * under-count by the number of processes and matching the shared number would
 * admit N× the traffic it was set to allow.
 */
export async function reserveElevenLabsChars(chars: number): Promise<BudgetCheck> {
  const amount = Math.max(0, Math.trunc(chars));
  if (amount === 0) {
    return {
      ok: true,
      used: 0,
      remaining: monthlyCharLimit(),
      via: redis.mode(),
      degraded: false,
    };
  }

  const month = thisMonth();
  const key = budgetKey(month);

  let used: number;
  let via: MeterMode = redis.mode();
  try {
    used = await redis.incrBy(key, amount);
  } catch (err) {
    if (!sharedMeterConfigured()) {
      // No durable meter was configured, so the in-process count IS the whole
      // truth for this instance. A failure here is a bug, not an outage.
      log("local budget meter failed, refusing:", err instanceof Error ? err.message : err);
      return {
        ok: false,
        reason: "meter-unavailable",
        retryAfterSec: fallbackFor("redis").retryAfterSec,
      };
    }
    log(
      "shared meter unreachable, degrading to in-process limits:",
      err instanceof Error ? err.message : err,
    );
    via = "local";
    try {
      used = await degradedMeter.incrBy(key, amount);
    } catch (err2) {
      log("degraded meter failed, refusing:", err2 instanceof Error ? err2.message : err2);
      return {
        ok: false,
        reason: "meter-unavailable",
        retryAfterSec: fallbackFor("redis").retryAfterSec,
      };
    }
  }

  const degraded = via === "local" && sharedMeterConfigured();
  const limit = effectiveCharLimit(via);

  if (used > limit) {
    await meterFor(via)
      .decrBy(key, amount)
      .catch(() => undefined);
    const retryAfterSec = Math.max(1, Math.ceil((cycleEndMs(month) - Date.now()) / 1000));
    return { ok: false, reason: "exhausted", retryAfterSec };
  }

  await meterFor(via)
    .expire(key, Math.max(60, Math.ceil((cycleEndMs(month) - Date.now()) / 1000) + 86_400))
    .catch(() => undefined);
  return { ok: true, used, remaining: limit - used, via, degraded };
}

/**
 * Give chars back. `via` must be the meter the reservation was taken from —
 * releasing against the other one leaves the real counter too high and the
 * stand-in too low, which is worse than not releasing at all.
 */
export async function releaseElevenLabsChars(
  chars: number,
  via: MeterMode = redis.mode(),
): Promise<void> {
  const amount = Math.max(0, Math.trunc(chars));
  if (amount === 0) return;
  await meterFor(via)
    .decrBy(budgetKey(thisMonth()), amount)
    .catch(() => undefined);
}

/* ── Circuit breaker ───────────────────────────────────────────────────────── */

const elevenLabsBreaker: Breaker = createBreaker("conversation_plane", {
  failureThreshold: 5,
  openMs: 15_000,
  halfOpenProbes: 1,
});

/* ── Egress throttle ───────────────────────────────────────────────────────── */

/**
 * Requests per hour allowed to reach ElevenLabs for one caller. Sized to a
 * human session or an operator-run script; a scrape loop exceeds it immediately
 * and is refused without spending anything. Read per call, as above.
 */
export const egressPerHour = (): number => Number(process.env.ELEVENLABS_EGRESS_PER_HOUR ?? 120);

/**
 * Has the operator attested that this deployment is entitled to use the vendor
 * account commercially? Read per call, like the ceilings above.
 */
export const commercialUseAttested = (): boolean =>
  process.env.ELEVENLABS_COMMERCIAL_USE === "true";

/* ── Retry ladder ──────────────────────────────────────────────────────────── */

const RETRY_STATUS = new Set([429, 500, 502, 503, 504, 529]);
/** Base ladder mirrors src/lib/outbox.ts. Overridable via ELEVENLABS_BACKOFF_MS as a
 * comma-separated list of millisecond steps. */
const BACKOFF_MS = ((): readonly number[] => {
  const raw = process.env.ELEVENLABS_BACKOFF_MS;
  if (raw) {
    const parsed = raw.split(",").map((s) => Number(s.trim()));
    if (parsed.every((n) => Number.isFinite(n) && n > 0)) return parsed as readonly number[];
  }
  return [250, 500, 1_000, 2_000, 4_000, 8_000] as const;
})();
const DEFAULT_MAX_RETRIES = Number(process.env.ELEVENLABS_MAX_RETRIES) || 2;
/** A hostile or misconfigured `Retry-After` must not park a request for ever. */
const MAX_RETRY_WAIT_MS = Number(process.env.ELEVENLABS_MAX_RETRY_WAIT_MS) || 10_000;

/** Equal jitter: half the step is fixed, half is random. */
export function backoffMs(attempt: number, rand: number = Math.random()): number {
  const base = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]!;
  return Math.round((base / 2) * (1 + 0.5 + rand * 0.5));
}

/** `Retry-After` as milliseconds, clamped to a wait the caller can honour. */
function retryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const secs = Number(header);
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, MAX_RETRY_WAIT_MS);
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.min(Math.max(0, date - Date.now()), MAX_RETRY_WAIT_MS);
  return null;
}

/** Errors meaning "the vendor was unreachable", and so worth retrying. */
function isTransient(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "AbortError" || err.name === "TimeoutError") return true;
  const code = (err as { cause?: { code?: unknown } }).cause?.code;
  return (
    code === "ECONNRESET" || code === "ENOTFOUND" || code === "ECONNREFUSED" || code === "ETIMEDOUT"
  );
}

/* ── Result types ──────────────────────────────────────────────────────────── */

export type EgressError = {
  /** Upstream status, or a synthesized 429/503 for a guard-side refusal. */
  status: number;
  retryable: boolean;
  /** Raw vendor text, truncated. Guard refusals carry their own reason. */
  body: string;
  /** Present when the budget or the throttle stopped the request. */
  retryAfterSec?: number;
  quotaExhausted?: boolean;
};

export type EgressResult<T> =
  { ok: true; data: T } | { ok: false; error: EgressError; breakerOpen: boolean };

/** Binary/multipart result: success carries the live, unread Response. */
export type BinaryUpstreamResult =
  | { ok: true; response: Response }
  | { ok: false; status: number; retryable: boolean; body: string; breakerOpen: boolean };

/** Thrown out of the guarded call once the vendor stayed unavailable. */
class VendorUnavailable extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`ElevenLabs unavailable (${status})`);
    this.name = "VendorUnavailable";
  }
}

type GuardOutcome =
  | { kind: "refusal"; error: EgressError }
  | { kind: "answered"; status: number; ok: boolean; bodyText: string; response?: Response }
  | { kind: "unreachable"; status: number; body: string; breakerOpen: boolean };

type RequestOptions = {
  path: string;
  method: "GET" | "POST" | "PATCH" | "PUT";
  /** Billable input length for the monthly budget; 0 for non-TTS endpoints. */
  billableChars: number;
  /** Resolved key. Callers pass their BYOK key here; it is never overwritten. */
  apiKey?: string;
  /** Identity the throttle is keyed on. */
  callerId?: string;
  headers?: Record<string, string>;
  body?: unknown;
  /** Send the body as-is instead of JSON-encoding it (multipart / form). */
  rawBody?: BodyInit;
  accept?: string;
  timeoutMs?: number;
  maxRetries?: number;
  /** Keep the Response for streaming instead of draining it to text. */
  keepResponse?: boolean;
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/* ── The guarded core ──────────────────────────────────────────────────────── */

/**
 * Throttle → budget → breaker → retry, in one place, shared by the JSON and
 * binary surfaces. This is the only code in the repo that opens a socket to
 * ElevenLabs.
 */
async function guardedRequest(o: RequestOptions): Promise<GuardOutcome> {
  const callerId = o.callerId ?? "platform";
  const timeoutMs = o.timeoutMs ?? env.ttsTimeoutMs;
  const maxRetries = o.maxRetries ?? DEFAULT_MAX_RETRIES;
  const apiKey = o.apiKey ?? env.elevenLabsApiKey;

  if (!apiKey) {
    return {
      kind: "refusal",
      error: { status: 503, retryable: false, body: "no ElevenLabs API key configured" },
    };
  }

  // ElevenLabs Terms §1(c)(i) restricts a Free User to NON-COMMERCIAL use, and
  // PUP §9(a) lists commercial use on a free account as prohibited. A bank
  // fraud-intervention pilot is commercial. Without this guard the only thing
  // standing between a demo and a terms breach is someone remembering to
  // upgrade, so the attestation is required here, on the one path every live
  // vendor call takes.
  if (!commercialUseAttested()) {
    return {
      kind: "refusal",
      error: {
        status: 403,
        retryable: false,
        body:
          "live ElevenLabs calls require ELEVENLABS_COMMERCIAL_USE=true; the free tier permits " +
          "non-commercial use only (ToS §1(c)(i), PUP §9(a))",
      },
    };
  }

  // 1. Throttle — before any spend, so a loop costs nothing but a refusal.
  const rl = consumeRateLimit("elevenlabs-egress", callerId, 1, egressPerHour());
  if (!rl.ok) {
    return {
      kind: "refusal",
      error: {
        status: 429,
        retryable: true,
        body: "ElevenLabs egress throttle exceeded",
        retryAfterSec: Math.max(1, Math.ceil(rl.retryAfterMs / 1000)),
      },
    };
  }

  // 2. Monthly budget.
  const reserved = Math.max(0, Math.trunc(o.billableChars));
  const budget = await reserveElevenLabsChars(reserved);
  if (!budget.ok) {
    return {
      kind: "refusal",
      error: {
        status: 429,
        retryable: budget.reason === "exhausted",
        body:
          budget.reason === "exhausted"
            ? `ElevenLabs monthly character budget exhausted (${monthlyCharLimit()}/month)`
            : "ElevenLabs usage meter unavailable",
        retryAfterSec: budget.retryAfterSec,
        quotaExhausted: budget.reason === "exhausted",
      },
    };
  }
  if (budget.degraded) {
    log(
      `degraded: in-process budget limit active (ceiling ${IN_PROCESS_LIMIT_CEILING} of ${monthlyCharLimit()})`,
    );
  }

  // Nothing was synthesised on these paths, so give the reservation back. Every
  // non-success exit below calls it; the flag keeps that to once. The release
  // goes back through the SAME meter the reservation came from.
  let released = false;
  const refund = () => {
    if (released || reserved === 0) return;
    released = true;
    void releaseElevenLabsChars(reserved, budget.via);
  };

  const headers: Record<string, string> = {
    accept: o.accept ?? "application/json",
    ...(o.body !== undefined ? { "content-type": "application/json" } : {}),
    "xi-api-key": apiKey,
    ...o.headers,
  };

  // A throw that is not a vendor outage is our bug; keep its message rather than
  // let the fallback relabel it as "vendor unavailable".
  let programmerError: string | null = null;
  // The vendor's own verdict at exhaustion, so the fallback can report it. A
  // caller publishing `ElevenLabs ${status}: ${detail}` needs the real status
  // and the real body, not a flattened 503.
  let outage: { status: number; body: string } | null = null;

  // 3. Breaker, 4. retry. The whole ladder is INSIDE the guarded call, so one
  // caller request moves the breaker by one — not by its attempt count.
  const outcome = await withDeclaredFallback<GuardOutcome>(
    elevenLabsBreaker,
    async (): Promise<GuardOutcome> => {
      let last = { status: 0, body: "no attempt" };
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const res = await fetch(`${baseUrl()}${o.path}`, {
            method: o.method,
            headers,
            body: o.rawBody ?? (o.body !== undefined ? JSON.stringify(o.body) : undefined),
            signal: controller.signal,
          });

          if (RETRY_STATUS.has(res.status) && attempt < maxRetries) {
            last = { status: res.status, body: (await res.text().catch(() => "")).slice(0, 300) };
            await sleep(retryAfterMs(res.headers.get("Retry-After")) ?? backoffMs(attempt));
            continue;
          }

          if (!res.ok) {
            const txt = await res.text().catch(() => "");
            refund();
            // A 5xx/429 that survived the whole ladder is a vendor outage: throw
            // so the breaker records it. A 4xx is our bad request — the vendor
            // answered correctly, so it returns and must not open the breaker.
            if (RETRY_STATUS.has(res.status)) {
              outage = { status: res.status, body: txt.slice(0, 300) };
              throw new VendorUnavailable(res.status, txt.slice(0, 300));
            }
            return { kind: "answered", status: res.status, ok: false, bodyText: txt.slice(0, 300) };
          }

          if (o.keepResponse) {
            return { kind: "answered", status: res.status, ok: true, bodyText: "", response: res };
          }
          return {
            kind: "answered",
            status: res.status,
            ok: true,
            bodyText: await res.text().catch(() => ""),
          };
        } catch (err) {
          if (!isTransient(err)) {
            programmerError = err instanceof Error ? err.message : String(err);
            throw err;
          }
          last = {
            status: 0,
            body: err instanceof Error ? err.message.slice(0, 300) : "network error",
          };
          if (attempt >= maxRetries) break;
          await sleep(backoffMs(attempt));
        } finally {
          clearTimeout(timer);
        }
      }
      // Retries exhausted: throw so the breaker records the outage, and give the
      // reservation back — nothing came out of the vendor. `last.status` stays 0
      // for a transport failure; `elevenLabsStt` reads that to decide whether a
      // partially-uploaded recording is worth re-sending.
      refund();
      outage = last;
      throw new VendorUnavailable(last.status, last.body || "ElevenLabs request failed");
    },
    {
      fallback: () => {
        refund();
        log("breaker refused:", fallbackFor("conversation_plane").declared);
        return {
          kind: "unreachable",
          // Report the vendor's own verdict when we have one; 503 only when the
          // breaker refused before a request was ever made. A non-transient throw
          // is our bug, and gets a 502 with its own message.
          status: outage?.status ?? (programmerError ? 502 : 503),
          body: outage?.body ?? programmerError ?? "vendor unavailable",
          breakerOpen: true,
        } satisfies GuardOutcome;
      },
    },
  );

  if (outcome.value) return outcome.value;

  // `value` is null only when the breaker swallowed a throw that `isFailure`
  // classified as a success — this call never passes one, so it is unreachable
  // and reported as an outage rather than silently as a 200.
  if (programmerError) log("unexpected egress error:", programmerError);
  return {
    kind: "unreachable",
    status: 503,
    body: programmerError ?? "vendor unavailable",
    breakerOpen: outcome.wasProbe || elevenLabsBreaker.state() === "open",
  };
}

/* ── Public surfaces ───────────────────────────────────────────────────────── */

/**
 * JSON egress. `ok: true` means the vendor returned 2xx. Every other outcome —
 * 4xx, 5xx after retries, an open breaker, a throttle, an exhausted budget — is
 * `ok: false` with a typed status, so a caller can never mistake a failed
 * upstream for an empty-but-successful payload.
 */
export async function elevenLabsFetch<T = unknown>(opts: {
  path: string;
  billableChars: number;
  method?: "GET" | "POST" | "PATCH" | "PUT";
  body?: unknown;
  apiKey?: string;
  callerId?: string;
  timeoutMs?: number;
  maxRetries?: number;
}): Promise<EgressResult<T>> {
  const guard = await guardedRequest({ ...opts, method: opts.method ?? "GET" });

  if (guard.kind === "refusal") return { ok: false, error: guard.error, breakerOpen: false };
  if (guard.kind === "unreachable") {
    return {
      ok: false,
      // 0 means "no HTTP status at all" (socket level). A caller publishing an
      // HTTP response cannot use it, so it surfaces as the equivalent 502 while
      // the binary surface keeps the 0 for `elevenLabsStt`'s re-upload decision.
      error: { status: guard.status || 502, retryable: true, body: guard.body },
      breakerOpen: guard.breakerOpen,
    };
  }
  if (!guard.ok) {
    return {
      ok: false,
      error: { status: guard.status, retryable: false, body: guard.bodyText },
      breakerOpen: false,
    };
  }
  try {
    return { ok: true, data: (guard.bodyText ? JSON.parse(guard.bodyText) : {}) as T };
  } catch {
    return {
      ok: false,
      error: { status: 502, retryable: false, body: "ElevenLabs returned a non-JSON body" },
      breakerOpen: false,
    };
  }
}

/**
 * Binary egress for TTS audio and STT multipart. Same layers; success hands
 * back the live Response so the streaming route can pipe it untouched.
 */
export async function fetchUpstreamBinary(
  method: "GET" | "POST",
  path: string,
  init: {
    headers?: Record<string, string>;
    body?: BodyInit;
    /** Input length to bill; the TTS surfaces pass the synthesis text length. */
    billableChars?: number;
    apiKey?: string;
    callerId?: string;
    accept?: string;
    timeoutMs?: number;
    maxRetries?: number;
  } = {},
): Promise<BinaryUpstreamResult> {
  const guard = await guardedRequest({
    path,
    method,
    billableChars: init.billableChars ?? 0,
    apiKey: init.apiKey,
    callerId: init.callerId,
    headers: init.headers,
    rawBody: init.body,
    accept: init.accept ?? "audio/mpeg",
    timeoutMs: init.timeoutMs,
    maxRetries: init.maxRetries,
    keepResponse: true,
  });

  if (guard.kind === "refusal") {
    return {
      ok: false,
      status: guard.error.status,
      retryable: guard.error.retryable,
      body: guard.error.body,
      breakerOpen: false,
    };
  }
  if (guard.kind === "unreachable") {
    return {
      ok: false,
      status: guard.status,
      retryable: true,
      body: guard.body,
      breakerOpen: guard.breakerOpen,
    };
  }
  if (!guard.ok) {
    return {
      ok: false,
      status: guard.status,
      retryable: false,
      body: guard.bodyText,
      breakerOpen: false,
    };
  }
  return { ok: true, response: guard.response as Response };
}

/**
 * STT helper. A multipart body cannot be re-sent once its stream is consumed, so
 * the form is rebuilt per outer attempt; `fetchUpstreamBinary` owns the 429/5xx
 * ladder. The outer loop only covers a mid-upload abort.
 */
export async function elevenLabsStt(
  audio: Buffer,
  mime: string,
  model: string,
  opts: { callerId?: string; maxRetries?: number } = {},
): Promise<BinaryUpstreamResult> {
  const outerMax = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  let last: BinaryUpstreamResult | null = null;
  for (let attempt = 0; attempt <= outerMax; attempt++) {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(audio)], { type: mime }), "recording");
    form.append("model_id", model);
    last = await fetchUpstreamBinary("POST", "/v1/speech-to-text", {
      body: form,
      accept: "application/json",
      billableChars: 0,
      callerId: opts.callerId,
      timeoutMs: 30_000,
      maxRetries: attempt === 0 ? DEFAULT_MAX_RETRIES : 0,
    });
    // Only a transport-level failure (status 0) is worth re-uploading for.
    if (last.ok || last.status !== 0) return last;
    await sleep(backoffMs(attempt));
  }
  return (
    last ?? {
      ok: false,
      status: 503,
      retryable: true,
      body: "vendor unavailable",
      breakerOpen: false,
    }
  );
}

/** Exposed for the breaker gate and instrumentation. */
export { elevenLabsBreaker };

/**
 * Reset the guard's in-process state. Suites that drive several vendor failures
 * through one module instance need this, or the fifth failure opens the breaker
 * for every later test in the file.
 */
export function _resetEgressForTest(): void {
  elevenLabsBreaker.reset();
  redis._reset();
}
