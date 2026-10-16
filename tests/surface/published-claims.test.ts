/**
 * SURFACE — published copy may only assert what the tree can support.
 *
 * Why this exists: two numbers shipped in the pitch surfaces that the repository's own
 * documents refute — a "~$0.05 blended cost / 66% gross margin" comment that cited
 * docs/UNIT-ECONOMICS.md, which models ≈$0.55, and a "multi-AZ · 99.99% uptime SLA"
 * claimed in a chip, a risk-table row and the *narrated speaker script*, against a single
 * `ovh_cloud_instance` and a security questionnaire that says "Single-region today".
 * Neither was caught, because the only claims gate in the tree
 * (`tests/surface/llms-txt.test.ts`) checks the two numbers that llms.txt already DERIVES,
 * and says nothing about the deck, the pages, or the JSON-LD. A claim that no test can see
 * is a claim that will drift back.
 *
 * The rule this enforces, per surface:
 *   1. A capability the code does not implement may not be named at all (mTLS, OAuth as an
 *      ingest mechanism, cloned personas, voice watermarking, pre-warmed channels).
 *   2. A language outside the `TtsLang` union may not appear in any public surface.
 *   3. A number that a config value or a committed artifact owns must be DERIVED from it,
 *      not retyped — so the copy and the code cannot disagree silently.
 *   4. An unmeasured latency may not be stated as a result. `60 s` is legal only as the
 *      case deadline it actually is; the spans that would prove time-to-contact are
 *      `not_measured` in evidence/latency/slo.json, so "about one second", "sub-second"
 *      and "61 seconds" are banned outright.
 *
 * Scope note: this scans SHIPPED COPY only. `docs/GAP-REGISTER.md` is an audit log and
 * legitimately quotes the false strings it recorded fixing — quoting a lie to document it
 * is not the same as publishing one, so it is deliberately not in the list below.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { slaSeconds } from "@/lib/config";
import { DEFAULT_RETENTION_DAYS } from "@/lib/privacy/retention";

const ROOT = process.cwd();

/** Every file this gate reads, so an addition has to be deliberate. */
function shippedCopy(): string[] {
  const viewsDir = join(ROOT, "src", "views");
  const views = readdirSync(viewsDir)
    .filter((f) => f.endsWith(".tsx"))
    .map((f) => join("src", "views", f));
  return [
    join("src", "lib", "deck.ts"),
    join("src", "app", "llms.txt", "route.ts"),
    join("src", "components", "seo", "JsonLd.tsx"),
    join("src", "lib", "commercial.ts"),
    ...views,
  ];
}

const FILES = shippedCopy();
const ALL = FILES.map((f) => ({ file: f, text: readFileSync(join(ROOT, f), "utf8") }));

/**
 * A banned phrase plus the reason it is banned. The reason is asserted to be non-trivial
 * below, so a future edit cannot hollow this list out into a no-op that keeps CI green.
 */
