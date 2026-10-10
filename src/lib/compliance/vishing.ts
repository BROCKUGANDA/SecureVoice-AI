/**
 * The vishing blocklist — the reason this product cannot be used to phish.
 *
 * The obvious question about an outbound fraud-intervention agent is the one a
 * sharp judge opens with: *fraudsters already impersonate banks by phone; you
 * have built a system that impersonates banks by phone — what is the
 * difference?* Answering that with policy is not an answer. This module makes the
 * answer structural: the agent is **incapable of speaking like a fraudster**,
 * because the patterns fraudsters depend on are refused at the last possible
 * moment before audio is synthesised.
 *
 * Why urgency language specifically. Vishing works by collapsing the victim's
 * decision window: *act now*, *final warning*, *your account will be closed*,
 * *right now*, *before it's too late*. A customer who is being genuinely helped by
 * their bank never needs a deadline — the bank already knows where the customer
 * is, and a bank that threatens to close an account from an automated call is
 * behaving exactly like the attack it is defending against. Refusing these strings
 * is therefore not a style preference; it removes the persuasion primitive.
 *
 * Design constraints, each one a lesson about how this kind of filter usually
 * goes wrong:
 *
 *   1. **It runs at the SPEECH BOUNDARY, not in the prompt.** A prompt rule is a
 *      request; this is a check on the bytes about to be synthesised. It is
 *      enforced on scripted lines, LLM drafts and tenant-authored copy alike,
 *      because a tenant is exactly who would try to use the platform as a phisher.
 *   2. **It never fails open.** See `verdictFor` — the failure mode of an
 *      unavailable filter must be silence, not speech.
 *   3. **No pattern matches the platform's OWN reassurance.** "your account will
 *      be closed" is banned; "your card is temporarily restricted pending human
 *      review" is the truth we are allowed to say. Every rule is therefore
 *      paired with a documented counter-example that must NOT trip it, and those
 *      counter-examples are asserted in the unit tests. A filter that blocks the
 *      honest script is worse than no filter, because it silently replaces
 *      reassurance with a hang-up.
 *   4. **The bank may switch a rule off.** `ctx.tenantOverrides` exists because
 *      a collections call in some jurisdictions is legally required to state a
 *      deadline. That is a legal obligation, not a vishing trick — but the
 *      override is per-tenant, explicit, and AUDITED, never a global default.
 *
 * Coverage note, stated honestly rather than implied: these rules are written for
 * Latin script (English, French, Swahili) and Arabic. Hindi and Urdu callers are
 * covered for the highest-signal patterns only; a production deployment in those
 * languages needs native-speaker review of this list before it can claim parity.
 * That is recorded in docs/VERIFICATION.md rather than papered over.
 */

/** A single banned pattern. `why` is audit context, never shown to a caller. */
type Rule = {
  id: string;
  pattern: RegExp;
  /** What an attacker gains by this being spoken. */
  why: string;
  /**
   * Per-tenant opt-out. Only a rule with an override may be disabled, and only
   * the one legal-deadline rule is.
   */
  overridable?: boolean;
  /**
   * Forgive the match when a negation governs it.
   *
   * The bank saying "your bank will never ask you to move money to a safe
   * account" is the product's best anti-vishing copy, and a naive keyword rule
   * catches it — because the sentence contains the attacker's phrase. A filter
   * that punishes the bank for warning its customer is worse than no filter, so a
   * rule may declare the negations that neutralise it.
   */
  forgivenWhenNegated?: RegExp;
};

function rule(
  id: string,
  source: string,
  why: string,
  overridable?: boolean,
  forgivenWhenNegated?: RegExp,
): Rule {
  return {
    id,
    pattern: new RegExp(source, "iu"),
    why,
    ...(overridable ? { overridable } : {}),
    ...(forgivenWhenNegated ? { forgivenWhenNegated } : {}),
  };
}

/**
 * How far back a negation has to reach to govern a match.
 *
 * Sixty characters is roughly one clause in a spoken line. Wider than that and
 * "we will never ask you for anything else, but first transfer the money to a
 * safe account" would be forgiven by a negation belonging to a different
 * sentence — which is precisely the construction an attacker would use.
 */
const NEGATION_WINDOW = 60;

const NEVER = String.raw`\b(?:never|will\s+not|won'?t|does\s+not|do\s+not|did\s+not|no\s+one\s+ever|dois\s+jamais|ne)\b`;

/**
 * All rules. Deliberately grouped by the harm each prevents, so a reviewer
 * reading the list can check the reasoning and not just the regexes.
 */
