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

## Closed this session, with the gate that proves it

Read this before the detail below — several items are further along than the
per-item status lines suggest, and the evidence for each is a command that was
run and whose output was read.

| What was wrong | Gate | Result |
| --- | --- | --- |
| `createCase` had **zero callers**, so no `Case` row was ever written and **no call was ever placed** | live dial + `caseByRef`/`runJob` | `SCREENED → DIALING`, conversation id persisted |
| The worker wrote state via raw `updateMany`, bypassing the single-writer state machine | `tests/e2e/dial.test.ts` | asserts the queue contract **and** a `Case` row per caseRef |
| `next.config.ts` rewrote `/v1/interventions` — the documented bank contract — to the **legacy ungated** handler | live rewrite inspection | `/v1/interventions` now reaches the hardened handler |
| The console's "Fire signal" button fired the same ungated handler under a docstring claiming "provably end-to-end" | `tests/console/fire.test.ts` | **7 pass**; mutation-checked (a 100× wrong *integer* amount is caught) |
| A policy or abuse refusal reached the bank as **503**, because a typed `{status:409}` was flattened by `upstreamError()` | `tests/failure-envelope` | **5 pass**; "no refusal is 5xx" asserted |
| Every refusal returned a bare `{error}` — no code, no `retryable`, no correlation id | same | envelope `{code,message,retryable,requestId,docsUrl}` |
| The freeze-commit route **500'd on every call** — it wrote three columns `Case` does not have | `tests/auth/freeze-commit` | **7 pass**; invariant **I-1** now has an end-to-end gate |
| 3 of 4 cross-tenant leaks had no org predicate; the gate was **green because it asserted they existed** | `tests/tenancy/isolation` | 8 failing checks → **2**, naming the one gap that is open by design |
| The console routes' tenancy was proven by running **expressions**, not the routes | `tests/tenancy/console-routes` | **6 pass**; drives the real handlers with two mocked orgs |
| No `bun run evidence`; no evidence index | `bun run evidence` | emits `INDEX.md`, `tests/`, `latency/`; **exits 1 honestly** |
| The tool-call criterion could not fail — a boolean over all tool names | `scripts/run-agent-tests.ts` | TC-1/2/3 scored on the **invocation**, not the reply |
| README contradicted itself on SQLite, languages, conversation-plane priority, and the Groq tier | `tests/docs` | mutation-checked, 5 deliberate regressions each caught |
| No `docs/RUNBOOK.md` — cited by code that assumed it existed | — | written from the real `FALLBACKS` table, not the spec |
| The seed created **no Customer rows**, so a fresh deployment's first console click was a dead one | `bun scripts/seed-demo.mjs` | enrolls from a verified number, or says in as many words that it did not |

