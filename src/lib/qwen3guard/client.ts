import "server-only";
/**
 * The Qwen3Guard-Gen HTTP client — the ONLY module that talks to the
 * moderation gateway.
 *
 * Design constraints, each of which exists because of a real failure mode:
 *
 *  - **Single chokepoint.** Every moderation call goes through `classify()`,
 *    so the timeout, the retry budget, the concurrency cap and the breaker are
 *    deployment properties, not per-call-site decisions. A second fetch to the
 *    gateway anywhere else is a bug.
 *  - **The gateway is NOT trusted.** It is an OpenAI-compatible service that
 *    can return garbage, lie about success, rate-limit, or vanish. Everything
 *    it says is parsed by `parseVerdict` (template.ts) and unreadable output
 *    becomes `invalid`, never Safe.
 *  - **Bounded concurrency.** The OVH Kepler gateway rate-limits aggressively
 *    (observed live: consecutive back-to-back calls 429). A semaphore of
 *    `QWEN3GUARD_CONCURRENCY` (default 2) keeps burst load off the provider
 *    instead of turning every call into a retry storm.
 *  - **Breaker, not endurance.** After `failureThreshold` consecutive
 *    transport failures the `moderation` breaker opens and callers get the
 *    declared fallback ("deterministic guard layer answers; never recorded as
 *    Safe") instead of a per-request timeout tax on a dead endpoint.
 *
 * The breaker is created lazily so that importing this module never touches
 * config-dependent state before the environment is loaded (the same discipline
 * `src/lib/llm.ts` follows for its breaker).
 */

import { env } from "@/lib/config";
import { createBreaker, type Breaker } from "@/lib/failures/breaker";
import { logError, logWarn } from "@/lib/validation/safe-log";
import type { ModerationMessage } from "./template";

/* ── The moderation breaker ──────────────────────────────────────────────── */

let breaker: Breaker | null = null;

function moderationBreaker(): Breaker {
  if (!breaker) {
    breaker = createBreaker("moderation", {
      // The gateway rate-limits; a couple of 429s in a burst is normal and the
      // retry layer absorbs them. Only sustained transport-level failure (5
      // consecutive) should open the breaker.
      failureThreshold: 5,
      successThreshold: 2,
      halfOpenProbes: 1,
    });
  }
  return breaker;
}

/** Live breaker view for /api/readyz and the operator console. */
export function moderationBreakerState(): ReturnType<Breaker["snapshot"]> {
  return moderationBreaker().snapshot();
}

export function resetModerationBreakerForTests(): void {
  moderationBreaker().reset();
}

/* ── Bounded concurrency ─────────────────────────────────────────────────── */

let semaphore: { limit: number; inFlight: number; queue: (() => void)[] } | null = null;

function getSemaphore(): { limit: number; inFlight: number; queue: (() => void)[] } {
  if (!semaphore) {
    const limit = Math.max(1, env.qwen3guardConcurrency);
    semaphore = { limit, inFlight: 0, queue: [] };
  }
  return semaphore;
}

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  const sem = getSemaphore();
  if (sem.inFlight >= sem.limit) {
    await new Promise<void>((resolve) => sem.queue.push(resolve));
  }
  sem.inFlight++;
  try {
    return await fn();
  } finally {
    sem.inFlight--;
    const next = sem.queue.shift();
    if (next) next();
  }
}

/* ── Classification ──────────────────────────────────────────────────────── */

export class ModerationTransportError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ModerationTransportError";
  }
}

