# Scope triage — 250 points, 48 hours

The checklists total roughly 250 items. A team genuinely ships **40–60** in a
hackathon. The rest must be **visible without being built**.

**The rule:** every un-built item gets one paragraph here and one box in the
architecture diagram. Judges score what they can see — and they can see
documentation. Spending two hours on a Tier-3 item that would have been one
paragraph costs two hours of demo polish, which scores more.

---

## Tier 1 — Demo-critical (must work live)

Everything in this tier was rehearsed, not merely implemented. If any of it is
red, the demo does not run.

| Item                                                 | Where it lives                                                   |
| ---------------------------------------------------- | ---------------------------------------------------------------- |
| Landing page + live pipeline ticker                  | `src/views/Home.tsx`                                             |
| Live browser-mic voice demo                          | `src/components/demo/LiveVoicePanel.tsx`                         |
| Green/red state flashes on the "yes"/"no" path       | `LiveVoicePanel` state machine                                   |
| Typewriter transcript, interim vs final              | `LiveVoicePanel` + `src/lib/realtime-events.ts`                  |
| 5 pre-seeded interventions                           | `scripts/seed-demo.mjs`                                          |
| Fire Intervention slide-out                          | `src/views/Console.tsx`                                          |
| One-click judge login                                | `src/views/Auth.tsx` (`NEXT_PUBLIC_DEMO_LOGIN_*`)                |
| Org switcher + refetch on switch                     | `src/components/shell/OrgSwitcher.tsx`                           |
| Credit wallet, 10,000 vs 0, Contact Sales modal      | `src/components/console/TopUpDialog.tsx`                         |
| Status pills                                         | `src/components/fx/core.tsx` `StatusPill`                        |
| Latency badge                                        | `src/lib/telemetry/spans.ts` + `src/components/slo/SloPanel.tsx` |
| Demo Mode badge                                      | `Console.tsx` header chip                                        |
| Toasts                                               | `src/hooks/use-toast.ts`                                         |
| Skeleton / loading states                            | `src/components/fx/LoadingIndicator.tsx`                         |
| Health endpoint                                      | `src/app/api/health/route.ts`                                    |
| Pre-seeded playable audio URLs                       | `public/demo-audio/` via `bun run db:seed:audio`                 |
| **Vishing blocklist refusing an utterance on stage** | `src/lib/compliance/vishing.ts`                                  |

---

## Tier 2 — Must exist, can be simple

Judges click around here. Each is small and high perceived value.

| Item                                               | Where it lives                                                      | Note                                                                 |
| -------------------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Docs page with cURL + webhook JSON                 | `src/views/Docs.tsx`                                                | Static content; the highest value-per-hour item in the whole project |
| "Send test webhook" button                         | `src/app/api/console/webhooks/test/route.ts`                        | Signs the **real** envelope, 3s timeout                              |
| Table filters + pagination                         | `src/components/fx/Pagination.tsx`                                  |                                                                      |
| RAG uploader with status pipeline                  | `src/app/api/console/documents/*`, `src/lib/knowledge/documents.ts` | Real: extract → chunk → embed → status, with a Retry button          |
| Masked BYOK fields                                 | `src/lib/byok.ts`, `src/lib/setup.ts`                               | Write-only; the GET returns masks and booleans only                  |
| Audit log viewer                                   | `src/views/Dashboard.tsx`, `src/app/api/console/audit/route.ts`     | Returns `verification` from the chain walk                           |
| Security headers (CSP / HSTS / Permissions-Policy) | `src/proxy.ts`, `next.config.ts`                                    | 30 minutes, disproportionate trust gain                              |
| Voicemail static-audio path                        | `src/lib/outreach-copy.ts`                                          |                                                                      |
| Onboarding wizard                                  | `src/views/SetupWizard.tsx`                                         | 5 steps, one save per step, secrets write-only                       |
| Latency SLO panel                                  | `src/components/slo/SloPanel.tsx`                                   | Built but **was unreachable** until this pass; now mounted           |

