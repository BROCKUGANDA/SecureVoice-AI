/**
 * Email delivery signals — the OUTBOUND half of the Resend webhook.
 *
 * `email.bounced` / `email.complained` / `email.delivery_delayed` /
 * `email.delivered` arrive AFTER a send the provider already accepted, and they
 * identify the message ONLY by the provider's own id. So the property that makes
 * them useful is the one under test here: the id is recorded on the outbox row at
 * send time, and a signal finds its way back to that row.
 *
 * Runs against the real database: `providerMessageId` lookup and the DEAD
 * transition are the behaviour, and a fake store would exercise neither.
 *
 *   bun scripts/run-tests.mjs email-delivery-signals
 */
import { test, expect, afterAll, describe } from "bun:test";
import { db } from "@/lib/db";
import { applyDeliverySignal } from "@/lib/email/outbox";

const MARK = `dsig-${Date.now().toString(36)}`;

/** A row in the shape a successful send leaves behind. */
async function sentRow(providerMessageId: string | null) {
  return db.emailOutbox.create({
    data: {
      kind: "magic_link",
      toEmail: `${MARK}@nowhere.test`,
      subject: "Sign in",
      payload: JSON.stringify({ origin: "https://example.test" }),
      state: "SENT",
      attempts: 1,
      sentAt: new Date(),
      ...(providerMessageId === null ? {} : { providerMessageId }),
    },
    select: { id: true },
  });
}

afterAll(async () => {
  await db.emailOutbox.deleteMany({ where: { toEmail: `${MARK}@nowhere.test` } });
  await db.$disconnect();
});

describe("delivery signals", () => {
  test("a bounce marks the row DEAD, so the address is never retried", async () => {
    const msgId = `${MARK}-bounce`;
    const row = await sentRow(msgId);

    const outcome = await applyDeliverySignal({
      providerMessageId: msgId,
      signal: "bounced",
      reason: "550 mailbox unavailable",
    });

    expect(outcome.matched).toBe(true);
    if (!outcome.matched) return;
    expect(outcome.state).toBe("DEAD");

    const after = await db.emailOutbox.findUnique({
      where: { id: row.id },
      select: { state: true, lastError: true },
    });
    expect(after?.state).toBe("DEAD");
    // The reason is kept so an operator can see WHY the address was abandoned.
    expect(after?.lastError).toContain("bounced");
    expect(after?.lastError).toContain("550");
  });

  test("a spam complaint is terminal too — sending again is how a domain gets blocklisted", async () => {
    const msgId = `${MARK}-complaint`;
    const row = await sentRow(msgId);

    const outcome = await applyDeliverySignal({
      providerMessageId: msgId,
      signal: "complained",
      reason: "marked as spam",
    });

    expect(outcome.matched).toBe(true);
    const after = await db.emailOutbox.findUnique({
      where: { id: row.id },
      select: { state: true, lastError: true },
    });
    expect(after?.state).toBe("DEAD");
    expect(after?.lastError).toContain("complained");
  });

  test("a delay is recorded WITHOUT changing state — the message may still arrive", async () => {
    const msgId = `${MARK}-delay`;
    const row = await sentRow(msgId);

    const outcome = await applyDeliverySignal({
      providerMessageId: msgId,
      signal: "delayed",
      reason: "greylisted",
    });

    expect(outcome.matched).toBe(true);
    const after = await db.emailOutbox.findUnique({
      where: { id: row.id },
      select: { state: true, lastError: true },
    });
    // NOT flipped back to PENDING: that would re-send a magic link that may
    // already have been delivered.
    expect(after?.state).toBe("SENT");
    expect(after?.lastError).toContain("delayed");
  });

  test("a delivery clears a previously recorded delay", async () => {
    const msgId = `${MARK}-delivered`;
    const row = await sentRow(msgId);

    await applyDeliverySignal({
      providerMessageId: msgId,
      signal: "delayed",
      reason: "greylisted",
    });
    const outcome = await applyDeliverySignal({
      providerMessageId: msgId,
      signal: "delivered",
      reason: "ok",
    });

    expect(outcome.matched).toBe(true);
    const after = await db.emailOutbox.findUnique({
      where: { id: row.id },
      select: { state: true, lastError: true },
    });
    expect(after?.state).toBe("SENT");
    expect(after?.lastError).toBeNull();
  });

  test("an id we never stored is reported as unmatched, not swallowed", async () => {
    const outcome = await applyDeliverySignal({
      providerMessageId: `${MARK}-never-sent`,
      signal: "bounced",
      reason: "550",
    });
    expect(outcome.matched).toBe(false);
    if (outcome.matched) return;
    expect(outcome.reason).toBe("unknown_message_id");
  });

  test("a signal with no id at all is reported, not silently dropped", async () => {
    // Rows written before providerMessageId existed, and sends where the
    // provider echoed no id, land here.
    const outcome = await applyDeliverySignal({
      providerMessageId: null,
      signal: "bounced",
      reason: "550",
    });
    expect(outcome.matched).toBe(false);
    if (outcome.matched) return;
    expect(outcome.reason).toBe("no_provider_message_id");
  });

  test("an unmatched bounce leaves other rows untouched", async () => {
    const msgId = `${MARK}-isolated`;
    const row = await sentRow(msgId);

    await applyDeliverySignal({
      providerMessageId: `${MARK}-different`,
      signal: "bounced",
      reason: "550",
    });

    const after = await db.emailOutbox.findUnique({
      where: { id: row.id },
      select: { state: true },
    });
    expect(after?.state).toBe("SENT");
  });
});
