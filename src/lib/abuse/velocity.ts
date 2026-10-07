import "server-only";
/**
 * Velocity anomaly detection (WP-14, control 3 of the dial gate).
 *
 * The allowlist and the tier gate constrain WHERE and WHO. They do not constrain
 * HOW FAST, and toll fraud is not a geography problem — it is a rate problem. A
 * hijacked key with a perfect-looking destination list still burns money at the
 * carrier's per-minute rate, and it does so fastest of all on destinations the
 * allowlist was written for (that is why premium-rate numbers exist: they are
 * *inside* the countries you legitimately serve).
 *
 * Three signals, each chosen because it is cheap to compute on a hot path and
 * hard for a legitimate operator to trip by accident:
 *
 *   1. new_destination_prefix — the org has never dialled this block before.
 *      A fraud run sprays many numbers in one range to look like traffic.
 *   2. burst_rate — more attempts than any human-driven fraud workflow
 *      produces inside one window.
 *   3. out_of_hours_volume — volume outside business hours. The weakest signal
 *      on purpose (a fraud desk legitimately runs nights), so it WARNS at the
 *      low threshold and only auto-pauses at a much higher one.
 *
 * Auto-pause is the response to (1) and (2); it is sticky, because an attacker
 * who can wait out a cooldown learns the cooldown.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * STATE: bounded, in-process, single node — and stated, not hidden
 *
 *   Every map here is bounded: org state is evicted oldest-first past
 *   maxTrackedOrgs, attempts per org are capped and pruned by age, prefixes per
 *   org are capped, and the pause store is capped with evictions COUNTED
 *   (velocitySnapshot().pausesEvicted) so a silent drop of a paused org shows up
 *   on the status surface instead of being invisible.
 *
 *   The caveat that matters: this state is per Node.js process. With two app
 *   instances behind the load balancer, an org can dial up to (cap × instances)
 *   and trip the velocity thresholds later than it should. That is acceptable
 *   for the single-node reference deployment and is NOT acceptable for
 *   production. The fix is not "add Redis to this file" — it is to implement
 *   AbusePauseStore against a shared store (setPauseStore) so the pause itself
 *   is durable, and to move the counters to a shared sliding window. Until then
 *   this control is a single-node guard, and the carrier-level controls (Twilio
 *   geo-lock + spend trigger) are the ones that hold regardless of topology.
 */

import { abuseConfig } from "./config";
import { destinationPrefix, normaliseE164, safeOrgKey } from "./geo";

export type VelocitySignal = "new_destination_prefix" | "burst_rate" | "out_of_hours_volume";

export type VelocityAction = "allow" | "warn" | "auto_pause";

export type VelocityRejectReason =
  /** The breaker was already tripped and has not been resumed by a human. */
  | "org_auto_paused"
  /** Enough previously-unseen destination prefixes inside the new-prefix window. */
  | "velocity_new_prefix_burst"
  /** Enough attempts inside the burst window. */
  | "velocity_burst_rate"
  /** Enough out-of-hours volume (warn threshold). */
  | "velocity_after_hours";

export type VelocityMetrics = {
  /** Attempts retained for this org inside the attempt window. */
  windowAttempts: number;
  /** Attempts inside the burst window. */
  burstAttempts: number;
  /** Distinct destination prefixes seen for this org. */
  distinctPrefixes: number;
  /** Prefixes first seen inside the new-prefix window (the anomaly). */
  newPrefixes: number;
  /** Attempts inside the attempt window that fell outside business hours. */
  afterHoursAttempts: number;
  /** Is the evaluation instant itself outside business hours (UTC)? */
  afterHours: boolean;
  burstWindowSec: number;
  newPrefixWindowSec: number;
};

export type VelocityVerdict =
  | {
      action: "allow";
      reason: null;
      signals: VelocitySignal[];
      alreadyPaused: false;
      metrics: VelocityMetrics;
    }
  | {
      action: "warn";
      reason: Exclude<VelocityRejectReason, "org_auto_paused">;
      signals: VelocitySignal[];
      alreadyPaused: false;
      metrics: VelocityMetrics;
    }
  | {
      action: "auto_pause";
      reason: VelocityRejectReason;
      signals: VelocitySignal[];
      /** True when the breaker was already open — the alert is not re-emitted. */
      alreadyPaused: boolean;
      metrics: VelocityMetrics;
    };

