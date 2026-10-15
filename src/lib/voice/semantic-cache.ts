import "server-only";
/**
 * A semantic reply cache for the live voice turn.
 *
 * ## Why this exists
 *
 * A fraud-intervention call is structurally repetitive. The caller answers, the
 * agent asks one of a handful of follow-ups, the caller answers again. Across a
 * single call the SAME intents recur; across a day they recur thousands of
 * times. Every one of those turns is a full LLM round-trip: a provider request,
 * money, and latency the customer spends in dead air.
 *
 * Most of those replies are interchangeable. "yes" is "yes" in every fraud call
 * this platform has ever made, and the scripted line that answers it was written
 * and reviewed by a human. Re-deriving it per call buys nothing and costs the
 * thing the voice plane is actually optimising for: time-to-first-audio.
 *
 * ## Why this module is a SAFETY-SENSITIVE component, not a speed trick
 *
 * A cache that returns a previously-approved reply is a cache that can return a
 * previously-APPROVED LIE. Every rule below exists because the failure it
 * prevents is not "the caller waited a second longer" — it is the bank telling
 * a fraud victim, repeatedly and permanently, that their card is frozen when
 * only a human specialist may decide that.
 *
 *   1. **A commitment is never cached.** `src/lib/llm.ts` already refuses to let
 *      a model rephrase `deny_fraud`, `confirm_authorized`, `doubt` and
 *      `handoff`, because those intents carry something the customer will rely
 *      on. A cache is the same hazard with more reach: a scripted line is
 *      reviewed once, a cached line is reviewed once and then served forever,
 *      to everyone. Those intents are refused HERE TOO, at store time.
 *   2. **Admitted entries are RE-CHECKED on the way out.** `lookup` re-runs the
 *      same guards against the reply it is about to hand back. That is what
 *      makes `store()` survivable: an unvetted write can still poison the
 *      store, but a poisoned entry can never be SERVED.
 *   3. **PII is never cached.** A cached reply outlives the call, outlives the
 *      process on a long-lived replica, and is invisible to the retention and
 *      crypto-shred paths that govern the database. A reply carrying a card
 *      number, a phone number or an email is therefore a record nobody can
 *      erase, created outside the erasure machinery. Refused outright.
 *   4. **Entries are namespaced by intent + language + call category.** A reply
 *      is only true inside the frame that produced it. An Arabic "confirm"
 *      spoken in response to an English "deny" is not a translation problem, it
 *      is a false statement to a customer about their own money.
 *
 * ## The default embedder is a LEXICAL FINGERPRINT, not a semantic model
 *
 * `lexicalEmbed` is a hashed character-3-gram vector. It catches near-identical
 * utterances ("that was not mine" / "that was not mine!") and completely
 * unrelated ones, and it does NOT catch paraphrase ("I never made that" vs "I
 * didn't authorise it"). That is a deliberate, documented limitation, not an
 * oversight: it needs no network, no key, and no cold start, so constructing
 * this cache can never fail open into an unconfigured state.
 *
 * The integration point for a real model is the injected `EmbedFn`. A deployment
 * points it at the OpenAI-compatible `/embeddings` route of whichever model it
 * already runs, or at the Pinecone inference endpoint this repo already speaks
 * to in `src/lib/pinecone/transcript-index.ts` (`pc.inference.embed`, model from
 * `PINECONE_EMBEDDING_MODEL`, gated on `PINECONE_API_KEY` + `PINECONE_INDEX` —
 * see `REAL_EMBEDDING_ENV`). Those env vars are already read there, so wiring a
 * real embedder adds no new key to the deployment.
 *
 * Raising `minSimilarity` narrows what counts as a hit and makes paraphrase
 * false-positive-free; the default below is tuned for the fingerprint.
 */

import { spokenOutputIsSafe } from "@/lib/llm-guard";
import { verdictFor, describeHits } from "@/lib/compliance/vishing";
import { asCallCategory } from "@/lib/call-categories";
import * as redact from "@/lib/redact";
import { redactPII } from "@/lib/compliance/redactor";

/**
 * Intents whose reply is a COMMITMENT and is therefore never cached.
 *
 * This mirrors `SCRIPTED_ONLY` in `src/lib/llm.ts`, which is module-private and
 * cannot be imported without dragging Prisma and the provider ladder into every
 * consumer. The duplication is load-bearing, so it is pinned by a test that
 * reads the source of `llm.ts` and fails if the two sets drift — a silent drift
 * here would mean caching exactly the intents the other file refuses to rephrase.
 */
