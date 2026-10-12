/**
 * The semantic reply cache — and specifically the rules that make it safe to
 * have at all.
 *
 * The speed story is easy and is not what these tests are for. What matters is
 * that a cache which replays a previously-approved reply can also replay a
 * previously-approved LIE, permanently, to every future caller. Each `describe`
 * block below pins one guard, and the guards are asserted from BOTH directions:
 * `storeApproved` must refuse, and a reply that got in by any other route must
 * still never be SERVED by `lookup`.
 *
 *   bun test tests/unit/semantic-cache.test.ts
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  COMMITMENT_INTENTS,
  DEFAULT_MIN_SIMILARITY,
  EMBED_DIM,
  SemanticCache,
  assertsAccountAction,
  containsPII,
  cosineSimilarity,
  createSemanticCache,
  defaultSemanticCache,
  foldUtterance,
  lexicalEmbed,
  resetDefaultSemanticCache,
  type CacheContext,
} from "@/lib/voice/semantic-cache";

const FRAME: CacheContext = {
  intent: "clarify",
  language: "en",
  callCategory: "time_critical_fraud",
};

/** A reply that is safe, non-committal, and free of any digit or PII shape. */
const APPROVED_REPLY =
  "Thank you. I am checking that with the specialist now. You may hang up and call the number on the back of your card.";

function cacheWith(overrides: Parameters<typeof createSemanticCache>[0] = {}) {
  return createSemanticCache({ minSimilarity: 0.999, ...overrides });
}

/* ────────────────────────────── the cosine helper ────────────────────────────── */

describe("cosineSimilarity", () => {
  test("identical vectors are 1", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 10);
  });

  test("orthogonal vectors are 0", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
  });

  test("opposite vectors are -1", () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 10);
  });

  test("scale does not change the answer", () => {
    // The same utterance embedded by two differently-sized models has to score
    // the same, or a cache silently stops hitting after an embedder swap.
    expect(cosineSimilarity([1, 2, 3], [10, 20, 30])).toBeCloseTo(1, 10);
  });

  test("a zero vector is 0, never NaN", () => {
    // NaN fails every comparison the cache makes, so a zero vector that
    // produced NaN would look identical to "no candidate found".
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });

  test("a length mismatch is 0, never a partial sum", () => {
    // Truncating to the shorter length would score a 768-dim model against a
    // 256-dim one as though they were comparable.
    expect(cosineSimilarity([1, 2, 3], [1, 2])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
  });
});

/* ───────────────────────────── the default embedder ───────────────────────────── */

describe("the default embedder", () => {
  test("is deterministic — same text, same vector, every time", async () => {
    const a = await lexicalEmbed("this is not my number");
    const b = await lexicalEmbed("this is not my number");
    expect(a).toEqual(b);
    expect(a.length).toBe(EMBED_DIM);
  });

  test("is normalised, so cosine is a plain angle", async () => {
    const v = await lexicalEmbed("call me back later today");
    const norm = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));
    expect(norm).toBeCloseTo(1, 10);
  });

  test("needs no network to construct the cache", async () => {
    // Constructing this cache must never fail open into an unconfigured state.
    // The proof is that it answers with a number at all.
    const c = createSemanticCache();
    expect(c.size).toBe(0);
    const hit = await c.lookup("yes", FRAME);
    expect(hit.source).toBe("miss");
  });

  test("rates a paraphrase BELOW a near-identical restatement", async () => {
    // The documented limitation: character n-grams catch typos and restatement,
    // not paraphrase. A caller who says "I never made that purchase" rather
    // than "that was not mine" is a real miss, and it degrades to the LLM.
    const restated = cosineSimilarity(
      await lexicalEmbed("that was not mine"),
      await lexicalEmbed("that was not mine."),
    );
    const paraphrase = cosineSimilarity(
      await lexicalEmbed("that was not mine"),
      await lexicalEmbed("I never made that purchase"),
    );
    expect(restated).toBeGreaterThan(paraphrase);
    expect(paraphrase).toBeLessThan(DEFAULT_MIN_SIMILARITY);
  });

  test("folds Arabic tashkeel and tatweel to the same vector", async () => {
    const plain = await lexicalEmbed("هذا ليس رقمي");
    const decorated = await lexicalEmbed("هٰذَا لَيسَ رَقميـ");
    expect(decorated).toEqual(plain);
  });
});

