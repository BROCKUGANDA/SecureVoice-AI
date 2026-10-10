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

/** Wallet on the "Demo Bank" tenant. 1 credit = 1 fired intervention. */
const DEMO_ORG_CREDITS = 10000;

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

/**
 * Create the demo Better Auth user + organization + membership.
 *
 * The demo login button on the sign-in page reads NEXT_PUBLIC_DEMO_LOGIN_EMAIL
 * and NEXT_PUBLIC_DEMO_LOGIN_PASSWORD from the environment. Without a matching
 * Better Auth user, the button renders but sign-in fails with "invalid
 * credentials" — a broken first impression for a judge.
 *
 * This function is idempotent: it uses upsert on the user email and
 * findFirst + create on the organization, so re-running the seed is safe.
 *
 * The password is hashed with Better Auth's own scrypt (N=16384, r=16, p=1),
 * NOT a hand-rolled hash. We use node:crypto's scryptSync with the same
 * parameters Better Auth uses internally, and the same `<salt>:<hexkey>`
 * storage shape its verifier reads.
 */
const seedDemoUser = async () => {
  const email = process.env.NEXT_PUBLIC_DEMO_LOGIN_EMAIL?.trim();
  const password = process.env.NEXT_PUBLIC_DEMO_LOGIN_PASSWORD?.trim();
  if (!email || !password) {
    console.log("→ demo user not seeded: NEXT_PUBLIC_DEMO_LOGIN_EMAIL / _PASSWORD not set");
    return;
  }

  // Hash the password into the shape Better Auth 1.7 ACTUALLY verifies.
  //
  // The previous version of this block wrote `scrypt$N$r$p$<salt>$<hash>` — a
  // format from an older Better Auth. In 1.7.7 the verifier is
  // `@better-auth/utils`' `verifyPassword`, which does:
  //     const [salt, key] = hash.split(":");
  //     if (!salt || !key) throw new Error("Invalid password hash");
  // so there is no `$`-delimited encoding to recognise: the value must be
  // `<salt>:<hexkey>`. The seed was therefore producing a hash that made
  // sign-in throw `Invalid password hash` (a 500), which is why the one-click
  // demo login failed even with a correctly seeded user.
  //
  // The parameters are not a convention to approximate — they must match
  // `config` in @better-auth/utils/dist/password.mjs exactly, or the derived
  // key differs and the comparison fails:
  //     N: 16384, r: 16, p: 1, dkLen: 64   (this block previously used r=8)
  // `hashPassword` there also normalises the password to NFKC before deriving,
  // which matters for any non-ASCII password and is a no-op for ASCII ones.
  const { scryptSync, randomBytes } = await import("node:crypto");

  // 32 hex chars — written as a STRING, not decoded to bytes: Better Auth
  // passes the same hex string to scrypt as a UTF-8 salt.
  const salt = randomBytes(16).toString("hex");
  const normalized = password.normalize("NFKC");
  // `maxmem` is not optional. OpenSSL's default is 32 MB and N=16384/r=16 needs
  // ~134 MB, so without it this throws ERR_CRYPTO_INVALID_SCRYPT_PARAMS
  // ("MEMORY_LIMIT_EXCEEDED") and the demo user is seeded with NO credential at
  // all. Better Auth's @noble implementation passes `128*N*r*2`, which is 64 MB;
  // the same figure satisfies OpenSSL here.
  const SCRYPT_MAXMEM = 128 * 16384 * 16 * 2;
  const key = scryptSync(normalized, salt, 64, {
    N: 16384,
    r: 16,
    p: 1,
    maxmem: SCRYPT_MAXMEM,
  }).toString("hex");
  const passwordHash = `${salt}:${key}`;

  // Create or update the user
  const user = await db.user.upsert({
    where: { email },
    create: { email, name: "Demo User", emailVerified: true },
    update: { emailVerified: true },
  });

  // Create or update the credential account.
  // Better Auth's credential sign-in uses providerId="credential" and
  // accountId=userId. The password hash goes in the `password` column.
  const existingAccount = await db.account.findFirst({
    where: { providerId: "credential", userId: user.id },
  });
  if (existingAccount) {
    await db.account.update({
      where: { id: existingAccount.id },
      data: { password: passwordHash },
    });
  } else {
    await db.account.create({
      data: {
        accountId: user.id,
        providerId: "credential",
        userId: user.id,
        password: passwordHash,
        email,
      },
    });
  }

  // Two tenants, one login. The wallet is ORG-scoped (src/lib/credits.ts reads
  // Organization.credits whenever the session carries an active org), so the
  // demo/operator split has to live in the seed or the demo org reads 0 credits
  // and every fired intervention 402s into the Contact Sales modal:
  //   - "Demo Bank"      10 000 credits — the walkthrough has to be able to fire.
  //   - "Operator Desk"       0 credits — shows the honest empty-wallet path,
  //                              including the BYOK alternative to top up.
  const org = await db.organization.upsert({
    where: { slug: "demo-bank" },
    create: {
      name: "Demo Bank",
      slug: "demo-bank",
      createdAt: new Date(),
      credits: DEMO_ORG_CREDITS,
    },
    update: { credits: DEMO_ORG_CREDITS },
  });

  const operatorOrg = await db.organization.upsert({
    where: { slug: "operator-desk" },
    create: {
      name: "Operator Desk",
      slug: "operator-desk",
      createdAt: new Date(),
      institutionType: "bank",
      credits: 0,
    },
    update: { credits: 0 },
  });

  // Memberships. Owner of the demo tenant, plain member of the operator desk:
  // membership is what `requireOperator()` reads, so the role has to exist on
  // both or switching to "Operator Desk" turns the whole console 403.
  const upsertMember = async (organizationId, role) => {
    const existing = await db.member.findFirst({
      where: { userId: user.id, organizationId },
    });
    if (existing) {
      await db.member.update({ where: { id: existing.id }, data: { role } });
      return;
    }
    await db.member.create({
      data: { userId: user.id, organizationId, role, createdAt: new Date() },
    });
  };
  await upsertMember(org.id, "owner");
  await upsertMember(operatorOrg.id, "member");

  // Create or update the user profile. These credits are the ORG-LESS fallback
  // only: as soon as an active org is set the org wallet above is authoritative.
  await db.userProfile.upsert({
    where: { userId: user.id },
    create: { userId: user.id, email, name: "Demo User", credits: 25, role: "demo" },
    update: { credits: 25 },
  });

  console.log(
    `✓ demo user ${email} → orgs "Demo Bank" (owner · ${DEMO_ORG_CREDITS} credits) + "Operator Desk" (member · 0 credits) · 25 fallback credits`,
  );
};

const main = async () => {
  for (const c of CASES) await seedCase(c);
  await seedProfile();
  await seedDemoUser();
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
