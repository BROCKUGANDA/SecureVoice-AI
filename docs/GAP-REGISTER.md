# Gap register — WP-1 to WP-24

Generated 2026-10-02 from a six-way read-only audit of the repository against
the Stage 2 work-package spec, plus a re-audit of everything already changed
today.

**How to read this.** Every row is a verified absence or a verified
contradiction, with the search that found it. Nothing here is inferred. Status
is one of:

- **FIXED** — closed today, with the gate named
- **OPEN** — real gap, unblocked, not yet closed
- **BLOCKED** — needs an external dependency this repo cannot supply
- **FALSIFIED** — a graded artifact asserts something untrue; correcting it is
  the work

---

## The pattern that explains most of this register

Three separate audits, covering different packages, converged on one finding:

> **The repository has high-quality modules that are well-tested at their own
> seam and then not reachable from the shipped path.**

This is the same failure class as the dial-path defect closed earlier today,
where `createCase()` existed with zero callers. The entry points that prove it:

| Entry point | Package | Production call sites |
| --- | --- | --- |
| `createCase()` | WP-2 | **0** until fixed today |
| `scopedDb()` | WP-12 | **1** (`api/auth/export/route.ts`) |
| `runRetention()` | WP-15 | **0** — no scheduler exists |
| `scaleMetricsSnapshot()`, `reapExpiredLeases()`, `replayDeadDialJob()` | WP-19 | **0** |
| `setAbuseConfig()`, `setOrgGeoPolicy()`, `setOrgTestNumbers()`, `setOrgPlanTier()` | WP-14 | **0** |
| `setOrgBudget()`, `clearOrgBudget()` | WP-13 | **0** |
| `safeLog()` / `logInfo()` / `logWarn()` / `logError()` | WP-22 | **0** — production uses raw `console.*` |
| `notify()` | WP-20 | **0** — the inbox can display alerts nothing can create |
| `src/lib/payments/**` incl. Paystack | WP-13 | **0** — no route imports it |
| `src/lib/failures/**` (envelope, breaker, db-failures, timeouts) | WP-21 | **0** — ~2,200 lines, and the chaos gate tests it while the routes keep their own status discipline |
| `requirePrivileged()` | WP-11 | 2 of 5 declared privileged actions |

A module with a green unit test and no production caller is not a feature. It
is a library. Counting those as "implemented" is how a submission ends up with
a passing test suite and a system that does not do the thing.

---

## Package status

| WP | Package | Status | Headline |
| --- | --- | --- | --- |
| 1 | Agent config as code | PARTIAL | `desiredState()` omits `data_collection`, so drift in 3 fields is invisible to the read-back |
| 2 | Signal to dial | **FIXED** | Case was never persisted; no call was ever placed |
| 3 | Server tools | PARTIAL | One global tool secret; the gate that claims otherwise cannot fail |
| 4 | Post-call ingest | PARTIAL | Quarantine rows are written and never read |
| 5 | Outbound bank notification | PARTIAL | Python verifier exists; dead-letter replay endpoint unverified |
| 6 | Multilingual | PARTIAL | Bank supplies language (correct); no `Intl`/number-to-words anywhere; disclosure never sent per-call |
| 7 | Latency instrumentation | **MISSING** | No tracing substrate; `slo.json` is transcribed constants |
| 8 | Evidence machine | **FIXED** | `bun run evidence` now exists and fails honestly |
| 9 | Red-team pack | PARTIAL | Server layer proven offline; conversation layer blocked on quota |
| 10 | Operator console | **OPEN** | Console click path bypasses every guardrail |
| 11 | Auth | PARTIAL | No freeze-commit route exists; invariant I-1 unachievable |
| 12 | Multi-tenancy | PARTIAL | The guard exists; one caller |
| 13 | Billing / Paystack | PARTIAL | BYOK is one global key from `AUTH_SECRET`; kill switch env-only |
| 14 | Abuse / toll fraud | PARTIAL | All 8 controls real; no per-org policy setter outside tests; no `ABUSE_*` in `.env.example` |
| 15 | Data protection | PARTIAL | Crypto-shredding holds no real data; no retention scheduler |
| 16 | Deploy / runbook | **MISSING** | `docs/RUNBOOK.md` does not exist |
| 17 | Customer integration | PARTIAL | No OpenAPI, no AsyncAPI, no conformance checker |
| 18 | Internal seams | PARTIAL | `PaymentProvider` real; 7 of 9 named ports absent; no offline mode |
| 19 | Concurrency and scale | PARTIAL | `CAPACITY.md` contradicts its own artifact (**FALSIFIED**) |
| 20 | Realtime / notifications | PARTIAL | Redis adapter built; no redis service shipped; cursor never sent |
| 21 | Failure semantics | PARTIAL | Excellent library, zero production callers |
| 22 | Input validation | PARTIAL | `safeLog` unused; production logs raw interpolation |
| 23 | Responsive / a11y | PARTIAL | Walkthrough runs with `--autoplay-policy=no-user-gesture-required`, which hides the Safari failure it should catch |
| 24 | Public surface | **MISSING** | `robots.txt` allows everything; no manifest, sitemap, `llms.txt`, JSON-LD, or `X-Robots-Tag` |