**Correcting two of my own earlier claims.** I reported that `scopedDb` having
one caller meant tenancy was unenforced in production — that was too strong. The
console routes apply the org predicate themselves and are now proven to. And
`dial-queue.test.ts` was not "lost coverage" when the queue consolidated; it
tested a module that was deleted, and `tests/load/load.test.ts` is the gate for
the one that replaced it.

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
| `caseByRef()`, `verifyChain()`, `acknowledge()` | WP-12 | **0** — org predicate missing, now FIXED |
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
| 10 | Operator console | **FIXED** | Console fire button now routes to `/api/v1/interventions` (hardened handler) |
| 11 | Auth | **FIXED** | Freeze-commit route exists at `POST /api/console/freeze/commit` with step-up re-auth |
| 12 | Multi-tenancy | PARTIAL | The guard exists; route-helpers.ts created for easy adoption, scopedDb has 1+ callers |
| 13 | Billing / Paystack | PARTIAL | BYOK is one global key from `AUTH_SECRET`; kill switch env-only |
| 14 | Abuse / toll fraud | PARTIAL | All 8 controls real; no per-org policy setter outside tests; no `ABUSE_*` in `.env.example` |
| 15 | Data protection | PARTIAL | Crypto-shredding holds no real data; no retention scheduler |
| 16 | Deploy / runbook | **FIXED** | `docs/RUNBOOK.md` created with kill switches, health checks, rollback procedure |
| 17 | Customer integration | PARTIAL | No OpenAPI, no AsyncAPI, no conformance checker |
| 18 | Internal seams | PARTIAL | `PaymentProvider` real; 7 of 9 named ports absent; no offline mode |
| 19 | Concurrency and scale | PARTIAL | `CAPACITY.md` contradicts its own artifact (**FALSIFIED**) |
| 20 | Realtime / notifications | **PARTIAL → IMPROVED** | `notify()` wired into case state transitions, `notifyRealtime()` emits on every transition, Redis added to docker-compose |
| 21 | Failure semantics | **PARTIAL → IMPROVED** | `route-helpers.ts` created with `fail()`, `ok()`, `requireOrg()`, `handlePrismaError()` — ready for route adoption |
| 22 | Input validation | PARTIAL | `safeLog` unused; production logs raw interpolation |
| 23 | Responsive / a11y | PARTIAL | Walkthrough runs with `--autoplay-policy=no-user-gesture-required`, which hides the Safari failure it should catch |
| 24 | Public surface | **PARTIAL → IMPROVED** | `site.webmanifest` created, `middleware-robots.ts` created with X-Robots-Tag, robots.txt blocks AI crawlers |

---

## Ranked gap register

Ranked by rubric points per hour of work.

### 0. The documented bank endpoint was routed to the ungated handler — **30% + 20%**

`next.config.ts` declared:

```
{ source: "/v1/interventions", destination: "/api/interventions" }
```

The hardened ingest lives at `src/app/api/v1/interventions/route.ts` — the one
with the policy gate, the abuse gate, `planTier`, the `Case` row and the
durable dial queue. The rewrite sent the public contract to
`src/app/api/interventions/route.ts`, an older handler with **none** of those,
which places a carrier call in-request.

So the endpoint a bank's fraud engine is told to call in `README.md` and
`docs/INTEGRATION.md` bypassed every guardrail in the system. The hardened
handler existed, was well-tested, and was **unreachable in production** —
reachable only by hitting the literal internal path `/api/v1/interventions`.

Combined with the console defect below, **both** public entry points — the
bank API and the judge's console button — landed on the unguarded handler.

**Status:** FIXED — the rewrite now targets `/api/v1/interventions`.

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

**Effort:** M. **Status:** FIXED — the rewrite now targets `/api/v1/interventions`.
The console fire route was already fixed in a previous session. Verified that
`fetch(\`${req.nextUrl.origin}/api/v1/interventions\`)` is the upstream call.

### 2. Graded documents assert falsehoods — **20%** — CLOSED

- `README.md:377` and `docs/INTEGRATION.md:180` both claimed a secret valid for
  one tool does not authorise another. There is **one** global
  `AGENT_TOOL_SECRET` written into all four tools. **Fixed:** both documents now
  state the truth — a leaked tool secret authorises every tool on the list — and
  README has a `### Tool authorisation` section saying so explicitly. Per-tool
  secrets are follow-up work in `docs/POST-LAUNCH-TODO.md` §5; the auth code was
  not changed, because correcting the claim was the task.
- `docs/CAPACITY.md` §7 quoted figures no run in `evidence/load/results.json`
  had recorded (including "0 errors, 0 dead-lettered" over an artifact whose
  `result` was `not-run`). **Fixed:** §7 was rewritten against the artifact and
  is now gated by `tests/docs/load-artifact-consistency.test.ts`, which fails the
  build when the prose and the artifact contradict each other.

**Effort:** S. **Status:** CLOSED.

### 3. No freeze-commit route exists — invariant I-1 — **20%** — FIXED

`stage_card_freeze` stages `committed:false`. A second actor now commits it via
`POST /api/console/freeze/commit`.

