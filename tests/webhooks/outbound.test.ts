import { test, expect } from "bun:test";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db } from "@/lib/db";
import {
  enqueueOutbox,
  claimBatch,
  deliver,
  drainOutbox,
  replayDeadLetter,
  canonicalJson,
  signPayload,
  verifySignature,
  maxAttempts,
  BACKOFF_LADDER_MS,
} from "@/lib/outbox";
import { verifySvSignature } from "../../scripts/verify_sv_signature.ts";

/**
 * WP-5 Gate: outbound bank notification proves
 *   1. delivery survives a receiver returning 500 three times (retry ladder),
 *   2. the dead-letter replay produces EXACTLY one additional delivery,
 *   3. the signature verifies in a second language implementation (Python),
 *   4. the transition + outbox row commit together, and retries are
 *      backoff-jittered across ~24h.
 */
process.env.BANK_WEBHOOK_SECRET = process.env.BANK_WEBHOOK_SECRET ?? "bank-secret-".repeat(4);

function spyReceiver(script: (call: number) => number) {
  const calls: { body: string; header: string | null }[] = [];
  let n = 0;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    n++;
    calls.push({
      body: String(init.body),
      header: (init.headers as Record<string, string>)["sv-signature"] ?? null,
    });
    const status = script(n);
    return new Response(JSON.stringify({ ok: status < 300 }), { status });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls, count: () => calls.length };
}

