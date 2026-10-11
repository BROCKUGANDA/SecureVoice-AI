# Tech Debt Ledger — SecureVoiceai

Generated 2026-10-11 from a full-repo audit: GitNexus code-graph (857 files,
17,781 symbols, 43,155 edges), git churn ranking, manifest reads, and
dimension-by-dimension source inspection. Reconciles against the previous
ledger (`docs/GAP-REGISTER.md`, 2026-10-02).

## Orientation

- **Stack truth** — Next.js 16 App Router, Prisma 7, bun runtime, better-auth
  ^1.7.7 + next-auth ^4.24.11 (both installed), zustand, three test runners
  (bun test via `run-tests.mjs`, jest on `tests-jest/`, cypress), docker-compose
  + Caddy, terraform.
- **Churn top 10** — `.github/workflows/ci.yml` (49), `.env.example` (42),
  `prisma/schema.prisma` (36), `package.json` (35), `docker-compose.yml` (33),
  `.github/workflows/deploy.yml` (31), `src/app/api/v1/interventions/route.ts`
  (29), `src/worker/dial.ts` (26), `bun.lock` (26), `README.md` (23).
- **Size top 10 (non-generated)** — `tests/chaos/chaos.test.ts` (2775),
  `tests/unit/failures-modules.test.ts` (2358), `tests/unit/abuse.test.ts` (2192),
  `tests/seams/seams.test.ts` (2073), `tests/unit/scale.test.ts` (1973),
  `tests/load/load.test.ts` (1958), `tests/unit/contracts.test.ts` (1799),
  `tests/tenancy/probe-registry.ts` (1677), `tests/e2e/elevenlabs-tool-routes.test.ts`
  (1663), `src/views/Dashboard.tsx` (1616).
- **Gate inventory** — `bun run test` (orchestrator, one process per file),
  `test:jest`, `test:coverage`, `test:e2e:cypress`, `release:check`, `verify`,
  `bun run evidence`. CI: `.github/workflows/ci.yml` (49 churns — the most
  changed file in the repo).
- **Priority corner** — high-churn + high-size + low-adoption: the failures
  library (2,200+ lines, 455 chaos checks, 6 of 85 routes adopted), the
  tenancy guard (184+ checks, 1 production caller), safe-log (35 of 85 routes).

## Findings