describe("foldUtterance", () => {
  test("unifies Arabic letter forms the transcriber varies", () => {
    // أ إ آ → ا, ى → ي, ة → ه. Without this the same sentence matches two
    // different vectors depending on who was speaking.
    expect(foldUtterance("أستطيع")).toBe(foldUtterance("استطيع"));
    expect(foldUtterance("مشغولة")).toBe(foldUtterance("مشغوله"));
  });

  test("strips punctuation and collapses whitespace", () => {
    expect(foldUtterance("  Yes!!   I did it.  ")).toBe("yes i did it");
  });

  test("keeps non-Latin scripts (\\p{L}, not \\w)", () => {
    expect(foldUtterance("نعم")).toBe("نعم");
  });
});

/* ─────────────────────────────── the happy path ─────────────────────────────── */

describe("lookup and store — the fast path", () => {
  test("serves a stored reply for the same utterance", async () => {
    const c = cacheWith();
    await c.store("yes that was me", APPROVED_REPLY, FRAME);
    const hit = await c.lookup("yes that was me", FRAME);
    expect(hit.hit).toBe(true);
    expect(hit.source).toBe("cache");
    expect(hit.reply).toBe(APPROVED_REPLY);
    expect(hit.similarity).toBeGreaterThan(0.999);
  });

  test("serves a near-identical restatement", async () => {
    const c = cacheWith({ minSimilarity: 0.8 });
    await c.store("that was not mine", APPROVED_REPLY, FRAME);
    const hit = await c.lookup("that was not mine!", FRAME);
    expect(hit.hit).toBe(true);
    expect(hit.similarity).toBeGreaterThan(0.8);
  });

  test("misses on an unrelated utterance", async () => {
    const c = cacheWith();
    await c.store("yes that was me", APPROVED_REPLY, FRAME);
    const miss = await c.lookup("how much is my balance", FRAME);
    expect(miss.hit).toBe(false);
    expect(miss.source).toBe("miss");
    expect(miss.reply).toBe("");
  });

  test("a miss carries no reply — an empty string, never a stale one", async () => {
    // A caller that cannot tell a miss from a hit would speak "" into the
    // phone, which is the one thing worse than speaking a stale line.
    const c = cacheWith();
    const miss = await c.lookup("anything", FRAME);
    expect(miss.reply).toBe("");
    expect(miss.hit).toBe(false);
  });

  test("uses an injected embedder instead of the default", async () => {
    // The integration point for a real model, proven without a network call.
    const c = cacheWith({ embed: async (text) => [text.length, text.split(" ").length] });
    await c.store("one two three", APPROVED_REPLY, FRAME);
    expect((await c.lookup("one two three", FRAME)).hit).toBe(true);
    expect((await c.lookup("one two", FRAME)).hit).toBe(false);
  });

  test("degrades to a miss when the embedder throws", async () => {
    // The cache is on the latency-critical path of a live call. A cache that
    // can fail the call has made itself a liability.
    const c = cacheWith({
      embed: async () => {
        throw new Error("model down");
      },
    });
    const out = await c.lookup("yes", FRAME);
    expect(out).toEqual({ hit: false, reply: "", source: "miss" });
  });

  test("degrades to a miss when the embedder returns garbage", async () => {
    const c = cacheWith({ embed: async () => [1, Number.NaN] });
    expect((await c.lookup("yes", FRAME)).hit).toBe(false);
    const c2 = cacheWith({ embed: async () => [] });
    expect((await c2.lookup("yes", FRAME)).hit).toBe(false);
  });
});

/* ──────────────────────────────── the deny-list ──────────────────────────────── */