---

## Ranked gap register

Ranked by rubric points per hour of work.

### 1. The console "Fire signal" button bypasses every guardrail — **30% + 20%**

`src/app/api/console/fire/route.ts` forwards to `/api/interventions`, an older
second ingest with **no policy gate, no abuse gate, no `Case` row, no durable
queue**, and it places the carrier call in-request. Its own docstring claims
"the identical flow, provably end-to-end".

This is the button a judge presses. Every guardrail closed today sits on
`/api/v1/interventions`, which no judge will touch. It simultaneously breaks
Working build (no case, so no staged freeze and no bank webhook) and
Guardrails (the demo path proves nothing), and it is an ungated carrier-call
surface.

**Effort:** M. **Status:** in progress.

### 2. Graded documents assert falsehoods — **20%**

- `README.md:377` and `docs/INTEGRATION.md:180` both claim a secret valid for
  one tool does not authorise another. There is **one** global
  `AGENT_TOOL_SECRET` written into all four tools. Both claims are false.
- `docs/CAPACITY.md` §7 quotes 0 errors and 0 dead-lettered jobs;
  `evidence/load/results.json` records `not-run` with 2,128 errors and 300
  dead-lettered jobs. A graded document contradicts its own artifact, and
  nothing gates it — `tests/docs/docs-accuracy.test.ts` reads only the README
  and the model card.

**Effort:** S. **Status:** in progress.

### 3. No freeze-commit route exists — invariant I-1 — **20%**

`stage_card_freeze` stages `committed:false`, and nothing ever commits it.
`commit_freeze` has zero call sites and there is no route for it, so the
"a second, human or bank-system actor commits" half of I-1 cannot happen. The
judge demo script explicitly shows `committed:false` with a reversal window —
which is correct — but the flow has no ending.

**Effort:** M. **Status:** OPEN.

### 4. Two gates that cannot fail on the defect they name — **20%**

- `tests/tenancy/isolation.test.ts` requires `DECLARED-GAP-still-unscoped` to be
  **true**. It is green because the gap is still open.
- `tests/tools/guard.test.ts:70-75` is labelled "cross-tool secret" but only
  asserts that a wrong secret gives 401, using the same secret for every tool.

**Effort:** S. **Status:** in progress.

### 5. `src/lib/failures/**` has zero production callers — **30%**

~2,200 lines: a 5-field error envelope with a leak scanner, a 9-row database
failure matrix, four circuit breakers with declared fallbacks, and a 9-edge
derived timeout tree. The chaos gate runs 455 real checks against it — and the
46 actual route handlers keep returning `{ error: string }`. Ten routes return
403 for role gating where the contract says cross-tenant must be 404. No route
emits `requestId`, `retryable` or `docsUrl`.

**Effort:** L to wire one route properly; the contract already exists.
**Status:** OPEN.

### 6. No latency instrumentation at all — **20%**

No OpenTelemetry dependency, no span emitter, no trace propagation. Latency is
`Date.now() - started` into audit `meta.latencyMs` at eight sites and never read
back. `/metrics` exposes gauges, not histograms. There is no p50/p95 anywhere
and no SLO panel.

Worse: `evidence/latency/slo.json` — which **I wrote today** — hardcodes
`551` and `9` as literal constants transcribed from `docs/VERIFICATION.md`, and
hardcodes `interventions_measured: 0`. It is a transcription, not a pipeline.
That is the same sin as the harness it was written to guard against.

**Effort:** M for real spans; S to stop the fabrication.
**Status:** OPEN — the fabrication half is urgent.

### 11. Two more falsifiable claims in customer-facing surfaces — **10%**