/* ── Alerts ───────────────────────────────────────────────────────────────── */

export type AbuseAlert = {
  id: string;
  orgId: string;
  /** ISO timestamp of the evaluation instant. */
  at: string;
  action: Exclude<VelocityAction, "allow">;
  reason: VelocityRejectReason;
  signals: VelocitySignal[];
  metrics: VelocityMetrics;
  /** Human-readable. Destinations are masked; org ids are not secrets. */
  detail: string;
};

export type AlertSink = (alert: AbuseAlert) => void;

const ALERT_BUFFER_MAX = 100;
let alertBuffer: AbuseAlert[] = [];
let alertSink: AlertSink | null = null;
let alertSeq = 0;

/**
 * Deliver alerts.
 *
 * Configure a sink at boot (on-call webhook, notifications.ts, audit chain).
 * With no sink configured, `warn` alerts are buffered only and `auto_pause`
 * alerts are additionally written to stderr — an auto-pause that happens in
 * silence is not a control, it is a hidden outage. With a sink configured the
 * sink owns delivery and we stay quiet, which also keeps test output clean.
 */
export function setAlertSink(sink: AlertSink | null): void {
  alertSink = sink;
}

/** Newest-last ring of recent alerts, for the status surface and for tests. */
export function recentAlerts(): AbuseAlert[] {
  return [...alertBuffer];
}

function emit(alert: AbuseAlert): void {
  alertBuffer = [...alertBuffer, alert].slice(-ALERT_BUFFER_MAX);
  if (alertSink) {
    try {
      alertSink(alert);
    } catch {
      // A broken sink must not become a failed dial decision.
    }
    return;
  }
  if (alert.action === "auto_pause") {
    console.error(
      `[abuse] auto-pause org=${alert.orgId} reason=${alert.reason} signals=${alert.signals.join(",")} — no alert sink configured`,
    );
  }
}

/* ── Pause store ──────────────────────────────────────────────────────────── */

export type PauseRecord = {
  orgId: string;
  at: number;
  /** Epoch ms, or null when the pause is sticky until a human resumes it. */
  expiresAt: number | null;
  reason: VelocityRejectReason | "manual";
  signals: VelocitySignal[];
  detail: string;
};

/**
 * Where the breaker state lives. Implement against Redis/Postgres and call
 * setPauseStore() at boot to make auto-pause hold across nodes and restarts;
 * the in-memory default below is single-node only (see the header).
 */
export interface AbusePauseStore {
  isPaused(orgId: string, now: number): boolean;
  pause(record: PauseRecord): void;
  /** Returns true when something was actually resumed. */
  resume(orgId: string): boolean;
  list(now: number): PauseRecord[];
}

class InMemoryPauseStore implements AbusePauseStore {
  private byOrg = new Map<string, PauseRecord>();
  /** Count of records dropped by the cap — surfaced, never silent. */
  evicted = 0;

  isPaused(orgId: string, now: number): boolean {
    const rec = this.byOrg.get(orgId);
    if (!rec) return false;
    if (rec.expiresAt !== null && rec.expiresAt <= now) {
      this.byOrg.delete(orgId);
      return false;
    }
    return true;
  }

  pause(record: PauseRecord): void {
    this.byOrg.set(record.orgId, record);
    const cap = abuseConfig().velocity.maxTrackedOrgs;
    while (this.byOrg.size > cap) {
      // Oldest pause first: a stale breaker is the cheapest state to lose.
      let oldestKey: string | null = null;
      let oldestAt = Infinity;
      for (const [k, r] of this.byOrg) {
        if (r.at < oldestAt) {
          oldestAt = r.at;
          oldestKey = k;
        }
      }
      if (oldestKey === null) break;
      this.byOrg.delete(oldestKey);
      this.evicted += 1;
    }
  }

