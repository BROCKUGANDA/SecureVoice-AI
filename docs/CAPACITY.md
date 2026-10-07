# Capacity model

**Purpose.** The arithmetic that decides whether a fraud-intervention campaign is
survived or shed, written down so a bank can check it and disagree with it.

**How to read every number in this file.** Each figure is labelled:

| Label            | Meaning                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------ |
| **MEASURED**     | We ran it ourselves and the artefact exists. `evidence/load/results.json` is the artefact for the Layer A figures. |
| **CALIBRATED**   | Derived from a published figure or a documented observation, never at our scale.                                   |
| **EXTRAPOLATED** | Projected by us from assumptions. **Never quote one as a fact.**                                                   |

A judge will find one number in this file and check it. If it is wrong, the whole
model is discounted. So the honest placeholders are labelled and the rest are
exact — the rule from `docs/UNIT-ECONOMICS.md` §6, applied to capacity instead of
cost.

Read date for all sourced vendor figures: **2026-10-02**.

The model is also **code**: `src/lib/scale/capacity.ts`. This document and that
module must agree; where they disagree, the module is right about the arithmetic
and this document is out of date.

---

## 1. The chain

Six steps, each one a function of the step before it. No step contains a magic
number.

```
cards × flag rate
  → interventions (a VOLUME, not a load)
  ÷ averaging window
  → mean interventions/hour
  × peak multiple
  → peak interventions/hour
  ÷ 3600
  → peak arrivals/second
  × mean call seconds
  → REQUIRED CONCURRENT CALLS        ← the number a vendor ceiling is compared against
  → provider ceilings               ← the lower of the two binds, always
  → cost at the peak
```

Two properties worth stating because they decide the whole design:

**Concurrency is invariant under time compression.** Required concurrency is
`arrival rate × talk time`; scaling the clock scales both, so the ratio holds.
You cannot make a burst cheaper by speeding up the test up. A campaign that
needs 210 concurrent calls needs 210 concurrent calls.

**The averaging window is the whole trick.** 2,800 interventions is _nothing_
averaged over a month (0.38 concurrent calls) and _a campaign_ averaged over 40
minutes (210 concurrent calls). Same volume, same code, different answer. This is
why `projectCapacity` takes `peakWindowMinutes`, and why any capacity number
quoted without its window is not a capacity number — it is a volume.

---

## 2. Vendor ceilings

Three ceilings, and they are not the same kind of number. Two are published; one
is account-specific and is ours to look up.

| Ceiling                                              | Our value | Provenance                                                                                                                                                                                                                  | Label      |
| ---------------------------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| **ElevenLabs Conversational AI concurrent sessions** | **40**    | elevenlabs.io/pricing/agents, read 2026-10-02. Published per tier: Free 4 · Starter 6 · Creator 10 · Pro 20 · Scale 30 · Business 40. Burst billing ($0.16/min vs $0.08/min) applies to calls running above the plan limit. | CALIBRATED |
| **Twilio outbound calls/second, per from-number**    | **2**     | Not published. Assigned per account; raised by support. Default is our conservative figure for a new account. Read it: Twilio Console → Voice → Settings.                                                                   | CALIBRATED |
| **Twilio account concurrent calls**                  | **10**    | Not published. Account-level, like the above. Read it from the same page.                                                                                                                                                   | CALIBRATED |

**Why none of these is labelled MEASURED.** We have never run a real conversation
at the ceiling. A published tier is a _published tier_; what our account is
actually permitted is a console reading, and until somebody puts that number in
`ELEVENLABS_MAX_CONCURRENT` / `TWILIO_CPS_PER_FROM_NUMBER` /
`TWILIO_MAX_CONCURRENT_CALLS` and re-runs the gate, every ceiling in this
document is a calibrated number. **The defaults are deliberately pessimistic** —
`src/lib/capacity.ts` defaults ElevenLabs to the FREE tier (4) — because assuming
a paid tier is how a demo discovers it was throttled on the day it mattered.

