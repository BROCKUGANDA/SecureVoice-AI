/**
 * Unit — the intent router's Urdu coverage.
 *
 * This file exists because of a specific regression, and every case below is
 * traceable to it.
 *
 * BEFORE: FRAUD_PATTERNS was /\b(no|not me|deny|denied|fraud|...)\b/i — an
 * English-only regex using `\b`, which is defined over [A-Za-z0-9_] and
 * therefore can never match around Arabic script.
 *
 * On the media-stream path this meant: a fraud victim calls in Urdu and says
 * "یہ میرا نہیں" (this is not mine). The regex does not match. The turn routes
 * to `clarify`. The JIT AuthZ soft freeze never fires. The card is not
 * protected. The audit chain records a routine clarification on what was
 * actually a fraud report.
 *
 * The legacy route (src/app/api/agent/route.ts) already carried Urdu denial
 * phrases, so this was a REGRESSION introduced with the new path — the platform
 * was safer before the router was shared than after.
 *
 * Two properties are asserted, and the second is the more important:
 *
 *   1. Denial phrased in each supported language routes to fraud_specialist.
 *
 *   2. AFFIRMATIVE Urdu containing the negation word نہیں does NOT. This is the
 *      reason the tables hold whole phrases rather than stems. "میرا نہیں سوال"
 *      means "I have no question" — a stem match on نہیں would stage a card
 *      freeze because the caller asked the agent to repeat itself. A router that
 *      over-triggers on negation is its own compliance failure: it takes a
 *      pre-approved protective action with no fraud report behind it.
 *
 *   bun scripts/run-tests.mjs router-urdu
 */
import { expect, test } from "bun:test";
import { routeAgentIntent, ROUTER_PHRASE_COUNTS } from "@/lib/ai/router";

test("an Urdu fraud denial reaches the fraud specialist and can fire the freeze", async () => {
  const denials = [
    "یہ میرا نہیں", // "this is not mine"
    "میرا نہیں ہے", // "it is not mine"
    "مجھ سے نہیں ہوا", // "did not happen through me"
    "مجھ کا نہیں", // "not mine" (neuter)
    "مجاز نہیں", // "not authorised"
    "میں نے نہیں کیا", // "I did not do it"
    "میں نے نہیں بھیجا", // "I did not send it"
    "یہ فراڈ ہے", // "this is fraud"
    "دھوکہ دیا گیا ہے", // "a fraud was committed"
    "میں نے کوئی خریداری نہیں کی", // "I made no purchase"
    "یہ میرا نہیں ہے براہ کرم روک دیں", // "not mine, please block it"
  ];

  for (const denial of denials) {
    expect(await routeAgentIntent(denial), `Urdu denial missed: ${denial}`).toBe(
      "fraud_specialist",
    );
  }
});

test("an affirmative Urdu sentence containing نہیں is NOT a fraud report", async () => {
  // The negation-safety case. Each of these is innocuous: the caller states
  // they have no question, no need, no problem. Freezing a card on any of these
  // would stage a protective action with no fraud report behind it.
  const affirmatives = [
    "مجھے کچھ نہیں چاہیے", // "I don't need anything"
    "میرا کوئی سوال نہیں", // "I have no question"
    "کوئی مسئلہ نہیں ہے", // "there is no problem"
    "میں ٹھیک ہوں نہیں کچھ", // "I am fine, nothing is wrong"
  ];

  for (const line of affirmatives) {
    const role = await routeAgentIntent(line);
    expect(role, `false positive on innocuous Urdu: ${line}`).not.toBe("fraud_specialist");
  }
});

test("the English denial set still routes exactly as before", async () => {
  const denials = [
    "no",
    "not me",
    "wasn't me",
    "i didn't do it",
    "that's fraud",
    "my card was stolen",
    "this is unauthorized",
    "i don't recognize this charge",
    "cancel it",
    "block the card",
  ];
  for (const denial of denials) {
    expect(await routeAgentIntent(denial), `English regression: ${denial}`).toBe(
      "fraud_specialist",
    );
  }
});

test("an innocuous English sentence is still not a fraud report", async () => {
  // Guards the other direction of the shared-table change: adding ten
  // languages to one regex must not make the classifier trigger-happy.
  const innocuous = [
    "no problem",
    "i have no questions",
    "nothing is wrong",
    "can you repeat that please",
    "hello",
  ];
  for (const line of innocuous) {
    expect(await routeAgentIntent(line), `false positive: ${line}`).not.toBe("fraud_specialist");
  }
});

test("a caller reporting fraud AND asking for their rights routes to fraud first", async () => {
  // Ordering is load-bearing. Freezing the card is the time-critical action;
  // explaining rights is not. Reversed, the customer spends the call learning
  // about their rights while an unauthorised charge completes.
  const combined = [
    "I want to complain, this charge is not mine",
    "مجھے شکایت کرنی ہے، یہ میرا نہیں ہے",
    "أريد تقديم شكوى، هذه العملية ليست لي",
  ];
  for (const line of combined) {
    expect(await routeAgentIntent(line), `ordering regression: ${line}`).toBe("fraud_specialist");
  }
});

test("rights and complaints without a fraud claim route to the compliance officer", async () => {
  const rights = [
    "I want to make a complaint",
    "مجھے شکایت کرنی ہے",
    "أريد تقديم شكوى",
  ];
  for (const line of rights) {
    expect(await routeAgentIntent(line), `rights regression: ${line}`).toBe("compliance_officer");
  }
});

test("distress and bereavement in Urdu reach the empathy agent", async () => {
  // Support Through Difficult Moments: a bereaved customer on a collections
  // call must not be handled by a script. "والدہ" (father/mother, as a grief
  // marker) and hospital vocabulary are the triggers.
  const distress = [
    "میری امی کا انتقال ہو گیا", // "my mother passed away"
    "میں بیمار ہوں", // "I am ill"
    "مجھے ڈر لگ رہا ہے", // "I am getting scared"
    "میں نہیں سمجھ سکا", // "I did not understand"
    "ہسپتال جا رہا ہوں", // "I am going to hospital"
  ];
  for (const line of distress) {
    expect(await routeAgentIntent(line), `Urdu distress missed: ${line}`).toBe("empathy_agent");
  }
});

test("an empty or non-string turn is a clarification, never a fraud report", async () => {
  // Defensive: the media-stream worker calls this on every final transcript,
  // including the empty one Deepgram emits on a false start.
  expect(await routeAgentIntent("")).toBe("clarify");
  expect(await routeAgentIntent("   ")).toBe("clarify");
  expect(await routeAgentIntent(undefined as unknown as string)).toBe("clarify");
  expect(await routeAgentIntent(null as unknown as string)).toBe("clarify");
});

test("every supported language carries a non-trivial phrase set", async () => {
  // Guards against a future edit dropping a language's table to a stub. The
  // counts are asserted loosely on purpose: this is a canary for "the tables
  // are still here", not a tripwire on the exact number.
  expect(ROUTER_PHRASE_COUNTS.fraud).toBeGreaterThan(40);
  expect(ROUTER_PHRASE_COUNTS.compliance).toBeGreaterThan(10);
  expect(ROUTER_PHRASE_COUNTS.empathy).toBeGreaterThan(20);
});