const BANNED: { readonly pattern: RegExp; readonly why: string }[] = [
  {
    pattern: /mutual TLS|OAuth 2\.0|mTLS/i,
    why: "there is no mTLS and no OAuth anywhere in the ingest path — auth is an HMAC signature over the raw body (SV-Signature) or a bearer key",
  },
  {
    pattern: /pre-?warmed channels|always[- ](hot|on)\b.{0,20}pre-?warm|pre-?warmed telephony/i,
    why: "pre-warming is real but flag-gated (worker/prewarm.ts + lib/voice/warm-audio.ts on the media-stream plane, flags.ts twilioMediaStreams:false) — publishing it as an always-on availability device is the claim this bans",
  },
  {
    pattern: /cloned voices|voice cloning is enabled|four cloned/i,
    why: "instant and pro cloning are disabled on this account; the live agent speaks one stock Library voice",
  },
  {
    pattern: /watermark(ed)? at synthesis|voice watermark/i,
    why: "no watermarking code exists in the tree",
  },
  {
    pattern:
      /no call audio (is |was )?(stored|kept|retained|saved)|we (do not|don't|never) store (any )?call audio|لا نحفظ تسجيلات/i,
    why: "audio IS retained for DEFAULT_RETENTION_DAYS.audio days and then deleted — the storage claim is false even though audio genuinely does not reach a decision model",
  },
  {
    pattern: /Filipino|Malayalam|Bengali|Tagalog|Bahasa/i,
    why: "outside the TtsLang union — those languages are not implemented",
  },
  {
    pattern: /Eleven v3|eleven_v3 text|v3 text-to-speech/i,
    why: "the shipped agent runs eleven_v4_turbo; v3 is refused with 400 expressive_tts_not_allowed",
  },
  {
    pattern: /style at 0\.\d|similarity boost at 0\.75, and style/i,
    why: "no style parameter exists anywhere — not in agent/securevoice.agent.yaml, not in config.ts. (stability 0.7 IS real for the worker TTS path, config.ts:414-424, and 0.5 for the agent plane; naming a value is fine, inventing a knob is not)",
  },
  {
    pattern: /never switches|locked after the first|language lock/i,
    why: "the live prompt switches when the caller switches and a switch_language tool is attached",
  },
  {
    pattern: /99(\.\d+)?\s*%\s*(uptime|availability)|multi-?AZ/i,
    why: "single region, one instance; the questionnaire says multi-region is roadmap",
  },
  {
    pattern:
      /about one second|~\s?1\s?s\b|sub-?second|freeze · 240\s?ms|within 800\s?ms|in 61 seconds|61-second/i,
    why: "unmeasured or refuted by evidence/latency/slo.json (the agent-answer path is not_measured)",
  },
  {
    pattern: /over ninety percent pass|90%?\+ (pass|test)|test suite (is |with )?complete/i,
    why: "the committed artifact records 17 of 19 gates, with load and surface failing",
  },
  {
    pattern: /executes? (the |a )?freeze|freeze (is )?executed|account frozen|frozen in \d/i,
    why: "card_freeze returns committed:false stage:pending_specialist — the platform stages, a human commits",
  },
  {
    pattern: /one-word (path|escape|route) to a human|human one word away/i,
    why: 'classify() has no handoff utterance; "are you human" is in the DOUBT set and returns a clarification, so the only path to a human is four unclear turns, sentiment escalation, or the tool boundary',
  },
  {
    pattern: /specialist (joins|arrives|calls back)[^.]{0,30}\b(30|45|60)\s?(s|sec|seconds)\b/i,
    why: "both handoff tools set ETA_SECS = 120, and with no specialist line configured the case is queued rather than bridged",
  },
];

describe("published claims — nothing shipped that the tree refutes", () => {
  test("the gate has files to read, or it is watching nothing", () => {
    // A vacuous pass is the failure mode this whole suite exists to prevent.
    expect(FILES.length).toBeGreaterThanOrEqual(12);
    for (const f of FILES) expect(f).toBeTruthy();
  });

  test("every ban states a reason, so the list cannot be hollowed out", () => {
    expect(BANNED.length).toBeGreaterThanOrEqual(10);
    for (const b of BANNED) {
      expect(b.why.length).toBeGreaterThan(30);
      expect(b.pattern.flags.includes("i")).toBe(true);
    }
  });

  test("no banned claim survives in shipped copy", () => {
    const hits: string[] = [];
    // A refutation marker counts only when it is the refuting sentence itself, so a
    // roadmap entry may legitimately say a language is not implemented even when the
    // language code sits on the line above it. Windowed, not per-line: the data is
    // `{ lang: "Bengali", note: "Not implemented — …" }`.
    const REFUTED =
      /\b(refused|not implemented|instead of|rather than|we do not claim|no such|not a measured|declared and not|is not instrumented|unverified)\b|لا زمن وصول|غير مقاس|غير مطبقة/i;
    for (const { file, text } of ALL) {
      const lines = text.split("\n");
      lines.forEach((line, i) => {
        // Comments are not published copy. The demo's own `prefetchSpeech` comment, for
        // instance, correctly describes client-side speech prefetch — a real mechanism that
        // has nothing to do with the telephony "pre-warmed channels" claim this gate bans.
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
        for (const b of BANNED) {
          if (!b.pattern.test(line)) continue;
          if (REFUTED.test(line)) continue;
          if (REFUTED.test(lines.slice(i, i + 5).join(" "))) continue;
          hits.push(`${file}:${i + 1}: ${line.trim().slice(0, 120)}\n    ↳ ${b.why}`);
        }
      });
    }
    expect(hits, hits.join("\n")).toEqual([]);
  });

  /**
   * The 60-second figure, and the wording that makes it honest.
   *
   * Named at module scope so the test below can probe them directly: the first version
   * of this ban was written as `seconds?\|sixty`, and in a JavaScript regex literal `\|`
   * is an escaped PIPE, not an alternation. The pattern therefore matched only the Arabic
   * branch — every English "within 60 seconds" shipped, and the gate reported green.
   * A ban that cannot match three quarters of its own scope is worse than no ban, because
   * it stops anyone from looking.
   */
  const PROMISES_A_60_SECOND_CONTACT = /60[\s-]?seconds?|sixty seconds|60\s?s\b|٦٠ ثانية/;
  const STATED_AS_THE_CLOCK_IT_IS =
    /deadline|budget|target|not a measured|no.t measured|case clock|SLA_SECONDS|setTimeout|timeout|مهلة|هدف|غير مقاس|لا زمن وصول/i;

  test("the 60-second figure is only ever a deadline, never a reached customer", () => {
    const offenders: string[] = [];
    for (const { file, text } of ALL) {
      text.split("\n").forEach((line, i) => {
        if (!PROMISES_A_60_SECOND_CONTACT.test(line)) return;
        // Qualified = stated as the clock it is (EN or AR). "مهلة" is deadline, "هدف" target,
        // and a line that says the figure is NOT measured is making the honest claim.
        if (STATED_AS_THE_CLOCK_IT_IS.test(line)) return;
        offenders.push(`${file}:${i + 1}: ${line.trim().slice(0, 120)}`);
      });
    }
    // Time-to-contact has no producer: signal_received_to_ringing is not_measured in
    // evidence/latency/slo.json. Any bare "within 60 seconds" therefore promises something
    // the repository has never observed.
    expect(offenders, offenders.join("\n")).toEqual([]);

    // Positive control, in BOTH languages. Without it this ban can silently regain a
    // dead branch — which is exactly how it shipped the first time, matched only Arabic,
    // and stayed green while English promises went out on the pricing FAQ.
    for (const probe of [
      "places an outbound call within 60 seconds of the signal",
      "the agent answers in sixty seconds",
      "dials within 60s of the alert",
      "يتصل الوكيل بالعميل خلال ٦٠ ثانية",
    ]) {
      expect({ probe, matched: PROMISES_A_60_SECOND_CONTACT.test(probe) }).toEqual({
        probe,
        matched: true,
      });
      expect({ probe, exempt: STATED_AS_THE_CLOCK_IT_IS.test(probe) }).toEqual({
        probe,
        exempt: false,
      });
    }
    // …and the honest framing is still exempt, or the ban would be a text filter.
    for (const honest of [
      "the case sits on a 60-second deadline the platform sets for itself",
      "٦٠ ثانية هي مهلة الحالة وليست زمن وصول مقاس",
    ]) {
      expect(STATED_AS_THE_CLOCK_IT_IS.test(honest)).toBe(true);
    }
  });

  test("the ban patterns are live — a fabricated line is caught, not ignored", () => {
    // Non-circular proof that this gate can fail: run every ban against one deliberately
    // false line. If the patterns rot (over-narrow, bad escaping, an accidental `g` flag
    // making `.test` stateful), this trips even when the real copy is clean.
    const fabricated =
      "OAuth 2.0 with mutual TLS, pre-warmed channels, 4 cloned voices watermarked at synthesis, " +
      "no call audio stored, Filipino and Malayalam supported, Eleven v3 text-to-speech with " +
      "stability at 0.7 and style at 0.3, language never switches after the first response, " +
      "multi-AZ 99.99% uptime, connects in about one second and sub-second turn-taking, " +
      "test suite complete with over ninety percent pass, the agent executes the freeze and the " +
      "account frozen in 61 seconds, with a one-word path to a human and a specialist joins " +
      "the call within 30 seconds.";
    const matched = BANNED.filter((b) => b.pattern.test(fabricated));
    expect(matched.length).toBe(BANNED.length);
    const missed = BANNED.filter((b) => !b.pattern.test(fabricated)).map((b) => b.why);
    expect(missed, `these bans matched nothing: ${missed.join(" | ")}`).toEqual([]);
  });

  test("llms.txt derives its numbers instead of retyping them", () => {
    const body =
      ALL.find((f) => f.file.replace(/\\/g, "/").endsWith("llms.txt/route.ts"))?.text ?? "";
    expect(body.length).toBeGreaterThan(1000); // the finder must match, or this test is vacuous
    // Interpolated, not literal: the source must reference the values it publishes.
    expect(body).toContain("${slaSeconds()}");
    expect(body).toContain("${DEFAULT_RETENTION_DAYS.audio}");
    expect(body).toContain("${DEFAULT_RETENTION_DAYS.transcripts}");
    expect(body).toContain("${durationPhrase(env.reversalWindowSecs)}");
  });

  test("the machine-readable surface agrees with the code it describes", async () => {
    const { GET } = await import("@/app/llms.txt/route");
    const text = await (await GET()).text();
    expect(text).toContain(`on a ${slaSeconds()}-second case deadline`);
    expect(text).toContain(`${DEFAULT_RETENTION_DAYS.audio} days`);
    expect(text).toContain(`${DEFAULT_RETENTION_DAYS.transcripts} days`);
    // The wrong pairing the audit found: transcripts were advertised on the 30-day window.
    expect(text).not.toMatch(/30-day audio and transcript/i);
  });

  test("the JSON-LD feature list names only implemented languages", () => {
    const jsonLd =
      ALL.find((f) => f.file.replace(/\\/g, "/").endsWith("seo/JsonLd.tsx"))?.text ?? "";
    expect(jsonLd.length).toBeGreaterThan(500);
    // The union the code actually has, asserted as the shipped list — so a language can be
    // added to the marketing array without being added to `TtsLang` and still fail here.
    expect(jsonLd).toContain('inLanguage: ["en", "ar", "hi", "ur", "fr", "sw"]');
    expect(jsonLd).not.toMatch(/"tl"|"ml"|"bn"/);
  });

  test("the gate would notice a new view file being added silently", () => {
    const viewsDir = join(ROOT, "src", "views");
    const onDisk = readdirSync(viewsDir).filter((f) => f.endsWith(".tsx")).length;
    const inList = FILES.filter((f) => f.startsWith(join("src", "views"))).length;
    expect(inList).toBe(onDisk);
  });
});