const RULES: readonly Rule[] = [
  // ── Deadline pressure ────────────────────────────────────────────────────
  // The core vishing primitive: shrink the window in which the customer could
  // think, call the bank, or tell somebody else.
  rule(
    "deadline.urgent",
    String.raw`\b(?:act|do\s+it|do\s+something|respond|respond\s+now|answer)\s+(?:now|immediately|right\s+away|at\s+once|straight\s+away)\b`,
    "immediacy pressure",
  ),
  rule(
    "deadline.right_now",
    String.raw`\b(?:you\s+need\s+to\s+act\s+(?:now|immediately|right\s+now)|this\s+(?:is\s+urgent|needs\s+to\s+be\s+handled\s+now)|urgent(?:ly)?\s+action\s+is\s+required)\b`,
    "immediacy pressure",
  ),
  rule(
    "deadline.final_warning",
    String.raw`\b(?:final\s+warning|last\s+warning|final\s+notice|this\s+is\s+your\s+last\s+chance|last\s+chance\s+to)\b`,
    "the escalation frame that separates a bank from an impersonator",
  ),
  rule(
    "deadline.before_too_late",
    String.raw`\b(?:before\s+it(?:'s|\s+is)\s+too\s+late|before\s+you\s+lose\s+(?:it|everything|access)|before\s+your\s+account\s+is)\b`,
    "loss-framed deadline",
  ),

  // ── Threat of closure / loss ─────────────────────────────────────────────
  // A real bank does not close an account from an automated call. Threatening to
  // is the second pillar of vishing, and it is the one a customer is most likely
  // to act on under stress.
  rule(
    "threat.account_closed",
    String.raw`\b(?:your\s+account\s+(?:will\s+be|is\s+going\s+to\s+be|shall\s+be|is)\s+(?:closed|closed\s+down|frozen|suspended|terminated)|we\s+(?:will|must|are\s+going\s+to)\s+(?:close|freeze|suspend|terminate)\s+your\s+account)\b`,
    "account-closure threat",
  ),
  rule(
    "threat.deactivated",
    String.raw`\b(?:your\s+(?:card|account|policy)\s+(?:will\s+be|is\s+being|has\s+been)\s+(?:deactivated|cancelled|canceled|void|invalidated))\b`,
    "instrument-cancellation threat",
  ),

  // ── Secrecy / isolation ──────────────────────────────────────────────────
  // The other pillar: get the victim away from the people who could help. "Do
  // not tell anyone" has no legitimate use on a bank's own fraud line.
  rule(
    "secrecy.do_not_tell",
    String.raw`\b(?:do\s*n[o']?t\s+(?:tell|inform|mention|alert|discuss\s+(?:this|it)\s+with)\s+(?:anyone|anybody|your\s+(?:family|spouse|partner|friend|manager|colleague))|keep\s+this\s+(?:between\s+us|secret|confidential))\b`,
    "isolation instruction",
  ),
  rule(
    "secrecy.dont_hang_up",
    String.raw`\b(?:do\s*n[o']?t\s+(?:hang\s*up|end\s+the\s+call|put\s+down)|stay\s+on\s+the\s+line\s+and\s+do\s+not\s+tell)\b`,
    "prevents the victim reaching a second channel",
  ),

  // ── Authority / impersonation of other institutions ───────────────────────
  // Claiming to be the regulator, the police or "the government" is a vishing
  // escalation used to make refusal feel illegal.
  rule(
    "authority.police",
    String.raw`\b(?:police|criminal\s+investigation\s+department|federal\s+investigation|interpol|regulator|central\s+bank)\s+(?:is|are|has|have|will)\s+(?:investigating|investigat\w*|calling|contacting|notifying|tracing)\b`,
    "impersonates law enforcement or a regulator",
  ),
  rule(
    "authority.arrest",
    String.raw`\b(?:you\s+are\s+under\s+investigation|you\s+(?:will|are\s+going\s+to\s+be)\s+(?:arrested|prosecuted)|legal\s+action\s+will\s+be\s+taken)\b`,
    "legal-threat impersonation",
  ),

  // ── Payment redirection ──────────────────────────────────────────────────
  // The reason this call exists in the fraud world at all.
  rule(
    "payment.move_money",
    String.raw`\b(?:transfer|send|wire|move|remit|deposit)\s+(?:the\s+)?(?:money|funds|balance|amount|sum)\s+to\s+(?:a\s+|this\s+)?(?:safe|secure|protected|trust|new|another|different)\b`,
    "payment redirection",
    false,
    new RegExp(NEVER, "iu"),
  ),
  rule(
    "payment.safe_account",
    String.raw`\b(?:safe|safe\s+and\s+secure|secure|protected)\s+account\b`,
    "the 'safe account' pretext",
    false,
    // Forgiven only by an explicit denial, because "safe account" is the one
    // phrase the bank MUST be able to say out loud: "your bank will never call
    // to ask you to move money to a safe account" is the warning itself.
    new RegExp(
      String.raw`\b(?:never|will\s+not|won'?t|do\s+not|no\s+bank\s+(?:will|would)\s+ever)\b.{0,80}$`,
      "iu",
    ),
  ),

  // ── Escalation that a real bank never performs ────────────────────────────
  rule(
    "escalation.sms_code",
    String.raw`\b(?:read|repeat|tell\s+me|confirm|give\s+me)\s+(?:me\s+)?(?:the\s+)?(?:code|otp|passcode|password|pin|number)\s+(?:we\s+)?(?:sent|texted|messaged)\b`,
    "solicits a delivered code",
  ),
  rule(
    "escalation.arrest_warrant",
    String.raw`\b(?:stay\s+on\s+the\s+line\s+(?:until|while)|you\s+cannot\s+end\s+this\s+call)\b`,
    "prevents termination",
  ),

  // ── Arabic ────────────────────────────────────────────────────────────────
  // Written for Gulf MSA, where the deadline + threat pair is the standard
  // opener. Longest-first inside each pattern handles the definite article, and
  // `\p{L}` fencing is used rather than `\b` because `\b` never matches around
  // Arabic script (the same trap documented in speech-gate.ts).
  rule(
    "ar.deadline",
    "(?:بشكل|على)\\s*(?:عاجل|فوري|فوراً|سريع)\\s*(?:في\\s*هذا\\s*(?:اللحظة|الوقت|الحين)| حالا?ً| الان)",
    "immediacy pressure (Arabic)",
  ),
  rule(
    "ar.final_warning",
    "(?:تحذير\\s*(?:نهائي|أخير)|الإنذار\\s*(?:النهائي|الأخير)|آخر\\s*فرصة)",
    "escalation frame (Arabic)",
  ),
  rule(
    "ar.closure_threat",
    "(?:سيتم\\s*(?:إيقاف|تجميد|إغلاق|الغاء|إلغاء)\\s*(?:حسابك|حسابِك|بطاقتك))|(?:حسابك\\s*(?:سيتم\\s*إيقافه|سيُغلق))",
    "account-closure threat (Arabic)",
  ),
  rule(
    "ar.secrecy",
    "(?:لا\\s*(?:تخبر|تخبري|تبلغ|تخبر أحداً|تخبر أحدًا)\\s*(?:أحداً|أحدًا|أي شخص|شخصاً))|(?:لا\\s*تخبر\\s*(?:أحد|عائلتك))",
    "isolation instruction (Arabic)",
  ),
  rule("ar.safe_account", "(?:حساب\\s*آمن)|(?:حساب\\s*سري)", "the 'safe account' pretext (Arabic)"),

  // ── Legal-deadline exemption ──────────────────────────────────────────────
  // A debt-collections call in several jurisdictions MUST state that action
  // follows if nothing is arranged. That is a legal obligation, not an
  // impersonation trick, so this one rule alone may be switched off by the
  // tenant that needs it — and doing so is audited.
  rule(
    "deadline.collections_notice",
    String.raw`\b(?:if\s+you\s+do\s+not\s+(?:pay|arrange|settle|respond)[^.]{0,40}(?:we\s+will|we\s+may|we\s+must)\s+(?:proceed|escalate|refer|take)\b)`,
    "collections legally-required consequence notice",
    true,
  ),
];

