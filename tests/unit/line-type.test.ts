/**
 * Line type — and, more importantly, what this module does NOT know.
 *
 * The repo has NO number-intelligence source: no Lookups client, no portability
 * (NMC/NAM) feed, no HLR, no `.env.example` key. So `classifyLine` is a prefix
 * heuristic with an optional injected lookup. These tests therefore assert two
 * different things and both matter:
 *
 *   - the blocks the table DOES claim (UAE mobile/landline, the NANP toll-free
 *     and 900 blocks, the UK VoIP/personal ranges) resolve as designed; and
 *   - everything it does NOT claim comes back `"unknown"` rather than as a
 *     confident guess, and a broken lookup degrades instead of throwing.
 *
 * The second half is the load-bearing half. A classifier that fills in the
 * blanks is worse than one that admits ignorance, because every caller stops
 * checking once the value looks plausible.
 */
import { describe, expect, test } from "bun:test";

import {
  CALLER_E164_RE,
  DEFAULT_LOOKUP_TIMEOUT_MS,
  LINE_TYPES,
  PREFIX_RULES,
  UNKNOWN_LINE,
  classifyByPrefix,
  classifyLine,
  isVoip,
  matchPrefixRule,
  supportsSmsConfirmation,
  type LineClassification,
  type LineLookupOptions,
} from "@/lib/voice/line-type";