---

## Tier 3 — Document, don't build

One paragraph each. These are real engineering, not vapour — but they are not
what a judge clicks in three minutes, and half-building any of them is worse than
describing it cleanly.

### Redis pub/sub for multi-instance fan-out

**What it would be.** The realtime service currently fans out within one process,
so two app instances each hold their own socket rooms and a console connected to
instance A never sees activity published by instance B. Production needs a
`PUBLISH`/`SUBSCRIBE` bridge so any instance can publish to any other instance's
sockets. **Why it is deferred.** The reference architecture is explicitly
single-instance (`src/lib/ratelimit.ts` documents the in-memory store as the
default), so this is a scaling change with no correctness bug behind it. The
boundary it would cross — `src/lib/realtime.ts` `notifyRealtime` — is already a
single function, so the change is contained.

### Hash-chained audit verifier

**What it would be.** Not a feature that is missing — **it exists**:
`verifyChain()` walks prev-hash links (not timestamps), detects forks, hash
mismatches and orphaned rows, and `GET /api/console/audit` returns the result
alongside the rows. Deferred only in the sense that a **bank-facing attestation
endpoint** (chain proof without an operator session) is not exposed. What is
deferred is the endpoint, not the cryptography.

### Dead-letter queue

**What it would be.** A queue whose exhausted messages land in a durable table an
admin can inspect and replay. **Largely built**: QStash `failureCallback` →
`/api/queue/dead-letter` persists the raw envelope, keyed by a stable
idempotency key so a retried enqueue cannot dead-letter the same case twice, and
`replayDeadLetter()` re-queues it. Not built: the operator-facing browser view.

### Semantic cache

**What it would be.** Caching embeddings by content hash so a repeated question
across cases costs one inference rather than N. **Deferred** because it trades a
correctness property (retrieval over the current document set) for a cost
optimisation, and during a pilot the document set is small and the cost is not
yet the binding constraint.

### SMS STOP handling

**What it would be.** Carrier-level STOP / START / HELP keywords, plus a
suppression list. **Largely built**: `SmsSuppression` and `DoNotCall` tables, an
inbound-SMS route, `src/lib/sms-verdict.ts` parsing YES/NO/STOP/START, and
`markVoiceFailed` suppressing after an opt-out. Not built: carrier-level
short-code registration per tenant.

### Carrier failover

**What it would be.** Falling back to a second carrier when the primary cannot
terminate to a destination. **Deferred** because UAE carrier termination rules
differ per provider and a failover that violates them is worse than no failover.
The dial gate's geo allowlist fails closed instead, which is the safer posture.

### 2FA on the operator console

**What it would be.** TOTP or WebAuthn for operator accounts. **Deferred on
purpose**: Better Auth supports it and sign-up is invite-only, so the marginal
risk-reduction is small compared with the time cost. Recorded in
`docs/POST-LAUNCH-TODO.md` as a pre-pilot item.

### Salah-time blocking

**What it would be.** Suppressing outbound calls during Friday prayer window,
derived from prayer times. **Deliberately scoped to a switch plus this line**,
because a hard-coded prayer-time table is region-specific data that will be wrong
for some customers; a tenant who needs it configures the window, and the setting
exists as `Organization` tenant state.

---

## What was cut from Tier 1, and why

Recorded because a silent cut looks like an oversight.

| Considered                       | Decision                                                                                                                   |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| WebRTC (full duplex)             | **Spec'd, not built** — the browser-facing socket is the whole gap; server plumbing exists. `docs/POST-LAUNCH-TODO.md` §2b |
| Pre-rendered Arabic TTS showcase | Defer until `eleven_multilingual_v2` Khaleeji quality is measured on real phrases — day one, not day three                 |
| Inbound voice-liveness demo      | Phase 2; would be a fraud **detector** product with its own evaluation burden                                              |
