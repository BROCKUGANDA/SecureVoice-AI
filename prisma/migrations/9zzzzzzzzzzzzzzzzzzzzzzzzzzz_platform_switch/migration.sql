-- PlatformSwitch: the deploy-free kill switch.
--
-- WHY THIS TABLE, AND WHY IT IS EMPTY BY DEFAULT
--
-- `BILLING_KILL_SWITCH` is an environment variable, and an environment variable
-- inside a container is fixed when the container starts. Flipping it in `.env`
-- stops metering only after a `docker compose up -d` -- which is a deploy
-- wearing a hat: it needs host access, it needs the box, and it needs somebody
-- awake enough to run it. A kill switch that cannot be flipped by the person
-- holding the pager is not an incident lever, it is a runbook step, and the
-- runbook said as much: until this migration, the ONLY genuinely deploy-free
-- switch stopped BILLING, and stopping DIALLING required
-- `docker compose stop dial-worker`.
--
-- This table is the second half of the dial kill switch. A row here is read by
-- every dial worker before every call, so the platform stops contacting
-- customers within seconds of an operator flipping it from the console -- no
-- restart, no deploy, no shell on the host.
--
-- The table is CREATED EMPTY on purpose. No row means "not engaged". A table
-- that shipped with the switch ON would be a deployment that could not make a
-- call, and a table that shipped with a row for every possible switch would be
-- a table of defaults nobody has decided on.
--
-- WHY IT IS NOT TENANT-SCOPED
--
-- There is no organisation column, and there must not be one: "stop
-- contacting customers" is a platform-wide control. A per-tenant kill switch
-- would be a lockout waiting for a support ticket, and the control this
-- implements is the one that has to work when the platform itself is the
-- problem.
--
-- The consequence is that this table sits OUTSIDE the row-level-security
-- boundary the tenant-scoped tables live in: it holds no personal data, it has
-- no tenant to scope by, and the RLS migrations select their tables by
-- "has a column named orgId" -- which this table deliberately does not have.
--
-- The grant below is to `sv_tenant` so the switch is still READABLE from
-- inside a tenant-scoped transaction. Read only: the tenant role has no
-- business engaging a platform-wide switch, and the console route that writes
-- it runs as the application role.

-- CreateTable
CREATE TABLE "PlatformSwitch" (
    "name" TEXT NOT NULL,
    "engaged" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT,
    "actor" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformSwitch_pkey" PRIMARY KEY ("name")
);

-- Idempotent by construction, like every later migration in this repository:
-- `migrate deploy` runs each file once, but a manual replay must not fail
-- halfway. The role is created by the tenant_rls migration, which runs BEFORE
-- this one, so the guard is only there for a database where that migration has
-- not been applied.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sv_tenant') THEN
    GRANT SELECT ON "PlatformSwitch" TO sv_tenant;
  END IF;
END $$;