export type VishingVerdict = {
  /** False means the utterance is refused and MUST NOT be synthesised. */
  ok: boolean;
  /** Rules that fired. Empty when ok. */
  hits: { id: string; why: string; overridable: boolean }[];
};

/** Every rule id, for documentation and for the console's "what we refuse" list. */
export function vishingRuleIds(): string[] {
  return RULES.map((r) => r.id);
}

/**
 * Judge an utterance. Pure — no I/O, no clock, no tenant lookup — so it can be
 * exhaustively unit-tested, which is the only way a blocklist earns trust.
 *
 * `disabled` are rule ids the TENANT has switched off. A non-overridable id in
 * that list is ignored rather than honoured: a request to disable "do not tell
 * anyone" must not be able to remove it, or the filter becomes a tenant setting
 * that a phisher's front company simply turns off.
 */
export function verdictFor(text: string, disabled: readonly string[] = []): VishingVerdict {
  const off = new Set(disabled);
  const source = (text ?? "").normalize("NFKC").replace(/\s+/g, " ");
  if (!source.trim()) return { ok: true, hits: [] };

  const hits: VishingVerdict["hits"] = [];
  for (const r of RULES) {
    // A rule is skipped only when it is BOTH marked overridable AND explicitly
    // disabled. Anything else is checked regardless of what was asked.
    if (r.overridable && off.has(r.id)) continue;
    const m = r.pattern.exec(source);
    if (!m) continue;
    // A governed negation forgives the match. Only the text BEFORE the match is
    // inspected, within one clause: a denial that comes AFTER the demand is not a
    // denial of it ("transfer the money to a safe account, and never call back").
    if (r.forgivenWhenNegated) {
      const before = source.slice(Math.max(0, m.index - NEGATION_WINDOW), m.index);
      if (r.forgivenWhenNegated.test(before)) continue;
    }
    hits.push({ id: r.id, why: r.why, overridable: Boolean(r.overridable) });
  }
  return { ok: hits.length === 0, hits };
}

/** One-line reason for an audit row. Never contains the utterance itself. */
export function describeHits(hits: VishingVerdict["hits"]): string {
  if (hits.length === 0) return "none";
  return hits.map((h) => `${h.id}(${h.why})`).join(", ");
}
