import "server-only";

/**
 * DTMF — the keypad channel, and the rules about what a keypad press is worth.
 *
 * ## Why this exists
 *
 * Today a caller on a fraud intervention has exactly one way to answer: speak.
 * That is a lossy channel. A line with crosstalk, a heavy accent, a background
 * conversation, a caller who cannot speak after laryngectomy, or a caller who
 * simply will not talk to an unknown number will fail the ASR, and the turn
 * loops until the unclear-turn ladder hands the call to a human. A keypress is
 * DTMF: it is carried in its own signalling channel, it is not affected by
 * line noise at all, and it needs no language and no vocabulary. On a bad line
 * it is *more* reliable than speech, not less — which is the whole reason it
 * belongs beside the speech path rather than after it.
 *
 * So this module supplies the three pieces the voice plane was missing:
 *   - a `<Gather>` that actually collects the presses,
 *   - a mapping from a key to an INTENT, and
 *   - the sentence the agent speaks back, per language.
 *
 * ## THE SECURITY RULE, and it is not negotiable
 *
 * **A keypad press carries no proof of identity.** It is a tone on a copper
 * pair. Anyone who can get the agent to dial a number — a spoofed caller ID, a
 * compromised account, a colleague standing at the desk — can press `2`. It is
 * in-band, unauthenticated, and replayable.
 *
 * Therefore: DTMF may ONLY ever classify INTENT. It must never be wired to
 * anything that authenticates, authorises, unblocks, or releases money. If a
 * future change makes `confirm_authorized` reachable from a keypress *without*
 * the institution's approved challenge flow behind it, that change is a
 * takeover vulnerability, not a feature. The same applies to the spoken
 * "yes": the keypress is a second way to say it, and it is worth exactly as
 * much as the sentence it replaces — no more.
 *
 * ## Why the input is treated as hostile
 *
 * Everything here arrives from a carrier POST body we did not author
 * (`Digits` on a `<Gather>` callback, see `src/app/api/twilio/turn/route.ts`
 * for the turn shape). A carrier field is attacker-influenced on any call the
 * platform did not place: anyone can POST a forged turn unless the webhook
 * signature check upstream has already failed them. So:
 *
 *   - nothing here throws. A throw on the turn route is a 500 and a dropped
 *     caller on a live fraud call; every refusal is a typed value instead.
 *   - a refusal is distinguishable from "the caller pressed nothing", because
 *     they are different events with different audit meaning.
 *   - the key→action table is DATA (`DEFAULT_DTMF_LAYOUT`), not control flow,
 *     so an institution can re-bind the keypad without a code change and
 *     without a forking an `if`-chain that only one of the branches is
 *     ever tested.
 *
 * ## Multi-press sequences
 *
 * `<Gather>` is built with `numDigits=1`, so Twilio normally hands us exactly
 * one key. A longer string still reaches this module — a legacy IVR leg that
 * collects two digits, a carrier that concatenates across Gather timeouts, a
 * queued press from a handset's predictive input — and the rule is:
 *
 *   - a burst of ONE key repeated (`"22"`) is the same intent pressed twice by
 *     a hand that slipped, and is honoured;
 *   - a burst of DIFFERENT keys (`"21"`) is refused as `ambiguous_multi_key`.
 *     Two different keys on a fraud call means we do not know which one the
 *     customer meant, and guessing is how a caller who said "1, that was not
 *     me" ends up recorded as having said "2, I authorised it". Refusing costs
 *     one re-prompt; guessing costs a frozen card that was never fraudulent.
 */

import { z } from "zod";
import { boundedInt, boundedString } from "@/lib/validation/schema";
import type { ConvLang } from "./conversation";

/* ── The action vocabulary ───────────────────────────────────────────────────── */

export const DTMF_ACTIONS = [
  "confirm_authorized",
  "deny_fraud",
  "request_human",
  "repeat",
  "cancel",
  "none",
] as const;

export type DtmfAction = (typeof DTMF_ACTIONS)[number];

export function isDtmfAction(value: unknown): value is DtmfAction {
  return typeof value === "string" && (DTMF_ACTIONS as readonly string[]).includes(value);
}