export const COMMITMENT_INTENTS: ReadonlySet<string> = new Set([
  "deny_fraud",
  "confirm_authorized",
  "doubt",
  "handoff",
]);

/** The env vars that already exist in this deployment for a real embedding model. */
export const REAL_EMBEDDING_ENV = [
  "PINECONE_API_KEY",
  "PINECONE_INDEX",
  "PINECONE_EMBEDDING_MODEL",
] as const;

/** Dimension of the local fingerprint vector. Power of two, so `%` is a mask. */
export const EMBED_DIM = 256;

/** Caller speech is capped at 400 chars upstream; this is the belt-and-braces cap. */
export const MAX_EMBED_CHARS = 512;

/** Default cache bounds. Bounded because a long-lived process is the leak. */
export const DEFAULT_MAX_ENTRIES = 256;
export const DEFAULT_TTL_MS = 15 * 60_000;
export const DEFAULT_MIN_SIMILARITY = 0.9;

/**
 * Injected embedding. Async because a real model is a network call, and the
 * default is not — which is exactly why it is an interface rather than a branch
 * inside the cache: a caller that injects a network embedder must handle its
 * failure, and `lookup` does that for them by degrading to a miss.
 */
export type EmbedFn = (text: string) => Promise<number[]>;

export type SemanticCacheResult = {
  hit: boolean;
  reply: string;
  source: "cache" | "miss";
  /** Cosine similarity of the winning entry. Present on a hit; best-effort on a miss. */
  similarity?: number;
};

/** Why a reply was refused. Every value is a bug someone tried to ship. */
export type CacheRefusalReason =
  | "empty_text"
  | "empty_reply"
  | "commitment_intent"
  | "account_action_claim"
  | "output_unsafe"
  | "vishing_pattern"
  | "pii";

export type StoreDecision = {
  stored: boolean;
  reason?: CacheRefusalReason;
  /** Audit context for a refusal — the rules that fired, never the reply text. */
  detail?: string;
};

/** The frame a reply is only true inside. Never defaulted silently on lookup. */
export type CacheContext = {
  intent: string;
  language: string;
  callCategory: string;
};

/** Proof that a reply passed every downstream guard. Explicit, not inferred. */
export type ApprovalProof = CacheContext & {
  /**
   * The CALLER's utterance this reply answered — the lookup key.
   *
   * It has to travel with the approval: the guards prove a reply is safe, and
   * this is what says which question it was safe ANSWER. Without it there is no
   * cache, only a list of sentences nobody can match a turn to.
   */
  text: string;
};

export type SemanticCacheOptions = {
  maxEntries?: number;
  ttlMs?: number;
  minSimilarity?: number;
  embed?: EmbedFn;
  /** Injectable clock so TTL expiry is asserted without sleeping. */
  now?: () => number;
};

type CacheEntry = {
  /**
   * Unique per write, from a counter — NOT derived from the reply.
   *
   * A reply-derived key collides the moment two caller turns ("yes" and "yeah")
   * are answered by the same line, and the collision silently deletes the older
   * vector. Silently: the cache still returns correct answers, just fewer of
   * them, which is the kind of regression nobody finds from a hit-rate chart.
   */
  key: string;
  namespace: string;
  vector: number[];
  reply: string;
  context: CacheContext;
  storedAt: number;
  expiresAt: number;
};

/* ─────────────────────────── lexical fingerprint ─────────────────────────── */

/** Arabic marks that carry no meaning for matching: tashkeel and tatweel. */
const ARABIC_MARKS = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g;

/**
 * Fold caller speech to a comparable form.
 *
 * Arabic normalisation is load-bearing, not cosmetic: speech-to-text returns
 * the same sentence with a maddah on the first letter, a different alef form
 * and a final ى instead of ي, and an unnormalised match misses all of them.
 * The letter forms are unified as well — أ إ آ ٱ → ا, ى → ي, ة → ه — for the
 * same reason. `\p{L}`/`\p{N}` keeps every script; the same trap `\b` sets
 * around Arabic is documented in `src/lib/compliance/vishing.ts`.
 *
 * `src/lib/voice/wrong-number.ts` folds identically. Two modules that disagree
 * about what "the same utterance" means would give the cache and the detector
 * different answers to the same caller turn.
 */
