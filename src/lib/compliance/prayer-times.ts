import "server-only";

const UAE_METHOD = 2; // General Authority of Islamic Affairs and Endowments

type PrayerTimings = Record<string, string>;

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

  const timings = cachedTimings;
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const prayers = ["Fajr", "Dhuhr", "Asr", "Maghrib", "Isha"];

  for (const prayer of prayers) {
    const raw = timings[prayer];
    if (!raw) continue;
    const prayerTime = toMinutes(raw);
    if (currentMinutes >= prayerTime - 10 && currentMinutes <= prayerTime + 15) {
      if (prayer === "Dhuhr" && now.getDay() === 5) {
        return true;
      }
      return true;
    }
  }

  return false;
}

function toMinutes(value: string): number {
  const [h, m] = value.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}