/**
 * Why a press did not become an action. Typed rather than an exception because
 * the turn route logs it and re-prompts: an exception here would surface as a
 * 500 on a live fraud call, and the caller would hear nothing at all.
 *
 * `absent` and `empty` are kept apart on purpose. "No `Digits` field in the
 * body" is the overwhelmingly common case (a speech-only turn) and says
 * nothing about the caller; `""` is a field that arrived and was empty, which
 * is what an interrupted Gather looks like. Collapsing them would make the audit
 * trail claim that interrupted callers never happened.
 */
export type DtmfRefusal =
  /** No value at all — Twilio omits `Digits` on a speech-only turn. */
  | "absent"
  /** Present, but empty or whitespace only. */
  | "empty"
  /** Not a string (a `FormData` File, a number from a JSON path, etc.). */
  | "not_a_string"
  /** Longer than any real Gather produces. */
  | "too_long"
  /** Contains something a keypad cannot send. */
  | "non_keypad_character"
  /** Two or more DIFFERENT keys in one burst — the customer's intent is unknown. */
  | "ambiguous_multi_key"
  /** A well-formed key with nothing bound to it in the active layout. */
  | "unmapped_key";

export type DtmfVerdict =
  { ok: true; action: DtmfAction } | { ok: false; reason: DtmfRefusal; detail: string };

/* ── The layout ──────────────────────────────────────────────────────────────── */

/**
 * The default key map, as DATA.
 *
 * The layout is deliberately not symmetric and not "1 = yes". On a fraud call
 * the two answers are not equivalent: "this was not me" is the answer that
 * needs to be cheapest and fastest to give, so it is `1` — the first digit a
 * hand lands on, and the one position memorised from every IVR ever dialled.
 * "Yes, I authorised it" is the answer we are least eager to collect, so it is
 * `2`: adjacent, but requiring the caller to have heard the question.
 *
 * `9` for a human, `0` to repeat, `*` to end the call — the conventional IVR
 * positions, because a caller who has pressed `9` for a person on another line
 * on the same day should not have to re-learn them here.
 *
 * `#` is bound to `none`: it is the key people press when a menu confuses them,
 * and the correct response to confusion is to say the options again, not to
 * guess what they meant.
 *
 * Keys `3`–`8` are intentionally unbound so that `{ ok: false, reason:
 * "unmapped_key" }` is a real, exercised outcome rather than a theoretical one.
 *
 * Overriding it is a data swap: pass your own frozen record to `mapDtmfDigits`.
 */
export const DEFAULT_DTMF_LAYOUT: Readonly<Record<string, DtmfAction>> = Object.freeze({
  "1": "deny_fraud",
  "2": "confirm_authorized",
  "9": "request_human",
  "0": "repeat",
  "#": "none",
  "*": "cancel",
});

/** Keys a telephone keypad can physically produce, plus the A–D DTMF extensions. */
export const KEYPAD_CHARACTERS = "0123456789*#ABCD";

const KEYPAD_RE = /^[0-9*#A-Da-d]+$/;

/**
 * Longest sequence accepted from the wire.
 *
 * `<Gather numDigits="1">` produces one character; this bound exists so a
 * carrier that concatenates (or an attacker) cannot make the mapping layer walk
 * an unbounded string on a request that is already authenticated-but-untrusted.
 */
export const MAX_DTMF_SEQUENCE = 24;

/* ── Parsing ────────────────────────────────────────────────────────────────── */

/**
 * Extract a validated keypad sequence from an untrusted carrier payload.
 *
 * Accepts the shapes Twilio actually sends: the `Digits` form field as a
 * string, absent (`null`/`undefined`), present-but-empty, or padded. Rejects
 * everything else — a non-keypad character means the value did not come from a
 * DTMF path at all (a transcription artefact, a proxy-injected field, a forged
 * turn), and the honest response to that is to say so rather than to strip the
 * odd characters and act on what is left.
 *
 * A–D are upper-cased so a carrier that sends lowercase maps identically; the
 * digits and `*`/`#` are returned exactly as they arrived, and a multi-key
 * burst is returned whole for the mapping layer to interpret.
 *
 * Total: returns `null` for every refusal, never throws.
 */
export function parseDtmf(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.length > MAX_DTMF_SEQUENCE) return null;
  if (!KEYPAD_RE.test(trimmed)) return null;
  return trimmed.toUpperCase();
}