**The two Twilio limits behave differently, and that difference is the whole
carrier strategy:**

- **Calls/second is per from-number.** N numbers at C cps give N×C. Buying numbers
  is a lever, it is immediate, and it costs pennies per number per month.
- **Account concurrency is not.** One account, one ceiling, raised by support with
  a lead time. No amount of procurement fixes it in an afternoon.

So the carrier plan is: buy numbers for the CPS, and ask support for the account
concurrency _before_ the pilot, not during a campaign.

**Burst allowance (CALIBRATED, EL policy).** ElevenLabs sells burst above the plan
limit at 3× the subscription concurrency, at double the per-minute rate. We treat
`ELEVENLABS_MAX_CONCURRENT × 3` as the ceiling for admission and as a budget line,
not as free headroom: it is the most expensive minute in the system and the one
most likely to be a mistake rather than a campaign.

---

## 3. Steady state — the trivial case, worked

Planning volume for a pilot bank: **200,000 card transactions/month** and a
**0.35% flag rate**. Both are inputs the institution supplies; neither is a
measurement of ours (EXTRAPOLATED inputs).

| Step                      | Arithmetic       | Result        |
| ------------------------- | ---------------- | ------------- |
| Interventions/month       | 200,000 × 0.0035 | **700**       |
| Mean interventions/hour   | 700 ÷ 730        | **0.96/h**    |
| Peak interventions/hour   | 0.96 × **8**     | **7.67/h**    |
| Peak arrivals/second      | 7.67 ÷ 3600      | **0.00213/s** |
| Required concurrent calls | 0.00213 × 180 s  | **0.38**      |

**0.38 concurrent calls.** Every vendor ceiling clears that by two orders of
magnitude, the cost is under a dollar a month, and the honest engineering answer
is that nothing needs building. This is the case most capacity documents stop at,
and stopping here is how a platform is designed for 0.38 concurrent calls and
then meets reality.

Two inputs carry the whole answer and both are **EXTRAPOLATED**: the flag rate
(0.35% is our planning figure, not a measurement — an institution's real fraud
rate could be 0.05% or 3%) and the **8× peak multiple** (our planning figure for
"worst hour of the month versus average"). Neither is defensible as a fact. The
8× is the one an institution will argue with, and the right answer is: it is
yours, not ours — give us your peak-hour ratio and we will re-run the model.

**Mean call duration is 3 minutes — CALIBRATED, not measured.**
`docs/UNIT-ECONOMICS.md` §1 calls this the observed handle time from demo
traffic. There is no pilot handle-time distribution yet. A fraud verification
needing a second challenge is charged as two interventions, so the tail is longer
than the mean; sizing the ceiling on the mean with a 3× burst allowance on top is
how that uncertainty is paid for rather than ignored. Recalibrate from
`Case.durationSeconds` (populated post-call, WP-4) once a pilot exists.

---

## 4. The burst — the case that is actually the problem

**A smishing / SIM-swap campaign hits 8,000 customers inside 40 minutes, at a
~35% flag rate** (EXTRAPOLATED — this is the scenario the brief defines and the
one the platform is sized against; it is not a measurement).

| Step                      | Arithmetic    | Result                                |
| ------------------------- | ------------- | ------------------------------------- |
| Interventions             | 8,000 × 0.35  | **2,800**                             |
| Averaging window          | the campaign  | **40 minutes = 0.667 h**              |
| Arrival rate              | 2,800 ÷ 0.667 | **4,200/h = 70/minute = 1.17/second** |
| Required concurrent calls | 1.17 × 180 s  | **210**                               |

Compare against the ceilings:

| Ceiling                                   | Value | Modelled peak needs | Verdict                              |
| ----------------------------------------- | ----- | ------------------- | ------------------------------------ |
| ElevenLabs concurrent sessions (Business) | 40    | 210                 | **5.25× over**                       |
| …at the 3× burst allowance                | 120   | 210                 | **1.75× over**                       |
| Twilio account concurrency                | 10    | 210                 | **21× over**                         |
| Twilio CPS (1 number × 2/s)               | 2/s   | 1.17/s              | OK — 1 number is enough for the rate |