| id | dimension | file:line | severity | effort | recommendation |
|---|---|---|---|---|---|
| arch.email-cycle | Architectural decay | `src/lib/email/queue.ts:25` ↔ `src/lib/email/resend.ts:39` | high | S | Break the import cycle: move `enqueueAndSendEmail` into a third module (e.g. `email/deliver.ts`) that both import, or invert so `resend.ts` never imports `queue.ts`. GitNexus `check --cycles` flags it. |
| arch.prewarm-dead | Architectural decay | `src/worker/prewarm.ts:1` (70 lines) | medium | S | Delete or wire. Zero invokers across repo, compose, Dockerfile, scripts. The `/prewarm` endpoint it serves is called by `dial.ts:328` but the worker process itself is never started. |
| arch.dual-auth | Architectural decay | `package.json:121` (`next-auth` alongside `better-auth`) | medium | M | Pick one. `auth:cutover` script asserts no Clerk; next-auth is either a migration remnant or a parallel path. Remove the unused one. |
| arch.god-views | Architectural decay | `src/views/Dashboard.tsx:177` (1616 lines), `src/views/Console.tsx` (1372 lines) | medium | L | Split into feature sections. Dashboard already has internal section components (Monitor, Analytics, Evaluation, Config, Compliance, WebhooksDemo) — extract each to its own file. |
| consist.triple-test-runner | Consistency rot | `scripts/run-tests.mjs`, `jest.config.cjs:70`, `cypress.config.ts` | medium | M | Three runners for one repo. jest covers `tests-jest/` (10 files); consider migrating to bun test or making jest the single unit runner and bun the integration runner with a clear boundary. |
| consist.dual-lockfile | Consistency rot | `bun.lock` (tracked) + `package-lock.json` (867KB, untracked) | low | S | Delete `package-lock.json` from disk; `packageManager: bun@1.4.2` is declared. Two lockfiles invite drift. |
| consist.dual-payments | Consistency rot | `src/lib/payments/gateway.ts:28` (paystack + paddle + manualinvoice) | medium | M | Paystack is implemented and unit-tested but the bound adapter is `manualinvoice` (`src/lib/ports/registry.ts:164-166`). Either wire paystack behind a feature flag or remove it. |
| consist.403-vs-404 | Consistency rot | `src/app/api/auth/invites/route.ts:86`, `src/app/api/auth/members/route.ts:96` | high | S | Cross-tenant access must return 404 (resource must not exist for the caller), not 403. The failures envelope already models this — adopt it here. |
| type.any-webhook | Type and contract gaps | `src/lib/elevenlabs/inbound.ts:140,141,155,165,176,178` | high | M | The ElevenLabs webhook payload is processed as `any` end-to-end. Define a zod schema for the inbound event and parse at the boundary. |
| type.any-instrumentation | Type and contract gaps | `src/instrumentation.ts:44` | low | S | `delete (event.extra as any)[k]` — type the Sentry event extra as `Record<string, unknown>` and narrow. |
| test.jest-swallowed | Test debt | `.github/workflows/ci.yml:425` | high | S | `bun run test:jest --coverage > /dev/null 2>&1 || true` — jest failures never fail CI. Remove `\|` `true` or make it blocking on main. |
| test.jest-orphaned | Test debt | `tests-jest/` (10 files), `jest.config.cjs:70` | medium | M | `release:check` and `verify` never run jest. Either add `test:jest` to the gate or delete `tests-jest/` and the jest config. |
| test.mega-files | Test debt | `tests/chaos/chaos.test.ts` (2775), `tests/unit/failures-modules.test.ts` (2358), `tests/unit/abuse.test.ts` (2192) | low | M | 2,775-line test files are hard to navigate and slow to debug. Split by scenario or assertion group. |
| dep.evidence-artifacts | Dependency and configuration debt | `evidence/` (49 tracked JSON files) | medium | M | Test output artifacts are committed to git and churn every run (3+ modified in working tree right now). Move to CI artifact upload or gitignore + regenerate. |
| dep.env-gate-boot | Dependency and configuration debt | `tests/tenancy/isolation.test.ts` boot; `src/lib/better-auth.ts:41`; `.env.example:448` (`BETTER_AUTH_SECRET=""`) | medium | S | Suites that import better-auth at module scope cannot run locally: `.env.example` ships `BETTER_AUTH_SECRET=""` and no `BETTER_AUTH_URL`, so the gate dies with "must be set and at least 32 characters" before any assertion. CI injects fixed throwaway values (`.github/workflows/ci.yml:71`). Fill the two vars in the local `.env` template or set them in `tests/preload.ts`. |
| dep.stray-tracked | Dependency and configuration debt | `{})` (0 bytes, tracked at root) | low | S | Delete. Accidental commit of a shell-redirect artifact. |
| dep.stray-untracked | Dependency and configuration debt | `Intl` (500B), `PR` (756B) on disk | low | S | Session scratch notes. Delete or gitignore. |
| perf.no-otel | Performance and resource debt | `src/lib/telemetry/spans.ts:470` (OTLP types only, no dependency) | medium | M | 30 `Date.now() - started` latency sites, no OpenTelemetry. Either add `@opentelemetry/*` or delete the OTLP-shaped types and the `transcribed` SLO constants. |
| perf.metrics-gauges-only | Performance and resource debt | `src/app/api/metrics/route.ts:55,67,70,83` | medium | S | `/metrics` exposes gauges only — no histograms, no p50/p95. Add a histogram for request latency. |
| perf.websocket-only | Performance and resource debt | `src/lib/realtime-client.ts:144` (`transports: ["websocket"]`) | medium | S | No polling fallback. In restrictive corporate networks websocket-only realtime silently degrades. Add `transports: ["websocket", "polling"]`. |
| errh.envelope-adoption | Error-handling and observability debt | 75 of 85 routes return raw `{ error: string }` | high | L | The failures envelope (5-field: code, message, retryable, requestId, docsUrl) is built and tested but adopted by 6 routes. Wire the remaining 75 via `route-helpers.ts`. |
| errh.raw-console | Error-handling and observability debt | `src/app/api/auth/invites/route.ts:116`, `src/app/api/auth/magic-link/route.ts:64`, `src/app/api/auth/reset/route.ts:72` | medium | S | Three `console.error` calls for email delivery failures. Use `logError` from safe-log for structured output. |
| errh.empty-catch | Error-handling and observability debt | `src/lib/voice-client.ts:79,84,95,185,228,261,330` | low | S | Eight empty `catch {}` blocks. Intentional (browser audio API throws on abort) but silent. Add a one-line comment or `catch { /* abort expected */ }`. |
| sec.tenancy-convention | Security hygiene | 46 of 86 routes hand-write the org predicate; `scopedDb` has 1 caller (`src/app/api/auth/export/route.ts`) | medium | M | Enforcement is by convention, not by a shared guard. A new route that forgets the predicate is caught only if it is in the tenancy probe registry. Extend `requireOrg()` adoption to the data-plane routes so scoping is structural. Note: the isolation gate is GREEN (4/4, no open cross-tenant gaps) — this is drift risk, not an active leak. |
| sec.tool-secret | Security hygiene | `README.md` (documented), `src/lib/agent-tool-auth.ts` | medium | M | One global `AGENT_TOOL_SECRET` authorises all four tools. Per-tool secrets are follow-up work in `docs/POST-LAUNCH-TODO.md` §5. |
| sec.demo-webhook-secret | Security hygiene | `src/app/api/webhooks/route.ts:25` | low | S | `whsec_demo_` fallback derived from `WEBHOOK_SECRET` when unset. Intentional demo mode but ensure it cannot activate in production (guard on `NODE_ENV`). |
| doc.gap-register-drift | Documentation drift | `docs/GAP-REGISTER.md` | low | S | The previous ledger is 9 days old and several rows have since been fixed (WP-17 openapi/conformance now exist). Re-run reconciliation or archive. |
| doc.worklog-committed | Documentation drift | `worklog.md` (17KB) | low | S | Session worklog committed to the repo. Move to a gitignored scratch file or delete. |