/** Which refusal applies to a raw value, so `mapDtmfDigits` can name it. */
function refusalFor(raw: string | null | undefined): DtmfRefusal {
  if (raw === null || raw === undefined || raw === "") return "absent";
  if (typeof raw !== "string") return "not_a_string";
  if (!raw.trim()) return "empty";
  if (raw.trim().length > MAX_DTMF_SEQUENCE) return "too_long";
  return "non_keypad_character";
}

/* ── Mapping ────────────────────────────────────────────────────────────────── */

/**
 * Map a raw keypad sequence to an intent.
 *
 * The layout lookup goes through `hasOwnProperty` rather than `layout[key]`
 * because an institution-supplied layout is a plain object and `layout["toString"]`
 * is a function: an inherited key would otherwise resolve to a truthy value and
 * be cast to a `DtmfAction`. The keys we read are constrained to the keypad
 * alphabet so this cannot fire today, but the cast happens here and the guard
 * belongs here too — a later layout with `"constructor"` in it should fail the
 * same way it would have always.
 *
 * Total: every input is either a typed refusal or an action. No exceptions.
 */
export function mapDtmfDigits(
  digits: string,
  layout: Readonly<Record<string, DtmfAction>> = DEFAULT_DTMF_LAYOUT,
): DtmfVerdict {
  const parsed = parseDtmf(digits);
  if (parsed === null) {
    return {
      ok: false,
      reason: refusalFor(digits),
      detail: "value is not a DTMF keypad sequence",
    };
  }

  // A burst is only an intent when every key in it is the SAME key. Different
  // keys mean the customer's answer is genuinely unknown — see the module note.
  const distinct = [...new Set(parsed.split(""))];
  if (distinct.length > 1) {
    return {
      ok: false,
      reason: "ambiguous_multi_key",
      detail: `sequence contains more than one distinct key; the customer's intent is not determinable`,
    };
  }

  const key = distinct[0];
  if (key === undefined) {
    return { ok: false, reason: "empty", detail: "no key was pressed" };
  }

  const bound = Object.prototype.hasOwnProperty.call(layout, key) ? layout[key] : undefined;
  if (bound === undefined) {
    return {
      ok: false,
      reason: "unmapped_key",
      detail: `no action is bound to key "${key}" in the active layout`,
    };
  }

  return { ok: true, action: bound };
}

/* ── The TwiML that collects the presses ────────────────────────────────────── */

const XML_ENTITIES: Readonly<Record<string, string>> = Object.freeze({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
});

/**
 * Escape all five XML metacharacters in a SINGLE pass.
 *
 * A prompt is customer-facing copy that often carries an institution's own
 * brand name ("Emirates NBD & Co") or a placeholder the tenant typed, and it is
 * interpolated into TwiML as element text. Unescaped, a `&` is not a cosmetic
 * bug — it starts a character reference, so "Terms & Conditions" becomes a
 * malformed document and the whole call drops at the carrier. The single
 * `replace` is deliberate: it cannot double-escape, because every character is
 * visited exactly once.
 */