- `src/views/Docs.tsx:363-368` publishes the legacy camelCase
  `signal.caseId` body shape. The canonical route `POST /v1/interventions` is
  `zod .strict()` and requires flat snake_case `transaction_ref`, so the public
  documentation page describes an API the server rejects. A judge's integrator
  sends exactly what the docs say and gets a 422.
- `src/lib/deck.ts:129` claims bank integration happens "via OAuth 2.0 and
  mTLS". Neither exists anywhere in the codebase — there is no OAuth client, no
  mTLS configuration, and no OIDC/SAML.
- `src/lib/failures/envelope.ts` sets every error's `docsUrl` to
  `https://docs.securevoice.ai/errors`. No such host is declared in any
  `Caddyfile` and there is no `/errors/[code]` route, so every typed error a
  bank receives carries a link to a 404.

All three are checkable in five minutes, and a falsified claim costs more than
an acknowledged gap.

**Effort:** S. **Status:** OPEN.

### 7. `docs/RUNBOOK.md` missing, kill switches incomplete — **30%**

No runbook. Kill switches exist for billing only; live dialling, the LLM
phrasing layer, BYOK and outbound webhooks all need a container restart.
`/readyz` asserts four things and not telephony reachability or voice quota.

**Effort:** S for the runbook, M for deploy-free switches. **Status:** OPEN.

### 8. `scopedDb` has one production caller — **20%**

The tenancy guard is real, tested at 184+ checks, and effectively unenforced.
Every route using raw `db` is unscoped. This is the loudest question in any bank
vendor review.

**Effort:** L (systemic). **Status:** OPEN.

### 9. Public surface absent — **10%**

`robots.txt` allows everything. No `X-Robots-Tag` on authenticated routes, no
`site.webmanifest`, no sitemap, no `llms.txt`, no JSON-LD, no AI-crawler policy,
no trust pages. The CSP and HSTS already set in `next.config.ts` are the one
strong asset.

**Effort:** S. **Status:** OPEN.

### 10. Notification and realtime paths built but unreachable — **10%**

`notify()` has no caller; `advanceEscalations` is re-exported and never invoked.
The Socket.IO Redis adapter is built and tested but no redis service ships in
`docker-compose.yml`; the client sends no `last_event_id` and hard-codes
websocket-only; `Console.tsx` stores the coarser `RealtimeStatus` instead of the
tested live/reconnecting/stale reducer.

**Effort:** M. **Status:** OPEN.

---

## Blocked — and honestly so

Per spec rule 10, these are recorded rather than stalled on.

| Item | Blocker | Owner |
| --- | --- | --- |
| Agent-layer pass rate (`bun run test:agent`) | ElevenLabs quota exhausted (10000/10000). 12 of 20 runs recorded as errors. Needs quota, not code. | founder — top up or wait for reset |
| Transcripts + post-call analysis artifacts | Require real completed calls against verified test numbers. | founder — needs a live dialling window |
| Named institution, contact, last-conversation date | Human sales. Cannot be generated; a guessed name is discoverable. | founder — see `docs/PILOT.md` §1 |
| Carrier per-minute rate for the pilot country | Needs the exact destination rate card. A US rate would discredit the model. | founder |
| Kenyan Paystack entity | Incorporation takes weeks. Adapter builds against test keys meanwhile. | founder — start now |
| Arabic native-speaker sign-off | Human. | founder |
| Twilio carrier geo-lock | Console action, not code. | founder — before any public URL |
| WP-2 p95 leg | Needs `TEST_DATABASE_URL` on a co-located Postgres. The remote instance hangs the 20-signal burst. | founder — start Docker |

---

## What the definition of done still needs

Against §13, the honest state after today:

- [x] `bun run evidence` exists and fails honestly
- [x] Dial path places calls; proven live
- [x] Cross-tenant isolation matrix passing
- [x] Tool-call criterion scored on invocation
- [x] App typecheck and lint clean
- [ ] `bun run evidence` exits 0 — blocked on quota
- [ ] `evidence/latency/slo.json` shows ≥30 real interventions — needs instrumentation
- [ ] Two consecutive unassisted live runs, EN and AR — needs a live calling window
- [ ] Freeze committed by a second actor — no route exists
- [ ] `docs/RUNBOOK.md` present
- [ ] Named institution in `docs/PILOT.md` — founder input
- [ ] `bun run test --offline` — no offline mode exists
- [ ] Carrier geo-lock active — founder console action