## Top fixes (ranked by severity)

1. **errh.envelope-adoption** (high, L) — 75 routes on raw `{ error }`. Wire
   `route-helpers.ts` (`fail()`, `ok()`, `requireOrg()`, `handleZodError()`)
   route by route. This also delivers `sec.tenancy-convention` for free, since
   `requireOrg()` returns a scoped client.
2. **type.any-webhook** (high, M) — untyped ElevenLabs payload. Zod schema at
   the webhook boundary (`src/lib/elevenlabs/inbound.ts:140-178`).
3. **consist.403-vs-404** (high, S) — cross-tenant 403→404 on invites/members.
4. **test.jest-swallowed** (high, S) — un-swallow jest in CI (`ci.yml:425`).
5. **arch.email-cycle** (high, S) — break the import cycle.
6. **sec.tenancy-convention** (medium, M) — extend `requireOrg()` so scoping is
   structural rather than hand-written per route.

## Quick wins (severity ≥ medium, effort S)

- `consist.dual-lockfile` — delete `package-lock.json`.
- `dep.stray-tracked` — delete `{})`.
- `dep.stray-untracked` — delete `Intl`, `PR`.
- `dep.env-gate-boot` — fill `BETTER_AUTH_SECRET` / `BETTER_AUTH_URL` so the
  tenancy gate runs locally instead of only in CI.
- `doc.worklog-committed` — gitignore `worklog.md`.
- `doc.gap-register-drift` — reconcile or archive.
- `errh.raw-console` — 3 sites to safe-log.
- `errh.empty-catch` — 8 sites, one-line comments.
- `sec.demo-webhook-secret` — guard on `NODE_ENV`.
- `perf.websocket-only` — add polling fallback.
- `perf.metrics-gauges-only` — add latency histogram.
- `arch.prewarm-dead` — delete or wire.
- `type.any-instrumentation` — narrow the `as any`.

## Corrections to this ledger

- **`sec.tenancy-enforcement` (first draft) was overclaimed and is retracted.**
  The first pass counted routes by a single `scopedDb` caller and asserted "84 of
  85 routes unscoped / critical". Observed evidence contradicts that: 46 of 86
  routes carry an explicit org predicate; the remainder are guarded by another
  mechanism (Upstash-Signature on the queue routes, `requireOperator()` on the
  console routes, the tool secret on the ElevenLabs tool routes, session auth on
  the voice/TTS routes) or are public by design (health, readyz, meta, status,
  pilot, onboarding, operator config). The isolation gate itself was then run
  and **passes 4/4** with no `KNOWN OPEN CROSS-TENANT GAP` output, and the four
  functions the previous ledger named (`caseByRef`, `caseByConversation`,
  `verifyChain`, `acknowledge`) all now take an `orgId` and apply a scope
  predicate. The finding was downgraded to medium and re-scoped as
  `sec.tenancy-convention` (drift risk, not an active leak).
- Route counts here are a grep floor, not a semantic analysis: a route that
  scopes through a differently-named helper would be missed. Treat 46/86 as
  "at least 46".

## Looks bad but is actually fine

- **`scopedDb` having one caller** — looks like unenforced tenancy, but the
  isolation gate proves otherwise: `tests/tenancy/isolation.test.ts` passes
  4/4 ("guard is fail-closed: an unscoped read is refused, not served",
  "isolation: every read path × both orgs") and the webhook bleedguard suite
  passes 3/3. The console routes apply the org predicate themselves. The
  previous ledger already corrected this once; the residual item is drift risk,
  not a leak.
- **Empty `catch {}` in `voice-client.ts`** — browser `HTMLAudioElement` API
  throws on `pause()`/`currentTime` when no audio is loaded. The catches are
  intentional; they just need a comment.