  resume(orgId: string): boolean {
    return this.byOrg.delete(orgId);
  }

  list(now: number): PauseRecord[] {
    const out: PauseRecord[] = [];
    for (const [k, r] of this.byOrg) {
      if (r.expiresAt !== null && r.expiresAt <= now) {
        this.byOrg.delete(k);
        continue;
      }
      out.push(r);
    }
    return out;
  }

  get evictedCount(): number {
    return this.evicted;
  }
}

const defaultPauseStore = new InMemoryPauseStore();
let pauseStore: AbusePauseStore = defaultPauseStore;

export function setPauseStore(store: AbusePauseStore | null): void {
  pauseStore = store ?? defaultPauseStore;
}

/* ── Per-org attempt state ────────────────────────────────────────────────── */

type OrgState = {
  /** Attempt instants, ascending, pruned by age on write. */
  attempts: number[];
  /** Destination prefix → the instant it was first seen by this org. */
  prefixFirstSeen: Map<string, number>;
  lastSeen: number;
};

const ORG_STATE = new Map<string, OrgState>();
let orgStateEvicted = 0;

const toMs = (at: number | Date | undefined, fallback: number): number => {
  if (at === undefined) return fallback;
  const ms = at instanceof Date ? at.getTime() : at;
  return Number.isFinite(ms) ? ms : fallback;
};

/**
 * Is this instant outside the configured business hours? Wrap-aware.
 *
 * Counted in `businessHoursTimezone`, not UTC. 21:00 UTC is 01:00 in Dubai, and
 * the entire purpose of this control is to not wake somebody up to ask them
 * about a transaction — so the hour is read off the clock of the person being
 * called, not of the server placing the call.
 */
export function isAfterHours(
  atMs: number,
  timeZone = abuseConfig().velocity.businessHoursTimezone,
): boolean {
  const cfg = abuseConfig().velocity;
  const hour = localHour(atMs, timeZone);
  const { businessHoursStart: start, businessHoursEnd: end } = cfg;
  if (start === end) return false; // 24h operation: never out of hours
  return start < end ? hour < start || hour >= end : hour < start && hour >= end;
}

/**
 * The first instant at or after `atMs` that is INSIDE permitted calling hours,
 * or `atMs` itself when it already is (or the deployment runs 24h). Used by the
 * dial worker to park a routine-category job until the window opens instead of
 * letting it climb the retry ladder into the middle of the night.
 *
 * 15-minute steps are resolution enough for a window measured in hours and keep
 * the search bounded (96 Intl format calls worst case, cached formatters).
 */
export function nextBusinessHoursStart(
  atMs: number,
  timeZone = abuseConfig().velocity.businessHoursTimezone,
): number {
  const STEP = 15 * 60 * 1000;
  const LIMIT = 24 * 60 * 60 * 1000;
  for (let t = atMs; t <= atMs + LIMIT; t += STEP) {
    if (!isAfterHours(t, timeZone)) return t;
  }
  // Unreachable unless the window is empty in a way the config validator
  // rejects; a day ahead is the honest fail-safe either way.
  return atMs + LIMIT;
}

const HOUR_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

/** The hour-of-day (0-23) this instant shows on a wall clock in `timeZone`. */
function localHour(atMs: number, timeZone: string): number {
  let fmt = HOUR_FORMATTERS.get(timeZone);
  if (!fmt) {
    // `hourCycle: "h23"` because `hour12: false` is the one spelling that can
    // return "24" for midnight, which is not an hour anyone's clock shows.
    fmt = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      hourCycle: "h23",
    });
    HOUR_FORMATTERS.set(timeZone, fmt);
  }
  const hour = Number(fmt.formatToParts(new Date(atMs)).find((p) => p.type === "hour")?.value);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new Error(`could not read the local hour for ${timeZone}`);
  }
  return hour;
}

/** Attempts inside (now - windowSec, now]. */
function countWithin(attempts: readonly number[], now: number, windowSec: number): number {
  const cutoff = now - windowSec * 1000;
  let n = 0;
  for (const t of attempts) if (t > cutoff) n += 1;
  return n;
}

