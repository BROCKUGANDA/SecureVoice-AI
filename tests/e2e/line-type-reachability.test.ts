/**
 * THE LINE-TYPE GATE ON A REACHABILITY CLAIM — an SMS that cannot arrive is not
 * evidence the customer was warned.
 *
 * `src/lib/voice/line-type.ts` shipped with 37 prefix-table tests and no caller.
 * Its own docstring names the failure it exists to prevent, and it is a good one:
 * a landline, toll-free or premium number accepts Twilio's `sent`, delivers it to a
 * machine with no handset, and "sent, silently, to nothing" looks identical to "the
 * customer was warned and said nothing". On a fraud call that is the confusion that
 * lets a transfer stand.
 *
 * The claim lives in `Case.smsSentAt`, which the state machine and the bank event
 * both read as proof of reach. So the gate is placed exactly there: the fallback
 * still walks the case to UNREACHABLE (withholding the STATE would hide the failed
 * call from the bank entirely, which is worse), but `smsSentAt` is written only
 * when the destination can actually receive an SMS.
 *
 * The lookup-less path is what is tested — `LINE_TYPE_LOOKUP_URL` unset means the
 * prefix table answers, and an unmatched prefix returns `unknown`, which is refused
 * like a landline rather than guessed at. A number this table cannot classify is a
 * number whose SMS receipt cannot be asserted.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

process.env.ELEVENLABS_DRY_RUN = "true";

const { db } = await import("@/lib/db");
const { createCase, transitionCase } = await import("@/lib/case-state-machine");
const { markVoiceFailed } = await import("@/lib/elevenlabs/sms-fallback");

const SLOW = 120_000;
const created: string[] = [];
const phones: string[] = [];

function ref(): string {
  return `SV-LT-${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

/** A case the voice call has just failed to reach: RECEIVED -> SCREENED -> DIALING. */
async function unreachableCase(phone: string) {
  const caseRef = ref();
  created.push(caseRef);
  phones.push(phone);
  await createCase({
    caseRef,
    orgId: null,
    phone,
    amountMinor: 250_000,
    currency: "AED",
    merchant: "Electronics World",
    language: "en",
    riskScore: 0.93,
    transactionRef: `TXN-${caseRef}`,
    consentRecordId: `CONSENT-${caseRef}`,
    cardLast4: "4242",
    signalKind: "card_transaction",
  });
  await transitionCase(caseRef, "SCREENED");
  await transitionCase(caseRef, "DIALING");
  return caseRef;
}

afterAll(async () => {
  await db.outboxEvent.deleteMany({ where: { caseRef: { in: created } } }).catch(() => {});
  await db.auditLog.deleteMany({ where: { callRef: { in: created } } }).catch(() => {});
  await db.case.deleteMany({ where: { caseRef: { in: created } } }).catch(() => {});
});

async function outcome(caseRef: string) {
  const row = await db.case.findFirstOrThrow({
    where: { caseRef },
    select: { state: true, smsSentAt: true },
  });
  const unconfirmable = await db.auditLog.count({
    where: { callRef: caseRef, intent: "sms_fallback_unconfirmable" },
  });
  return { ...row, unconfirmable };
}

describe("a texted landline is not a warned customer", () => {
  test(
    "a UAE mobile keeps the reachability claim",
    async () => {
      const caseRef = await unreachableCase("+971501234567");
      const r = await markVoiceFailed({ caseRef, reason: "voicemail" });
      expect(r.sent).toBe(true);

      const o = await outcome(caseRef);
      expect(o.state).toBe("UNREACHABLE");
      expect(o.smsSentAt).not.toBeNull();
      expect(o.unconfirmable).toBe(0);
    },
    SLOW,
  );

  test(
    "a Dubai landline reaches UNREACHABLE with NO smsSentAt, and says why in the chain",
    async () => {
      // 9712 + 7 subscriber digits: the rule is `high` confidence, so this is not
      // a classification failure being hedged — the platform knows it cannot land.
      const caseRef = await unreachableCase("+97121234567");
      const r = await markVoiceFailed({ caseRef, reason: "voicemail" });
      expect(r.sent).toBe(true);

      const o = await outcome(caseRef);
      expect(o.state).toBe("UNREACHABLE");
      expect(o.smsSentAt, "a landline was recorded as reachable by SMS").toBeNull();
      expect(o.unconfirmable).toBe(1);
    },
    SLOW,
  );

  test(
    "a toll-free number is refused the same claim",
    async () => {
      const caseRef = await unreachableCase("+971800123456");
      await markVoiceFailed({ caseRef, reason: "no_answer" });

      const o = await outcome(caseRef);
      expect(o.state).toBe("UNREACHABLE");
      expect(o.smsSentAt).toBeNull();
      expect(o.unconfirmable).toBe(1);
    },
    SLOW,
  );

  test(
    "a number the prefix table cannot place gets no claim either — unknown is not mobile",
    async () => {
      // The refusal is the whole point of `UNKNOWN_LINE`: guessing here would put
      // the same "warned and silent" inference on a number nobody looked at.
      const caseRef = await unreachableCase("+1999999999");
      await markVoiceFailed({ caseRef, reason: "voicemail" });

      const o = await outcome(caseRef);
      expect(o.state).toBe("UNREACHABLE");
      expect(o.smsSentAt).toBeNull();
      expect(o.unconfirmable).toBe(1);
    },
    SLOW,
  );
});
