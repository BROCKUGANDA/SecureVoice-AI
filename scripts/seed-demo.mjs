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

import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { createHash } from "node:crypto";

// Prisma ORM v7 has no built-in pool: the connection is opened by the
// `@prisma/adapter-pg` driver adapter. `?schema=` is a Prisma-only query param
// that node-pg drops, so it is passed to the adapter explicitly.
const databaseUrl = process.env.DATABASE_URL ?? "";
const namedSchema = /[?&]schema=([^&]+)/.exec(databaseUrl)?.[1];
const db = new PrismaClient({
  adapter: new PrismaPg(
    { connectionString: databaseUrl, max: 1 },
    namedSchema ? { schema: namedSchema } : undefined,
  ),
});
const GENESIS = "0".repeat(64);

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
  return createHash("sha256")
    .update(prev + "\n" + JSON.stringify(rec))
    .digest("hex");
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
  {
    ref: "SV-8642",
    lang: "ar",
    risk: 0.94,
    channel: "card",
    amount: "AED 2500",
    merchant: "Electronics World",
    action: "card_freeze_temporary",
    delivery: "call",
    minsAgo: 26,
  },
  {
    ref: "SV-8641",
    lang: "en",
    risk: 0.91,
    channel: "payment",
    amount: "AED 8120",
    merchant: "Online FX",
    action: "card_freeze_temporary",
    delivery: "sms",
    minsAgo: 52,
  },
  {
    ref: "SV-8640",
    lang: "ur",
    risk: 0.88,
    channel: "transfer",
    amount: "AED 950",
    merchant: "Telecom top-up",
    action: "transfer_hold_24h",
    delivery: "call",
    minsAgo: 74,
  },
  {
    ref: "SV-8639",
    lang: "en",
    risk: 0.83,
    channel: "card",
    amount: "AED 320",
    merchant: "Grocery abroad",
    action: "verify_only",
    delivery: "sms",
    minsAgo: 96,
  },
  {
    ref: "SV-8638",
    lang: "hi",
    risk: 0.9,
    channel: "remittance",
    amount: "AED 6000",
    merchant: "Wire transfer",
    action: "transfer_hold_24h",
    delivery: "call",
    minsAgo: 118,
  },
  {
    ref: "SV-8637",
    lang: "ar",
    risk: 0.96,
    channel: "card",
    amount: "AED 12300",
    merchant: "Luxury retail",
    action: "card_freeze_temporary",
    delivery: "call",
    minsAgo: 141,
  },
  {
    ref: "SV-8636",
    lang: "en",
    risk: 0.87,
    channel: "login",
    amount: null,
    merchant: null,
    action: "verify_only",
    delivery: "sms",
    minsAgo: 163,
  },
  {
    ref: "SV-8635",
    lang: "ur",
    risk: 0.95,
    channel: "card",
    amount: "AED 4400",
    merchant: "Crypto ramp",
    action: "card_freeze_temporary",
    delivery: "call",
    minsAgo: 187,
  },
  {
    ref: "SV-8634",
    lang: "fr",
    risk: 0.92,
    channel: "card",
    amount: "AED 3100",
    merchant: "Marché Global",
    action: "card_freeze_temporary",
    delivery: "sms",
    minsAgo: 210,
  },
  {
    ref: "SV-8633",
    lang: "sw",
    risk: 0.93,
    channel: "remittance",
    amount: "AED 1850",
    merchant: "Hawala Express",
    action: "transfer_hold_24h",
    delivery: "call",
    minsAgo: 233,
  },
  {
    ref: "SV-8632",
    lang: "fr",
    risk: 0.89,
    channel: "payment",
    amount: "AED 990",
    merchant: "Boutique en ligne",
    action: "card_freeze_temporary",
    delivery: "sms",
    minsAgo: 258,
  },
  {
    ref: "SV-8631",
    lang: "sw",
    risk: 0.9,
    channel: "login",
    amount: null,
    merchant: null,
    action: "verify_only",
    delivery: "sms",
    minsAgo: 282,
  },
  {
    ref: "SV-8630",
    lang: "hi",
    risk: 0.92,
    channel: "card",
    amount: "AED 7800",
    merchant: "Luxury retail",
    action: "card_freeze_temporary",
    delivery: "call",
    minsAgo: 305,
  },
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
    redactedText:
      `BANK-SEED-${c.ref} · CUST-${c.ref.slice(-4)} · ${c.channel} · ${c.risk}` +
      (c.merchant ? ` · ${c.merchant}` : ""),
  };

  const h1 = chainHash(prev, base);
  await db.auditLog.create({
    data: {
      callRef: base.callRef,
      action: base.action,
      intent: base.intent,
      callerId: base.callerId,
      redactedText: base.redactedText,
      meta: base.meta,
      orgId: null,
      prevHash: prev,
      chainHash: h1,
      createdAt: stamp(c.minsAgo),
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
    action: "handoff",
    callRef: c.ref,
    callerId: "seed",
    intent: `delivery_${c.delivery}`,
    meta: deliveryMeta,
    orgId: null,
    redactedText: "[REDACTED]",
  });
  await db.auditLog.create({
    data: {
      callRef: c.ref,
      action: "handoff",
      intent: `delivery_${c.delivery}`,
      callerId: "seed",
      redactedText: "[REDACTED]",
      meta: deliveryMeta,
      orgId: null,
      prevHash: prev,
      chainHash: h2,
      createdAt: stamp(c.minsAgo - 0.5),
    },
  });
  console.log("✓", c.ref, `risk ${c.risk} · ${c.action} · ${c.delivery}`);
}