function getState(key: string, now: number): OrgState {
  let s = ORG_STATE.get(key);
  if (!s) {
    s = { attempts: [], prefixFirstSeen: new Map(), lastSeen: now };
    ORG_STATE.set(key, s);
  }
  return s;
}

/** Drop the least-recently-seen orgs until the map is inside its cap. */
function boundOrgState(): void {
  const cap = abuseConfig().velocity.maxTrackedOrgs;
  while (ORG_STATE.size > cap) {
    let oldestKey: string | null = null;
    let oldestSeen = Infinity;
    for (const [k, s] of ORG_STATE) {
      if (s.lastSeen < oldestSeen) {
        oldestSeen = s.lastSeen;
        oldestKey = k;
      }
    }
    if (oldestKey === null) break;
    ORG_STATE.delete(oldestKey);
    orgStateEvicted += 1;
  }
}

export type RecordAttemptInput = {
  orgId: string;
  e164: string;
  at?: number | Date;
};

/**
 * Record one dial attempt for velocity accounting. NEVER throws.
 *
 * Only attempts that got past the cheap deterministic controls (geography,
 * tier, cooldown, caps) should be recorded — see guards.ts. Recording every
 * request would let a scan of geo-blocked numbers auto-pause a legitimate org,
 * which is a self-inflicted denial of service and a very easy way to get this
 * control switched off.
 */
export function recordAttempt(input: RecordAttemptInput): void {
  try {
    const key = safeOrgKey(input.orgId);
    const norm = normaliseE164(input.e164);
    if (!key || !norm) return;

    const cfg = abuseConfig().velocity;
    const now = toMs(input.at, Date.now());
    const state = getState(key, now);

    // Prune by age, then by count: an org that dials continuously must not be
    // able to grow its own slice of memory. Attempts are ascending, so one
    // pass from the front drops everything that fell out of the window.
    const cutoff = now - cfg.attemptWindowSec * 1000;
    let keepFrom = 0;
    while (keepFrom < state.attempts.length) {
      const t = state.attempts[keepFrom];
      if (t === undefined || t > cutoff) break;
      keepFrom += 1;
    }
    if (keepFrom > 0) state.attempts = state.attempts.slice(keepFrom);
    for (const [prefix, seen] of state.prefixFirstSeen) {
      if (seen <= cutoff) state.prefixFirstSeen.delete(prefix);
    }
    state.attempts.push(now);
    while (state.attempts.length > cfg.maxAttemptsPerOrg) state.attempts.shift();

    const prefix = destinationPrefix(norm);
    if (prefix && !state.prefixFirstSeen.has(prefix)) {
      state.prefixFirstSeen.set(prefix, now);
      while (state.prefixFirstSeen.size > cfg.maxPrefixesPerOrg) {
        let oldestKey: string | undefined;
        let oldestSeen = Infinity;
        for (const [p, seen] of state.prefixFirstSeen) {
          if (seen < oldestSeen) {
            oldestSeen = seen;
            oldestKey = p;
          }
        }
        if (oldestKey === undefined) break;
        state.prefixFirstSeen.delete(oldestKey);
      }
    }

    state.lastSeen = now;
    boundOrgState();
  } catch {
    // Velocity accounting is defence in depth; it never blocks a dial.
  }
}

export type EvaluateInput = { orgId: string; at?: number | Date };

/**
 * Is a count threshold in use?
 *
 * `0` is the OFF value for every velocity threshold, not the strictest one.
 * `n >= 0` is true for every org on every evaluation, so a knob that was
 * never really configured — an operator who set `ABUSE_AFTER_HOURS_WARN=0`
 * meaning "do not warn me" — instead warned (and, a few lines further down,
 * paused) EVERY org on EVERY dial, at any hour. A threshold of zero is not a
 * tighter threshold; it is a switch, and it now reads as one.
 *
 * The count itself is already scoped: `afterHoursAttempts` counts only
 * attempts that HAPPENED outside business hours, so a non-zero count is proof
 * of out-of-hours activity. Gating on the evaluation instant's `afterHours`
 * flag as well would be wrong — an org that dialled all night is exactly who
 * an operator needs warned about when they read this at 10:00.
 */
