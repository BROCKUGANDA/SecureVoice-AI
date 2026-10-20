import "server-only";
/**
 * Pilot mode — the bounded operating mode a live pilot runs in, and the
 * deploy-free lever that stops outbound dialling.
 *
 * ── Why this exists ───────────────────────────────────────────────────────────
 *
 * `docs/PILOT-READINESS.md` describes a Phase 1 pilot: one alert type, an
 * opt-in cohort, a hard daily call cap, human approval of every dial, and a
 * kill switch the institution holds. Every one of those was a sentence in a
 * document and none of them was a control in the code. The platform could
 * place a call, but it could not be *bounded*: there was no mode to run a
 * pilot in, no per-tenant volume ceiling, no per-dial human gate, and — the
 * gap `docs/RUNBOOK.md` §3 records in its own words — "no kill switch for live
 * dialling". Stopping outbound calls meant `docker compose stop dial-worker`,
 * which is a deploy wearing a hat.
 *
 * This module is the missing control surface. It is deliberately small, and
 * every part of it is a switch an operator can reach during an incident.
 *
 * ── The three modes ───────────────────────────────────────────────────────────
 *
 *   off     — normal operation. No pilot ceiling applies. THE DEFAULT, and the
 *             mode every existing deployment is in, so switching pilot mode on
 *             is an explicit act rather than a side effect of an env change.
 *   shadow  — Phase 0. The platform records cases and runs every gate, but
 *             places NO calls and sends NO SMS: it touches no customer. This
 *             is what "shadow pilot on an approved pseudonymised dataset" means
 *             in `docs/PILOT-READINESS.md`.
 *   live    — Phase 1. Calls happen, bounded by the volume cap, the
 *             concurrency cap, the one-alert-type restriction, and a human
 *             approval recorded per dial.
 *
 * ── The kill switch, and why it has two halves ────────────────────────────────
 *
 * `DIAL_KILL_SWITCH` (environment) is read from `process.env` on EVERY
 * decision and is never cached, so flipping it takes effect on the next call.
 * But an environment variable inside a container is fixed when the container
 * starts: flipping it in `.env` needs a `docker compose up -d`, host access,
 * and somebody awake. That is the same objection the repository raises about
 * `BILLING_KILL_SWITCH` in `src/lib/billing/breaker.ts`, and it is why the
 * switch ALSO has a database half: a row in `PlatformSwitch`, written by the
 * console and read by every worker before every call. That half needs no
 * deploy, no restart and no shell — the person holding the pager flips it and
 * the platform stops dialling within seconds.
 *
 * The two halves are OR'd. Either one stops dialling. The environment half is
 * the outer brake for a host that is already unwell; the database half is the
 * lever for a live incident.
 *
 * ── What the kill switch stops, and what it does not ──────────────────────────
 *
 * It stops VOICE. The blind-ping SMS fallback keeps running, and that is a
 * deliberate boundary rather than an omission: the SMS exists to WARN a
 * customer that their card is being questioned and to tell the bank the
 * customer was not reached. Suppressing it during a voice incident would
 * leave a customer with a live fraud attempt and nobody telling them. What
 * the switch does guarantee is that no CARRIER CALL is placed.
 *
 * Pilot mode is different, and stricter: in `shadow` mode nothing is sent at
 * all, because Phase 0 touches no customer — not even a warning text. And a
 * pilot BLOCK (cap reached, awaiting approval) parks the dial job instead of
 * failing it, so a blocked pilot can never trigger the SMS fallback either.
 *
 * ── Every pilot block PARKS; none of them ever fails ──────────────────────────
 *
 * A blocked dial is not a failed dial. `src/lib/scale/queue.ts` distinguishes
 * the two: a failure consumes an attempt and, at the end of the ladder,
 * dead-letters the job into the SMS fallback — which sends a blind-ping text
 * to a customer. A pilot block must never do that. "The kill switch is on",
 * "the daily cap is reached", "a human has not approved this dial yet" are
 * all reasons to WAIT, and the queue already has the mechanism for waiting:
 * `failDialJob` with a `retryAfterMs` puts the row back to PENDING WITHOUT
 * consuming an attempt. So every block here returns a retryable outcome with a
 * delay, and no pilot block can ever produce a customer-facing SMS.
 *
 * ── The counters are the DATABASE's ───────────────────────────────────────────
 *
 * The daily count and the concurrency count are both computed by Postgres, in
 * the database's own clock and against the database's own rows. The lesson
 * recorded at the top of `src/lib/scale/queue.ts` is that a JS `Date` written
 * through the driver arrives as its UTC wall time while `now()` returns the
 * server's local wall time — on this deployment's host, three hours apart — so
 * a window computed in JS and compared against a database timestamp is wrong
 * by three hours. Every window here is therefore expressed as
 * `now() - interval` / `date_trunc('day', now())` in SQL, and every row
 * counted is a row the DATABASE wrote (`dial_job.created_at` is always
 * `now()`; nothing writes it from JavaScript).
 *
 * ── What "the cap" counts ────────────────────────────────────────────────────
 *
 * One intervention = one case dispatched to the dial queue, regardless of
 * outcome. That is the same definition the pricing model uses, and it is the
 * right one for a pilot: a case that rang out and a case that reached a
 * customer both consumed an intervention, and a cap measured on "calls
 * actually answered" would let a pilot dial twice its contracted volume
 * during a bad week of unanswered calls.
 */