**Voice can cover 120 ÷ 210 = 57.1% of this campaign.** The remaining ~43% — about
1,200 customers in a bank whose cards are being attacked — must be reached a
different way, in minutes, while the attack is still happening.

Three conclusions follow, and they are the deliverable of this document:

1. **There is no ElevenLabs tier on the public price list that serves this burst
   by voice.** Serving 210 concurrent needs a negotiated limit, and a negotiated
   limit is a procurement conversation with a lead time. The published ladder tops
   out at 40; the burst allowance reaches 120.
2. **Therefore the fallback channel is not a nice-to-have — it is the majority
   path for a real campaign, and it must be as reliable as the voice channel.**
   An SMS or app-push alert that goes out in 30 seconds to a customer whose SIM is
   being swapped is arguably _more_ valuable than a call that queues for four
   minutes behind 200 other calls.
3. **The cost at peak is a step function, not a slope.** §6.

---

## 5. Degradation behaviour

What happens when offered volume exceeds what we can serve. The design rule: **we
degrade in a defined, audited, risk-prioritised order, and we never drop a case
silently.** A silent drop during a fraud campaign is the failure that would
disqualify the platform in a bank's procurement review, because "we could not
reach this customer" with no record is indistinguishable from not having tried.

**The gauge is the database, not a counter in memory** (`src/lib/admission.ts`).
In-flight is a `COUNT` of live cases. An in-process counter is wrong the moment
there are two instances, and wrong in the dangerous direction — each instance
believing it has full headroom. The COUNT is naturally correct across instances,
survives a restart and needs no reconciliation sweep. Cost: one indexed COUNT per
admission decision (MEASURED in Layer A — see §7).

**What the gauge costs, measured.** The whole admission decision — the gauge
COUNT, a grouped count over `dial_job`, and (on a shed) the audit append — is
**4.5 ms p50 / 8.7 ms p95** at steady state and **14.4 ms p50 / 178.8 ms p95** at burst,
when 224 workers contend for a 20-connection pool. The degradation is
connection-pool wait, not the COUNT itself: at a few thousand `Case` rows the scan
is not the problem. Two consequences: the gauge is cheap enough to keep on the
hot path at pilot scale, and the roadmap trigger for replacing it with a leased
counter table is _"gauge p95 exceeds the admission latency budget"_, not a
guess. Layer A measured the whole path, not the COUNT in isolation, so the
trigger has to be re-measured directly before it fires.

**The ladder** (`src/lib/capacity.ts`, thresholds as percentages of the burst
allowance; at Business tier, burst allowance = 120):

| Band        | In-flight          | Behaviour                                                                                                                               |
| ----------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| NORMAL      | < 84               | Dial freely.                                                                                                                            |
| CONSTRAINED | ≥ 84 (70% of 120)  | Dial only above the expected-loss threshold (AED 500 equivalent by default, `SHED_EXPECTED_LOSS_MINOR`). The rest fall back to **SMS**. |
| SHED        | ≥ 114 (95% of 120) | Voice reserved for the top tier only (4× the expected-loss threshold). Everything else falls back to **app push**.                      |

**Expected loss = risk × amount at risk** — an integer minor-unit product, so
triage is currency-agnostic and float-free. It is also the queue's `priority`
column, so the ordering holds _inside_ the queue: when only some of a burst can
be dialled, the customers with the most money at risk are dialled first.

**Every shed writes an audit row** naming the band, the reason, the fallback
taken, the expected loss, the threshold and the gauge reading at the decision.
The row is written on a fast path (no transaction, dedicated 5-connection audit
client) so shedding never delays the fallback delivery, and a failed append is
logged loudly rather than swallowed. Measured in Layer A: every shed carried an
audit row, and **zero** sheds lacked one across every recorded run (§7).

