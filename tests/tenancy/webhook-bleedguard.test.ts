/**
 * Webhook bleedguard — inbound ElevenLabs events must correlate only within the
 * tenant that owns the agent the event names.
 *
 * The delivery authenticates on ONE shared platform secret, which proves nothing
 * about tenancy. Before the per-org agent binding, a replayed `conversation_id`
 * could therefore be correlated against a case belonging to any tenant.
 *
 * The property under test: the tenant is resolved from `agent_id`, and the case
 * lookup is scoped by it. So an event naming org A's agent cannot resolve org
 * B's case — it is quarantined instead.
 */
import { test, expect, afterAll } from "bun:test";
import { db } from "@/lib/db";
import { resolveInboundOrgId } from "@/lib/elevenlabs/inbound";
import { caseByConversation } from "@/lib/case-state-machine";

process.env.ELEVENLABS_DRY_RUN = "true";

const ORG_A = "aaaaaaaa-0000-4000-8000-aaaaaaaaaaa1";
const ORG_B = "bbbbbbbb-0000-4000-8000-bbbbbbbbbbb2";
const AGENT_A = "agent-alpha-1111";
const AGENT_B = "agent-beta-2222";
const RUN = Date.now().toString(36);

async function seedOrg(id: string, slug: string, agentId: string) {
  await db.organization.upsert({
    where: { id },
    create: { id, name: `Bleedguard ${slug}`, slug, createdAt: new Date(), elevenAgentId: agentId },
    update: { elevenAgentId: agentId },
  });
}

async function seedCase(orgId: string, conversationId: string) {
  return db.case.create({
    data: {
      caseRef: `SV-BG-${slugSafe(orgId)}-${RUN}`,
      conversationId,
      orgId,
      state: "CONFIRMED_FRAUD",
      phone: "+97150000000",
      language: "en",
    },
    select: { id: true, caseRef: true, orgId: true, conversationId: true },
  });
}

function slugSafe(v: string) {
  return v.slice(0, 8);
}

afterAll(async () => {
  await db.case.deleteMany({ where: { caseRef: { startsWith: "SV-BG-" } } });
  await db.organization.deleteMany({ where: { elevenAgentId: { in: [AGENT_A, AGENT_B] } } });
  // No $disconnect here: this file shares one process with the other tenancy
  // suites, and disconnecting the shared Prisma client out from under them is
  // what made six unrelated console-route assertions fail. probe-registry owns
  // the disconnect.
});

test("WEBHOOK BLEEDGUARD: an event naming org A's agent cannot resolve org B's case", async () => {
  await seedOrg(ORG_A, `bg-a-${RUN}`, AGENT_A);
  await seedOrg(ORG_B, `bg-b-${RUN}`, AGENT_B);

  const caseB = await seedCase(ORG_B, `conv-b-${RUN}`);
  const caseA = await seedCase(ORG_A, `conv-a-${RUN}`);

  // The event names org A's agent...
  const row = {
    id: "row-a",
    eventType: "post_call_transcription",
    conversationId: caseB.conversationId,
    eventTimestamp: Date.now(),
    agentId: AGENT_A,
  };
  const orgForA = await resolveInboundOrgId(row, { agent_id: AGENT_A });

  // ...so it resolves to org A, and org B's conversation id is out of scope.
  expect(orgForA).toBe(ORG_A);

  const leaked = await caseByConversation(caseB.conversationId!, orgForA);
  expect(leaked).toBeNull();

  // The control: the same lookup scoped to the OWNING tenant does resolve, so
  // the assertion above is about the tenant predicate and not a broken lookup.
  const own = await caseByConversation(caseB.conversationId!, ORG_B);
  expect(own?.caseRef).toBe(caseB.caseRef);
  const ownA = await caseByConversation(caseA.conversationId!, ORG_A);
  expect(ownA?.caseRef).toBe(caseA.caseRef);
});

test("WEBHOOK BLEEDGUARD: an unbound agent falls back to the default namespace, not any org", async () => {
  const row = {
    id: "row-unknown",
    eventType: "post_call_transcription",
    conversationId: null,
    eventTimestamp: Date.now(),
    agentId: null,
  };
  expect(await resolveInboundOrgId(row, {})).toBeNull();
});

test("WEBHOOK BLEEDGUARD: the payload agent_id wins over the stored row", async () => {
  await seedOrg(ORG_B, `bg-b2-${RUN}`, AGENT_B);

  // A tampered/incorrect stored row must not widen the scope: the signed
  // payload's own agent_id is authoritative.
  const row = {
    id: "row-tamper",
    eventType: "post_call_transcription",
    conversationId: null,
    eventTimestamp: Date.now(),
    agentId: AGENT_A,
  };
  expect(await resolveInboundOrgId(row, { agent_id: AGENT_B })).toBe(ORG_B);
});