import { db } from "@/lib/db";
import { DEFAULT_ORG_ID } from "@/lib/tenancy/guard";
import { logError, logInfo, logWarn } from "@/lib/validation/safe-log";

/* ── The vocabulary ─────────────────────────────────────────────────────────── */

export const PILOT_MODES = ["off", "shadow", "live"] as const;
export type PilotMode = (typeof PILOT_MODES)[number];

export const PILOT_MODE_ENV = "PILOT_MODE";
export const DIAL_KILL_SWITCH_ENV = "DIAL_KILL_SWITCH";
export const PILOT_DAILY_CALL_CAP_ENV = "PILOT_DAILY_CALL_CAP";
export const PILOT_CONCURRENCY_CAP_ENV = "PILOT_CONCURRENCY_CAP";
export const PILOT_HUMAN_APPROVAL_ENV = "PILOT_HUMAN_APPROVAL";
export const PILOT_SIGNAL_KIND_ENV = "PILOT_SIGNAL_KIND";

/** The row name the dial kill switch occupies in `PlatformSwitch`. */
export const DIAL_KILL_SWITCH_NAME = "dial_kill_switch";

/**
 * The audit `intent` that records a human approving ONE dial.
 *
 * The approval lives in the append-only audit chain rather than in a column on
 * the case: the chain is already the record a bank's reviewer reads, it is
 * already tamper-evident, and it is already indexed on `(callRef, createdAt)`
 * so the lookup is cheap. A column would be a second place to look and a
 * second thing to keep in step with the chain.
 */
export const PILOT_APPROVAL_INTENT = "pilot_dial_approved";
/** The audit `intent` that records a human declining a dial. */
export const PILOT_DECLINE_INTENT = "pilot_dial_declined";

/**
 * The kill switch's truthy spellings.
 *
 * Identical to `BILLING_KILL_SWITCH`'s set in `src/lib/billing/breaker.ts`,
 * deliberately: an operator who has learned one switch has learned the other,
 * and two different vocabularies for "stop everything" is one more thing to
 * get wrong at 03:00. Anything else is NOT engaged — the same allowlist
 * semantics the billing breaker uses, and for the same reason: an
 * unrecognised value must not silently mean "the platform is off".
 *
 * ── WHY A TYPO DOES NOT ENGAGE THE SWITCH ────────────────────────────────────
 *
 * The obvious alternative is to treat any unrecognised non-empty value as
 * ENGAGED, so that `DIAL_KILL_SWITCH=stoppped` cannot leave the platform
 * dialling through what the operator believes is a stop. That is the wrong
 * trade here, and the reason is specific to the ENV half.
 *
 * The database half fails CLOSED because a database blip is a TRANSIENT
 * condition: it resolves on its own, and the conservative reading costs a
 * minute of not-dialling. An env value is not transient — it is written in a
 * file and read at container start, so a typo there is a PERMANENT
 * condition. Failing closed on a typo would therefore mean: one misspelling
 * stops every outbound call for this deployment until somebody finds the
 * spelling, restarts the container and fixes it. For a fraud platform that is
 * a self-inflicted outage traded for a control that has a working database
 * half and a console switch behind it.
 *
 * So the env half keeps allowlist semantics and the gap is closed where it
 * can actually be seen: the unrecognised value is logged LOUDLY (once per
 * distinct value) and the raw value and a `recognised` flag are published on
 * `pilotStatus`, so the console says
 * `env: "stoppped" — NOT RECOGNISED, the switch is NOT engaged` rather than
 * a bare `false` the operator has to interpret.
 */
const KILL_SWITCH_TRUE = new Set(["1", "true", "on", "yes", "stop", "halt"]);

/**
 * The explicit "not engaged" spellings.
 *
 * `DIAL_KILL_SWITCH=0` is what an operator writes when they mean "leave it
 * off", and it has to MEAN that — otherwise the natural thing to type during
 * an incident (to be explicit) would stop every fraud call. The switch has
 * three states, not two: unset (off), explicitly off (off), and anything else
 * that is not a recognised spelling (NOT engaged, but loudly).
 */
const KILL_SWITCH_FALSE = new Set(["0", "false", "off", "no", "disabled", "none"]);

/** The raw env value the kill switch was last read with, for the status surface. */
let killSwitchEnvRaw: string | null = null;
/** The last unrecognised kill-switch value we complained about. */
let killSwitchEnvRefusedRaw: string | null = null;

/* ── The mode ────────────────────────────────────────────────────────────────── */

/**
 * The last unrecognised `PILOT_MODE` value we complained about.
 *
 * One warning per DISTINCT value: the getter runs on every decision, so a
 * boolean warn-once would spam-free but also evidence-free — a second operator
 * correcting the typo would get silence.
 */
let pilotModeRefusedRaw: string | null = null;

/**
 * The pilot mode this deployment is in.
 *
 * An UNRECOGNISED value resolves to `"shadow"`, not to `"off"`, and that is the
 * one genuinely debatable decision in this file.
 *
 * The operator set a pilot-mode variable. The platform cannot honour what it
 * does not understand, so it must choose a direction, and the two directions
 * are not symmetric: `"shadow"` places no calls and `"off"` places calls with
 * no pilot ceiling at all. A typo in a variable whose whole purpose is to
 * BOUND the platform must not resolve to "unbounded". The cost of the
 * conservative reading is a deployment that stops making calls until somebody
 * reads the log line — and the log line says exactly what happened and what
 * the valid values are, on the first request that touches it.
 *
 * An UNSET variable is `"off"`, and that is not the same case at all: unset is
 * the state every existing deployment is in, and the mode that leaves their
 * behaviour unchanged.
 */