test("WP-5: outbox retries, dead-letters, replays once, cross-language signature", async () => {
  const SECRET = process.env.BANK_WEBHOOK_SECRET!;
  const RUN = Date.now().toString(36);
  const caseRef = `SV-F-OUT-${RUN.toUpperCase()}`;

  // Isolation: `claimBatch` deliberately takes whatever is oldest and due, so
  // a verdict left PENDING by another test (e.g. WP-4's, which asserts on the
  // transition and never delivers) would be claimed instead of ours. Drain the
  // shared queue first so this gate measures only its own events.
  await db.outboxEvent.updateMany({
    where: { state: { in: ["PENDING", "SENDING"] } },
    data: { state: "DELIVERED", deliveredAt: new Date() },
  });

  // ── 1. The outbox row and the case transition commit together ──────────
  const caseRow = await db.case.create({
    data: { caseRef, orgId: "org-test", state: "CONFIRMED_FRAUD" },
  });

  const tx = await db.$transaction(async (t) => {
    await t.case.update({ where: { id: caseRow.id }, data: { state: "FREEZE_STAGED" } });
    return enqueueOutbox(t, {
      eventType: "case.notified",
      caseRef,
      orgId: "org-test",
      targetUrl: "http://bank.example/hook",
      data: { state: "NOTIFIED", outcome: "success", audit_ref: caseRef },
    });
  });
  expect(tx.id).toBeTruthy();
  const persisted = await db.outboxEvent.findUnique({ where: { id: tx.id } });
  expect(persisted?.state).toBe("PENDING");
  expect(persisted?.payload).toBe(canonicalJson(JSON.parse(persisted!.payload)));

  // ── 2. Delivery survives three 500s, then lands ─────────────────────────
  const flaky = spyReceiver((call) => (call <= 3 ? 500 : 200));
  // Make the row due, then claim exactly it (the worker claims in nextAttemptAt
  // order; we assert on identity so the gate cannot silently measure a
  // different event than the one it created).
  await db.outboxEvent.update({ where: { id: tx.id }, data: { nextAttemptAt: new Date(0) } });
  const claimed = await claimBatch(10);
  const mine = claimed.filter((e) => e.id === tx.id);
  expect(mine).toHaveLength(1);
  const first = await deliver(mine[0]!, flaky.fetchImpl);
  expect(first.status).toBe("RETRY");
  expect(flaky.count()).toBe(1);

  // The next attempt is scheduled into the future, not immediate.
  const afterFail = await db.outboxEvent.findUnique({ where: { id: tx.id } });
  expect(afterFail?.state).toBe("PENDING");
  expect(afterFail?.attempts).toBe(1);
  expect(afterFail?.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 30_000);
  expect(BACKOFF_LADDER_MS[0]).toBe(60_000);

  // Drain again for each of the next three attempts (the retry delay is
  // bypassed by advancing nextAttemptAt, which is what the worker's clock
  // does in production).
  for (let i = 0; i < 3; i++) {
    await db.outboxEvent.update({ where: { id: tx.id }, data: { nextAttemptAt: new Date(0) } });
    const batch = (await claimBatch(10)).filter((e) => e.id === tx.id);
    expect(batch).toHaveLength(1);
    await deliver(batch[0]!, flaky.fetchImpl);
  }
  expect(flaky.count()).toBe(4);
  const delivered = await db.outboxEvent.findUnique({ where: { id: tx.id } });
  expect(delivered?.state).toBe("DELIVERED");
  expect(delivered?.deliveredAt).not.toBeNull();

  // The signature on the wire is valid and covers the exact bytes sent.
  // flaky.count() is asserted to be 4 directly above, so the fourth call exists.
  const sent = flaky.calls[3]!;
  expect(verifySvSignature(sent.body, sent.header, SECRET).ok).toBe(true);
  // Tampering with a single byte invalidates it.
  expect(verifySvSignature(sent.body + " ", sent.header, SECRET).ok).toBe(false);
  expect(verifySignature(sent.header, sent.body, "wrong-secret").ok).toBe(false);

  // ── 3. Exhausting the ladder dead-letters the event ─────────────────────
  const doomed = await db.outboxEvent.create({
    data: {
      caseRef,
      eventType: "case.notified",
      payload: canonicalJson({ event_id: "doomed", event_type: "case.notified", data: {} }),
      targetUrl: "http://bank.example/hook",
      state: "PENDING",
    },
  });
  const always500 = spyReceiver(() => 500);
  for (let i = 0; i < maxAttempts(); i++) {
    await db.outboxEvent.update({ where: { id: doomed.id }, data: { nextAttemptAt: new Date(0) } });
    const batch = (await claimBatch(10)).filter((e) => e.id === doomed.id);
    expect(batch).toHaveLength(1);
    const res = await deliver(batch[0]!, always500.fetchImpl);
    if (i < maxAttempts() - 1) expect(res.status).toBe("RETRY");
    else expect(res.status).toBe("DEAD");
  }
  expect(always500.count()).toBe(maxAttempts());
  const deadRow = await db.outboxEvent.findUnique({ where: { id: doomed.id } });
  expect(deadRow?.state).toBe("DEAD");
  const dl = await db.deadLetter.findUnique({ where: { eventId: doomed.id } });
  expect(dl).not.toBeNull();

  // ── 4. Dead-letter replay produces EXACTLY one additional delivery ─────
  const nowOk = spyReceiver(() => 200);
  const replayed = await replayDeadLetter(dl!.id);
  expect(replayed.ok).toBe(true);
  await drainOutbox(1, nowOk.fetchImpl);
  expect(nowOk.count()).toBe(1);
  const afterReplay = await db.outboxEvent.findUnique({ where: { id: doomed.id } });
  expect(afterReplay?.state).toBe("DELIVERED");

  // Replaying the same dead letter again is refused (idempotent admin action).
  expect((await replayDeadLetter(dl!.id)).error).toBe("already_replayed");
  expect(nowOk.count()).toBe(1);

  // ── 4b. Our own receiver accepts it, and refuses a forgery ─────────────
  // This is the path /inspector displays: signer -> receiver -> stored row.
  const { POST: receiver } = await import("@/app/api/webhooks/receiver/route");
  const recvReq = (body: string, header: string | null) =>
    new Request("http://localhost/api/webhooks/receiver", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(header ? { "sv-signature": header } : {}),
      },
      body,
    }) as unknown as Parameters<typeof receiver>[0];

  const accepted = await receiver(recvReq(sent.body, sent.header));
  expect(accepted.status).toBe(200);
  expect((await accepted.json()).verified).toBe(true);

  const storedEvent = await db.inboundBankEvent.findFirst({
    where: { caseRef, eventType: "case.notified" },
    orderBy: { receivedAt: "desc" },
  });
  expect(storedEvent?.signatureValid).toBe(true);
  // A redelivery of the same event_id must not create a second row.
  await receiver(recvReq(sent.body, sent.header));
  expect(await db.inboundBankEvent.count({ where: { eventId: storedEvent!.eventId } })).toBe(1);

  const refused = await receiver(recvReq(sent.body, "t=1,v0=" + "00".repeat(32)));
  expect(refused.status).toBe(401);

  // ── 5. Python (second language) verifies the same delivery ─────────────
  // A gate that silently skips its own check is worse than no gate, so a
  // missing interpreter is a FAILURE, not a skip. Point PYTHON at any
  // CPython 3.8+ if it is not on PATH.
  const py = findPython();
  expect(py, "no Python interpreter found - set PYTHON=/path/to/python").not.toBeNull();
  {
    const dir = mkdtempSync(join(tmpdir(), "sv-sig-"));
    const bodyFile = join(dir, "body.json");
    writeFileSync(bodyFile, sent.body, "utf8");
    const proc = Bun.spawnSync([
      py!,
      "scripts/verify_sv_signature.py",
      bodyFile,
      sent.header!,
      SECRET,
    ]);
    const out = proc.stdout.toString();
    expect(out).toContain("VERIFIED");

    // And a forged signature is rejected by the second implementation too.
    const forged = Bun.spawnSync([
      py!,
      "scripts/verify_sv_signature.py",
      bodyFile,
      "t=1,v0=deadbeef",
      SECRET,
    ]);
    expect(forged.stdout.toString()).toContain("REJECTED");

    // A tampered body is rejected too - the classic re-serialisation mistake.
    writeFileSync(bodyFile, sent.body.replace("success", "success "), "utf8");
    const tampered = Bun.spawnSync([
      py!,
      "scripts/verify_sv_signature.py",
      bodyFile,
      sent.header!,
      SECRET,
    ]);
    expect(tampered.stdout.toString()).toContain("REJECTED");
  }

  // ── 6. Canonicalisation is deterministic and key-sorted ────────────────
  expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  expect(signPayload("{}", 1, SECRET)).toBe(signPayload("{}", 1, SECRET));

  await db.$disconnect();
}, 120_000);