function thresholdArmed(threshold: number): boolean {
  return threshold > 0;
}

/**
 * Evaluate the velocity verdict for an org at an instant.
 *
 * Side effects: an `auto_pause` opens the breaker (once) and emits one alert.
 * A `warn` emits one alert. A second evaluation while already paused does not
 * re-alert — a flood of alerts is how a real one gets ignored.
 *
 * A threshold of `0` means that signal is OFF, not "tripped constantly" — see
 * `thresholdArmed`. The out-of-hours thresholds in particular are 0-by-
 * mistake the dangerous ones: zero out-of-hours attempts is the normal state
 * of a healthy tenant, so a 0 that fired would be a permanent false positive
 * rather than a tighter guard.
 */
export function evaluate(input: EvaluateInput): VelocityVerdict {
  const cfg = abuseConfig().velocity;
  const key = safeOrgKey(input.orgId);
  const now = toMs(input.at, Date.now());
  const state = ORG_STATE.get(key);
  const attempts = state?.attempts ?? [];

  let newPrefixes = 0;
  if (state) {
    const prefixCutoff = now - cfg.newPrefixWindowSec * 1000;
    for (const seen of state.prefixFirstSeen.values()) if (seen > prefixCutoff) newPrefixes += 1;
  }
  const burstAttempts = countWithin(attempts, now, cfg.burstWindowSec);
  const windowAttempts = countWithin(attempts, now, cfg.attemptWindowSec);
  const afterHoursAttempts = countWithin(
    attempts.filter((t) => isAfterHours(t)),
    now,
    cfg.attemptWindowSec,
  );

  const metrics: VelocityMetrics = {
    windowAttempts,
    burstAttempts,
    distinctPrefixes: state?.prefixFirstSeen.size ?? 0,
    newPrefixes,
    afterHoursAttempts,
    afterHours: isAfterHours(now),
    burstWindowSec: cfg.burstWindowSec,
    newPrefixWindowSec: cfg.newPrefixWindowSec,
  };

  if (!key) {
    return { action: "allow", reason: null, signals: [], alreadyPaused: false, metrics };
  }

  if (pauseStore.isPaused(key, now)) {
    return {
      action: "auto_pause",
      reason: "org_auto_paused",
      signals: [],
      alreadyPaused: true,
      metrics,
    };
  }

  // All tripped signals are reported, not just the deciding one — an operator
  // reading the alert needs the pattern, not the first threshold that fired.
  const signals: VelocitySignal[] = [];
  if (newPrefixes >= cfg.newPrefixBurst) signals.push("new_destination_prefix");
  if (burstAttempts >= cfg.burstRateMax) signals.push("burst_rate");
  if (thresholdArmed(cfg.afterHoursWarn) && afterHoursAttempts >= cfg.afterHoursWarn) {
    signals.push("out_of_hours_volume");
  }

  const allow: VelocityVerdict = {
    action: "allow",
    reason: null,
    signals: [],
    alreadyPaused: false,
    metrics,
  };
  if (signals.length === 0) return allow;

  const pause = (reason: Exclude<VelocityRejectReason, "org_auto_paused">): VelocityVerdict => {
    const detail =
      `velocity anomaly on ${key}: ${newPrefixes} new destination prefix(es) in ${cfg.newPrefixWindowSec}s, ` +
      `${burstAttempts} attempt(s) in ${cfg.burstWindowSec}s, ${afterHoursAttempts} out-of-hours attempt(s)`;
    pauseStore.pause({
      orgId: key,
      at: now,
      expiresAt: cfg.pauseTtlSec > 0 ? now + cfg.pauseTtlSec * 1000 : null,
      reason,
      signals,
      detail,
    });
    emit({
      id: `abuse-${now.toString(36)}-${++alertSeq}`,
      orgId: key,
      at: new Date(now).toISOString(),
      action: "auto_pause",
      reason,
      signals,
      metrics,
      detail,
    });
    return { action: "auto_pause", reason, signals, alreadyPaused: false, metrics };
  };

  if (newPrefixes >= cfg.newPrefixBurst) return pause("velocity_new_prefix_burst");
  if (burstAttempts >= cfg.burstRateMax) return pause("velocity_burst_rate");

  // Weakest signal: warn first, auto-pause only past the higher threshold.
  if (thresholdArmed(cfg.afterHoursPause) && afterHoursAttempts >= cfg.afterHoursPause) {
    return pause("velocity_after_hours");
  }
  if (thresholdArmed(cfg.afterHoursWarn) && afterHoursAttempts >= cfg.afterHoursWarn) {
    const reason = "velocity_after_hours" as const;
    emit({
      id: `abuse-${now.toString(36)}-${++alertSeq}`,
      orgId: key,
      at: new Date(now).toISOString(),
      action: "warn",
      reason,
      signals,
      metrics,
      detail: `out-of-hours volume on ${key}: ${afterHoursAttempts} attempt(s) outside business hours (not pausing yet)`,
    });
    return { action: "warn", reason, signals, alreadyPaused: false, metrics };
  }

  return allow;
}