export function pilotMode(): PilotMode {
  return pilotModeResolution().mode;
}

/**
 * The pilot mode AND whether the operator's spelling was understood.
 *
 * `pilotMode()` alone answers "what will the platform do", which is the
 * question the decision path needs. It cannot answer "did the operator mean
 * what they typed", and a typo in `PILOT_MODE` is otherwise invisible on
 * every operator surface: `mode: "shadow"` renders exactly like a deliberate
 * Phase 0, so an operator who wrote `PILOT_MODE=shaddow` concludes the pilot
 * is intentionally in shadow when the truth is that the platform refused to
 * understand them.
 *
 * The effective mode is still `"shadow"` — the conservative reading is
 * unchanged — but `recognised: false` and the raw value travel with it so
 * the console and `/api/status` can say so out loud.
 */
export function pilotModeResolution(): {
  mode: PilotMode;
  raw: string;
  recognised: boolean;
} {
  const raw = (process.env[PILOT_MODE_ENV] ?? "").trim().toLowerCase();
  if (raw === "") return { mode: "off", raw: "", recognised: true };
  if ((PILOT_MODES as readonly string[]).includes(raw)) {
    return { mode: raw as PilotMode, raw, recognised: true };
  }

  if (pilotModeRefusedRaw !== raw) {
    pilotModeRefusedRaw = raw;
    logError("[pilot] PILOT_MODE is not a recognised mode", {
      value: raw.slice(0, 40),
      valid: PILOT_MODES.join(","),
      effect: "treating it as 'shadow' — no outbound contact",
    });
  }
  return { mode: "shadow", raw, recognised: false };
}

/* ── The kill switch ─────────────────────────────────────────────────────────── */

/**
 * The environment half of the dial kill switch.
 *
 * Read from `process.env` on EVERY call and never cached at module scope: a
 * cached value would need a restart to change, which is the exact property
 * that makes a switch useless in an incident.
 */
export function dialKillSwitchEnvEngaged(): boolean {
  const raw = process.env[DIAL_KILL_SWITCH_ENV];
  killSwitchEnvRaw = raw ?? null;
  if (!raw) return false;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "") return false;
  if (KILL_SWITCH_TRUE.has(trimmed)) return true;
  // An explicit "off" is not a typo and does not deserve a complaint.
  if (KILL_SWITCH_FALSE.has(trimmed)) return false;
  if (killSwitchEnvRefusedRaw !== trimmed) {
    killSwitchEnvRefusedRaw = trimmed;
    logError("[pilot] DIAL_KILL_SWITCH is not a recognised spelling — the switch is NOT engaged", {
      value: trimmed.slice(0, 40),
      recognised: Array.from(KILL_SWITCH_TRUE).join(","),
      effect:
        "outbound dialling CONTINUES; fix the value or use the operator switch in the console",
    });
  }
  return false;
}

/**
 * The raw environment value the kill switch was last read with.
 *
 * Null when the variable is unset. Exposed so the operator surface can print
 * the value rather than a bare boolean.
 */
export function dialKillSwitchEnvRawValue(): string | null {
  return killSwitchEnvRaw;
}

/**
 * Was the environment value UNDERSTOOD?
 *
 * "Unset" counts as understood — there is nothing to mis-spell. An
 * unrecognised value is the one case that matters, because the operator
 * believes the switch is doing something it is not.
 */
export function dialKillSwitchEnvRecognised(): boolean {
  const raw = killSwitchEnvRaw;
  if (raw === null) return true;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "") return true;
  if (KILL_SWITCH_TRUE.has(trimmed)) return true;
  // The explicit "off" spellings are understood too: they mean the same thing
  // as leaving the variable unset, and an operator who wrote one of them is
  // not confused.
  return KILL_SWITCH_FALSE.has(trimmed);
}

/**
 * How long a database-read switch state is trusted before it is re-read.
 *
 * Five seconds. Long enough that the hot path is not paying a round-trip per
 * dial, short enough that the person who flipped the switch sees the platform
 * stop before they start wondering whether it worked. The environment half has
 * NO cache at all, because reading it costs nothing.
 */
const SWITCH_CACHE_MS = 5_000;

type CachedSwitch = { engaged: boolean; readAt: number; available: boolean };
let cachedDialSwitch: CachedSwitch | null = null;

/** Test seam: forget the cached switch state. */
export function _resetPilotSwitchCacheForTest(): void {
  cachedDialSwitch = null;
}

/**
 * The last database-read failure we complained about.
 *
 * One complaint per outage, not one per read. The read is cached for five
 * seconds, so a database that is down for an hour would otherwise produce
 * seven hundred identical log lines — and a log that repeats itself every five
 * seconds is a log nobody reads, which is how a switch that is working (or a
 * database that is not) goes unnoticed.
 */
let switchReadFailureLogged = false;

/**
 * The database half of the dial kill switch.
 *
 * Fails CLOSED on a database error: a switch whose state cannot be read is
 * treated as ENGAGED. That is the conservative direction for a control whose
 * purpose is "stop contacting customers" — but it is worth being honest about
 * the cost: a database blip stops the platform dialling until the blip ends.
 * The alternative (fail open) means a database blip silently disarms the
 * switch, which is the failure the switch exists to prevent. A pilot that
 * stops calling for ninety seconds during a database wobble is a much better
 * outcome than a pilot that keeps calling because it could not read a row.
 *
 * The read is cached for `SWITCH_CACHE_MS`; see the note there.
 */