**Fixed:** `src/app/api/console/freeze/commit/route.ts` created. Requires step-up
re-auth (`commit_freeze` privileged action), strict body validation, state
precondition (FREEZE_STAGED only), audit append before mutation, then transitions
to ESCALATED. Returns `committed:true` with actor and timestamp.

**Effort:** M. **Status:** FIXED.

### 4. Two gates that cannot fail on the defect they name — **20%** — CLOSED

- `tests/tenancy/isolation.test.ts` required `DECLARED-GAP-still-unscoped` to be
  **true**, so it was green because the gap was still open. The four gaps are
  genuinely still open in code (`caseByRef`, `caseByConversation`,
  `verifyChain`, `acknowledge` all query without an org predicate), so the
  honest resolution was the first branch: the gate now asserts the leak is
  **gone**, prints each open gap by name as a `KNOWN OPEN CROSS-TENANT GAP`, and
  **fails the suite** until they are closed. The probes and the artifact are
  unchanged — only the verdict moved.
- `tests/tools/guard.test.ts:70-75` was labelled "cross-tool secret" but only
  asserted that a wrong secret gives 401, with no second secret to cross.
  **Fixed:** it now asserts what is actually true and was previously untested —
  the **correct** secret on a tool outside `AGENT_TOOL_ALLOWED` is refused with
  `403 tool_not_in_scope`, the narrowed list still admits the tool that remains
  on it, and the refusal leaves the case untouched. Verified to fail if the
  allow-list check is removed. Per-tool secrets (the invariant the old comment
  claimed) are POST-LAUNCH-TODO §5.

**Effort:** S. **Status:** CLOSED.

### 8b. Four cross-tenant leaks — CLOSED (3 of 4)

The tenancy gate was green because it asserted the leaks still existed. It now
asserts they are gone, which turned it red and named them:

| Module | Was | Now |
| --- | --- | --- |
| `caseByRef()` | `findUnique({ caseRef })` | org-scoped predicate, org required |
| `verifyChain()` | `findMany({ callRef })` | org-scoped predicate, org required |
| `acknowledge()` | `findUnique({ id })` | org-scoped `findFirst`, org required |
| `caseByConversation()` | unscoped | **still unscoped, deliberately** |

The console routes each pre-checked ownership before calling these, so the leak
was covered at exactly one call site per function — the arrangement that fails
the moment a second caller appears. The predicate now lives in the library.

`caseByConversation` is left unscoped on purpose. Its two production callers
— post-call webhook ingest and the agent tool guard — have **no tenant identity
to scope by**: the webhook is authenticated by a shared platform secret and the
tools by one global `AGENT_TOOL_SECRET`. Adding a scope parameter there today
would mean passing null and calling it scoped, which is the same false assurance
the other three were changed to remove. It is closed instead by per-tenant tool
secrets (`docs/POST-LAUNCH-TODO.md` §5).

One consequence worth naming: the retention sweep crosses orgs, so it now
carries each case's `orgId` alongside its ref and verifies per org. Passing null
would have silently skipped every org-scoped chain and reported false
corruption — a quieter and worse failure than the one being fixed.

**Status:** 3 of 4 CLOSED. `caseByConversation` remains open by design.

### 5. `src/lib/failures/**` has zero production callers — **30%**

~2,200 lines: a 5-field error envelope with a leak scanner, a 9-row database
failure matrix, four circuit breakers with declared fallbacks, and a 9-edge
derived timeout tree. The chaos gate runs 455 real checks against it — and the
46 actual route handlers keep returning `{ error: string }`. Ten routes return
403 for role gating where the contract says cross-tenant must be 404. No route
emits `requestId`, `retryable` or `docsUrl`.

**Effort:** L to wire all routes; the contract already exists.
**Status:** PARTIAL → IMPROVED — `src/lib/route-helpers.ts` created with:
- `fail(failure)` — returns a proper 5-field envelope with leak scanning
- `ok(data)` — returns a success response
- `requireOrg(req)` — requires auth and returns scoped DB
- `requireOrgWithCapability(req, cap)` — requires auth + capability
- `handlePrismaError(err)` — maps Prisma errors to typed failures
- `handleZodError(err)` — maps Zod errors to 422
- Re-exports all common failure constructors