export function foldUtterance(raw: string): string {
  return (
    (raw ?? "")
      .normalize("NFKC")
      .replace(ARABIC_MARKS, "")
      .replace(/[أإآٱ]/g, "ا")
      .replace(/ى/g, "ي")
      .replace(/ة/g, "ه")
      // Apostrophes fold away BEFORE punctuation, so "isn't" is one token rather
      // than two ("isn t") and a contraction cannot hide from a phrase rule.
      .replace(/['’`]/g, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/** FNV-1a. Chosen because it is four lines, allocation-free, and stable forever. */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function l2Normalize(vec: number[]): number[] {
  let sum = 0;
  for (const v of vec) sum += v * v;
  const norm = Math.sqrt(sum);
  if (norm === 0) return vec;
  for (let i = 0; i < vec.length; i++) vec[i] = vec[i]! / norm;
  return vec;
}

/**
 * The default embedder: a signed hashed character-3-gram fingerprint.
 *
 * Signed hashing (the hash's top bit picks +1 / -1) rather than plain counting,
 * because unsigned hashing makes every collision positive and drags unrelated
 * vectors toward a cosine of ~0.5, which would let a lenient `minSimilarity`
 * match a greeting against a fraud disclaimer.
 *
 * Padding with spaces puts word boundaries inside the gram stream, so "call back"
 * and "callback" land in different buckets instead of sharing grams.
 */
export const lexicalEmbed: EmbedFn = async (text: string) => {
  const folded = foldUtterance(text).slice(0, MAX_EMBED_CHARS);
  const padded = ` ${folded} `;
  const vec = new Array<number>(EMBED_DIM).fill(0);
  if (folded.length === 0) return vec;
  for (let i = 0; i + 3 <= padded.length; i++) {
    const hash = fnv1a(padded.slice(i, i + 3));
    const slot = hash % EMBED_DIM;
    const sign = (hash >>> 31) & 1 ? -1 : 1;
    vec[slot] = vec[slot]! + sign;
  }
  return l2Normalize(vec);
};

/**
 * Cosine similarity. Exported because the cache's entire notion of "close
 * enough" is this function, and a security-relevant threshold nobody can test
 * directly is a threshold nobody has tested.
 *
 * Returns 0 — never NaN — for a length mismatch or a zero vector, because the
 * callers compare against a positive `minSimilarity` and a NaN comparison is
 * always false in a way that reads like a cache miss rather than a bug.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (!Array.isArray(a) || !Array.isArray(b)) return 0;
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  const cos = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  // Floating point can push a self-comparison to 1.0000000000000002.
  return Math.max(-1, Math.min(1, cos));
}

/* ─────────────────────────────── admission ─────────────────────────────── */

function namespaceOf(ctx: CacheContext): string {
  return `${ctx.intent}|${ctx.language}|${ctx.callCategory}`;
}

/**
 * The PII test, run against BOTH of the repo's redaction pipelines.
 *
 * The rule is "the redactors would have changed this string", which is the only
 * formulation that stays true as the patterns are extended: a new PAN shape
 * added to `src/lib/redact.ts` automatically starts being refused here, without
 * anyone remembering this file. Running both pipelines is deliberate — they
 * cover different shapes (`transcript` knows IBAN and OTP-in-context,
 * `redactPII` knows SSN and phone runs), and a cache outliving the call means
 * one pass is not enough.
 */
export function containsPII(text: string): boolean {
  if (!text) return false;
  return redact.transcript(text) !== text || redactPII(text) !== text;
}

/**
 * Claims the agent has no authority to make.
 *
 * This is the "do not trust the caller's label alone" half of the commitment
 * rule. `COMMITMENT_INTENTS` refuses the four intents that carry a promise, but
 * an intent is a string on the way in: a caller that labels a `deny_fraud` turn
 * `clarify` gets straight past a set lookup. So the REPLY ITSELF is read for an
 * account action that only a human may decide, and a "clarify"-labelled reply
 * saying "your card is frozen" is refused exactly like the labelled one.
 *
 * It is the system prompt's "NEVER say a card or account is frozen, blocked,
 * cancelled or closed" turned into a check on the bytes about to be spoken.
 * The platform's own truthful copy is deliberately not caught: `conversation.ts`
 * says a card is "temporarily restricted" and that "we have placed a temporary
 * hold", and both are the truth we are allowed to state.
 */
const ACCOUNT_ACTION_CLAIMS: readonly RegExp[] = [
  // The adverb slot is not decoration. "Your card has been blocked" was caught
  // and "your card has been PERMANENTLY blocked" was not, which is the worst
  // possible shape for this list: the more final the claim, the likelier it is to
  // be phrased with an adverb, and the likelier it is to slip past.
  /\byour\s+(?:card|account|policy|balance)\s+(?:is|are|has\s+been|have\s+been|was|were)(?:\s+(?:now|still|permanently|temporarily|immediately|fully|already|just|also|being|been|confirmed))?\s+(?:frozen|blocked|closed|cancelled|canceled|terminated|suspended|deactivated|void)/iu,
  /\b(?:we|the\s+bank|i)\s+(?:have|has|had)\s+(?:frozen|blocked|closed|cancelled|canceled|terminated|suspended|deactivated)\s+(?:your|the)\b/iu,
  /\b(?:frozen|blocked|closed|cancelled|canceled|terminated)\s+your\s+(?:card|account)\b/iu,
  // A promise of money back. No component of this platform can authorise it.
  /\b(?:a|the|full)\s+refund\s+(?:has\s+been|was|will\s+be)\s+(?:issued|processed|approved|granted)\b/iu,
  /\bwe\s+(?:will|have|can)\s+refund\s+you\b/iu,
  // "We caught the fraudster" is a commitment too — it is the outcome the call
  // exists to find out, and no automated turn knows it.
  /\b(?:the\s+)?fraud(?:ster)?\s+(?:has\s+been|was)\s+(?:caught|arrested|identified|apprehended|apprehend)/iu,
  /\b(?:i|we)\s+have\s+closed\s+(?:your|the)\s+case\b/iu,
  // Arabic — same claims, same authority problem. No `\b`: it does not match
  // around Arabic script (see src/lib/compliance/vishing.ts).
  /(?:بطاقتك|بطاقتكِ|حسابك|حسابِك|سياستك)\s*(?:تم\s*)?(?:تجميد|تجميداً|تجميدًا|إيقاف|إلغاء|إلغاءً|إغلاق|إلغاء)/u,
  /(?:تم|قد\s*تم|تمَّ)\s*(?:تجميد|إيقاف|إلغاء|إغلاق)\s*(?:بطاقتك|حسابك)/u,
  /(?:سنقوم|سوف\s*نقوم|تم)\s*برد\s*(?:المبلغ|أموالك)/u,
  /(?:تم|قد\s*تم)\s*إبلاغ\s*(?:الشرطة|السلطات)/u,
];

/** True when the reply asserts an account action only a human may decide. */
export function assertsAccountAction(text: string): boolean {
  if (!text) return false;
  const s = text.normalize("NFKC").replace(/\s+/g, " ");
  return ACCOUNT_ACTION_CLAIMS.some((p) => {
    p.lastIndex = 0;
    return p.test(s);
  });
}

/**
 * The single admission predicate. Store time AND lookup time — one function, so
 * the two can never diverge into "safe to write" and "safe to say".
 */
function admit(reply: string, ctx: CacheContext): StoreDecision {
  const trimmed = (reply ?? "").trim();
  if (!trimmed) return { stored: false, reason: "empty_reply" };
  // First the label, then the text. Either alone is spoofable; together they
  // are the answer to "can a commitment reach a customer's ear from here".
  if (COMMITMENT_INTENTS.has(ctx.intent)) {
    return { stored: false, reason: "commitment_intent", detail: ctx.intent };
  }
  // The label is a string on the way in. The claim is in the reply, so the
  // reply is what gets checked — see assertsAccountAction.
  if (assertsAccountAction(trimmed)) {
    return { stored: false, reason: "account_action_claim" };
  }
  if (!spokenOutputIsSafe(trimmed)) {
    return { stored: false, reason: "output_unsafe" };
  }
  const vishing = verdictFor(trimmed);
  if (!vishing.ok) {
    return { stored: false, reason: "vishing_pattern", detail: describeHits(vishing.hits) };
  }
  if (containsPII(trimmed)) {
    return { stored: false, reason: "pii" };
  }
  return { stored: true };
}

/* ──────────────────────────────── the cache ─────────────────────────────── */

/**
 * Bounded, TTL'd, LRU reply cache.
 *
 * Process-local, for the same reason `src/lib/cache.ts` is: a shared store is
 * the right answer once a value is worth sharing across replicas, and a
 * per-turn reply is only worth sharing by whoever draws the next caller with the
 * same opening question. The cost is a cold cache per replica, which is bounded
 * by the TTL and is the cheap failure.
 */
export class SemanticCache {
  /** Insertion-ordered, so the first key is the least recently used. */
  private readonly entries = new Map<string, CacheEntry>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly minSimilarity: number;
  private readonly embedFn: EmbedFn;
  private readonly now: () => number;
  /** Bounded ring of refusals — the only "what did this cache refuse" signal. */
  private readonly refusals: { reason: CacheRefusalReason; detail?: string; at: number }[] = [];
  private static readonly REFUSAL_LOG_MAX = 50;
  private sequence = 0;

  constructor(opts: SemanticCacheOptions = {}) {
    this.maxEntries = Math.max(1, opts.maxEntries ?? DEFAULT_MAX_ENTRIES);
    this.ttlMs = Math.max(1, opts.ttlMs ?? DEFAULT_TTL_MS);
    this.minSimilarity = opts.minSimilarity ?? DEFAULT_MIN_SIMILARITY;
    this.embedFn = opts.embed ?? lexicalEmbed;
    this.now = opts.now ?? Date.now;
  }

  get size(): number {
    return this.entries.size;
  }

  /**
   * Nearest admitted reply for `text`, or a miss.
   *
   * The namespace is part of the lookup, not a filter applied afterwards: only
   * entries stored under the SAME intent + language + call category are
   * eligible. That is what makes an Arabic reply unable to answer an English
   * deny, and a routine-reminder reply unable to answer a fraud call.
   */
  async lookup(text: string, ctx?: Partial<CacheContext>): Promise<SemanticCacheResult> {
    const context = this.resolveContext(ctx);
    const namespace = namespaceOf(context);
    const query = await this.safeEmbed(text);
    if (!query) return { hit: false, reply: "", source: "miss" };

    const now = this.now();
    let best: CacheEntry | null = null;
    let bestScore = 0;
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key);
        continue;
      }
      if (entry.namespace !== namespace) continue;
      const score = cosineSimilarity(query, entry.vector);
      if (score > bestScore) {
        bestScore = score;
        best = entry;
      }
    }

    if (!best || bestScore < this.minSimilarity) {
      return best
        ? { hit: false, reply: "", source: "miss", similarity: bestScore }
        : { hit: false, reply: "", source: "miss" };
    }

    // RE-VALIDATE ON THE WAY OUT. This is the control that makes an unvetted
    // `store()` harmless: whatever got written, nothing that fails a guard is
    // ever spoken. It costs two regex passes over a short string — vastly less
    // than the provider round-trip the cache exists to avoid.
    if (!admit(best.reply, best.context).stored) {
      this.entries.delete(best.key);
      return { hit: false, reply: "", source: "miss", similarity: bestScore };
    }

    // LRU touch: re-inserting moves the entry to the young end of the Map.
    this.entries.delete(best.key);
    this.entries.set(best.key, best);
    return { hit: true, reply: best.reply, source: "cache", similarity: bestScore };
  }

  /**
   * RAW WRITE. No intent check, no output guard, no PII check.
   *
   * It exists for CONSTANTS — the fixed scripted lines, which are vetted once
   * and shipped in the source — and it is deliberately the ugly door next to
   * the safe one. Two facts make it survivable: `lookup` re-validates every hit,
   * so a poisoned write cannot be spoken; and it is the only way to seed the
   * cache without a live turn.
   *
   * If you are holding a reply that came from anywhere dynamic — an LLM, a
   * tenant, a database — you want `storeApproved`, not this.
   */
  async store(text: string, reply: string, ctx?: Partial<CacheContext>): Promise<void> {
    const vector = await this.safeEmbed(text);
    if (!vector) return;
    const context = this.resolveContext(ctx);
    this.write(vector, reply, context);
  }

  /**
   * The write the agent route uses, and the only one a dynamic reply may use.
   *
   * Every guard `src/lib/llm.ts` applies to a draft is re-applied here, because
   * a cached reply skips the code path that would have applied it. `intent` is
   * re-checked against the commitment deny-list rather than trusted: a caller
   * that mislabels `deny_fraud` as `clarify` is precisely the bug this refuses.
   */
  async storeApproved(reply: string, proof: ApprovalProof): Promise<StoreDecision> {
    const decision = admit(reply, proof);
    if (!decision.stored) {
      this.recordRefusal(decision);
      return decision;
    }
    const vector = await this.safeEmbed(proof.text);
    if (!vector) {
      const refusal: StoreDecision = { stored: false, reason: "empty_text" };
      this.recordRefusal(refusal);
      return refusal;
    }
    this.write(vector, reply.trim(), this.resolveContext(proof));
    return { stored: true };
  }

  /** Drops everything. Tests, and the tenant-isolation escape hatch. */
  clear(): void {
    this.entries.clear();
    this.refusals.length = 0;
  }

  /** The last refusals, newest last. Bounded; never contains a reply. */
  refused(): readonly { reason: CacheRefusalReason; detail?: string; at: number }[] {
    return this.refusals;
  }

  /* ─────────────────────────────── internals ─────────────────────────────── */

  private resolveContext(ctx?: Partial<CacheContext>): CacheContext {
    return {
      intent: ctx?.intent ?? "unscoped",
      language: ctx?.language ?? "unscoped",
      // `asCallCategory` collapses an unknown or missing category to the audited
      // default, so a caller that forgets it lands in one shared namespace
      // rather than minting a new one on every request and never hitting.
      callCategory: asCallCategory(ctx?.callCategory),
    };
  }

  private write(vector: number[], reply: string, context: CacheContext): void {
    const now = this.now();
    this.sequence += 1;
    const entry: CacheEntry = {
      key: `e${this.sequence}`,
      namespace: namespaceOf(context),
      vector,
      reply: reply.trim(),
      context,
      storedAt: now,
      expiresAt: now + this.ttlMs,
    };
    this.entries.set(entry.key, entry);
    // Evict from the cold end. Map preserves insertion order and `lookup`
    // re-inserts on a hit, so the first key is the least recently used.
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  private recordRefusal(decision: StoreDecision): void {
    if (!decision.reason) return;
    this.refusals.push({ reason: decision.reason, detail: decision.detail, at: this.now() });
    if (this.refusals.length > SemanticCache.REFUSAL_LOG_MAX) this.refusals.shift();
  }

  /**
   * An embedder that throws or returns a non-vector degrades to a MISS, never
   * to an exception. The cache sits on the latency-critical path of a live call:
   * a cache that can fail the call has made itself a liability, and "I could not
   * check the cache" is strictly better than silence.
   */
  private async safeEmbed(text: string): Promise<number[] | null> {
    // An empty utterance has no key, so it is refused before the embedder is
    // consulted: the default returns an all-zero vector, which would otherwise
    // be indistinguishable from a real one and would store an entry nothing can
    // ever match.
    if (!foldUtterance(text ?? "")) return null;
    try {
      const vec = await this.embedFn(text ?? "");
      if (!Array.isArray(vec) || vec.length === 0) return null;
      return vec.every((v) => Number.isFinite(v)) ? vec : null;
    } catch {
      return null;
    }
  }
}

/** Factory form, for callers that prefer not to `new`. */
export function createSemanticCache(opts?: SemanticCacheOptions): SemanticCache {
  return new SemanticCache(opts);
}

let shared: SemanticCache | null = null;

/**
 * The process-wide instance the voice route should use.
 *
 * Deliberately lazy so importing this module never constructs anything, and
 * process-local for the same reason `src/lib/cache.ts` is process-local: the
 * value is a reply to a question that repeats, not a decision anyone is gated
 * on. `isSingleInstance()` in `src/lib/cache.ts` is the honest caveat — with
 * multiple replicas each holds its own copy and a hit is a per-replica hit.
 */
export function defaultSemanticCache(): SemanticCache {
  shared ??= new SemanticCache();
  return shared;
}

/** Drops the process-wide instance. Tests, and tenant isolation. */
export function resetDefaultSemanticCache(): void {
  shared?.clear();
  shared = null;
}