export async function dialKillSwitchDbState(): Promise<{
  engaged: boolean;
  available: boolean;
}> {
  const now = Date.now();
  if (cachedDialSwitch && now - cachedDialSwitch.readAt < SWITCH_CACHE_MS) {
    return { engaged: cachedDialSwitch.engaged, available: cachedDialSwitch.available };
  }
  try {
    const row = await db.platformSwitch.findUnique({
      where: { name: DIAL_KILL_SWITCH_NAME },
      select: { engaged: true },
    });
    const engaged = row?.engaged === true;
    cachedDialSwitch = { engaged, readAt: now, available: true };
    if (switchReadFailureLogged) {
      switchReadFailureLogged = false;
      logInfo("[pilot] the dial kill switch is readable again", {
        engaged,
        effect: engaged ? "outbound dialling remains stopped" : "outbound dialling may resume",
      });
    }
    return { engaged, available: true };
  } catch (err) {
    cachedDialSwitch = { engaged: true, readAt: now, available: false };
    if (!switchReadFailureLogged) {
      switchReadFailureLogged = true;
      logError("[pilot] could not read the dial kill switch; treating it as ENGAGED", {
        error: err instanceof Error ? err.message : String(err),
        effect: "outbound dialling is stopped until the database is readable",
      });
    }
    return { engaged: true, available: false };
  }
}

/**
 * Engage or release the dial kill switch.
 *
 * The write is the console's; this function is the only thing that performs
 * it, so the state has exactly one writer and the audit row and the table row
 * cannot disagree.
 */
export async function setDialKillSwitch(input: {
  engaged: boolean;
  actor: string;
  reason?: string;
}): Promise<{ engaged: boolean; updatedAt: Date }> {
  const row = await db.platformSwitch.upsert({
    where: { name: DIAL_KILL_SWITCH_NAME },
    create: {
      name: DIAL_KILL_SWITCH_NAME,
      engaged: input.engaged,
      reason: input.reason ?? null,
      actor: input.actor,
    },
    update: {
      engaged: input.engaged,
      reason: input.reason ?? null,
      actor: input.actor,
      updatedAt: new Date(),
    },
    select: { engaged: true, updatedAt: true },
  });
  // The cache is dropped rather than updated: the next read must come from the
  // database, because the write that just happened is the thing the cache would
  // otherwise contradict for up to five seconds.
  cachedDialSwitch = null;
  return row;
}

/**
 * Is dialling stopped right now, by either half of the switch?
 *
 * The environment half is checked FIRST and costs nothing: if the operator has
 * already set it, there is no reason to touch the database at all.
 */
export async function dialKillSwitchEngaged(): Promise<boolean> {
  if (dialKillSwitchEnvEngaged()) return true;
  const state = await dialKillSwitchDbState();
  return state.engaged;
}

/* ── The caps ───────────────────────────────────────────────────────────────── */

/**
 * A positive-integer environment value, or null when unset.
 *
 * A malformed value THROWS rather than resolving to a default. The billing
 * breaker does the same for its caps (`envMinor` in
 * `src/lib/billing/breaker.ts`), and for the same reason: a cap that silently
 * became "unlimited" is the failure this whole class of control exists to
 * prevent, and a cap that silently became "zero" is a self-inflicted outage.
 * The caller catches and fails closed.
 */
function positiveIntEnv(name: string): number | null {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return null;
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n <= 0) {
    throw new RangeError(`${name} must be a positive integer (got ${JSON.stringify(raw)})`);
  }
  return n;
}

/** Interventions one organisation may dispatch per day, or null for no cap. */
export function pilotDailyCallCap(): number | null {
  return positiveIntEnv(PILOT_DAILY_CALL_CAP_ENV);
}

/** Calls one organisation may have in flight at once, or null for no cap. */
export function pilotConcurrencyCap(): number | null {
  return positiveIntEnv(PILOT_CONCURRENCY_CAP_ENV);
}

/**
 * The one alert type this pilot is chartered for, or null for no restriction.
 *
 * "One alert type" is a Phase 1 rule in `docs/PILOT-READINESS.md` §3, and a
 * restriction on the SIGNAL rather than on the call: a card-fraud pilot that
 * quietly starts dialling claimants is a scope violation the customer did not
 * agree to, and no amount of downstream care fixes it.
 */
export function pilotSignalKind(): string | null {
  const raw = (process.env[PILOT_SIGNAL_KIND_ENV] ?? "").trim();
  return raw === "" ? null : raw;
}

/**
 * Must a human approve every dial in this deployment?
 *
 * True by default in `live` mode. Phase 1 says "No auto-dial in Phase 1,
 * regardless of the institution's fraud-engine confidence" — that is the rule
 * the mode exists to enforce, so the default is ON and turning it OFF takes an
 * explicit `false` plus a warning in the log.
 *
 * The override exists because a pilot is not the only way to use `live`: an
 * institution whose OWN fraud desk approves every call has satisfied the
 * requirement, and requiring a second approval inside our console would be
 * theatre. The audit chain records who approved, either way.
 */
