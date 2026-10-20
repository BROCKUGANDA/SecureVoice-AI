-- Per-tool scoping for tenant agent credentials. NULL is the legacy shape and
-- remains readable; new credentials always carry a scope list.
ALTER TABLE "AgentToolSecret" ADD COLUMN IF NOT EXISTS "toolScope" TEXT;