export function escapeXml(value: string): string {
  return String(value ?? "").replace(/[<>&'"]/g, (c) => XML_ENTITIES[c] ?? c);
}

/**
 * Where a `<Gather>` may POST its result.
 *
 * A `<Gather action="...">` hands the carrier a URL to POST `CallSid`, `From`
 * and `Digits` to — that is, to hand the caller's phone number and what they
 * pressed to whatever string is in this attribute. It is therefore validated,
 * not escaped-and-trusted:
 *
 *   - a site-relative path is allowed (the only shape we actually use);
 *   - an absolute URL must be HTTPS;
 *   - `http://` is refused, because a downgrade here sends the caller's number
 *     in clear text to a third party;
 *   - a protocol-relative `//host/path` is refused, because it inherits a
 *     scheme we did not check;
 *   - control characters and quote/angle brackets are refused outright.
 *
 * `null` means "do not put an `action` on this Gather", not "throw". A Gather
 * with no action simply returns control to the enclosing TwiML flow, which is a
 * strictly better failure than posting a customer's details somewhere we did
 * not intend.
 */
export function sanitiseGatherActionUrl(raw: string): string | null {
  const value = String(raw ?? "").trim();
  if (!value) return null;
  if (/[\u0000-\u001f\u007f]/.test(value)) return null;
  if (value.startsWith("//")) return null;
  if (value.startsWith("/")) return value;
  if (/^https:\/\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+$/.test(value) && !/['<>\\]/.test(value)) {
    return value;
  }
  return null;
}

export type GatherTwimlOptions = {
  /** Spoken while the keys are collected. Escaped into `<Say>`. */
  prompt: string;
  /** Keys collected before the Gather submits. Default 1. */
  numDigits?: number;
  /** Seconds of silence before the Gather submits anyway. Default 8. */
  timeoutSeconds?: number;
  /** Where the carrier POSTs the press. Validated by `sanitiseGatherActionUrl`. */
  actionUrl: string;
  /** Spoken when the Gather times out with no key pressed. */
  fallback?: string;
};

const GatherOptionsSchema = z.object({
  prompt: boundedString({ min: 1, max: 2_000, trim: true }),
  numDigits: boundedInt({ min: 1, max: 10 }).default(1),
  timeoutSeconds: boundedInt({ min: 1, max: 60 }).default(8),
  actionUrl: boundedString({ min: 1, max: 2_048, trim: true }),
  fallback: boundedString({ max: 2_000, trim: true }).optional(),
});

/** TwiML for a call we cannot build a Gather for: say the prompt, collect nothing. */
function promptOnlyTwiml(prompt: unknown): string {
  const text = typeof prompt === "string" ? prompt.slice(0, 2_000) : "";
  const say = text ? `<Say>${escapeXml(text)}</Say>` : "";
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${say}</Response>`;
}

/**
 * Build the `<Gather>` that actually collects keypad presses.
 *
 * `input` is `dtmf speech` by default and that is the whole point of the
 * module: the SAME question is offered on both channels at once, so a customer
 * on a good line speaks and a customer on a bad line presses, and the turn
 * route handles whichever Twilio delivered first. Offering only DTMF would
 * silently exclude every caller who cannot use a keypad; offering only speech
 * is the status quo this module exists to fix.
 *
 * Never throws. If the options do not validate, the response degrades to the
 * prompt alone with no Gather at all — the caller still hears the question, and
 * nothing is collected into an endpoint we have not checked.
 */
export function buildGatherTwiml(opts: GatherTwimlOptions): string {
  const parsed = GatherOptionsSchema.safeParse(opts);
  if (!parsed.success) return promptOnlyTwiml(opts?.prompt);
  const { prompt, numDigits, timeoutSeconds, actionUrl, fallback } = parsed.data;

  const action = sanitiseGatherActionUrl(actionUrl);
  const attributes = [
    `input="dtmf speech"`,
    `numDigits="${numDigits}"`,
    `timeout="${timeoutSeconds}"`,
    `method="POST"`,
    ...(action ? [`action="${escapeXml(action)}"`] : []),
  ].join(" ");

  const fallbackSay = fallback ? `<Say>${escapeXml(fallback)}</Say>` : "";
  return (
    `<?xml version="1.0" encoding="UTF-8"?><Response>` +
    `<Say>${escapeXml(prompt)}</Say>` +
    `<Gather ${attributes}>${fallbackSay}</Gather>` +
    `</Response>`
  );
}

/* ── What the agent says back ───────────────────────────────────────────────── */

/**
 * The spoken acknowledgement, per action and per language.
 *
 * These are CONSTANTS for the same reason every other line in
 * `src/lib/voice/conversation.ts` is a constant: the sentence that confirms a
 * protective action, or that invites a second attempt after a mis-key, is not
 * something a language model gets to paraphrase. A model that rewords
 * "I have placed a temporary restriction" is one paraphrase away from "your
 * account has been permanently closed", which is the decision this platform is
 * built specifically NOT to make.
 *
 * The non-English lines are authored against the English source and carry the
 * same outstanding native sign-off recorded in `docs/GAP-REGISTER.md` for the
 * rest of the voice plane.
 *
 * `confirm_authorized` here is an acknowledgement of WHAT WAS PRESSED. It
 * authorises nothing — see the security rule at the top of this file.
 */
export const DTMF_SPEECH: Record<DtmfAction, Record<ConvLang, string>> = {
  confirm_authorized: {
    en: "Thank you. I have closed the review on this transaction. Your bank will never call asking you to move money to a safe account. If anyone does, hang up and call the number on your card.",
    ar: "شكراً لك. أغلقت المراجعة على هذه العملية. مصرفك لن يتصل أبداً لطلب نقل أموالك إلى حساب آمن. وإذا اتصل بك أحد، أغلق الخط واتصل بالرقم الموجود على بطاقتك.",
    hi: "धन्यवाद। मैंने इस लेनदेन की समीक्षा बंद कर दी है। आपका बैंक कभी पैसा सुरक्षित खाते में भेजने के लिए कॉल नहीं करेगा। ऐसा कोई करे तो कॉल काटें और कार्ड पर छपे नंबर पर बैंक को कॉल करें।",
    ur: "شکریہ۔ میں نے اس لین دین کی نظرثانی بند کر دی ہے۔ آپ کا بینک کبھی پیسہ محفوظ اکاؤنٹ میں بھیجنے کے لیے کال نہیں کرے گا۔ اگر کوئی ایسا کرے تو کال کاٹیں اور کارڈ پر لکھے نمبر سے بینک کو کال کریں۔",
    fr: "Merci. J'ai clos la vérification de cette opération. Votre banque ne vous appellera jamais pour vous demander de transférer de l'argent vers un compte sûr. Si quelqu'un le fait, raccrochez et appelez le numéro de votre carte.",
    sw: "Asante. Nimefunga ukaguzi wa muamala huu. Benki yako haitawahi kupigia kukuomba uhamishe pesa kwenda akaunti salama. Kama mtu yeyote akifanya hivyo, kata simu na upige benki kwa nambari iliyo kwenye kadi yako.",
  },
  deny_fraud: {
    en: "Thank you for telling me. I have flagged this as fraud and placed a temporary restriction on your card while a human fraud specialist reviews it. You will not be responsible for this transaction.",
    ar: "شكراً لإبلاغي. أبلغت عن هذه العملية كاحتيال ووضعت قيداً مؤقتاً على بطاقتك ريثما يراجعها أخصائي احتيال بشري. لن تتحمل مسؤولية هذه العملية.",
    hi: "धन्यवाद कि आपने बताया। मैंने इसे धोखाधड़ी के रूप में चिह्नित कर दिया है और आपके कार्ड पर अस्थायी रोक लगा दी है, जब तक एक मानव विशेषज्ञ इसकी समीक्षा न करें। इस लेनदेन की ज़िम्मेदारी आपकी नहीं होगी।",
    ur: "بتانے کا شکریہ۔ میں نے اسے فراڈ کے طور پر نشان زد کر دیا ہے اور آپ کے کارڈ پر عارضی پابندی لگا دی ہے، یہاں تک کہ ایک انسانی ماہر اس کا جائزہ لے۔ اس لین دین کی ذمہ داری آپ کی نہیں ہوگی۔",
    fr: "Merci de me l'avoir dit. J'ai signalé cette opération comme frauduleuse et placé une restriction temporaire sur votre carte pendant qu'un spécialiste de la fraude l'examine. Vous ne serez pas responsable de cette opération.",
    sw: "Asante kwa kunifisha. Nimeweka alama ya udanganyifu kwenye muamala huu na kuweka kizuizi cha muda kwenye kadi yako wakati mtaalamu wa udanganyifu anakagua. Hutawajibikia muamala huu.",
  },
  request_human: {
    en: "Of course. I am passing this to a human specialist who will call you shortly. Please stay on the line.",
    ar: "بالتأكيد. سأحوّل الأمر إلى أخصائي بشري سيتصل بك قريباً. يرجى البقاء على الخط.",
    hi: "ज़रूर। मैं इसे एक मानव विशेषज्ञ को भेज रहा हूँ जो आपसे जल्द ही संपर्क करेंगे। कृपया लाइन पर रहें।",
    ur: "ضرور۔ میں یہ ایک انسانی ماہر کو بھیج رہا ہوں جو آپ سے جلد رابطہ کریں گے۔ براہ کرم لائن پر رہیں۔",
    fr: "Bien sûr. Je transmets à un spécialiste humain qui vous rappellera prochainement. Veuillez rester en ligne.",
    sw: "Bila shaka. Ninampa kwa mtaalamu wa binadamu atakayakupigia simu hivi karibuni. Tafadhali endelea kwenye simu.",
  },
  repeat: {
    en: "Let me say that again. Is there a transaction you do not recognize? Press one if it was not you, or two if it was you.",
    ar: "دعني أكرر. هل هناك عملية لا تعرفها؟ اضغط على واحد إذا لم تكن أنت، أو اثنين إذا كنت أنت.",
    hi: "मैं दोहराता हूँ। क्या कोई लेनदेन है जो आप नहीं पहचानते? अगर वह आपका नहीं था तो एक दबाएँ, और अगर आपका था तो दो दबाएँ।",
    ur: "میں دہراتا ہوں۔ کیا کوئی لین دین ہے جو آپ نہیں پہچانتے؟ اگر وہ آپ کا نہیں تھا تو ایک دبائیں، اور اگر آپ کا تھا تو دو دبائیں۔",
    fr: "Je répète. Y a-t-il une opération que vous ne reconnaissez pas ? Appuyez sur un si ce n'était pas vous, ou sur deux si c'était vous.",
    sw: "Nitarudia. Kuna muamala usioujua? Bofya moja kama si uliidhinisha, au mbili kama uliidhinisha.",
  },
  cancel: {
    en: "Thank you. Goodbye.",
    ar: "شكراً لك. إلى اللقاء.",
    hi: "धन्यवाद। अलविदा।",
    ur: "شکریہ۔ اللہ حافظ۔",
    fr: "Merci. Au revoir.",
    sw: "Asante. Kwaheri.",
  },
  none: {
    en: "I did not take that as an answer. Is there a transaction you do not recognize? Press one if it was not you, or two if it was you.",
    ar: "لم أعتبر ذلك إجابة. هل هناك عملية لا تعرفها؟ اضغط على واحد إذا لم تكن أنت، أو اثنين إذا كنت أنت.",
    hi: "मैंने इसे उत्तर नहीं माना। क्या कोई लेनदेन है जो आप नहीं पहचानते? अगर वह आपका नहीं था तो एक दबाएँ, या अगर आपका था तो दो दबाएँ।",
    ur: "میں نے اسے جواب نہیں مانا۔ کیا کوئی لین دین ہے جو آپ نہیں پہچانتے؟ اگر وہ آپ کا نہیں تھا تو ایک دبائیں، یا اگر آپ کا تھا تو دو دبائیں۔",
    fr: "Je n'ai pas pris cela pour une réponse. Y a-t-il une opération que vous ne reconnaissez pas ? Appuyez sur un si ce n'était pas vous, ou sur deux si c'était vous.",
    sw: "Sikukubali kuwa jibu. Kuna muamala usioujua? Bofya moja kama si uliidhinisha, au mbili kama uliidhinisha.",
  },
};

/**
 * What the agent SAYS after a press. English unless the caller chose otherwise,
 * matching the `table[lang] ?? table.en` convention every other voice table
 * uses.
 *
 * Never returns an empty string: `DtmfAction` is a closed union and the table
 * covers it, but the fallback is the `cancel` line rather than `""` because a
 * caller who pressed a key and heard silence has been given the worst possible
 * outcome from a keypad that clearly worked.
 */
export function describeDtmfForSpeech(action: DtmfAction, lang: ConvLang = "en"): string {
  const row = DTMF_SPEECH[action];
  if (!row) return DTMF_SPEECH.cancel[lang] ?? DTMF_SPEECH.cancel.en;
  return row[lang] ?? row.en;
}