let pilotApprovalWarned = false;
export function pilotRequiresHumanApproval(): boolean {
  if (pilotMode() !== "live") return false;
  const raw = (process.env[PILOT_HUMAN_APPROVAL_ENV] ?? "").trim().toLowerCase();
  if (raw === "") return true;
  if (raw === "false" || raw === "0" || raw === "no" || raw === "off") {
    if (!pilotApprovalWarned) {
      pilotApprovalWarned = true;
      logWarn("[pilot] human approval of every dial is DISABLED in live mode", {
        env: PILOT_HUMAN_APPROVAL_ENV,
        effect: "dials are placed without a recorded per-dial approval",
      });
    }
    return false;
  }
  return true;
}

/* ── The counters ───────────────────────────────────────────────────────────── */

/**
 * Is this org id the SHARED namespace?
 *
 * `DEFAULT_ORG_ID` is the literal namespace an org-less session shares with
 * seeded demo rows, and `src/lib/case-state-machine.ts` reads a NULL org as
 * `orgId IS NULL OR orgId = 'default'`. So `null` and `"default"` are the SAME
 * namespace, and a counter that treats them as different counts two
 * different row sets for one tenant.
 *
 * That disagreement was not theoretical. The console's identity carries
 * `orgId: "default"` (a string) while the dial worker's job row carries
 * `org_id = NULL` for the very same unscoped signal, because `enqueueDialJob`
 * writes `input.orgId ?? null`. The worker therefore counted
 * `org_id IS NULL OR org_id = 'default'` and the console counted
 * `org_id = 'default'` — so the operator's screen said "4 of 5 dispatched,
 * room for one more" while the worker saw 6 and blocked every dial.
 *
 * One predicate, used by every pilot counter and by the console's
 * "awaiting approval" query, is the only way two surfaces can agree.
 */
export function pilotOrgIsShared(orgId: string | null | undefined): boolean {
  return orgId === null || orgId === undefined || orgId === DEFAULT_ORG_ID;
}

/**
 * Interventions this organisation has ACTED ON today.
 *
 * ── What the cap counts, and why it is not a row count ───────────────────────
 *
 * The unit is the CASE, not the job row, and it is not "rows created today".
 *
 *   · A case retried is still one intervention. The pricing model bills one
 *     intervention per case dispatched to the dial queue, so counting job
 *     rows would make a case that is dialled twice burn two units of the
 *     pilot's contracted volume and hit the cap at half the contracted
 *     number of customers. `count(DISTINCT case_id)` fixes that.
 *
 *   · The window is a UNION, not just "created today". A pilot that admitted
 *     500 cases yesterday and has not dialled them yet has a BACKLOG, and
 *     yesterday's admission tells us nothing about how many customers that
 *     backlog will call today. The union of "admitted today" and "settled
 *     today" is the number of distinct customers the pilot can still touch
 *     today, which is the thing a "hard daily call cap" is actually for.
 *
 *   · `completed_at` is the settle marker. It is set when a job finishes —
 *     done or dead — and a dead job that never reached a carrier is counted
 *     too. That over-counts slightly, which is the safe direction: the
 *     ceiling is tighter than the truth rather than looser.
 *
 * `excludeCaseId` removes one case from the count. The dial-time decision
 * uses it because the case being decided is already inside the window (it
 * was admitted today), and counting it would make the cap refuse its own
 * last permitted intervention.
 *
 * `date_trunc('day', now())` is the DATABASE's calendar day, not UTC and not
 * the app server's. That is a deliberate choice, not an accident: the queue
 * leases, the audit chain and every deadline in this system already run on
 * the database clock, and a cap that resets on a different boundary from the
 * rest of the platform is a cap nobody can reason about.
 */
export async function pilotActedToday(
  orgId: string | null,
  opts: { excludeCaseId?: string | null } = {},
): Promise<number> {
  const exclude = opts.excludeCaseId ?? null;
  const shared = pilotOrgIsShared(orgId);
  const rows = shared
    ? await db.$queryRaw<{ n: number }[]>`
        SELECT count(DISTINCT "case_id")
                 FILTER (WHERE "case_id" IS DISTINCT FROM ${exclude})::int AS "n"
          FROM "dial_job"
         WHERE ("org_id" IS NULL OR "org_id" = ${DEFAULT_ORG_ID})
           AND (
                 "created_at"  >= date_trunc('day', now())
              OR "completed_at" >= date_trunc('day', now())
           )
      `
    : await db.$queryRaw<{ n: number }[]>`
        SELECT count(DISTINCT "case_id")
                 FILTER (WHERE "case_id" IS DISTINCT FROM ${exclude})::int AS "n"
          FROM "dial_job"
         WHERE "org_id" = ${orgId}
           AND (
                 "created_at"  >= date_trunc('day', now())
              OR "completed_at" >= date_trunc('day', now())
           )
      `;
  return rows[0]?.n ?? 0;
}

/**
 * Seconds until the database's day rolls over.
 *
 * The cap's reset time is published so an operator can say "the cap refills
 * in eleven minutes" instead of guessing at a timezone.
 */
export async function pilotSecondsUntilReset(): Promise<number> {
  const rows = await db.$queryRaw<{ secs: number }[]>`
    SELECT GREATEST(
             60,
             extract(epoch FROM (date_trunc('day', now()) + interval '1 day' - now()))::int
           )::int AS "secs"
  `;
  return rows[0]?.secs ?? 60;
}

