import "server-only";

const UAE_METHOD = 2; // General Authority of Islamic Affairs and Endowments

type PrayerTimings = Record<string, string>;

/**
 * How long either side of a prayer time a ROUTINE call must not be placed.
 *
 * Measured from the prayer time the Aladhan response carries, in local Dubai
 * minutes. A time-critical fraud verification is exempt — `compliance/gate.ts`
 * only consults this for non-critical categories — so these windows never stand
 * between a customer and a freeze.
 */
const PRAYER_WINDOW = { before: 10, after: 15 } as const;

/**
 * The ONE region this policy consults, shared by both halves of the gate.
 *
 * `Organization.region` (prisma/schema.prisma:909, `UAE|GCC|MENA|OTHER`) exists
 * and is read for display only, so a per-tenant geography here would be a story
 * the ingest gate tells and the dial worker ignores: a GCC tenant refused at
 * ingest by a hardcoded "UAE" and then dialled into the same window at claim time
 * is worse than one honest assumption in one place. Per-tenant prayer timing is
 * a real gap and stays named — see `docs/TODO.md` — rather than half-implemented.
 */
export const PRAYER_GATE_REGION = "UAE";

/**
 * Friday's Dhuhr is Jumu'ah: a congregation, not a pause at a desk. The whole
 * observance runs longer than any other prayer's window, so the block runs an
 * hour from the prayer time rather than the 25 minutes every other prayer gets.
 */
const JUMUAH_WINDOW = { before: 10, after: 50 } as const;

let cachedTimings: PrayerTimings | null = null;
let cachedDate = "";

/**
 * Today's timings, from the cache or from Aladhan.
 *
 * Null means "we do not know" — a non-UAE region, a failed fetch, or a response
 * with no usable body. Both callers below treat that as NO WINDOW rather than as
 * a block, which is the existing posture of this module: the prayer gate is a
 * courtesy that must never become the reason a fraud verification did not happen,
 * and an outage at a third-party API must not silently stop every routine call.
 */
async function loadTimings(region: string, now: Date): Promise<PrayerTimings | null> {
  if (region !== "UAE") return null;

  const dateKey = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
  if (cachedDate === dateKey && cachedTimings) return cachedTimings;

  const url = new URL("https://api.aladhan.com/v1/timingsByCity");
  url.searchParams.set("city", "Dubai");
  url.searchParams.set("country", "AE");
  url.searchParams.set("method", String(UAE_METHOD));
  url.searchParams.set("date", dateKey);

  try {
    const res = await fetch(url.toString());
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: { timings?: PrayerTimings } };
    if (!json.data?.timings) return null;
    cachedTimings = json.data.timings;
    cachedDate = dateKey;
  } catch {
    return null;
  }

  return cachedTimings;
}

export async function isWithinPrayerWindow(region: string): Promise<boolean> {
  const timings = await loadTimings(region, new Date());
  if (!timings) return false;
  return prayerWindowContains(timings, new Date());
}

/**
 * How long to wait before the CURRENT prayer window is clear, in milliseconds.
 *
 * This exists for the DIAL worker. `isWithinPrayerWindow` answers "may we call
 * now", which is enough at ingest where the answer is a 409, but a job that is
 * already queued needs a WAKE TIME — otherwise the retry ladder fires at 15 s,
 * 30 s and 60 s into the middle of the same congregation, burns the attempts, and
 * dead-letters a routine reminder that only needed ten more minutes.
 *
 * Null when no window is active. The caller adds its own floor, because a
 * zero-millisecond "defer" is a busy loop.
 */
export async function prayerDeferralMs(
  region: string,
  now: Date = new Date(),
): Promise<number | null> {
  const timings = await loadTimings(region, now);
  if (!timings) return null;
  return prayerWindowEndsInMs(timings, now);
}

/**
 * The pure half of `prayerDeferralMs`, exported so the Friday branch is testable
 * without waiting for a Friday: it reads the same two window tables
 * `prayerWindowContains` decides with, so a deferral can never be computed against
 * a window the check itself does not use.
 */
export function prayerWindowEndsInMs(timings: PrayerTimings, now: Date): number | null {
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  let latestEnd: number | null = null;

  for (const prayer of ["Fajr", "Dhuhr", "Asr", "Maghrib", "Isha"]) {
    const raw = timings[prayer];
    if (!raw) continue;
    const prayerTime = toMinutes(raw);
    const window = prayer === "Dhuhr" && now.getDay() === 5 ? JUMUAH_WINDOW : PRAYER_WINDOW;
    const end = prayerTime + window.after;
    if (currentMinutes >= prayerTime - window.before && currentMinutes <= end) {
      // The LATEST end, not the first match: overlapping windows (an early Maghrib
      // near Isha) must not wake the job into the second one.
      if (latestEnd === null || end > latestEnd) latestEnd = end;
    }
  }

  if (latestEnd === null) return null;
  // +1 minute past the end, so the wake-up lands strictly outside the window
  // rather than on its last minute, where the check would still say no.
  return (latestEnd - currentMinutes + 1) * 60_000;
}

/**
 * The window decision itself, given a timings object and a moment.
 *
 * Split out and exported because the thing worth proving here is a branch that
 * depends on what day of the week it is: folding it into the network-caching
 * function above would mean either waiting for Friday or asserting nothing at
 * all. The Friday branch used to read `if (Dhuhr && isFriday) return true;
 * return true;` — two identical outcomes, so the longer observance was a comment
 * rather than a behaviour, and a routine call could still be placed into the
 * congregation for the 35 minutes after the prayer ended.
 */
export function prayerWindowContains(timings: PrayerTimings, now: Date): boolean {
  const currentMinutes = now.getHours() * 60 + now.getMinutes();

  for (const prayer of ["Fajr", "Dhuhr", "Asr", "Maghrib", "Isha"]) {
    const raw = timings[prayer];
    if (!raw) continue;
    const prayerTime = toMinutes(raw);
    const window = prayer === "Dhuhr" && now.getDay() === 5 ? JUMUAH_WINDOW : PRAYER_WINDOW;
    if (
      currentMinutes >= prayerTime - window.before &&
      currentMinutes <= prayerTime + window.after
    ) {
      return true;
    }
  }

  return false;
}

function toMinutes(value: string): number {
  const [h, m] = value.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}
