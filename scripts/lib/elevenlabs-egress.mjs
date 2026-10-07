/**
 * Script-side ElevenLabs egress guard.
 *
 * The app has its own guard at src/lib/elevenlabs/egress.ts. These scripts
 * cannot use it: that module is `server-only` and imports Next's config layer,
 * while `scripts/*.mjs` and `bun scripts/*.ts` run as their own process with no
 * bundler. So this file holds the same two properties that matter when a human
 * is at a terminal rather than a request is being served:
 *
 *   1. RETRY WITH BACKOFF. An operator re-running a walkthrough take used to
 *      crash on the first 429 — halfway through, after paying for the part that
 *      already rendered. A transient 5xx killed the whole run.
 *   2. A CHARACTER CEILING THAT REFUSES BEFORE THE CALL. These scripts synthesize
 *      narration for the demo video, which bills against the same 10,000
 *      characters/month as the live product. A loop that re-renders everything is
 *      the realistic way to lose the month, and it looks identical to a normal
 *      run until the quota is gone.
 *
 * SCOPE, stated rather than implied: this counter lives in a file on this
 * machine and is shared by the scripts only. It does NOT see characters spent
 * through the running app, and it is not the account's real balance. The
 * authoritative number is ElevenLabs' own usage page; the ceiling here is a
 * seatbelt against an operator mistake, not a replacement for the vendor meter.
 */
import fs from "node:fs";
import path from "node:path";

const HOST = "https://api.elevenlabs.io";
const RETRY_STATUS = new Set([429, 500, 502, 503, 504, 529]);
const BACKOFF_MS = [250, 500, 1_000, 2_000, 4_000];
const MAX_RETRY_WAIT_MS = 10_000;

/** Default monthly ceiling for script spending, leaving the app room. */
export const DEFAULT_SCRIPT_CHAR_CAP = Number(process.env.ELEVENLABS_SCRIPT_CHAR_CAP ?? 4_000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function backoffMs(attempt, rand = Math.random()) {
  const base = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
  return Math.round((base / 2) * (1.5 + rand * 0.5));
}

function retryAfterMs(header) {
  if (!header) return null;
  const secs = Number(header);
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, MAX_RETRY_WAIT_MS);
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.min(Math.max(0, date - Date.now()), MAX_RETRY_WAIT_MS);
  return null;
}

function isTransient(err) {
  if (!(err instanceof Error)) return false;
  if (err.name === "AbortError" || err.name === "TimeoutError") return true;
  const code = err.cause?.code;
  return ["ECONNRESET", "ENOTFOUND", "ECONNREFUSED", "ETIMEDOUT"].includes(code);
}

const monthKey = () => new Date().toISOString().slice(0, 7);

/**
 * Spend ledger on disk. Keyed by month so it rolls over on its own, and written
 * per call so an interrupted run cannot lose what it already paid for.
 */
export function createCharLedger({ file, cap = DEFAULT_SCRIPT_CHAR_CAP, label = "script" } = {}) {
  const statePath =
    file ?? path.join(process.cwd(), "scripts", "walkthrough", ".elevenlabs-spend.json");
  const load = () => {
    try {
      const raw = JSON.parse(fs.readFileSync(statePath, "utf8"));
      return raw.month === monthKey() ? raw : { month: monthKey(), chars: 0 };
    } catch {
      return { month: monthKey(), chars: 0 };
    }
  };

  return {
    used: () => load().chars,
    remaining: () => Math.max(0, cap - load().chars),
    /** Reserve before the call: the point is to never send the request. */
    claim(chars) {
      const state = load();
      if (state.chars + chars > cap) {
        return {
          ok: false,
          used: state.chars,
          cap,
          reason:
            `refusing to spend ${chars} chars: script ledger holds ${state.chars}/${cap} ` +
            `for ${state.month} (${label}). Raise ELEVENLABS_SCRIPT_CHAR_CAP or delete the ledger ` +
            `file if the account really has room.`,
        };
      }
      state.chars += chars;
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(statePath, JSON.stringify(state));
      return { ok: true, used: state.chars };
    },
    /** Give the reservation back when the vendor never accepted it. */
    release(chars) {
      const state = load();
      state.chars = Math.max(0, state.chars - chars);
      fs.writeFileSync(statePath, JSON.stringify(state));
    },
  };
}

/**
 * `fetch` with backoff. Returns the final Response; throws only on a
 * non-transient failure or a transport error that outlived the ladder.
 */
export async function fetchWithBackoff(
  url,
  init = {},
  { maxRetries = 3, timeoutMs = 30_000 } = {},
) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      if (RETRY_STATUS.has(res.status) && attempt < maxRetries) {
        lastErr = new Error(
          `HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`,
        );
        await sleep(retryAfterMs(res.headers.get("Retry-After")) ?? backoffMs(attempt));
        continue;
      }
      if (!res.ok) {
        // Hand back the response so the caller can decide: a 401 is not retried
        // forever, and a 422 means the payload is wrong, not the network.
        return res;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (!isTransient(err)) throw err;
      if (attempt >= maxRetries) break;
      await sleep(backoffMs(attempt));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * A guarded TTS call. Bills `text.length` against the ledger BEFORE the request
 * and releases it if the vendor rejected the call.
 */
export async function synthWithGuard({ voiceId, text, model, apiKey, outputFormat }, ledger) {
  const claim = ledger.claim(text.length);
  if (!claim.ok) throw new Error(claim.reason);

  const url =
    `${HOST}/v1/text-to-speech/${encodeURIComponent(voiceId)}` +
    (outputFormat ? `?output_format=${outputFormat}` : "");
  try {
    const res = await fetchWithBackoff(url, {
      method: "POST",
      headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        model_id: model,
        voice_settings: { stability: 0.42, similarity_boost: 0.8, style: 0.15 },
      }),
    });
    if (!res.ok) {
      throw new Error(
        `narrator TTS ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`,
      );
    }
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    // Exactly one release path: a rejected or failed call never spent anything.
    ledger.release(text.length);
    throw err;
  }
}

/** Guarded JSON call to the ElevenLabs control plane (agents, simulation). */
export async function jsonWithGuard({ pathname, method = "GET", body, apiKey }, opts = {}) {
  const res = await fetchWithBackoff(
    `${HOST}${pathname}`,
    {
      method,
      headers: {
        "xi-api-key": apiKey,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    },
    opts,
  );
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(`ElevenLabs ${method} ${pathname} ${res.status}: ${text.slice(0, 300)}`);
  }
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`ElevenLabs ${method} ${pathname}: response was not JSON`);
  }
}