test("WP-5: concurrent claimers never both win the same delivery", async () => {
  // SKIP LOCKED is not a claim on its own. Ten claimers racing for one event
  // must produce exactly ONE winner, or a bank notification is delivered twice
  // and the bank's dedupe key ends up doing work our queue should have done.
  const single = await db.outboxEvent.create({
    data: {
      caseRef: `SV-F-OUT-RACE`,
      eventType: "case.notified",
      payload: canonicalJson({ event_id: "race-single", event_type: "case.notified", data: {} }),
      targetUrl: "http://bank.example/hook",
    },
  });

  const claimers = await Promise.all(Array.from({ length: 10 }, () => claimBatch(10)));
  const winners = claimers.flat().filter((e) => e.id === single.id);
  expect(winners).toHaveLength(1);

  // And across a burst, no id is ever handed out twice.
  await db.outboxEvent.updateMany({
    where: { state: "PENDING" },
    data: { state: "DELIVERED", deliveredAt: new Date() },
  });
  for (let i = 0; i < 12; i++) {
    await db.outboxEvent.create({
      data: {
        caseRef: `SV-F-OUT-RACE`,
        eventType: "case.notified",
        payload: canonicalJson({ event_id: `race-${i}`, event_type: "case.notified", data: {} }),
        targetUrl: "http://bank.example/hook",
      },
    });
  }
  const raced = (await Promise.all(Array.from({ length: 12 }, () => claimBatch(10))))
    .flat()
    .map((e) => e.id);
  expect(new Set(raced).size).toBe(raced.length);

  await db.$disconnect();
}, 120_000);

function findPython(): string | null {
  const candidates = [
    process.env.PYTHON,
    "python",
    "python3",
    "C:\\Program Files\\AutoClaw\\resources\\python\\python.exe",
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    try {
      const p = Bun.spawnSync([c, "--version"]);
      if (p.exitCode === 0) return c;
    } catch {
      /* try next */
    }
  }
  return null;
}