/** A fetchImpl that never touches the network. */
const jsonFetch = (body: unknown, status = 200): typeof fetch =>
  (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;

async function classify(
  e164: string,
  lookup?: LineLookupOptions | null,
): Promise<LineClassification> {
  return classifyLine(e164, lookup ? { lookup } : {});
}

describe("UAE (+971) — the market this deployment is actually in", () => {
  test("a mobile is a mobile, with high confidence", async () => {
    const r = await classify("+971501234567");
    expect(r.type).toBe("mobile");
    expect(r.source).toBe("prefix");
    expect(r.confidence).toBe("high");
  });

  test("every UAE mobile block resolves to mobile", async () => {
    // E.164 drops the national trunk 0, so `050 …` is `+97150 …`.
    for (const national of ["50", "52", "54", "55", "56", "58"]) {
      expect((await classify(`+971${national}1234567`)).type).toBe("mobile");
    }
  });

  test("a landline is a landline — and cannot receive SMS", async () => {
    const r = await classify("+97121234567");
    expect(r.type).toBe("landline");
    expect(r.source).toBe("prefix");
    expect(supportsSmsConfirmation(r.type)).toBe(false);
  });

  test("every UAE area code in the table resolves to landline", async () => {
    for (const area of ["2", "4", "6", "7", "9"]) {
      const r = await classify(`+971${area}1234567`);
      expect(r.type).toBe("landline");
    }
  });

  test("a mobile and a landline of similar shape never collide", async () => {
    // 12 digits = mobile, 11 digits = landline. The length bound is what keeps
    // a truncated landline from being read as a mobile.
    expect((await classify("+971501234567")).type).toBe("mobile");
    expect((await classify("+97150123456")).type).toBe("unknown");
    expect((await classify("+9712123456")).type).toBe("unknown");
  });

  test("the UAE 800 block is toll-free, at low confidence", async () => {
    const r = await classify("+97180012345");
    expect(r.type).toBe("toll_free");
    expect(r.confidence).toBe("low");
    expect(supportsSmsConfirmation(r.type)).toBe(false);
  });
});

describe("the North American Numbering Plan — only what a prefix can know", () => {
  test("a toll-free number is recognised", async () => {
    for (const area of ["800", "833", "844", "855", "866", "877", "888"]) {
      const r = await classify(`+1${area}5551234`);
      expect(r.type).toBe("toll_free");
      expect(r.source).toBe("prefix");
      expect(supportsSmsConfirmation(r.type)).toBe(false);
    }
  });

  test("900 is premium", async () => {
    const r = await classify("+19005551234");
    expect(r.type).toBe("premium");
    expect(supportsSmsConfirmation(r.type)).toBe(false);
  });

  test("a GEOGRAPHIC NANP number is unknown — a prefix cannot say mobile, landline or VoIP", async () => {
    // The honest answer, and the one that keeps the module from inventing a
    // signal the NANP does not carry.
    expect((await classify("+14155550100")).type).toBe("unknown");
    expect((await classify("+12125550142")).type).toBe("unknown");
  });

  test("976 is NOT treated as premium — it overlaps live geographic area codes", async () => {
    // Calling it premium would mislabel real customers in 713/210/954.
    expect((await classify("+17129761234")).type).toBe("unknown");
  });
});

describe("VoIP and personal-number blocks that are knowable", () => {
  test("the UK 056 VoIP block resolves to voip", async () => {
    const r = await classify("+445612345678");
    expect(r.type).toBe("voip");
    expect(r.source).toBe("prefix");
    expect(isVoip(r.type)).toBe(true);
  });

  test("the UK 074 personal-number block resolves to personal_number", async () => {
    const r = await classify("+447400123456");
    expect(r.type).toBe("personal_number");
    expect(isVoip(r.type)).toBe(false);
  });

  test("an ITU international-network block resolves to voip", async () => {
    expect((await classify("+882123456789")).type).toBe("voip");
    expect((await classify("+883123456789")).type).toBe("voip");
  });

  test("ITU shared-cost and premium blocks resolve as such", async () => {
    expect((await classify("+80812345678")).type).toBe("shared_cost");
    expect((await classify("+870123456789")).type).toBe("shared_cost");
    expect((await classify("+979123456789")).type).toBe("premium");
    expect(supportsSmsConfirmation("shared_cost")).toBe(false);
    expect(supportsSmsConfirmation("premium")).toBe(false);
  });
});

describe("unknown and invalid — the states that must stay honest", () => {
  test("a number that is not E.164 is unknown, not guessed", async () => {
    for (const bad of [
      "",
      "not-a-number",
      "0501234567",
      "+0",
      "12345",
      "+971 50 123",
      "++971501234567",
    ]) {
      const r = await classify(bad);
      expect(r).toEqual(UNKNOWN_LINE);
    }
  });

  test("an E.164 number with nothing in the table is unknown", async () => {
    // A UK geographic number IS separable from a prefix — it is simply not in
    // this table, and the answer for an unlisted number is unknown.
    const r = await classify("+442079460958");
    expect(r.type).toBe("unknown");
    expect(r.source).toBe("unknown");
    expect(r.confidence).toBe("unknown");
  });

  test("NO prefix-derived classification ever claims to know business vs consumer", async () => {
    // Structural, not an oversight: `PrefixRule` has no `class` field to fill in
    // wrongly, so this holds for every rule in the table.
    for (const rule of PREFIX_RULES) {
      const padded =
        rule.prefix + "1".repeat(Math.max(0, (rule.length ?? 12) - rule.prefix.length));
      const r = classifyByPrefix(`+${padded}`);
      if (r.source !== "prefix") continue;
      expect(r.class).toBe("unknown");
    }
  });

  test("the strict E.164 gate is the one Twilio uses", () => {
    // `isE164` in @/lib/twilio.ts: `+`, non-zero country digit, 7–14 more.
    expect(CALLER_E164_RE.test("+971501234567")).toBe(true);
    expect(CALLER_E164_RE.test("+12345678")).toBe(true);
    expect(CALLER_E164_RE.test("+1234567")).toBe(false);
    expect(CALLER_E164_RE.test("971501234567")).toBe(false);
    expect(CALLER_E164_RE.test("+02345678")).toBe(false);
  });

  test("separators and the 00 international prefix are canonicalised first", async () => {
    expect((await classify("+971 50 123 4567")).type).toBe("mobile");
    expect((await classify("+971-50-123-4567")).type).toBe("mobile");
    expect((await classify("+971.50.123.4567")).type).toBe("mobile");
    expect((await classify("00971501234567")).type).toBe("mobile");
    // A national form with no `+` is NOT canonicalised into one — the shared
    // `normaliseE164` only rewrites a `00` prefix, and guessing the country
    // code is exactly the kind of guess this module refuses to make.
    expect((await classify("(971) 50 123 4567")).type).toBe("unknown");
  });

  test("classifyLine never rejects, whatever it is handed", async () => {
    const hostile = ["", "null", "+", "😀", "+971501234567", "9".repeat(4_000)];
    for (const value of hostile) {
      await expect(classifyLine(value)).resolves.toBeDefined();
    }
  });
});

describe("supportsSmsConfirmation — may this channel be relied on as proof of reach?", () => {
  test("false for every line type that has no handset to receive on", () => {
    for (const type of ["landline", "toll_free", "premium", "shared_cost"] as const) {
      expect(supportsSmsConfirmation(type)).toBe(false);
    }
  });

  test("false for unknown — a silent SMS and an ignored SMS look the same", () => {
    // Treating an unclassifiable number as SMS-capable is how "confirmation
    // sent" becomes "customer was reached" on a call nobody answered.
    expect(supportsSmsConfirmation("unknown")).toBe(false);
  });

  test("true only for the reachable types", () => {
    expect(supportsSmsConfirmation("mobile")).toBe(true);
    expect(supportsSmsConfirmation("voip")).toBe(true);
    expect(supportsSmsConfirmation("personal_number")).toBe(true);
  });

  test("answers every declared line type — no gap in the union", () => {
    for (const type of LINE_TYPES) {
      expect(typeof supportsSmsConfirmation(type)).toBe("boolean");
      expect(typeof isVoip(type)).toBe("boolean");
    }
    expect(isVoip("mobile")).toBe(false);
    expect(isVoip("voip")).toBe(true);
  });
});

describe("the optional lookup — and every way it can fail", () => {
  test("a good answer wins over the prefix table", async () => {
    const r = await classify("+14155550100", {
      endpoint: "https://numbers.example",
      token: "t",
      fetchImpl: jsonFetch({ line_type: "voip", caller_type: "business" }),
    });
    expect(r.type).toBe("voip");
    expect(r.class).toBe("business");
    expect(r.source).toBe("lookup");
    expect(r.confidence).toBe("high");
  });

  test("vendor spelling variants are normalised", async () => {
    for (const [wire, expected] of [
      ["Mobile", "mobile"],
      ["fixed_line", "landline"],
      ["VOIP", "voip"],
      ["toll free", "toll_free"],
      ["shared cost", "shared_cost"],
    ] as const) {
      const r = await classify("+971501234567", {
        endpoint: "https://numbers.example",
        fetchImpl: jsonFetch({ line_type: wire }),
      });
      expect(r.type).toBe(expected);
    }
  });

  test("a THROWING lookup degrades to the prefix table and never throws", async () => {
    const failures: string[] = [];
    const r = await classifyLine("+971501234567", {
      lookup: {
        endpoint: "https://numbers.example",
        fetchImpl: (() => Promise.reject(new Error("ECONNRESET"))) as unknown as typeof fetch,
      },
      onLookupFailure: (detail) => failures.push(detail),
    });
    expect(r.type).toBe("mobile");
    expect(r.source).toBe("prefix");
    // The failure is REPORTED, so an operator can see the enrichment service
    // is down instead of quietly getting prefix answers forever.
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("ECONNRESET");
  });

  test("a hanging lookup is bounded by the timeout budget", async () => {
    // A number-enrichment service having a bad minute must cost the caller
    // dead air, not the turn.
    expect(DEFAULT_LOOKUP_TIMEOUT_MS).toBeLessThanOrEqual(2_000);

    const r = await classify("+971501234567", {
      endpoint: "https://numbers.example",
      timeoutMs: 50,
      fetchImpl: ((_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        })) as unknown as typeof fetch,
    });
    expect(r.type).toBe("mobile");
    expect(r.source).toBe("prefix");
  });

  test("a non-2xx, a non-JSON body and an unparseable body all degrade", async () => {
    const http500 = await classify("+971501234567", {
      endpoint: "https://numbers.example",
      fetchImpl: jsonFetch({ line_type: "mobile" }, 500),
    });
    expect(http500.source).toBe("prefix");

    const notJson = await classify("+971501234567", {
      endpoint: "https://numbers.example",
      fetchImpl: (async () =>
        new Response("<html>maintenance</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        })) as unknown as typeof fetch,
    });
    expect(notJson.source).toBe("prefix");

    const wrongShape = await classify("+971501234567", {
      endpoint: "https://numbers.example",
      fetchImpl: jsonFetch({ line_type: { nested: true } }),
    });
    expect(wrongShape.source).toBe("prefix");
  });

  test("a provider that does not KNOW the number is not treated as an outage", async () => {
    const failures: string[] = [];
    const r = await classifyLine("+971501234567", {
      lookup: {
        endpoint: "https://numbers.example",
        fetchImpl: jsonFetch({ line_type: "unknown", message: "not in database" }),
      },
      onLookupFailure: (detail) => failures.push(detail),
    });
    expect(r.type).toBe("mobile");
    expect(r.source).toBe("prefix");
    // Degrades QUIETLY: paging an operator every time a number is absent from a
    // vendor database is a page they will learn to ignore.
    expect(failures).toHaveLength(0);
  });

  test("no endpoint means no network call at all", async () => {
    let called = false;
    const r = await classify("+971501234567", {
      endpoint: "",
      fetchImpl: (async () => {
        called = true;
        return new Response("{}");
      }) as unknown as typeof fetch,
    });
    expect(called).toBe(false);
    expect(r.source).toBe("prefix");
  });

  test("a lookup never rescues a number that is not E.164", async () => {
    const r = await classify("nonsense", {
      endpoint: "https://numbers.example",
      fetchImpl: jsonFetch({ line_type: "mobile" }),
    });
    expect(r).toEqual(UNKNOWN_LINE);
  });

  test("an alerting callback that throws does not take the call with it", async () => {
    const r = await classifyLine("+971501234567", {
      lookup: {
        endpoint: "https://numbers.example",
        fetchImpl: (() => Promise.reject(new Error("boom"))) as unknown as typeof fetch,
      },
      onLookupFailure: () => {
        throw new Error("the pager is down");
      },
    });
    expect(r.type).toBe("mobile");
    expect(r.source).toBe("prefix");
  });
});

describe("the prefix table itself", () => {
  test("every rule declares the evidence it rests on", () => {
    for (const rule of PREFIX_RULES) {
      expect(rule.prefix).toMatch(/^[0-9]+$/);
      expect(rule.type).toBeTruthy();
      expect(["high", "low", "unknown"]).toContain(rule.confidence);
      // A rule with no note is a rule nobody can audit six months later.
      expect(rule.note.length).toBeGreaterThan(10);
      if (rule.length !== undefined) expect(rule.length).toBeGreaterThan(rule.prefix.length);
    }
  });

  test("no two rules bind the same block to different types", () => {
    const seen = new Map<string, string>();
    for (const rule of PREFIX_RULES) {
      const key = `${rule.prefix}:${rule.length ?? "*"}:${rule.maxLength ?? "*"}`;
      expect(seen.get(key)).toBeUndefined();
      seen.set(key, rule.type);
    }
  });

  test("the longest prefix wins, so a specific rule is never shadowed", () => {
    // +971800 must not be read as a UAE landline block, and +1800 must not be
    // swallowed by anything broader.
    expect(matchPrefixRule("97180012345")?.type).toBe("toll_free");
    expect(matchPrefixRule("18005551234")?.type).toBe("toll_free");
    expect(matchPrefixRule("445612345678")?.type).toBe("voip");
  });

  test("an unlisted block has no rule", () => {
    expect(matchPrefixRule("14155550100")).toBeNull();
    expect(matchPrefixRule("442079460958")).toBeNull();
  });
});
