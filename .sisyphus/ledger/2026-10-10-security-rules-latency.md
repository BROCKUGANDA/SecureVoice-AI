# Session ledger — 2026-10-10

## Task

Wire the five security rules and the three latency tricks into the
SecureVoiceai Twilio Media Streams plane, end to end (user chose "both").

## What was done

### Security rules (deterministic, enforced in code)

1. **Rule 5 — numbers as speech.** New `src/lib/compliance/spoken-numbers.ts`
   (`renderNumbersAsSpeech`), wired into `prepareSpeech` between markdown
   stripping and redaction. Amounts/currencies/years/percent/ordinals rendered
   to words; identifier-shaped digit runs (PAN/phone/SSN) deliberately left
   intact so `redactPII` still recognises them downstream.
2. **Rule 2 — never-ask.** New `src/lib/compliance/never-ask.ts`
   (`NEVER_ASK_LINE` per language + `callerRequestsSecret`). Wired into the
   media-stream worker (short-circuits the router) and the `/api/agent` turn
   API (replaces the draft).
3. **Rule 1 — untrusted speech.** The worker's router is deterministic (no
   prompt to hijack), so the enforcement story is the audit: injection
   attempts recorded via `detectInjectionAttempt` + `auditAppend`, service
   continues unchanged.
4. **Rules 3 & 4** already enforced on the LLM path (vishing blocklist,
   SAFETY_EXIT). Rule 4 was NOT actually spoken on the media-stream plane —
   the exit is now spoken as its own turn after the opening and as the last
   thing before the fraud branch closes the line.

### Latency tricks

1. **Trick 1 — prewarm at DIALING.** Dial worker POSTs `/prewarm` on the
   voice-stream plane (new endpoint, optional `VOICE_PREWARM_SECRET` guard);
   warms the fixed-phrase audio cache + pre-connects a pooled Deepgram
   socket. New `src/lib/voice/warm-audio.ts` (process-local mulaw cache,
   injectable synthesizer, stats). `prewarm.ts` rewritten — the old warm
   filled the buffered `tts()` cache which the streaming transport never
   reads.
2. **Trick 3 — backchannel.** Wired into `handleTranscript` (250 ms timer,
   cancelled on first audio, served from the local warm cache only, gated by
   `shouldPlayBackchannel`, never during the opening).
3. **Trick 2** — satisfied architecturally on this plane (deterministic
   router over vetted fixed lines; HTTP plane already streams provider audio
   with `optimize_streaming_latency=3`). Documented rather than claimed.

### Observability

`answered_to_first_agent_word` span now carries `{cached, backchannel,
neverAsk}` attributes.

### Bug found and fixed (pre-existing on HEAD)

Fraud branch set `state.ended = true` before speaking the freeze
confirmation; both playback loops break on `state.ended`, so the most
legally consequential sentence was never spoken on this plane. Terminal
turns now pass `force: true`.

### Also

- Per-language line tables moved from the worker into
  `src/lib/voice/conversation.ts` (import-cycle-free warming).
- Repaired `tests/unit/stop-left-the-voice-registry-empty.test.ts`, RED on
  main (safe-log mock missing `logWarn` imported by `languages.ts`) — now
  14 pass.
- Compose env: `VOICE_STREAM_INTERNAL_URL`, `VOICE_PREWARM_SECRET` wired
  into dial-worker + voice-stream-worker.
- `docs/VERIFICATION.md` section appended.

## Files changed

- NEW `src/lib/compliance/spoken-numbers.ts`, `never-ask.ts`
- NEW `src/lib/voice/warm-audio.ts`
- MOD `src/lib/compliance/speech-gate.ts`, `src/lib/voice/backchannel.ts`,
  `conversation.ts`, `deepgram-client.ts`, `src/worker/voice-stream.ts`,
  `src/worker/prewarm.ts`, `src/worker/dial.ts`,
  `src/app/api/agent/route.ts`, `docker-compose.yml`,
  `tests/unit/stop-left-the-voice-registry-empty.test.ts`