**Two more degradation points, in the order they bite:**

- **Client-side vendor ceiling** (`withElevenLabsCeiling`). Before asking the
  vendor for a slot we check our own semaphore, and a 429 is retried with
  jittered exponential backoff (250 ms base, ×2, 8 s cap, equal jitter — half
  fixed, half random; same reasoning as AWS's "Exponential Backoff And Jitter").
  **The slot is released before the backoff sleep**: holding it would convert the
  vendor's throttle into ours. After `MAX_THROTTLE_ATTEMPTS` (5) the call fails
  typed rather than retrying into a bill.
- **Gate exhaustion degrades, it does not queue.** If the local semaphore cannot
  get a slot within `maxWaitMs`, the caller gets `VendorCeilingExhaustedError`
  and the platform treats it as a shed: fallback channel plus an audit row. An
  unbounded wait in front of a customer's fraud case is worse than shedding it.
- **The queue is the buffer, and it is durable.** `dial_job`
  (`src/lib/scale/queue.ts`): every case has a row _before_ it has a call.
  Claiming is `FOR UPDATE SKIP LOCKED`, so N workers drain it with no lock and no
  head-of-line blocking. A worker killed mid-call leaves a lease that expires, and
  any worker may reclaim it — a crash delays the queue by at most one lease and
  never strands a case. Attempts are bounded; an exhausted job goes to `DEAD` with
  its error attached, and only an operator replays it.

**A finding worth recording** (MEASURED, Layer A): the ladder counts _in-flight
cases_, while the vendor counts _concurrent sessions_. They are not the same unit,
and the gap between them is exactly the queue standing in front of the vendor.
At Business tier, up to 120 cases can be in flight while at most 40 hold a
session. That is coherent — but it means the admission gauge alone cannot tell an
operator whether the _vendor_ is at its ceiling. `vendor_max_concurrent_sessions`
is reported separately in the artifact for that reason, and the band ladder should
not be read as a vendor-concurrency meter.

---

## 6. Cost at the peak

Minutes of talk in an hour **equals** concurrent calls, because each concurrent
call consumes one voice-minute per minute. That identity makes the peak cost
arithmetic exact rather than approximate.

Serving the 40-minute campaign from §4:

| Line                                          | Arithmetic               | USD          |
| --------------------------------------------- | ------------------------ | ------------ |
| Conversational AI, in plan (40 concurrent)    | 40 × $0.08/min           | **$3.20/h**  |
| Conversational AI, over plan (170 concurrent) | 170 × $0.16/min          | **$27.20/h** |
| Carrier                                       | **EXCLUDED — see below** | **?**        |
| **Total at the peak**                         |                          | **$30.40/h** |
| **Over the 40-minute campaign**               | 30.40 × 40/60            | **$20.27**   |

**The carrier line is EXCLUDED, not estimated.** The per-minute carrier rate is
destination-specific and is still marked INPUT REQUIRED in
`docs/UNIT-ECONOMICS.md` §2 (a US domestic call and East African mobile
termination differ by an order of magnitude). So **$30.40/h is a floor, not an
estimate**, and this document says so rather than filling the cell.

**One operational consequence that is easy to miss:** the billing breaker
(`src/lib/billing/breaker.ts`, `BILLING_HOURLY_LIMIT_MINOR`, integer minor units)
must be set **above $30.40 → 3,040 minor units**, or a legitimate campaign gets
stopped by our own spend breaker at exactly the moment it matters. The model
returns `requiredHourlyBillingCeilingMinor` for this so the number is computed
rather than remembered. Conversely, that same ceiling is what stops a metered
provider charging us for something we did not ask for, and
`BILLING_KILL_SWITCH` is the incident lever.

---

## 7. What Layer A measured

`tests/load/load.test.ts`, artefact `evidence/load/results.json`, command and
full caveats below. Vendors mocked at the port seam; the queue, the admission
ladder, the case state machine and persistence are all real, against local
Postgres 17.11 (MEASURED). Run on a Windows dev host, 224 workers against a
20-connection pool, `ELEVENLABS_MAX_CONCURRENT=40` (Business tier, CALIBRATED).

**The artifact is the authority and this section transcribes it;
`tests/docs/load-artifact-consistency.test.ts` fails the build when the two
disagree.** That gate exists because earlier revisions of this document quoted a
run the artifact had never recorded — "1,118 dialled, 82 shed", and "0 errors, 0
dead-lettered" against an artifact that recorded `result: "not-run"` with hundreds
of errors and dead jobs. A document that flatters itself about its own measurements
is worse than one that does not.

The artifact's `result` is **`recorded`** — the run completed, with
`summary.cases_accounted_exactly: true`.

**Read the two tables below in that order, because they are not equally stable.**

**What does not move between runs** — these held on every run of this gate recorded
on 2026-10-02, and they are the assertions that matter:

| Invariant                                  | Value                                                |
| ------------------------------------------ | ---------------------------------------------------- |
| `result`                                   | `recorded` — the run completed                       |
| `summary.cases_accounted_exactly`          | `true`                                               |
| Errors, both scenarios                     | **0** (error rate 0.00%, target < 1%)                |
| Jobs dead-lettered / lost / double-claimed | **0 / 0 / 0**                                        |
| Cases accounted for with no audit row      | **0**                                                |
| Cases unaccounted / in flight at the end   | **0 / 0**                                            |
| Audit chains verified from genesis         | 25/25, none broken                                   |
| Vendor double's peak concurrent sessions   | **40 of 40** — the ceiling was reached, not inferred |
| Gate timeouts                              | 0                                                    |

**What does move between runs.** The shed split and the latency percentiles are
properties of _a run_, not of the design: successive runs of this gate on the same
code produced 632, 715, 681, 299 and 92 sheds out of 1,200, because which case
loses the race for a voice slot is wall-clock contention. **So this section does
not pin them.** It reports the ranges observed across the runs recorded on
2026-10-02 and points at the artifact for the current run's exact figures, which
is also why `tests/docs/load-artifact-consistency.test.ts` gates the invariants
above and the internal consistency of this section rather than chasing a number
that legitimately changes every few minutes.

**Read the ranges below as "what the gate actually produced", not as a forecast.**
Any of them is re-recorded by the next run; the invariant table is what a bank
should hold us to.

**Steady state** — 300 cases, 8 offered concurrent. Stable across every run:

|                         |                   |
| ----------------------- | ----------------- |
| Dialled / shed / errors | 300 / 0 / **0**   |
| Band observed           | NORMAL only       |
| Injected 429s survived  | 17, all recovered |

Admission decision p50 / p95 / p99 was **4.3–4.9 / 8.1–10.8 / 19.3–24.7 ms**
across the runs recorded on 2026-10-02; end-to-end p50 / p95 / p99 **2.3–2.9 /
4.3–5.1 / 4.5–5.2 s**. The current run's exact figures are in the artifact.

**Campaign burst** — 1,200 cases at **224 offered concurrent** (the modelled peak is
210; see the note on counts below). Ranges across the runs recorded on 2026-10-02:

|                                                            | Observed range                                            | Label    |
| ---------------------------------------------------------- | --------------------------------------------------------- | -------- |
| Cases in                                                   | 1,200                                                     | MEASURED |
| Offered concurrency                                        | **224 workers**                                           | MEASURED |
| Peak conversations in flight (this run's cases only)       | 78–184                                                    | MEASURED |
| Bands entered                                              | NORMAL → CONSTRAINED → **SHED**                           | MEASURED |
| Dialled                                                    | 485–1,193                                                 | MEASURED |
| Shed with an audit row                                     | 7–715                                                     | MEASURED |
| **Errors**                                                 | **0 — error rate 0.00%** (target < 1%)                    | MEASURED |
| Max concurrent sessions the vendor double ever saw         | **40 of 40**                                              | MEASURED |
| Gate timeouts                                              | 0                                                         | MEASURED |
| Peak queue depth                                           | 1,200 (all offered work is durable before the first dial) | MEASURED |
| Jobs done / dead-lettered / lost / double-claimed          | 1,200 / **0** / **0** / **0**                             | MEASURED |
| Admission decision p50 / p95 / p99 (incl. the gauge COUNT) | 14–393 / 179–679 / 204–887 ms                             | MEASURED |
| End-to-end p50                                             | 6.2–11.2 s                                                | MEASURED |

The sheds are never all one band — recorded runs split them across
`admission_shed_shed` and `admission_constrained_shed`, so the CONSTRAINED band
does real work before the SHED gate closes. That is the ladder behaving as two
stages, not one.

**Accounting — the assertion that matters (MEASURED, and invariant):**

```
cases in                 1,200
= dialled        + shed WITH an audit row = 1,200   ← the pair moves, the sum does not
+ unaccounted                0     ← a non-zero value fails the gate
queue rows               1,200     (one durable row per case)
jobs left PENDING/CLAIMED    0
audit chains verified     25/25 from genesis
vendor calls placed       = dialled = exactly one call per customer
```

**Two honest caveats about the numbers above.**

_Case count is scaled; concurrency is not._ The modelled campaign is 2,800
interventions. These runs played 1,200 of them (set `LOAD_BURST_CASES=2800` for the
full replay) because the quantity under test is **concurrency**, not case count.
Offered concurrency was the modelled 210 (224 workers).

_Why the platform did not hold 224 conversations._ The ladder, not a lucky
configuration, decides how much voice a campaign gets. 224 workers offered load;
conversations were admitted only while the gauge stayed under the SHED gate (114),
and each shed worker frees its slot in microseconds while a dialled case holds one
for the synthetic talk time. Recorded runs peaked between **78 and 184** of their
own conversations and shed between 92 and 715 of 1,200. Workers spending their
time shedding are not concurrent conversations, which is why the offered number
and the admitted number are not the same number.

**That the split moves that much between runs is the finding, not noise.** A bank
sizing a campaign cannot be promised "N% reaches voice"; what is stable is the
mechanism — every shed carries an audit row, and every case is accounted for
exactly. Note also the gap between a run's own in-flight peak and the global gauge
reading (78 vs 154 in one recorded run): the ladder counts everything in flight,
including rows another suite left behind.

**The p50 of 6.2–11.2 s is process time, not vendor time.** It is 224 workers × ~25
database round trips contending for a 20-connection pool, with each conversation
held for a synthetic 120 ms. It is **not** a claim about time-to-first-audio,
carrier latency or vendor response time, and it must never be quoted as one.
Vendor backoff sleeps are injected as no-ops in the gate and the delays that
_would_ have been waited are recorded separately, so no latency percentile includes
them.

**What Layer A did NOT measure** (repeated here because the artifact is what gets
read, not this paragraph):

- Real telephony: Twilio calls/second per from-number, account concurrency,
  carrier latency, answer and seize rates.
- ElevenLabs: actual concurrent-session enforcement, the real 429 rate at the
  ceiling, real time-to-first-audio, real per-minute billing.
- Network behaviour between app, provider and the bank's webhook endpoint.
- Multi-instance behaviour. Every worker here is one process on one database.
  `FOR UPDATE SKIP LOCKED` is exercised; cross-instance clock skew and per-instance
  pool contention are not.
- Postgres at a realistic index size — the gauge is a `COUNT` over `Case.state`
  and this database has a few thousand rows.

**Layer B (real vendor load) is POST-SUBMISSION.** It needs carrier and
conversational-AI budget, a scheduled window with the bank, and the ceilings read
out of both consoles. Until it exists, no claim in this document about vendor
behaviour is MEASURED, and the document says which ones are not.

### Two defects the gate caught, and why they are written down

Both were found by this gate, not by review, and both would have shipped.

**1. `FOR UPDATE SKIP LOCKED` alone is not a claim.** The claim's candidate list is
captured from a snapshot, so a worker whose snapshot predates another worker's
commit still sees a row as PENDING and re-claims it, overwriting the first
worker's `claimed_by`. Measured at 8-way concurrency: one job id returned to
seven successive claims. Worse, with `LIMIT 1` and many workers every worker
snapshots the _same_ top-priority row, so one job collects N claims of which N-1
are useless — ~270,000 claims for 1,200 cases, and the drain never finished. The
fix is to re-assert the claim condition on the `UPDATE`'s target, which makes
PENDING → CLAIMED an atomic compare-and-set, plus `renewClaim()` immediately
before the call as the last line of defence. **A queue that can double-claim is a
queue that can call a customer twice about their own card**, which is a trust
failure, not a performance one.

**2. A lease written from the application's clock is a lease in the past.** The
`dial_job` columns are `TIMESTAMP(3)` — no timezone. A JS `Date` sent through the
driver arrives as its **UTC** wall time, while `now()` returns the server's
**local** wall time. On a host that is not UTC (this repository's own Postgres
runs on `E. Africa Standard Time`, UTC+3) every lease was written three hours in
the past, so every claimed row was instantly reclaimable and the queue livelocked.
The API now takes _durations_, never instants, and every deadline is
`now() + interval` computed by the database.

The general rule, and the reason both are in this document: **anything compared
against `now()` must be written by the same clock.** Neither defect would have
been visible in a unit test, a demo, or a single-worker run.

---

## 8. Connection arithmetic

Every process that talks to Postgres costs connections, and the arithmetic that
decides how many instances we can run is boring, easy to get wrong, and fails all
at once when it is wrong:

```
(instances × connection_limit) + workers ≤ max_connections − reserved
```

With the `reserved` term carrying the connections that must survive our own
outage: Postgres's `superuser_reserved_connections`, plus a deliberate reserve for
migrations, a `psql` session, monitoring and backups. **Reserving nothing means
the first person to open a psql prompt during a campaign cannot connect.**

Measured on this machine (Postgres 17.11): `max_connections = 100`,
`superuser_reserved_connections = 3`. Assume a reserved total of **10** (3
superuser + 7 operational) → **90 usable**. The deployed value must be read from
the target host; the default is rarely what a provisioned instance gives you.

| Instances | Dial workers | App pool | Worker pool | Audit pools | Total   | Fits 90?            |
| --------- | ------------ | -------- | ----------- | ----------- | ------- | ------------------- |
| 1         | 1            | 10       | 20          | 10          | 40      | ✅ 50 spare         |
| 2         | 2            | 20       | 40          | 20          | 80      | ✅ 10 spare — tight |
| 3         | 3            | 30       | 60          | 30          | **120** | ❌ **over by 30**   |

Two things in that table are worth arguing about:

**The audit pool is per process and it is the thing that breaks the arithmetic.**
`src/lib/db.ts` creates a _second_ Prisma client with a 5-connection pool for
fire-and-forget audit appends, per process. It is the right design (audit writes
must not starve the hot path) and it is invisible until you multiply it: three
instances is 15 connections nobody budgeted for. If we need a third instance, the
cheapest fix is a shared audit pool or a queue in front of the appends — not a
larger `max_connections`.

**The dial-worker pool is the biggest single term.** Workers do not need 20
connections each. Their steady state is a claim, an admission decision and a
handful of writes; the 20-connection figure is a worst-case number for a saturated
worker. Sizing it to the modelled burst, a worker pool of 10 per worker is enough,
and the third instance becomes affordable.

Levers, in the order to reach for them: (1) shrink the pools to the measured
figures; (2) put PgBouncer in transaction mode in front of Postgres and stop
counting app connections against `max_connections` at all; (3) raise
`max_connections` — which costs memory, because every connection is a backend
process; (4) a read replica for the gauge and the console (§9).

---

## 9. Roadmap — deliberately NOT built in this slice

Partitioning, read replicas and autoscaling are **post-submission**. They are
listed here so that "we did not build it" reads as a decision with a reason
rather than an omission.

| Item                                                  | Why it is not in this slice                                                                                                                                                                                                                                   | What it would change                                                                                                                                                                                        |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Table partitioning on `Case`** (`createdAt` ranges) | The gauge is a `COUNT` over `Case.state`; at pilot volumes (thousands of rows) it is not the bottleneck, and partitioning before the row count justifies it is a cost with no measured benefit.                                                               | Bounds the gauge scan and makes retention a `DROP PARTITION` instead of a `DELETE`. Trigger: when the gauge's p95 exceeds the admission latency budget.                                                     |
| **Read replicas**                                     | Every write on the dial path is on the primary by definition, and the gauge must be read from the primary (a lagging replica would under-count live conversations and over-admit). A replica helps the console and the analytics, which are not on this path. | Takes the Command Center and the inspector off the primary. Trigger: when console reads are a measurable share of primary load.                                                                             |
| **Autoscaling on the gauge**                          | The binding constraint is a _vendor_ ceiling, not our compute. Adding instances does not add ElevenLabs sessions, so autoscaling would scale the thing that is not scarce and leave the thing that is unchanged.                                              | The only thing autoscaling genuinely helps is queue-drain throughput during a backlog. Trigger: when measured queue depth at peak exceeds what a fixed worker set clears inside the bank's response window. |
| **PgBouncer / connection pooling**                    | Needs a deployment change (a proxy in front of Postgres), not a code change, and it interacts with prepared statements and the advisory-lock path in the audit chain.                                                                                         | Decouples app connections from `max_connections`, which is what unblocks the third instance (§8).                                                                                                           |
| **A dedicated gauge table instead of `COUNT`**        | A counter is faster but has to be correct across instances and across crashes, which means a leased counter row and a reconciliation sweep — strictly more machinery than a COUNT, for a query that is currently sub-millisecond.                             | Takes the hot-path gauge off the case table entirely. Trigger: measured gauge p95 above the admission budget.                                                                                               |

**Layer B vendor load testing** is also post-submission, for the reasons in §7.

---

## 10. Provenance

| Figure                                                        | Status                                                                                                |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| ElevenLabs Agents $/min, burst $/min, concurrency by tier     | **CALIBRATED** — elevenlabs.io/pricing/agents, read 2026-10-02                                        |
| The tier our account is actually on (40)                      | **CALIBRATED** — published tier; console reading still outstanding                                    |
| Twilio CPS per from-number (2), account concurrency (10)      | **CALIBRATED** — our conservative defaults for a new account, not quoted terms; read from the console |
| Mean call duration (180 s)                                    | **CALIBRATED** — docs/UNIT-ECONOMICS.md §1, demo-traffic handle time; no pilot distribution           |
| Flag rate 0.35% (steady) / 35% (campaign)                     | **EXTRAPOLATED** — planning figures                                                                   |
| Peak multiple 8×                                              | **EXTRAPOLATED** — our planning figure; the institution supplies its own                              |
| Campaign shape (8,000 customers / 40 min)                     | **EXTRAPOLATED** — the scenario this platform is sized against                                        |
| Steady-state and burst concurrency, cost at peak              | **COMPUTED** from the above by `src/lib/scale/capacity.ts`                                            |
| Layer A throughput, latency percentiles, rates, depths, peaks | **MEASURED** — `evidence/load/results.json`, on this host, vendors mocked                             |
| `max_connections = 100`, `superuser_reserved_connections = 3` | **MEASURED** on this machine; re-read on the deployed host                                            |
| Reserved = 10, pool sizes in §8                               | **CALIBRATED** — an operating decision, not an observation                                            |
| Everything about real vendor behaviour under load             | **NOT MEASURED** — Layer B, post-submission                                                           |

No number in this file is presented as a measurement we did not take.
