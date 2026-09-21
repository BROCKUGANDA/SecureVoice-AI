/**
 * The storyboard. This one file is the single source of truth for the video:
 * narration, captions, the DOM steps that drive the browser, and the agent
 * lines that get mixed under the narration during the call scene.
 *
 * Re-cutting the video means editing the text here — narrate.mjs, cards.py,
 * capture.mjs and assemble.mjs all read from this module.
 *
 * Step vocabulary (interpreted by capture.mjs):
 *   { nav }            click a top-nav button by label
 *   { click }          click any visible button by label
 *   { text }           wait until text is visible (scene gate)
 *   { sleep }          fixed pause in ms
 *   { scroll }         smooth scroll { y, ms }
 *   { cursor }         glide the mouse to text, for a "human" read
 * Every scene also declares `min` seconds of screen time, so a take never
 * cuts away before the UI has finished animating.
 *
 * Narration length is the edit: capture.mjs paces each scene to the measured
 * voice-over, so ~15 characters per second is the budget per scene.
 */

const S = (o) => o;

export const TITLE = "SecureVoice AI — end-to-end platform walkthrough";

export const scenes = [
  S({
    id: "01-open",
    kind: "card",
    chapter: "The gap",
    title: "38 minutes vs 60 seconds",
    subtitle: "Real-time voice fraud intervention",
    narration:
      "A bank's fraud engine flags a case; an analyst takes nine minutes to see it and thirty-eight to work it. A fraudster needs seconds. SecureVoice AI closes that gap — the platform, live.",
    captions: ["A fraud case takes an agent 38 minutes", "A fraudster needs seconds"],
    min: 2.0,
  }),
  S({
    id: "02-pitch",
    kind: "capture",
    chapter: "The pitch",
    title: "What the platform claims",
    narration:
      "The public overview, and the claim is narrow by design: detect, call the customer, freeze the account, leave an audit trail a regulator can verify. Docs and Security sit right beside it.",
    captions: ["Public overview — no session required", "Docs and Security ship with it"],
    steps: [
      { sleep: 800 },
      { cursor: "Fraud detected" },
      { scroll: { y: 1500, ms: 7000 } },
      { scroll: { y: 2600, ms: 5000 } },
    ],
    min: 4.0,
  }),
  S({
    id: "03-signin",
    kind: "capture",
    chapter: "Access",
    title: "Role-gated operator access",
    narration:
      "Access is role-gated. This session is stamped operator — full access. A demo seat gets a different badge and only the guided simulation. Clerk holds the identity; no passwords live here.",
    captions: ["Operator and demo seats are different roles", "Clerk holds the identity — no stored passwords"],
    steps: [
      { nav: "Overview" },
      { scroll: { y: 1900, ms: 1400 } },
      { click: "Sign in to run the platform" },
      { sleep: 1200 },
      { text: "Recent interventions", timeout: 9000 },
      { sleep: 1200 },
    ],
    min: 2.0,
  }),
  S({
    id: "04-console",
    kind: "capture",
    chapter: "Command Center",
    title: "The operator view",
    narration:
      "That's the Command Center: recent interventions with risk score and language, delivery state for every leg, and the audit chain behind each case. The feed is pushed, not polled.",
    captions: ["Live intervention feed over SSE", "Cases carry risk score and language"],
    steps: [
      { scroll: { y: 700, ms: 6000 } },
      { scroll: { y: 0, ms: 2500 } },
    ],
    min: 3.0,
  }),
  S({
    id: "05-call",
    kind: "capture",
    chapter: "The voice agent",
    title: "Detection to call in seconds",
    narration:
      "The guided simulation replays a real case without dialling anyone. A signed risk signal arrives — twenty-five hundred dirhams, new device, high-risk location. The agent opens with a disclosure, verifies the payment, then freezes the card.",
    captions: [
      "Signed risk signal → outbound call in seconds",
      "Disclosure, verification, freeze — phase by phase",
    ],
    steps: [
      { nav: "Demo" },
      { text: "Simulate fraud alert", timeout: 20000 },
      { click: "Simulate fraud alert" },
      { text: "Agent Pipeline", timeout: 20000 },
      { sleep: 20000 },
    ],
    min: 4.0,
    agentLines: [
      { at: 6.0, lang: "en", text: "This is Marcus calling about a transaction on your card." },
      { at: 13.5, lang: "en", text: "You did not authorise the twenty-five hundred dirham payment — is that correct?" },
    ],
  }),
  S({
    id: "06-guardrails",
    kind: "capture",
    chapter: "Compliance",
    title: "Guardrails, not prompts",
    narration:
      "Three things make this safe to put in front of a customer. Every call opens with a disclosure. The agent never asks for a PIN, an OTP or a password, and that is enforced on the server rather than by asking the model nicely. And personal data is redacted before it reaches the database.",
    captions: ["No PINs, OTPs or passwords — server-enforced", "PII redacted before persistence"],
    steps: [
      { nav: "Security" },
      { sleep: 1500 },
      { scroll: { y: 1400, ms: 8000 } },
    ],
    min: 3.0,
  }),
  S({
    id: "07-arabic",
    kind: "capture",
    chapter: "Multilingual",
    title: "The same flow in Arabic",
    narration:
      "The customer's language is the agent's language. Switching the call to Arabic routes to a different voice identity — Fatima, Gulf Arabic — same disclosure, same guardrails, a bilingual transcript on screen. Each language carries its own voice, so it never sounds translated.",
    captions: ["Voice identity per language", "Arabic: Fatima, Gulf Arabic"],
    steps: [
      { nav: "Demo" },
      { sleep: 1200 },
      { chip: "عربي" },
      { text: "FATIMA", timeout: 9000 },
      { sleep: 8000 },
    ],
    min: 3.0,
  }),
  S({
    id: "08-audit",
    kind: "capture",
    chapter: "Evidence",
    title: "A chain that proves itself",
    narration:
      "And on the compliance side, every action is sealed as a row in an immutable audit log: a sha256 hash over the canonical serialisation, chained to the row before it, so editing any field breaks the link from that point onward. Filter, actor, detail, hash — the list an auditor recomputes.",
    captions: ["sha256 hash chain, canonical serialisation", "Sealed rows an auditor can recompute"],
    steps: [
      { nav: "Dashboard" },
      { sleep: 1200 },
      { click: "Compliance" },
      { text: "Immutable audit log", timeout: 9000 },
      { sleep: 1200 },
      { scroll: { y: 700, ms: 5000 } },
    ],
    min: 3.0,
  }),
  S({
    id: "09-close",
    kind: "card",
    chapter: "Outcome",
    title: "Frozen in 60 seconds",
    subtitle: "Fraud detected · Customer called · Account frozen",
    narration:
      "Fraud detected, customer called, account frozen — sixty seconds instead of thirty-eight minutes, in the customer's own language, with an audit trail that proves itself afterwards. That is SecureVoice AI.",
    captions: ["60 seconds, not 38 minutes", "Tamper-evident audit chain"],
    min: 1.5,
  }),
];

/** Buttons the capture must never press, whatever a scene asks for. */
export const FORBIDDEN =
  /(enroll|fire intervention|fire the|place call|send sms|save key|remove key|delete|reset database)/i;