/* ── Operator actions ─────────────────────────────────────────────────────── */

export function isOrgPaused(orgId: string, at?: number | Date): boolean {
  const key = safeOrgKey(orgId);
  if (!key) return false;
  return pauseStore.isPaused(key, toMs(at, Date.now()));
}

/** Open the breaker by hand (support action / an external detector). */
export function pauseOrg(
  orgId: string,
  options: { reason?: PauseRecord["reason"]; detail?: string; at?: number | Date } = {},
): boolean {
  const key = safeOrgKey(orgId);
  if (!key) return false;
  const now = toMs(options.at, Date.now());
  pauseStore.pause({
    orgId: key,
    at: now,
    expiresAt:
      abuseConfig().velocity.pauseTtlSec > 0
        ? now + abuseConfig().velocity.pauseTtlSec * 1000
        : null,
    reason: options.reason ?? "manual",
    signals: [],
    detail: options.detail ?? "paused by operator",
  });
  return true;
}

/** Close the breaker. Resuming is always a human decision. */
export function resumeOrg(orgId: string): boolean {
  return pauseStore.resume(safeOrgKey(orgId));
}

/** Open breakers, for the status surface. */
export function pausedOrgs(at?: number | Date): PauseRecord[] {
  return pauseStore.list(toMs(at, Date.now()));
}

/* ── Observability / test surface ─────────────────────────────────────────── */

export function velocitySnapshot(at?: number | Date) {
  const cfg = abuseConfig().velocity;
  let attemptsTracked = 0;
  for (const s of ORG_STATE.values()) attemptsTracked += s.attempts.length;
  return {
    trackedOrgs: ORG_STATE.size,
    attemptsTracked,
    orgStateEvicted,
    pausedOrgs: pauseStore.list(toMs(at, Date.now())).length,
    /** Pauses dropped by the store cap — non-zero means a cap is too low. */
    pausesEvicted: defaultPauseStore.evictedCount,
    alertsBuffered: alertBuffer.length,
    thresholds: {
      burstWindowSec: cfg.burstWindowSec,
      burstRateMax: cfg.burstRateMax,
      newPrefixWindowSec: cfg.newPrefixWindowSec,
      newPrefixBurst: cfg.newPrefixBurst,
      afterHoursWarn: cfg.afterHoursWarn,
      afterHoursPause: cfg.afterHoursPause,
      pauseTtlSec: cfg.pauseTtlSec,
    },
    scope: "in-process, single node — see the multi-node caveat in this file's header",
  };
}

/**
 * Clear all velocity state: attempts, prefixes, breakers and the alert buffer.
 * Test helper, and the right thing to call if a process ever needs a clean
 * breaker board. Not a security control — it is not authenticated.
 */
export function resetVelocityState(): void {
  ORG_STATE.clear();
  orgStateEvicted = 0;
  for (const rec of pauseStore.list(Date.now())) pauseStore.resume(rec.orgId);
  defaultPauseStore.evicted = 0;
  alertBuffer = [];
  alertSeq = 0;
}