- NEW tests: compliance-spoken-numbers (22), compliance-speech-gate-numbers
  (7), compliance-never-ask (12), voice-warm-audio (10), voice-backchannel
  (10) — all green.

## Next steps

1. Await full-suite result (background run); investigate any NEW red.
2. Run `bun run verify` (format + lint + tsc + tests + build) once the
   suite is green.
3. Commit; the tree also contains an untracked `PR` entry that predates
   this session — leave it alone.
4. Native-speaker review of the Hindi/Swahili patterns in never-ask.ts and
   vishing.ts before claiming parity (scope note recorded in
   docs/VERIFICATION.md).

## CONCURRENT WRITER EVENT (recorded for the next session)

While this work was in progress, the repo owner committed it as
`321d7de` "feat(security): 4-layer currency defense (Zod API gate + spoken
map + LLM rules + Intl UI) + zero/cross-border/Arabic edges", combining
this session's files with their own layer (`src/lib/currency-map.ts`,
`src/components/AmountDisplay.tsx`, agent-prompts/api-gateway changes).
HEAD therefore already contains the full implementation.

Still UNCOMMITTED after that commit (this session's polish only):

- `docker-compose.yml` — VOICE_STREAM_INTERNAL_URL / VOICE_PREWARM_SECRET
- `docs/VERIFICATION.md` — the session section appended here
- prettier formatting in spoken-numbers.ts, never-ask.ts, warm-audio.ts,
  prewarm.ts, compliance-spoken-numbers.test.ts
- `.sisyphus/ledger/2026-10-10-security-rules-latency.md` (this file)

Verified after the commit: HEAD's voice-stream.ts carries the force fix,
/prewarm, backchannel, never-ask, warm-cache and injection-audit wiring;
HEAD's agent/route.ts carries the never-ask wiring unmodified. The two
currency tables (theirs: src/lib/currency-map.ts for their API/UI layer;
mine: CURRENCY_WORDS in spoken-numbers.ts for the TTS gate) coexist —
consolidation is a follow-up, not done mid-flight.

## FULL-SPECTRUM TEST RUN (2026-10-10, all categories)

| Category                                                                        | Result                                                                                                                   |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Unit (bun, 150 files)                                                           | full suite run; 5 suites red — ALL pre-existing (baseline-verified)                                                      |
| New unit tests (this work)                                                      | 61 pass (22+7+12+10+10)                                                                                                  |
| Integration (tenancy/auth/billing/privacy/contracts/seams/routes/tools/console) | ran in full suite; same 5 pre-existing reds                                                                              |
| E2E (tests/e2e, 19 files)                                                       | ran in full suite — green                                                                                                |
| E2E (Cypress, primary-flow)                                                     | 5/5 pass                                                                                                                 |
| Jest                                                                            | 44/44 pass, 5/5 suites                                                                                                   |
| Realtime cross-node (Redis on 6380)                                             | 50/50 pass                                                                                                               |
| Flaky detection                                                                 | 3x repeat of 9 relevant suites: identical 112/0                                                                          |
| Lighthouse (prod build)                                                         | perf 43, a11y 96 — budgets were ALREADY failing; baseline 31/96, so current is BETTER on every metric                    |
| Regression baseline (93f6d28 worktree)                                          | load 14, console documents 3, console fire 6, flag-gating 1, privacy WP-15 all reproduce identically — ZERO new failures |
| auth:cutover / lint / tsc / build                                               | pass (build needed one fix, below)                                                                                       |

### Pre-existing red (baseline-verified at 93f6d28, NOT this work)

- load gate: 14 fail — expects a local Postgres at 127.0.0.1:5432 that this
  machine does not run.
- console documents 3 / console fire 6 — external Pinecone config + fire-route
  409 assertions; identical at baseline.
- flag-gating 1 — a flag maps to SEED_DEMO, not FEATURE_*; identical at
  baseline.
- privacy WP-15 (erasure rows 4->7, 14 HTTP calls) — identical at baseline.

### Bugs found and fixed while running the categories

1. **THE BUILD WAS RED** — src/components/AmountDisplay.tsx (the concurrent
   writer's) began `import "use client";` (an import statement) instead of
   the `"use client";` directive, so Next never marked it a client boundary
   and the production build failed with "Can't resolve 'use client'". Fixed
   with the one-character change; build verified green. (Uncommitted.)
2. **scripts/lighthouse.mjs** — two harness bugs blocked the perf gate:
   `screenEmulation`/`formFactor` rejected by Lighthouse 13's validation, and
   `launched.kill().catch()` crashing because kill() returns void in this
   chrome-launcher version (masking the real error). Both fixed; the gate now
   runs. (Uncommitted.)
3. Its dev-server heuristic `/webpack-hmr|turbopack|.../` false-positives on
   Next 16 PRODUCTION builds (chunk filenames contain "turbopack-*"), so the
   gate needed --allow-dev; production-ness was verified separately (no dev
   markers, minified chunks).

### Uncommitted at end of session (writer sweeps them in periodically)

- src/components/AmountDisplay.tsx (directive fix — build red without it)
- scripts/lighthouse.mjs (two harness fixes — perf gate red without them)
- evidence/* + Intl (writer's/test-run artifacts; junk untracked files
  `44px`, `handoff)`, `x[1]` are their shell accidents, untouched)

## REVIEW-FINDINGS PASS (2026-10-10, later)

Ten suspected defects from an AI review, verified line by line: 9 real and
fixed, 1 (prenotify 90s/300s) already fixed earlier and reported invalid.

Fixed (all in the review-fixes section of docs/VERIFICATION.md):

1. MCP tools/call: caller credential now required + forwarded; platform
   credential never substituted (src/app/api/elevenlabs/mcp/route.ts).
2. MCP forwarding origin: fixed, never from req.url (same file + Caddy
   `header_up Host {host}` evidence).
3. switch_language: org predicate added to both queries
   (src/app/api/elevenlabs/tools/switch-language/route.ts); new real-DB
   regression test tests/tools/switch-language-bleedguard.test.ts.
4. Campaigns: RECEIVED → SCREENED before enqueue
   (src/app/api/v1/campaigns/route.ts).
5. Campaigns: language in the dial-job payload + case, same value.
6. Campaigns: `lang` is `z.enum(SUPPORTED_LANGS)` — unsupported rejected.
7. Subagent nodes require onReturn (validate.ts + schema.ts superRefine);
   regression test added.
8. MCP protocol tests now assert the JSON-RPC envelope (jsonrpc + echoed id).
9. Campaign tests assert which phones are enqueued, every accepted recipient
   is queued, the SCREENED transition, the language payload, and the refusal.

Verification: tsc clean · lint 0 errors · 120 suites green in the affected
slice · bleedguard verified against the real DB · operator-manifest green
(its no-"secret"-in-responses guard forced a manifest-note rewording).

## COMMITTED

`56bd24b` — "fix(security): MCP caller auth + fixed forward origin,
switch-language org scope, campaign dial-state/language, workflow onReturn
invariant". 17 files, +561/-52. Includes the earlier uncommitted fixes
(AmountDisplay directive, lighthouse harness), the .env.example + compose
entries for MCP_TOOL_FORWARD_ORIGIN, and the bleedguard test's DB-requirement
note. Post-commit re-run of the three rewritten suites: 27 pass / 0 fail.

Deliberately NOT committed (not mine / run artifacts): `Intl` (the repo
owner's scratch file), evidence/* (regenerated per test run), and the junk
untracked files `44px`, `handoff)`, `setTimeout(r`, `x[1]` (shell accidents).

UNCOMMITTED at session end (same pattern — the repo owner sweeps):

- all of the above source + test changes
- (from earlier) AmountDisplay.tsx directive fix, lighthouse.mjs harness fixes
