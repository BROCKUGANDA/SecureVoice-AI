-- Bind inbound ElevenLabs events to a tenant.
--
-- Bleedguard, second half. Per-tenant tool secrets closed the AGENT TOOL path:
-- the credential names the org, so the case lookup is tenant-scoped. The inbound
-- WEBHOOK path had no such signal — it authenticates on one shared platform
-- secret, so a replayed conversation id could still be correlated against a case
-- belonging to any tenant.
--
-- The payload already carries the identifier. ElevenLabs names the agent that
-- produced the event, and the platform dials one phone number per tenant, so
-- either one resolves to exactly one organization. Recording that binding turns
-- the webhook from "platform-scoped, trust the shared secret" into
-- "tenant-scoped, verified by which agent this event came from".
--
-- Unique because the mapping must be one-to-one in both directions: two tenants
-- sharing an agent id would make the binding ambiguous and reintroduce exactly
-- the cross-tenant read this closes. NULL is allowed and repeatable, so a
-- single-tenant deployment needs no configuration and an unbound event still
-- resolves to the default namespace rather than failing.

ALTER TABLE "organization" ADD COLUMN "elevenAgentId" TEXT;
ALTER TABLE "organization" ADD COLUMN "elevenPhoneNumberId" TEXT;

CREATE UNIQUE INDEX "organization_elevenAgentId_key" ON "organization"("elevenAgentId");
CREATE UNIQUE INDEX "organization_elevenPhoneNumberId_key" ON "organization"("elevenPhoneNumberId");