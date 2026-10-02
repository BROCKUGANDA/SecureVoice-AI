/**
 * The child-process half of the AA-1.3 timezone gate.
 *
 * Run once per hostile TZ by `tz-safety.test.ts`, which sets `TZ` in this
 * process's environment BEFORE exec — because `TZ` is consumed by the C runtime
 * at process start and cannot be changed reliably afterwards.
 *
 * Emits one JSON object on stdout and nothing else, so the parent can compare
 * values across zones directly.
 *
 * Deliberately touches the three places where a timezone bug would actually
 * appear in this codebase: the budget-window day boundary, the daily TTS quota
 * key, and the audit-chain timestamp.
 */
import { windowBounds } from "@/lib/billing/breaker";

/**
 * A fixed instant, 23:40 UTC — deliberately close to midnight, because that is
 * where a local-time implementation and a UTC implementation disagree most.
 * Chosen as an absolute instant so every zone sees the SAME moment.
 */
const PROBE_INSTANT = Date.UTC(2026, 2, 14, 23, 40, 0);

/** The audit timestamp format the chain actually writes. */
const isoNow = (d: Date): string => d.toISOString();

const dailyStart = new Date(PROBE_INSTANT);
const daily = windowBounds("daily", dailyStart);
const hourly = windowBounds("hourly", dailyStart);

// The daily TTS quota key is `toISOString().slice(0, 10)` in src/lib/tts-quota.ts.
const quotaKey = isoNow(dailyStart).slice(0, 10);

process.stdout.write(
  JSON.stringify({
    tz: process.env.TZ ?? null,
    // Epoch ms are timezone-independent BY CONSTRUCTION. If these ever differ,
    // something is formatting a wall-clock time into a stored value.
    probeInstant: PROBE_INSTANT,
    isoTimestamp: isoNow(dailyStart),
    quotaKey,
    dailyWindowStartMs: daily.start.getTime(),
    dailyWindowEndMs: daily.end.getTime(),
    hourlyWindowStartMs: hourly.start.getTime(),
    hourlyWindowEndMs: hourly.end.getTime(),
    // Pure local-time readings, which MUST differ per zone. These are asserted to
    // be present so the harness is proven to be actually changing the zone: if
    // these were identical everywhere, TZ never took effect and every other
    // assertion in the parent would be vacuous.
    localHour: dailyStart.getHours(),
    localDayOfMonth: dailyStart.getDate(),
    localOffsetMinutes: -dailyStart.getTimezoneOffset(),
  }),
);