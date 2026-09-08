/**
 * Lightweight, deterministic distress/panic detection over the customer turn —
 * flags the call for a human operator takeover (checklist #19) without an LLM
 * dependency or extra latency.
 *
 * Signals: panic/distress vocabulary, repetition (agitation), help-seeking,
 * third-party pressure ("someone is telling me"), and elderly-vulnerability
 * cues — across the supported languages.
 *
 * Returns a coarse sentiment plus an escalation recommendation. Escalation is
 * conservative: when in doubt, hand to a human.
 */

export type Sentiment = "calm" | "distressed" | "confused";

export type SentimentResult = {
  sentiment: Sentiment;
  escalate: boolean;
  reason?: string;
};

const DISTRESS = [
  // en
  "scared", "afraid", "panicking", "panic", "help me", "help!", "police", "crying", "terrified", "freaking out",
  "my savings", "all my money", "please help", "i don't know what to do",
  // ar
  "أنا خائف", "أنا خائفة", "مساعدة", "الشرطة", "أنا خوف", "كل أموالي", "أنقذوني",
  // hi
  "डर गया", "डर गई", "मदद", "पुलिस", "मेरी सारी", "बचाओ",
  // ur
  "خوف", "مدد", "پولیس", "میری ساری", "بچاؤ",
  // fr
  "j'ai peur", "peur", "au secours", "la police", "tout mon argent", "aidez-moi",
  // sw
  "naogopa", "ogopa", "msaada", "polisi", "pesa zote",
];

const CONFUSION = [
  "what?", "who is this", "i don't understand", "what do you mean", "confused",
  "ماذا", "لا أفهم", "من أنت", "क्या", "समझ नहीं", "کیا", "سمجھ نہیں",
  "quoi", "je ne comprends", "qui êtes", "nini", "sieui", "sielewi",
];

const THIRD_PARTY_PRESSURE = [
  "someone is telling me", "he is telling me", "she told me to", "the man on the other",
  "on the phone with me", "أمامي يقول", "कोई कह रहा", "کوئی کہہ", "quelqu'un me dit", "mtu ananiambia",
];

export function analyzeSentiment(text: string): SentimentResult {
  const t = text.toLowerCase();

  for (const m of DISTRESS) {
    if (t.includes(m)) {
      return { sentiment: "distressed", escalate: true, reason: `distress marker: "${m}"` };
    }
  }
  for (const m of THIRD_PARTY_PRESSURE) {
    if (t.includes(m)) {
      // classic social-engineering tell: the caller is being coached live
      return { sentiment: "distressed", escalate: true, reason: "possible live coaching / third-party pressure" };
    }
  }
  for (const m of CONFUSION) {
    if (t.includes(m)) {
      return { sentiment: "confused", escalate: false, reason: `confusion marker: "${m}"` };
    }
  }

  // agitation: the same short turn repeated quickly reads as panic
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length >= 3 && new Set(words).size <= Math.ceil(words.length / 2)) {
    return { sentiment: "distressed", escalate: true, reason: "repetitive/agitated phrasing" };
  }

  return { sentiment: "calm", escalate: false };
}