describe("COMMITMENT_INTENTS never enter the cache", () => {
  // These are the four intents src/lib/llm.ts refuses to let a model rephrase.
  // Caching them would be the same hazard with more reach: a scripted line is
  // reviewed once, a cached line is reviewed once and then served forever.
  const COMMITMENTS = ["deny_fraud", "confirm_authorized", "doubt", "handoff"] as const;

  for (const intent of COMMITMENTS) {
    test(`refuses ${intent}`, async () => {
      const c = cacheWith();
      const decision = await c.storeApproved("Your card has been frozen pending review.", {
        text: "it was fraud",
        intent,
        language: "en",
        callCategory: "time_critical_fraud",
      });
      expect(decision.stored).toBe(false);
      expect(decision.reason).toBe("commitment_intent");
      // The reason names the intent so an operator can see WHICH one was tried.
      expect(decision.detail).toBe(intent);
      expect(c.size).toBe(0);
    });
  }

  test("the deny-list mirrors SCRIPTED_ONLY in src/lib/llm.ts", () => {
    // The set is duplicated because SCRIPTED_ONLY is module-private. A silent
    // drift would mean caching exactly the intents the other file refuses to
    // rephrase, so the duplication is pinned against the source text.
    const src = readFileSync(join(process.cwd(), "src/lib/llm.ts"), "utf8");
    const block = /const SCRIPTED_ONLY[^=]*=\s*new Set\(\[([^\]]*)\]/.exec(src);
    expect(block).not.toBeNull();
    const inLlm = [...(block![1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
    expect(new Set(inLlm)).toEqual(new Set(COMMITMENT_INTENTS));
  });
});

/* ─────────────────────────────── the other guards ─────────────────────────────── */

describe("storeApproved — the guards a reply must pass", () => {
  test("accepts a reply that passes everything", async () => {
    const c = cacheWith();
    const decision = await c.storeApproved(APPROVED_REPLY, {
      text: "yes that was me",
      ...FRAME,
    });
    expect(decision.stored).toBe(true);
    expect(decision.reason).toBeUndefined();
    expect((await c.lookup("yes that was me", FRAME)).reply).toBe(APPROVED_REPLY);
  });

  test("refuses a reply that solicits a secret", async () => {
    const c = cacheWith();
    const decision = await c.storeApproved("Can you give me your PIN to verify this?", {
      text: "what do you need",
      ...FRAME,
    });
    expect(decision.stored).toBe(false);
    expect(decision.reason).toBe("output_unsafe");
  });

  test("refuses a reply that matches the vishing blocklist", async () => {
    const c = cacheWith();
    const decision = await c.storeApproved("Act now or your account will be closed today.", {
      text: "so what happens",
      ...FRAME,
    });
    expect(decision.stored).toBe(false);
    expect(decision.reason).toBe("vishing_pattern");
  });

  test("refuses a reply carrying PII", async () => {
    // A cached reply outlives the call AND the process, and is invisible to
    // the retention and crypto-shred paths that govern the database. It is a
    // record nobody can erase, created outside the erasure machinery.
    const c = cacheWith();
    const decision = await c.storeApproved("Your card 4111111111111111 was used in Dubai.", {
      text: "where was it used",
      ...FRAME,
    });
    expect(decision.stored).toBe(false);
    expect(decision.reason).toBe("pii");
  });

  test("refuses an empty reply", async () => {
    const c = cacheWith();
    const decision = await c.storeApproved("   ", { text: "yes", ...FRAME });
    expect(decision.stored).toBe(false);
    expect(decision.reason).toBe("empty_reply");
  });

  test("refuses when the caller utterance is empty", async () => {
    const c = cacheWith();
    const decision = await c.storeApproved(APPROVED_REPLY, { text: "", ...FRAME });
    expect(decision.stored).toBe(false);
    expect(decision.reason).toBe("empty_text");
  });

  test("refusals are recorded, bounded, and never carry the reply", async () => {
    const c = cacheWith();
    await c.storeApproved("secret on a plate: my PIN is 1234", { text: "x", ...FRAME });
    expect(c.refused()).toHaveLength(1);
    expect(c.refused()[0]!.reason).toBe("output_unsafe");
    expect(JSON.stringify(c.refused())).not.toContain("1234");
  });

  test("the refusal log is bounded", async () => {
    const c = cacheWith();
    for (let i = 0; i < 80; i++) {
      await c.storeApproved("Act now or your account will be closed.", { text: `t${i}`, ...FRAME });
    }
    expect(c.refused().length).toBeLessThanOrEqual(50);
  });
});

describe("containsPII — the rule is 'the redactors would change this'", () => {
  test("catches a PAN, a phone and an email", () => {
    expect(containsPII("card 4111111111111111")).toBe(true);
    expect(containsPII("call +971501234567")).toBe(true);
    expect(containsPII("reach me at sara@example.ae")).toBe(true);
  });

  test("does not fire on ordinary spoken copy", () => {
    // A redactor that swallows the platform's own reassurance is worse than no
    // redactor, because it silently replaces reassurance with a cache miss.
    expect(containsPII(APPROVED_REPLY)).toBe(false);
    expect(containsPII("Your bank will never ask you to move money to a safe account")).toBe(false);
    expect(containsPII("twenty five hundred dirhams")).toBe(false);
  });

  test("an empty string is not PII", () => {
    expect(containsPII("")).toBe(false);
  });
});

/* ─────────────────────────── re-validation on the way out ─────────────────────────── */

describe("lookup re-validates, so a poisoned write can never be served", () => {
  // This is what makes the raw `store()` door survivable. An unvetted write can
  // poison the store; a poisoned entry still cannot reach the phone.

  test("a raw-stored vishing reply is not served", async () => {
    const c = cacheWith();
    await c.store("what happens now", "Act now, your account will be closed today.", FRAME);
    const hit = await c.lookup("what happens now", FRAME);
    expect(hit.hit).toBe(false);
    expect(hit.reply).toBe("");
  });

  test("a raw-stored commitment reply is not served", async () => {
    const c = cacheWith();
    await c.store("it was fraud", "Your card is frozen and the balance is gone.", FRAME);
    expect((await c.lookup("it was fraud", FRAME)).hit).toBe(false);
  });
  test("a raw-stored PII reply is not served", async () => {
    const c = cacheWith();
    await c.store("where was it", "It was used on card 4111111111111111 in Dubai.", FRAME);
    expect((await c.lookup("where was it", FRAME)).hit).toBe(false);
  });

  test("the poisoned entry is evicted rather than re-checked forever", async () => {
    const c = cacheWith();
    await c.store("what happens now", "Act now, your account will be closed today.", FRAME);
    expect(c.size).toBe(1);
    await c.lookup("what happens now", FRAME);
    expect(c.size).toBe(0);
  });

  test("a commitment reply cannot be stored under a lying intent label", async () => {
    // The caller mislabels deny_fraud as clarify. The intent set alone would
    // wave this through, so the REPLY is read for an account action too.
    const c = cacheWith();
    const decision = await c.storeApproved("Your card is frozen.", {
      text: "it was fraud",
      ...FRAME,
      intent: "clarify",
    });
    expect(decision.stored).toBe(false);
    expect(decision.reason).toBe("account_action_claim");
  });

  test("and it cannot be served either, even after a raw write", async () => {
    const c = cacheWith();
    await c.store("help", "Your card is frozen.", { ...FRAME, intent: "clarify" });
    // Raw store bypasses admission, so this one IS in the store — and the
    // re-validation on read is what stops it reaching the phone.
    expect(c.size).toBe(1);
    const hit = await c.lookup("help", { ...FRAME, intent: "clarify" });
    expect(hit.hit).toBe(false);
    expect(hit.reply).toBe("");
  });
});

/* ─────────────────────────── the claim the agent cannot make ─────────────────────────── */

describe("assertsAccountAction — the reply text, not just the intent", () => {
  test("catches claims only a human may decide", () => {
    for (const claim of [
      "Your card is frozen.",
      "Your account has been closed.",
      "We have suspended your card.",
      "A refund has been issued to your account.",
      "We will refund you in full.",
      "The fraudster has been caught.",
      "I have closed your case.",
    ]) {
      expect(assertsAccountAction(claim), claim).toBe(true);
    }
  });

  test("catches the Arabic equivalents", () => {
    expect(assertsAccountAction("تم تجميد بطاقتك.")).toBe(true);
    expect(assertsAccountAction("سنقوم برد المبلغ.")).toBe(true);
  });

  test("does NOT catch the platform's own truthful copy", () => {
    // conversation.ts FREEZE_CONFIRMATION and EMERGENCY_FALLBACK are the
    // sentences that may actually be spoken. A guard that refused them would
    // silently replace a true reassurance with a cache miss.
    expect(
      assertsAccountAction(
        "I have temporarily restricted your card to protect your account. A human fraud specialist will review this shortly.",
      ),
    ).toBe(false);
    expect(
      assertsAccountAction(
        "We are experiencing technical difficulties. To protect your account, we have placed a temporary hold.",
      ),
    ).toBe(false);
    expect(assertsAccountAction(APPROVED_REPLY)).toBe(false);
  });

  test("does not fire on an empty string", () => {
    expect(assertsAccountAction("")).toBe(false);
  });
});

/* ────────────────────────────────── namespacing ────────────────────────────────── */

describe("entries are namespaced by intent + language + call category", () => {
  test("an Arabic reply never answers an English lookup", async () => {
    // Not a translation problem: the reply is only true inside its own frame.
    const c = cacheWith();
    const arabic = "تم التأكد من العملية مع أخصائي الاحتيال.";
    await c.storeApproved(arabic, {
      text: "نعم",
      intent: "clarify",
      language: "ar",
      callCategory: "time_critical_fraud",
    });
    const english = await c.lookup("نعم", { ...FRAME, intent: "clarify", language: "en" });
    expect(english.hit).toBe(false);
    const arabicHit = await c.lookup("نعم", {
      intent: "clarify",
      language: "ar",
      callCategory: "time_critical_fraud",
    });
    expect(arabicHit.hit).toBe(true);
    expect(arabicHit.reply).toBe(arabic);
  });

  test("a different intent never hits", async () => {
    const c = cacheWith();
    await c.storeApproved(APPROVED_REPLY, { text: "can you repeat that", ...FRAME });
    expect((await c.lookup("can you repeat that", { ...FRAME, intent: "unclear" })).hit).toBe(
      false,
    );
  });

  test("a different call category never hits", async () => {
    const c = cacheWith();
    await c.storeApproved(APPROVED_REPLY, { text: "can you repeat that", ...FRAME });
    const routine = await c.lookup("can you repeat that", { ...FRAME, callCategory: "routine" });
    expect(routine.hit).toBe(false);
  });

  test("an unknown category collapses to the audited default", async () => {
    // A caller that forgets the category lands in the DEFAULT namespace rather
    // than minting a new one per request and never hitting anything.
    const c = cacheWith();
    await c.storeApproved(APPROVED_REPLY, {
      text: "can you repeat that",
      intent: "clarify",
      language: "en",
      callCategory: "nonsense-category",
    });
    const viaDefault = await c.lookup("can you repeat that", {
      intent: "clarify",
      language: "en",
      callCategory: "time_critical_fraud",
    });
    expect(viaDefault.hit).toBe(true);
  });

  test("an unscoped store cannot be read by a scoped lookup", async () => {
    // The namespace defaults to "unscoped" on BOTH sides, so a caller who
    // forgets to pass one cannot accidentally borrow a framed reply.
    const c = cacheWith();
    await c.store("hello", APPROVED_REPLY);
    expect((await c.lookup("hello", FRAME)).hit).toBe(false);
    expect((await c.lookup("hello")).hit).toBe(true);
  });
});

/* ────────────────────────────────── the bounds ────────────────────────────────── */

describe("the cache is bounded — an unbounded cache in a long-lived process is a leak", () => {
  test("never exceeds maxEntries", async () => {
    const c = createSemanticCache({ maxEntries: 4, minSimilarity: 0.999 });
    for (let i = 0; i < 20; i++) await c.store(`utterance number ${i}`, APPROVED_REPLY, FRAME);
    expect(c.size).toBeLessThanOrEqual(4);
  });

  test("evicts least-recently-used, not least-recently-written", async () => {
    const c = createSemanticCache({ maxEntries: 3, minSimilarity: 0.999 });
    await c.store("alpha utterance", APPROVED_REPLY, FRAME);
    await c.store("beta utterance", APPROVED_REPLY, FRAME);
    await c.store("gamma utterance", APPROVED_REPLY, FRAME);
    // Touch alpha so beta becomes the coldest entry.
    await c.lookup("alpha utterance", FRAME);
    await c.store("delta utterance", APPROVED_REPLY, FRAME);
    expect((await c.lookup("beta utterance", FRAME)).hit).toBe(false);
    expect((await c.lookup("alpha utterance", FRAME)).hit).toBe(true);
  });

  test("expired entries are not served and are swept out", async () => {
    let clock = 1_000;
    const c = new SemanticCache({ ttlMs: 100, now: () => clock });
    await c.store("half an hour later", APPROVED_REPLY, FRAME);
    expect((await c.lookup("half an hour later", FRAME)).hit).toBe(true);
    clock += 101;
    const after = await c.lookup("half an hour later", FRAME);
    expect(after.hit).toBe(false);
    expect(c.size).toBe(0);
  });

  test("clear() empties the cache and the refusal log", async () => {
    const c = cacheWith();
    await c.store("hello", APPROVED_REPLY, FRAME);
    await c.storeApproved("", { text: "x", ...FRAME });
    c.clear();
    expect(c.size).toBe(0);
    expect(c.refused()).toHaveLength(0);
  });

  test("an unbounded maxEntries or ttlMs is clamped to something usable", async () => {
    const c = new SemanticCache({ maxEntries: 0, ttlMs: -5 });
    await c.store("hello", APPROVED_REPLY, FRAME);
    expect(c.size).toBe(1);
    expect((await c.lookup("hello", FRAME)).hit).toBe(true);
  });
});

/* ──────────────────────────────── the singleton ──────────────────────────────── */

describe("the process-wide instance", () => {
  test("is one object, and resettable for tests and tenant isolation", async () => {
    resetDefaultSemanticCache();
    const a = defaultSemanticCache();
    expect(defaultSemanticCache()).toBe(a);
    await a.store("shared utterance", APPROVED_REPLY, FRAME);
    expect((await defaultSemanticCache().lookup("shared utterance", FRAME)).hit).toBe(true);
    resetDefaultSemanticCache();
    expect(defaultSemanticCache()).not.toBe(a);
    expect(defaultSemanticCache().size).toBe(0);
  });
});

/* ───────────────────────────── the safety contract ───────────────────────────── */

describe("the cache cannot be made to speak a commitment", () => {
  // One end-to-end statement of the invariant, over the whole surface: every
  // intent, every write path, every read path.
  const DANGEROUS = ["deny_fraud", "confirm_authorized", "doubt", "handoff"] as const;

  for (const intent of DANGEROUS) {
    test(`no path stores or serves ${intent}`, async () => {
      const c = cacheWith();
      const ctx = { ...FRAME, intent };
      const reply = "Your card is frozen and a specialist has been alerted.";
      const decision = await c.storeApproved(reply, { text: "it was fraud", ...ctx });
      expect(decision.stored).toBe(false);
      expect(decision.reason).toBe("commitment_intent");
      // Even the raw door, checked under its true intent on the way out.
      await c.store("it was fraud", reply, ctx);
      expect((await c.lookup("it was fraud", ctx)).hit).toBe(false);
      expect(c.size).toBeLessThanOrEqual(1);
    });
  }
});
