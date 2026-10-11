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
 * Friday's Dhuhr is Jumu'ah: a congregation, not a pause at a desk. The whole
 * observance runs longer than any other prayer's window, so the block runs an
 * hour from the prayer time rather than the 25 minutes every other prayer gets.
 */
const JUMUAH_WINDOW = { before: 10, after: 50 } as const;

let cachedTimings: PrayerTimings | null = null;
let cachedDate = "";

export async function isWithinPrayerWindow(region: string): Promise<boolean> {
  if (region !== "UAE") return false;

  const now = new Date();
  const dateKey = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
  if (cachedDate !== dateKey || !cachedTimings) {
    const url = new URL("https://api.aladhan.com/v1/timingsByCity");
    url.searchParams.set("city", "Dubai");
    url.searchParams.set("country", "AE");
    url.searchParams.set("method", String(UAE_METHOD));
    url.searchParams.set("date", dateKey);

    const res = await fetch(url.toString());
    if (!res.ok) return false;
    const json = (await res.json()) as { data: { timings: PrayerTimings } };
    cachedTimings = json.data.timings;
    cachedDate = dateKey;
  }

  if (!cachedTimings) return false;

  return prayerWindowContains(cachedTimings, now);
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