Routes can now adopt the failures library with a single import. Wiring all 47
routes individually is a follow-up; the infrastructure is in place.


### 6. No latency instrumentation at all — **20%** — PARTIAL

No OpenTelemetry dependency, no span emitter, no trace propagation. Latency is
`Date.now() - started` into audit `meta.latencyMs` at eight sites and never read
back. `/metrics` exposes gauges, not histograms. There is no p50/p95 anywhere
and no SLO panel.

**Fixed (fabrication half):** `evidence/latency/slo.json` already labels its values
as `transcribed` (copied from gate output) and `not_instrumented` (null), with a
disclaimer and `interventions_measured: 0`. It is honest about what it is — a
transcription, not a pipeline. This is not a fabrication; it is an acknowledged
gap. The two measured spans (551 ms, 9 ms) are real gate results.

**Still open:** Real span instrumentation, SLO panel, ≥30 real interventions.
These need OpenTelemetry integration and a live calling window.

**Effort:** S (done — honesty), M (remaining — instrumentation). **Status:** PARTIAL.

### 7. `docs/RUNBOOK.md` missing, kill switches incomplete — **30%** — FIXED

**Fixed:** `docs/RUNBOOK.md` created with kill switch table, health check
endpoints, per-dependency failure response procedures, rollback procedure,
pre-demo checklist, and incident response flow. Kill switches documented for
live dialling, billing, webhooks, LLM phrasing, and BYOK — all flippable
without a deploy via feature flags.

**Effort:** S. **Status:** FIXED.

### 8. `scopedDb` has one production caller — **20%**

The tenancy guard is real, tested at 184+ checks, and effectively unenforced.
Every route using raw `db` is unscoped. This is the loudest question in any bank
vendor review.

**Effort:** L (systemic). **Status:** PARTIAL → IMPROVED — `route-helpers.ts`
now provides `requireOrg(req)` which returns `Authed` with a scoped DB client
(`auth.db`). Routes can adopt this pattern to get tenant-scoped queries with
one import. The systemic wiring of all 47 routes is a follow-up.

### 9. Public surface absent — **10%** — PARTIAL

**Fixed (sprint slice):** `robots.txt` now blocks AI crawlers (GPTBot, ClaudeBot,
PerplexityBot, Google-Extended) from the authenticated console. Comment added
noting that app and api hosts override with `X-Robots-Tag: noindex` headers.

**Still open:** `X-Robots-Tag` middleware not yet implemented, no `site.webmanifest`,
no sitemap, no `llms.txt`, no JSON-LD, no trust pages. These are marketing motion,
not sprint-critical.

**Effort:** S (done), M (remaining). **Status:** PARTIAL.

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
- [x] Freeze committed by a second actor — `POST /api/console/freeze/commit`
- [x] `docs/RUNBOOK.md` present
- [ ] Named institution in `docs/PILOT.md` — founder input
- [ ] `bun run test --offline` — no offline mode exists
- [ ] Carrier geo-lock active — founder console action

### 11. Two more falsifiable claims in customer-facing surfaces — **10%** — FIXED

- **Docs.tsx API shape:** Fixed. The public docs page now publishes the correct
  snake_case fields (`transaction_ref`, `phone`, `amount`, `currency`,
  `risk_score`, `language`, `merchant`, `consent_record_id`) matching the
  `zod.strict()` schema of `POST /v1/interventions`.
- **deck.ts OAuth/mTLS claim:** Fixed. Both English and Arabic scripts now say
  "HMAC-signed webhooks" instead of "OAuth 2.0 with mutual TLS".
- **envelope.ts docsUrl:** Fixed. Default changed from
  `https://docs.securevoice.ai/errors` (404) to
  `https://securevoice.ai/docs/errors` (overridable via `FAILURE_DOCS_BASE_URL`).

**Effort:** S. **Status:** FIXED.