/**
 * Calls this organisation currently has in flight.
 *
 * Counted from `dial_job` rows in state CLAIMED. A CLAIMED row is one a
 * worker has claimed and is actively working — which is the closest durable
 * proxy for "a call is happening right now" that survives a worker dying
 * (the lease expires and the row becomes claimable again).
 *
 * This is a GLOBAL count, unlike the abuse gate's concurrency cap, which is
 * per process and therefore multiplied by the number of worker replicas. A
 * pilot's ceiling must be the ceiling the customer agreed to, not the ceiling
 * times the replica count.
 */
export async function pilotInFlightNow(orgId: string | null): Promise<number> {
  const rows = pilotOrgIsShared(orgId)
    ? await db.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS "n"
          FROM "dial_job"
         WHERE ("org_id" IS NULL OR "org_id" = ${DEFAULT_ORG_ID})
           AND state = 'CLAIMED'
      `
    : await db.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS "n"
          FROM "dial_job"
         WHERE "org_id" = ${orgId}
           AND state = 'CLAIMED'
      `;
  return rows[0]?.n ?? 0;
}

/* ── The approval record ────────────────────────────────────────────────────── */

/**
 * The audit `intent` that records a human approving ONE dial attempt.
 *
 * The attempt number is part of the intent, not a field beside it. The audit
 * table's `meta` column is a JSON STRING (`String?` in the schema), so it
 * cannot be queried as JSON — a lookup for "the approval for attempt 2" would
 * have to be a `LIKE` over a serialised blob, which is the kind of predicate
 * that silently stops matching when somebody reformats a JSON blob. The
 * intent is an indexed, exact-match column, so the attempt belongs there.
 *
 * The format is `pilot_dial_approved:<attempt>`. A prefix match finds every
 * approval for a case (the console's "awaiting approval" count needs that);
 * an exact match finds the one that authorises a given attempt.
 *
 * A COLON, not a `#`: `safeKey` in `src/lib/audit-chain.ts` strips every
 * character outside `[\w.:-]` on the way into the chain, so a `#`-suffixed
 * intent was being stored as `pilot_dial_approved1` — an exact match for
 * `pilot_dial_approved#1` could then never exist, and live mode blocked every
 * effort at every attempt while the console reported "approved". The colon
 * survives the sanitiser because it is already in its allowlist.
 */
export function pilotApprovalIntent(attemptNo: number): string {
  return `${PILOT_APPROVAL_INTENT}:${Math.max(1, Math.trunc(attemptNo))}`;
}

/**
 * Has a human approved THIS attempt of this dial?
 *
 * Reads the append-only audit chain. An approval authorises the attempt it
 * names and no other: a case that is dialled, comes back unanswered and is
 * retried as attempt 2 needs a SECOND approval, because a second call to a
 * customer is a second call to a customer and Phase 1 says a human approves
 * every dial.
 *
 * The old behaviour — "any approval row for this caseRef, ever" — authorised
 * a fresh dial a month later, from an approval recorded before the case was
 * even in this state, and it was never revoked by a later decline. Both of
 * those are now closed: the attempt is part of the intent, and a decline for
 * the case REFUSES every attempt for it.
 *
 * The org predicate matches the shared namespace the same way the counters
 * do, so an approval recorded against a NULL-org case is found by the worker
 * whose job row is also NULL-org.
 */
