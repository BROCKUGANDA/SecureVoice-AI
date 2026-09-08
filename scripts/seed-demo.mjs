/**
 * Demo data seeding — populates a fresh database with realistic intervention
 * cases so the Command Center isn't empty when a judge logs in.
 *
 * Every case is written as a chain-consistent audit sequence (case creation +
 * delivery receipt), using the EXACT canonicalization the runtime's
 * verifyChain() expects: sha256(prevHash + "\n" + JSON.stringify(rec)) where
 * rec's keys are inserted in the order [action, callRef, callerId, intent,
 * meta, orgId, prevHash, redactedText], skipping null/undefined, and meta is
 * the sorted-key canonical JSON string.
 *
 * Run: node scripts/seed-demo.mjs
 */

import { PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";

const db = new PrismaClient();
const GENESIS = "0".repeat(64);
const KEY_ORDER = ["action", "callRef, ", "callerId", "intent", "meta", "orgId", "prevHash", "redactedText"];

// canonical: exact TS ordering — action, callRef, callerId, intent, meta, orgId, prevHash, redactedText
function chainHash(prev, fields) {
  const rec = {};
  if (fields.action != null) rec.action = fields.action;
  rec.callRef = fields.callRef;
  if (fields.callerId != null) rec.callerId = fields.callerId;
  if (fields.intent != null) rec.intent = fields.intent;
  if (fields.meta != null) rec.meta = fields.meta;
  if (fields.orgId != null) rec.orgId = fields.orgId;
  rec.prevHash = prev;
  if (fields.redactedText != null) rec.redactedText = fields.redactedText;
  return createHash("sha256").update(prev + "\n" + JSON.stringify(rec)).digest("hex");
}

function canonMeta(obj) {
  const walk = (v) => {
    if (v === null || typeof v !== "object") return JSON.stringify(v);
    if (Array.isArray(v)) return "[" + v.map(walk).join(",") + "]";
    const ks = Object.keys(v).sort();
    return "{" + ks.map((k) => JSON.stringify(k) + ":" + walk(v[k])).join(",") + "}";
  };
  return walk(obj);
}

const CASES = [
  { ref: "SV-8642", lang: "ar", risk: 0.94, channel: "card", amount: "AED 2500", merchant: "Electronics World", action: "card_freeze_temporary", delivery: "call", minsAgo: 26 },
  { ref: "SV-8641", lang: "en", risk: 0.91, channel: "payment", amount: "AED 8120", merchant: "Online FX", action: "card_freeze_temporary", delivery: "sms", minsAgo: 52 },
  { ref: "SV-8640", lang: "ur", risk: 0.88, channel: "transfer", amount: "AED 950", merchant: "Telecom top-up", action: "transfer_hold_24h", delivery: "call", minsAgo: 74 },
  { ref: "SV-8639", lang: "en", risk: 0.83, channel: "card", amount: "AED 320", merchant: "Grocery abroad", action: "verify_only", delivery: "sms", minsAgo: 96 },
  { ref: "SV-8638", lang: "hi", risk: 0.9, channel: "remittance", amount: "AED 6000", merchant: "Wire transfer", action: "transfer_hold_24h", delivery: "call", minsAgo: 118 },
  { ref: "SV-8637", lang: "ar", risk: 0.96, channel: "card", amount: "AED 12300", merchant: "Luxury retail", action: "card_freeze_temporary", delivery: "call", minsAgo: 141 },
  { ref: "SV-8636", lang: "en", risk: 0.87, channel: "login", amount: null, merchant: null, action: "verify_only", delivery: "sms", minsAgo: 163 },
  { ref: "SV-8635", lang: "ur", risk: 0.95, channel: "card", amount: "AED 4400", merchant: "Crypto ramp", action: "card_freeze_temporary", delivery: "call", minsAgo: 187 },
];

const stamp = (minsAgo) => new Date(Date.now() - minsAgo * 60 * 1000);

async function seedCase(c) {
  const existing = await db.auditLog.findFirst({ where: { callRef: c.ref }, select: { id: true } });
  if (existing) {
    console.log("·", c.ref, "already seeded");
    return;
  }
  let prev = GENESIS;
  const base = {
    action: "freeze",
    callRef: c.ref,
    callerId: "seed",
    intent: `risk_${c.channel}_${c.action}`,
    meta: canonMeta({
      producerCaseId: `BANK-SEED-${c.ref}`,
      customerRef: `CUST-${c.ref.slice(-4)}`,
      lang: c.lang,
      riskScore: c.risk,
      channel: c.channel,
      plannedAction: c.action,
      handoff: "fraud_specialist",
      slaSeconds: 60,
      verifiedSignature: true,
      latencyMs: 3 + Math.floor(Math.random() * 8),
    }),
    orgId: null,
    redactedText: `BANK-SEED-${c.ref} · CUST-${c.ref.slice(-4)} · ${c.channel} · ${c.risk}` + (c.merchant ? ` · ${c.merchant}` : ""),
  };

  const h1 = chainHash(prev, base);
  await db.auditLog.create({
    data: {
      callRef: base.callRef, action: base.action, intent: base.intent, callerId: base.callerId,
      redactedText: base.redactedText, meta: base.meta, orgId: null,
      prevHash: prev, chainHash: h1, createdAt: stamp(c.minsAgo),
    },
  });
  prev = h1;

  const deliveryMeta = canonMeta({
    delivery: {
      channel: c.delivery,
      to: "[REDACTED]",
      sid: `SEED${createHash("sha1").update(c.ref).digest("hex").slice(0, 24)}`,
      status: "delivered",
      attempts: [],
    },
    latencyMs: 900 + Math.floor(Math.random() * 600),
  });
  const h2 = chainHash(prev, {
    action: "handoff", callRef: c.ref, callerId: "seed", intent: `delivery_${c.delivery}`, meta: deliveryMeta, orgId: null, redactedText: "[REDACTED]",
  });
  await db.auditLog.create({
    data: {
      callRef: c.ref, action: "handoff", intent: `delivery_${c.delivery}`, callerId: "seed",
      redactedText: "[REDACTED]", meta: deliveryMeta, orgId: null,
      prevHash: prev, chainHash: h2, createdAt: stamp(c.minsAgo - 0.5),
    },
  });
  console.log("✓", c.ref, `risk ${c.risk} · ${c.action} · ${c.delivery}`);
}

const seedProfile = async () => {
  // wallet row for the Clerk operator (created on first sign-in if missing —
  // this pre-arms the credits balance so the console works instantly)
  await db.userProfile.upsert({
    where: { clerkUserId: "user_3J3Lfk4hzKz2MsVGp2Nj1DYGbDj" },
    create: { clerkUserId: "user_3J3Lfk4hzKz2MsVGp2Nj1DYGbDj", email: "operator@securevoice.ae", name: "Platform Operator", role: "operator", credits: 500 },
    update: {},
  });
  await db.userProfile.upsert({
    where: { clerkUserId: "user_3J3Lg9M6FSaFx7LFiw1mb3Zq4VQ" },
    create: { clerkUserId: "user_3J3Lg9M6FSaFx7LFiw1mb3Zq4VQ", email: "demo@securevoice.ae", name: "Demo Explorer", role: "demo", credits: 25 },
    update: {},
  });
  console.log("✓ wallet rows for operator (500) + demo (25)");
};

const main = async () => {
  for (const c of CASES) await seedCase(c);
  await seedProfile();
  const count = await db.auditLog.count();
  console.log(`done — ${count} audit rows total`);
};

main()
  .catch((e) => {
    console.error("seed failed:", e.message);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