type Classification = {
  text: string;
  model: string;
  promptTokens?: number;
  completionTokens?: number;
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * One classification round-trip, breaker-governed, concurrency-capped,
 * retry-budgeted.
 *
 * Retries ONLY on 429 and 5xx — the classes where a second attempt can
 * succeed without re-sending meaningfully different work. 4xx responses other
 * than 429 are configuration or payload errors; retrying them is how a retry
 * budget is burned on an answer that will never change.
 *
 * On transport failure the breaker records it. When the breaker is OPEN, this
 * function throws `ModerationTransportError` immediately with the declared
 * fallback's Retry-After, so the caller degrades in microseconds rather than
 * waiting out a timeout.
 */
export async function classify(messages: ModerationMessage[]): Promise<Classification> {
  const b = moderationBreaker();
  const permit = b.permit();
  if (!permit.allowed) {
    throw new ModerationTransportError(
      `moderation breaker ${permit.state}: ${permit.fallback?.declared ?? "unavailable"}`,
      503,
      (permit.fallback?.retryAfterSec ?? 10) * 1_000,
    );
  }

  const url = `${env.qwen3guardBaseUrl.replace(/\/$/, "")}/chat/completions`;
  const model = env.qwen3guardModel;
  const timeoutMs = env.qwen3guardTimeoutMs;
  const maxAttempts = 1 + env.qwen3guardRetries;
  const apiKey = env.qwen3guardApiKey;

  try {
    return await withSlot(async () => {
      let lastError: ModerationTransportError | null = null;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const res = await fetch(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
            },
            body: JSON.stringify({
              model,
              messages,
              max_tokens: 128,
              temperature: 0,
            }),
            signal: controller.signal,
          });

          if (res.ok) {
            const body = (await res.json()) as {
              choices?: { message?: { content?: string } }[];
              usage?: { prompt_tokens?: number; completion_tokens?: number };
              model?: string;
            };
            const text = body.choices?.[0]?.message?.content;
            if (typeof text !== "string" || text.length === 0) {
              // A 200 with no content is malformed at the protocol level; do
              // not retry it (the answer will not change), do not accept it.
              // Status 400 semantics: the catch re-throws non-retryable
              // statuses untouched.
              b.recordFailure();
              throw new ModerationTransportError("moderation gateway returned no content", 400);
            }
            b.recordSuccess();
            return {
              text,
              model: body.model ?? model,
              promptTokens: body.usage?.prompt_tokens,
              completionTokens: body.usage?.completion_tokens,
            };
          }

          const retryAfterMs = Number(res.headers.get("retry-after")) * 1_000;
          const err = new ModerationTransportError(
            `moderation gateway HTTP ${res.status}`,
            res.status,
            Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : undefined,
          );
          // Rate limiting and server-side faults are retryable; auth/config
          // errors are not.
          if (res.status !== 429 && res.status < 500) {
            b.recordFailure();
            throw err;
          }
          lastError = err;
        } catch (err) {
          if (
            err instanceof ModerationTransportError &&
            err.status &&
            err.status < 500 &&
            err.status !== 429
          ) {
            throw err;
          }
          lastError =
            err instanceof ModerationTransportError
              ? err
              : new ModerationTransportError(
                  `moderation gateway unreachable: ${err instanceof Error ? err.message : String(err)}`,
                );
        } finally {
          clearTimeout(timer);
        }

        if (attempt < maxAttempts) {
          // Exponential backoff with jitter, honouring Retry-After when the
          // gateway sent one, capped so a caller's own budget still applies.
          const base = lastError.retryAfterMs ?? 250 * 2 ** (attempt - 1);
          const jitter = Math.floor(Math.random() * 100);
          await sleep(Math.min(base + jitter, 2_000));
        }
      }

      b.recordFailure();
      throw lastError ?? new ModerationTransportError("moderation gateway failed");
    });
  } catch (err) {
    if (
      !(err instanceof ModerationTransportError) ||
      (err.status && err.status < 500 && err.status !== 429)
    ) {
      b.recordFailure();
    }
    logWarn("[moderation] classify failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/**
 * Warm the gateway: one tiny classification so the first real moderation of a
 * live call does not pay cold-path latency. Best-effort — a warm-up failure is
 * logged, never thrown, because a deployment that cannot reach the gateway
 * will find out from its health checks, not from a crash at boot.
 */
export async function warmUpModerator(): Promise<boolean> {
  try {
    await classify([{ role: "user", content: "Hello" }]);
    return true;
  } catch (err) {
    logError("[moderation] warm-up failed (the breaker will record sustained failure)", {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
