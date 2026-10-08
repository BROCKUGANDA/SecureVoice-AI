-- Per-user onboarding progress.
--
-- Signup is invite-only, so every account here was created by a bank. An invited
-- operator arrives with no idea what the console does, and the two failure modes
-- are both worse than having no onboarding at all: a console nobody can read in
-- 60 seconds, or a tour that nags a returning operator forever.
--
-- One row per user, keyed on the account id (the first-party identity, which is
-- what requireAuth returns), with the completed steps as a JSON array. A row per
-- step would make "has this user finished" a count() on the path of every page
-- load; this keeps it a single indexed read.
--
-- `skippedAt` and `completedAt` are both nullable and both meaningful. They are
-- not redundant: "you did the tour" and "you told us to stop showing it" are
-- different facts, and collapsing them means either a tour that nags a power user
-- or a guide nobody can reopen.

CREATE TABLE "OnboardingState" (
    "userId"         UUID NOT NULL,
    "completedSteps"  TEXT NOT NULL DEFAULT '[]',
    "skippedAt"       TIMESTAMP(3),
    "completedAt"     TIMESTAMP(3),
    "updatedAt"       TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OnboardingState_pkey" PRIMARY KEY ("userId")
);