const seedProfile = async () => {
  // Wallet rows for the two seeded platform seats.
  //
  // These used to be created against the Clerk userIds ("user_…") and the old
  // `clerkUserId` column. Both are gone: `UserProfile.userId` is now a UUID that
  // references the Better Auth `user` row (better-auth.ts sets
  // advanced.database.generateId = "uuid"), so a Clerk-shaped string cannot be
  // written at all.
  //
  // The demo seats therefore cannot be pre-armed here: a UserProfile must be
  // attached to a real Better Auth user, and those users are created by signing
  // up (or by the invite flow), not by this script. `createIdentity()` in
  // src/lib/auth/identity.ts already creates the profile row on first sign-in,
  // with the operator role and 500 credits. Seeding a row here would only
  // produce an orphan that fails the foreign key.
  //
  // To run the console with the operator seat: sign up as the operator email,
  // then add that user to the tenant organization and grant the operator role
  // (roles come from organization membership, not from this row).
  console.log("→ profiles are created on first sign-in; nothing to seed for the wallets");
};

/**
 * The Console's "Fire intervention signal" button needs an enrolled Customer:
 * the hardened `/v1/interventions` path resolves the destination from a real
 * row, tenant-scoped, and refuses with a typed `customer_not_enrolled` when
 * there is none. Without this step a freshly seeded deployment has nobody to
 * call, and the judge's very first click does nothing.
 *
 * A phone number is NOT invented here. Dialling a number nobody verified is
 * worse than not dialling: it is a real call to a real stranger, and it makes
 * the demo evidence a fabrication. The operator supplies a number they have
 * verified on the Twilio trial, and the seed either creates the enrollment or
 * says, in as many words, that it did not.
 */
const seedEnrollment = async () => {
  const phone = process.env.DEMO_TEST_PHONE?.trim();
  const consentRecordId = process.env.DEMO_CONSENT_RECORD_ID?.trim();
  if (!phone || !consentRecordId) {
    console.log(
      "⚠ NO ENROLLED CUSTOMER — the console 'Fire intervention signal' button will\n" +
        "  return customer_not_enrolled until you set both:\n" +
        "    DEMO_TEST_PHONE=+<E.164 test number you have verified on Twilio>\n" +
        "    DEMO_CONSENT_RECORD_ID=CONSENT-<your consent record>\n" +
        "  then re-run `bun run db:seed`. The number is not invented here on purpose.",
    );
    return;
  }
  if (!/^\+[1-9]\d{1,14}$/.test(phone)) {
    console.error(`✗ DEMO_TEST_PHONE is not E.164: ${phone}`);
    process.exitCode = 1;
    return;
  }
  const customerRef = `SELF-${(process.env.DEMO_OPERATOR_EMAIL ?? "operator").split("@")[0].replace(/\W/g, "") || "operator"}`;
  await db.customer.upsert({
    where: { customerRef },
    create: {
      customerRef,
      phone,
      consentRecordId,
      optedOut: false,
      lang: "en",
      channel: "call",
    },
    update: { phone, consentRecordId, optedOut: false },
  });
  console.log(`✓ enrolled customer ${customerRef} → ${phone}`);
};

const main = async () => {
  for (const c of CASES) await seedCase(c);
  await seedProfile();
  await seedEnrollment();
  const count = await db.auditLog.count();
  console.log(`done — ${count} audit rows total`);
};

main()
  .catch((e) => {
    console.error("seed failed:", e.message);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