- **`evidence/` JSON artifacts tracked** — the evidence machine (`bun run
  evidence`) is a deliberate hackathon-submission gate: `tests/docs` asserts
  `CAPACITY.md` against `evidence/load/results.json`. The artifacts must exist
  for the gate to pass. The debt is that they're *committed* rather than
  *generated in CI* — but that's a design choice for a judged submission, not
  an accident.
- **`transcribed` SLO constants in `evidence/latency/slo.json`** — labelled
  `transcribed` and `not_instrumented` with a disclaimer. Honest about what
  they are. Not a fabrication.
- **`whsec_demo_` webhook secret** — demo-mode fallback so the webhook signing
  demo works without a real secret. Guarded by the demo action, not production.
- **`handleZodError` returning null for Zod 4 errors** — was dead code, fixed
  2026-10-03 per GAP-REGISTER §10a. Verified fixed.
- **`next-auth` installed** — may be a migration remnant, but `auth:cutover`
  asserts no Clerk, not no next-auth. Open question until confirmed.
- **`src/lib/store.ts` CRITICAL risk (42 impacted)** — it's the client-side
  zustand view store. High blast radius is inherent to a shared client store,
  not a defect. The fix is architectural (split by domain), not urgent.
- **`dial.ts` 0 impacted (UNKNOWN)** — GitNexus can't track worker entry-point
  invocation. `dial.ts` is invoked by compose (`docker-compose.yml:181`), not
  by an import edge. Not dead code.

## Reconciliation vs `docs/GAP-REGISTER.md` (2026-10-02)

| WP | Previous status | Now | Verdict |
|---|---|---|---|
| WP-2 signal to dial | FIXED | `createCase` called from dial path | RESOLVED |
| WP-10 console fire | FIXED | routes to `/api/v1/interventions` | RESOLVED |
| WP-11 freeze-commit | FIXED | `POST /api/console/freeze/commit` exists | RESOLVED |
| WP-12 tenancy | PARTIAL | isolation gate GREEN 4/4; 4 named gaps all take `orgId`; 46/86 routes scoped by hand | RESOLVED |
| WP-13 billing/Paystack | PARTIAL | paystack implemented, bound adapter still `manualinvoice` | CARRIED |
| WP-14 abuse | PARTIAL | no per-org setters in production routes | CARRIED |
| WP-15 retention | PARTIAL | retention worker exists (`docker-compose.yml:270`) | IMPROVED |
| WP-17 integration | PARTIAL | `openapi.ts`, `conformance.ts`, `asyncapi.ts` exist; `/openapi` + `/v1/conformance/run` routes served | IMPROVED |
| WP-19 scale | PARTIAL | `scaleMetricsSnapshot`, `reapExpiredLeases`, `replayDeadDialJob` still no production callers | CARRIED |
| WP-20 realtime | PARTIAL | `notify()` called from `case-state-machine.ts:215`, `sms-verdict.ts:249`; redis in compose | IMPROVED |
| WP-21 failures | PARTIAL | `route-helpers.ts` exists; 6 of 85 routes adopted | IMPROVED |
| WP-22 validation | PARTIAL | safe-log adopted by 35 of 85 routes | IMPROVED |
| WP-23 responsive | PARTIAL | unchanged | CARRIED |
| WP-24 public surface | PARTIAL | robots.txt, webmanifest, middleware-robots exist | IMPROVED |
| WP-7 latency | PARTIAL | no OTel; 30 `Date.now()` sites; OTLP types only | CARRIED |
| WP-5 outbound | PARTIAL | unchanged | CARRIED |
| WP-6 multilingual | PARTIAL | unchanged | CARRIED |
| WP-9 redteam | PARTIAL | unchanged | CARRIED |
| WP-18 seams | PARTIAL | unchanged | CARRIED |

**NEW findings** (not in previous ledger): `arch.email-cycle`,
`arch.prewarm-dead`, `arch.dual-auth`, `arch.god-views`,
`consist.triple-test-runner`, `consist.dual-lockfile`, `consist.dual-payments`,
`consist.403-vs-404`, `type.any-webhook`, `type.any-instrumentation`,
`test.jest-swallowed`, `test.jest-orphaned`, `test.mega-files`,
`dep.evidence-artifacts`, `dep.stray-tracked`, `dep.stray-untracked`,
`perf.no-otel`, `perf.metrics-gauges-only`, `perf.websocket-only`,
`errh.raw-console`, `errh.empty-catch`, `sec.tool-secret`,
`sec.demo-webhook-secret`, `doc.gap-register-drift`, `doc.worklog-committed`.

## Boundary

This ledger is prepared analysis. It is not a completed cleanup, a measured
quality improvement, observed command evidence, review, CI, or merge evidence.
Every fix it recommends is separate coding work.
