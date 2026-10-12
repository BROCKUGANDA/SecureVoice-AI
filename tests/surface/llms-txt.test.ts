/**
 * `GET /llms.txt` — the brief an answer engine reads before it decides to cite.
 *
 * The file is derived from `INDEXABLE_PATHS` and `PLANS`, and these tests are what
 * make that derivation real rather than a comment:
 *
 *   · every indexable path is linked, with a description. A route added to the
 *     sitemap without prose fails here, because a bare link teaches an engine
 *     nothing and a missing link means the page is invisible to it;
 *   · the prices are the ones the checkout charges, including the `null` cases that
 *     mean "negotiated" rather than "free" or "zero";
 *   · every URL is absolute and on the published origin — a relative link in a
 *     plain-text file resolves against nothing, and a localhost origin here is the
 *     same misconfiguration that deindexes the site (see
 *     `tests/unit/site-origin.test.ts`);
 *   · the response is `text/plain` and does not ask to be indexed itself.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { INDEXABLE_PATHS } from "@/app/sitemap";
import { PLANS } from "@/lib/commercial";
import { GET } from "@/app/llms.txt/route";

const ORIGIN = "https://llms-txt.test.example";
const savedSiteUrl = process.env.NEXT_PUBLIC_SITE_URL;

beforeAll(() => {
  process.env.NEXT_PUBLIC_SITE_URL = ORIGIN;
});

afterAll(() => {
  if (savedSiteUrl === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
  else process.env.NEXT_PUBLIC_SITE_URL = savedSiteUrl;
});

async function fetchFile(): Promise<{ body: string; res: Response }> {
  const res = await GET();
  return { res, body: await res.text() };
}

describe("the response", () => {
  test("is plain text, cacheable, and not itself a search result", async () => {
    const { res } = await fetchFile();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex, follow");
    expect(res.headers.get("Cache-Control")).toContain("max-age");
  });
});

describe("the page list", () => {
  test("every indexable path is linked, with a description", async () => {
    const { body } = await fetchFile();
    for (const path of INDEXABLE_PATHS) {
      const url = `${ORIGIN}${path === "/" ? "" : path}`;
      expect(body, `${path} is not linked`).toContain(`](${url})`);
      // A link with no `: prose` after it is a route someone added to the sitemap
      // and did not describe. The file still lists it; the test does not accept it.
      const linkLine = body.split("\n").find((l) => l.includes(`](${url})`)) ?? "";
      expect(linkLine.includes("): "), `${path} has no description`).toBe(true);
    }
  });

  test("nothing links a path the crawler is told to stay away from", async () => {
    const { body } = await fetchFile();
    for (const forbidden of ["/api/", "/inspector", "/_next/", "/v1/"]) {
      expect(body, `llms.txt links ${forbidden}`).not.toContain(`](${ORIGIN}${forbidden}`);
    }
  });

  test("every link is absolute — a relative URL in a text file resolves against nothing", async () => {
    const { body } = await fetchFile();
    for (const match of body.matchAll(/\]\(([^)]+)\)/g)) {
      const url = match[1]!;
      expect(url, url).toMatch(/^https:\/\//);
      expect(url.startsWith(ORIGIN), url).toBe(true);
    }
  });
});

describe("the pricing block", () => {
  test("lists every plan with the figures the checkout uses", async () => {
    const { body } = await fetchFile();
    for (const plan of PLANS) {
      expect(body, `${plan.id} missing`).toContain(`- ${plan.name}:`);
      if (plan.monthlyUsd !== null) {
        expect(body, `${plan.id} price`).toContain(
          `${plan.monthlyUsd} USD per month (${plan.yearlyUsd} per year, ten monthly)`,
        );
      } else {
        expect(body, `${plan.id} must read as negotiated`).toContain("contract-priced");
      }
      if (plan.overageCents !== null) {
        expect(body, `${plan.id} overage`).toContain(
          `${(plan.overageCents / 100).toFixed(2)} USD per additional call`,
        );
      }
    }
  });

  test("a seat cap is stated as a seat count, not silently omitted", async () => {
    const { body } = await fetchFile();
    for (const plan of PLANS) {
      const line = body.split("\n").find((l) => l.startsWith(`- ${plan.name}:`)) ?? "";
      expect(
        line.includes("seat") || line.includes("unlimited seats"),
        `${plan.id} says nothing about seats`,
      ).toBe(true);
    }
  });
});

describe("the claims", () => {
  test("the retention window matches the one the erasure code enforces", async () => {
    const { body } = await fetchFile();
    expect(body).toContain("retained for 30 days");
    // The same number, from the module that actually deletes.
    const { DEFAULT_RETENTION_DAYS } = await import("@/lib/privacy/retention");
    expect(DEFAULT_RETENTION_DAYS.audio).toBe(30);
  });

  test("it does not promise a payment to an end user", async () => {
    const { body } = await fetchFile();
    expect(body.toLowerCase()).toContain("no payment is ever taken from an end user");
  });
});