export async function pilotDialApproved(
  caseRef: string,
  attemptNo: number,
  orgId?: string | null,
): Promise<boolean> {
  const orgPredicate = pilotOrgIsShared(orgId)
    ? { OR: [{ orgId: null }, { orgId: DEFAULT_ORG_ID }] }
    : { orgId: orgId as string };

  // A decline is terminal for the case: the operator said NO to this alert.
  // It is checked FIRST and it wins over any earlier approval, because the
  // case is moved to REJECTED and must not be dialled again.
  const declined = await db.auditLog.findFirst({
    where: { callRef: caseRef, intent: PILOT_DECLINE_INTENT, ...orgPredicate },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  if (declined !== null) return false;

  const approval = await db.auditLog.findFirst({
    where: { callRef: caseRef, intent: pilotApprovalIntent(attemptNo), ...orgPredicate },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  return approval !== null;
}

/* ── The dial-time decision ─────────────────────────────────────────────────── */

export type PilotBlockReason =
  | "dial_kill_switch"
  | "pilot_shadow_mode"
  | "pilot_daily_cap"
  | "pilot_concurrency_cap"
  | "pilot_human_approval_required"
  | "pilot_signal_kind_out_of_scope"
  | "pilot_invalid_configuration";

export type PilotDialDecision =
  | { allowed: true; mode: PilotMode; checked: readonly string[] }
  | {
      allowed: false;
      mode: PilotMode;
      reason: PilotBlockReason;
      detail: string;
      /**
       * How long to wait before looking again.
       *
       * ALWAYS present and ALWAYS at least a minute: the queue clamps a
       * deferred retry to [1 min, 24 h] and, more importantly, a deferred
       * retry does NOT consume an attempt. A pilot block must never look like
       * a failed dial.
       */
      retryAfterMs: number;
    };

const MIN_RETRY_MS = 60_000;
const MAX_RETRY_MS = 24 * 60 * 60 * 1_000;

/**
 * May this call be placed right now?
 *
 * The authoritative check, made at the last possible moment before the
 * carrier boundary — the same place the calling-hours window, the prayer
 * window, the do-not-call registry and the carrier breaker are checked. A
 * ceiling enforced only at intake is a ceiling that a queue draining at 03:00
 * walks straight past.
 *
 * NEVER THROWS. A decision that cannot be made is a refusal, not an exception:
 * the alternative is a dial that proceeds because the control that was
 * supposed to stop it had a bad day.
 *
 * AND THAT IS NOT A THEORETICAL PROMISE. The counters below read the
 * database, and a database that is briefly unreachable would have thrown
 * straight out of this function — into the dial worker's handler, where a
 * throw is counted as a CRASHED handler, settled as a retryable failure, and
 * climbs the attempt ladder. At the end of that ladder the job dead-letters,
 * and the dead-letter path sends the blind-ping SMS to the customer. A
 * database blip would therefore have turned into a text message to a customer
 * during the exact window in which the pilot was supposed to be contacting
 * nobody — the failure this module's header says is impossible. The whole
 * body is therefore wrapped, and a read that fails becomes a refusal.
 */
export async function pilotDialDecision(input: {
  orgId: string | null;
  caseRef: string;
  /** The case id, used to exclude this case from the cap counter. */
  caseId?: string | null;
  signalKind?: string | null;
  /** The queue attempt this dial is for. A human approval is bound to one. */
  attemptNo?: number;
}): Promise<PilotDialDecision> {
  const mode = pilotMode();
  const checked: string[] = [];

  try {
    // 1. The kill switch. First, and before anything that touches the database,
    //    because it must work even when the database does not.
    if (dialKillSwitchEnvEngaged()) {
      return {
        allowed: false,
        mode,
        reason: "dial_kill_switch",
        detail: `outbound dialling is stopped (${DIAL_KILL_SWITCH_ENV})`,
        retryAfterMs: MIN_RETRY_MS,
      };
    }
    const sw = await dialKillSwitchDbState();
    if (sw.engaged) {
      return {
        allowed: false,
        mode,
        reason: "dial_kill_switch",
        detail: sw.available
          ? "outbound dialling is stopped (operator kill switch)"
          : "outbound dialling is stopped (the operator switch could not be read; the platform fails closed)",
        retryAfterMs: MIN_RETRY_MS,
      };
    }
    checked.push("kill_switch");

    // 2. Shadow mode. Phase 0 places no calls at all.
    if (mode === "shadow") {
      return {
        allowed: false,
        mode,
        reason: "pilot_shadow_mode",
        detail: "pilot is in shadow mode: cases are recorded, no customer is contacted",
        retryAfterMs: 5 * MIN_RETRY_MS,
      };
    }

    // 3. Off: nothing above applies and nothing below is checked. The whole
    //    point of the default is that a deployment that never heard of pilot
    //    mode pays nothing for it.
    if (mode === "off") {
      return { allowed: true, mode, checked };
    }

    // 4. Live mode. From here every check is a pilot ceiling.
    //
    //    THE CHARTER FAILS CLOSED ON AN UNKNOWN ALERT TYPE. A charter is a
    //    scope control: it says "this pilot is chartered for card-transaction
    //    fraud and nothing else". A signal with no `signal_kind` is not
    //    demonstrably inside that scope — and `signal_kind` is OPTIONAL in the
    //    v1 bank contract, so the unknown case is the common case, not the
    //    exotic one. The earlier reading (`kind && signalKind && mismatch`)
    //    skipped the check entirely when the kind was absent, which meant a
    //    bank could omit the field on a claim-payout alert and have it
    //    dialled under a card-fraud charter, with no `out_of_scope` row
    //    anywhere in the audit chain to show for it.
    const kind = pilotSignalKind();
    if (kind) {
      const signalKind = (input.signalKind ?? "").trim();
      if (signalKind !== kind) {
        return {
          allowed: false,
          mode,
          reason: "pilot_signal_kind_out_of_scope",
          detail:
            signalKind === ""
              ? `this pilot is chartered for '${kind}' signals, and this case carries no signal type; an untyped alert cannot be shown to be in scope`
              : `this pilot is chartered for '${kind}' signals; this case is '${signalKind}'`,
          retryAfterMs: 60 * MIN_RETRY_MS,
        };
      }
    }
    checked.push("signal_kind");

    let dailyCap: number | null;
    let concurrencyCap: number | null;
    try {
      dailyCap = pilotDailyCallCap();
      concurrencyCap = pilotConcurrencyCap();
    } catch (err) {
      // A malformed cap must not become "no cap". Fail closed, loudly.
      logError("[pilot] a pilot cap is misconfigured; refusing to dial", {
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        allowed: false,
        mode,
        reason: "pilot_invalid_configuration",
        detail: "a pilot cap is misconfigured; the platform refuses to dial until it is fixed",
        retryAfterMs: 60 * MIN_RETRY_MS,
      };
    }

    if (dailyCap !== null) {
      // The count EXCLUDES the case being decided, because that case is
      // already inside today's window (it was admitted today). "Already acted
      // on today" therefore means "other cases", and the cap is spent when
      // that count reaches the cap — one predicate, shared with the intake
      // gate, so the two surfaces cannot disagree about the same number.
      const acted = await pilotActedToday(input.orgId, { excludeCaseId: input.caseId ?? null });
      checked.push("daily_cap");
      if (acted >= dailyCap) {
        const secondsUntilReset = await pilotSecondsUntilReset();
        return {
          allowed: false,
          mode,
          reason: "pilot_daily_cap",
          detail: `daily pilot cap reached (${acted}/${dailyCap} interventions acted on today)`,
          retryAfterMs: Math.min(MAX_RETRY_MS, Math.max(MIN_RETRY_MS, secondsUntilReset * 1_000)),
        };
      }
    }

    if (concurrencyCap !== null) {
      const inFlight = await pilotInFlightNow(input.orgId);
      checked.push("concurrency_cap");
      if (inFlight >= concurrencyCap) {
        return {
          allowed: false,
          mode,
          reason: "pilot_concurrency_cap",
          detail: `pilot concurrency cap reached (${inFlight}/${concurrencyCap} calls in flight)`,
          retryAfterMs: MIN_RETRY_MS,
        };
      }
    }

    if (pilotRequiresHumanApproval()) {
      const approved = await pilotDialApproved(input.caseRef, input.attemptNo ?? 1, input.orgId);
      checked.push("human_approval");
      if (!approved) {
        return {
          allowed: false,
          mode,
          reason: "pilot_human_approval_required",
          detail: `a human must approve attempt ${input.attemptNo ?? 1} of this dial before it is placed`,
          retryAfterMs: MIN_RETRY_MS,
        };
      }
    }

    return { allowed: true, mode, checked };
  } catch (err) {
    // The last line of defence, and the one that makes "NEVER THROWS" true.
    //
    // A refusal here is a PARK, not a failure: the worker turns it into a
    // deferred retry that consumes no attempt, so a database blip cannot push
    // a job down the ladder and out of the blind-ping SMS fallback.
    logError("[pilot] the pilot decision could not be made; refusing to dial", {
      caseRef: input.caseRef,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      allowed: false,
      mode,
      reason: "pilot_invalid_configuration",
      detail:
        "the pilot controls could not be evaluated; the platform refuses to dial rather than guess",
      retryAfterMs: MIN_RETRY_MS,
    };
  }
}

/* ── The status surface ─────────────────────────────────────────────────────── */

export type PilotStatus = {
  mode: PilotMode;
  /** The raw `PILOT_MODE` value, and whether the platform understood it. */
  rawMode: string;
  modeRecognised: boolean;
  killSwitch: {
    env: boolean;
    database: boolean;
    engaged: boolean;
    /**
     * Whether the operator's switch could be READ.
     *
     * `engaged: true` with `available: false` means "we could not tell", which
     * is a different fact from "an operator stopped the pilot". Without this
     * field a database outage renders as an operator action, and somebody
     * spends the incident looking for a button nobody pressed.
     */
    databaseAvailable: boolean;
    /** The raw env value, so a typo is visible rather than inferred. */
    envRaw: string | null;
    /** True when the env value was set but is not a recognised spelling. */
    envRecognised: boolean;
  };
  dailyCap: number | null;
  concurrencyCap: number | null;
  /**
   * Why a cap could not be read, when one is misconfigured.
   *
   * A `null` cap means two very different things — "no cap is configured" and
   * "the configured cap is broken" — and the difference is the difference
   * between a deliberate choice and an outage.
   */
  capError: string | null;
  humanApprovalRequired: boolean;
  signalKind: string | null;
  /** Null when the counts could not be read. Never a fabricated zero. */
  actedToday: number | null;
  inFlightNow: number | null;
  /** Seconds until the database's day rolls over, or null if unreadable. */
  secondsUntilReset: number | null;
};

/**
 * The pilot state, for an operator surface.
 *
 * Never throws: a status surface that 500s during an incident is worse than
 * one that reports "unknown".
 */
export async function pilotStatus(orgId: string | null = null): Promise<PilotStatus> {
  const resolution = pilotModeResolution();
  const mode = resolution.mode;
  const env = dialKillSwitchEnvEngaged();
  const envRaw = dialKillSwitchEnvRawValue();
  let database = false;
  let databaseAvailable = false;
  try {
    const sw = await dialKillSwitchDbState();
    database = sw.engaged;
    databaseAvailable = sw.available;
  } catch {
    // `dialKillSwitchDbState` never throws — it fails closed internally — so
    // this is a belt-and-braces path. The state stays "engaged" because that
    // is what the decision path does with an unreadable switch.
    database = true;
    databaseAvailable = false;
  }

  let actedToday: number | null = null;
  let inFlightNow: number | null = null;
  let secondsUntilReset: number | null = null;
  try {
    if (mode !== "off") {
      actedToday = await pilotActedToday(orgId);
      inFlightNow = await pilotInFlightNow(orgId);
      secondsUntilReset = await pilotSecondsUntilReset();
    }
  } catch {
    actedToday = null;
    inFlightNow = null;
    secondsUntilReset = null;
  }

  let dailyCap: number | null = null;
  let concurrencyCap: number | null = null;
  let capError: string | null = null;
  try {
    dailyCap = pilotDailyCallCap();
    concurrencyCap = pilotConcurrencyCap();
  } catch (err) {
    dailyCap = null;
    concurrencyCap = null;
    capError = err instanceof Error ? err.message : String(err);
  }

  return {
    mode,
    rawMode: resolution.raw,
    modeRecognised: resolution.recognised,
    killSwitch: {
      env,
      database,
      engaged: env || database,
      databaseAvailable,
      envRaw,
      envRecognised: dialKillSwitchEnvRecognised(),
    },
    dailyCap,
    concurrencyCap,
    capError,
    humanApprovalRequired: pilotRequiresHumanApproval(),
    signalKind: pilotSignalKind(),
    actedToday,
    inFlightNow,
    secondsUntilReset,
  };
}
