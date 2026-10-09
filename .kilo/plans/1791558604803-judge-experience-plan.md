# Judge Experience Plan — SecureVoice AI (5 hackathon priorities)

Implementation-ready plan for the five items requested, in build order. Each task lists the exact files to touch, the contracts to preserve, and the tests to add. **Read `node_modules/next/dist/docs/` before writing any Next.js code** (AGENTS.md: this is Next 16 with breaking changes — `after()`, route handlers, `NextRequest` APIs).

## Decisions (locked)

| # | Decision |
|---|---|
| D1 | Live browser-mic demo = **Option A now**: surface the existing real pipeline (mic → `/api/asr` → `/api/agent` → streaming `/api/tts/stream` with barge-in) as a public landing-page widget. **Full-duplex WebSocket (B) is a specced follow-up**, not in this build. |
| D2 | Credit wallet = **org-scoped with per-user fallback**: `Organization.credits` is the wallet whenever the session has an active org; `UserProfile.credits` remains the org-less fallback. |
| D3 | Documents/RAG = **full real pipeline**: `Document` table, PDF text extraction, chunking, Pinecone embeddings, status pipeline with retry, org-scoped test search. |
| D4 | Wizard BYOK = **ElevenLabs key (existing encrypted field) + optional OpenAI-compatible LLM key + base URL** (new encrypted fields), wired into the existing provider precedence. |
| D5 | Loading states = **add `lottie-react`** (dynamically imported) with hand-authored minimal Lottie JSON + CSS fallback. |
| D6 | Seeded recordings = **generate real static audio at seed time** via ElevenLabs into `public/demo-audio/`, honest "sealed" state when no key. |

## Current-state facts (verified — do not re-litigate)

- A real half-duplex voice panel already exists: `ConversationPanel` at `src/views/Demo.tsx:1050-1482` (MediaRecorder → `blobToWavBase64` → POST `/api/asr` → POST `/api/agent` → `streamSpeech` with mic-monitor barge-in, typed fallback, `aria-live` log). It is signed-in-only (`VIEW_ACCESS.demo = "user"`) and buried below the scripted sim. The APIs it calls are anonymous-capable and IP-rate-limited.
- Credits are **per-user** today: `UserProfile.credits` (operator 500 / demo 25), atomic claim in `src/lib/credits.ts` (`deductCredit`/`refundCredit`), 402 in `src/app/api/console/fire/route.ts:137-143`. `/api/console/me` returns `profile.credits`; `Console.tsx:294,557,655` renders it.
- `src/components/console/TopUpDialog.tsx` **exists but is never rendered** — `Console.tsx:35-36,297` imports it and `walletEmptyNotice` without using them. Wire them (T4).
- Onboarding today is a product *tour* (`src/lib/onboarding.ts`, `ONBOARDING_STEPS`), not institution setup. No wizard exists.
- `Organization` already has `twilioVoiceNumber`, `twilioSmsSenderId`, `twilioMessagingServiceSid`, `vendorWebhookUrl`, `vendorWebhookSecretEnc`, `shariahCompliant`, `institutionType` (closed set `bank|insurer` — Takaful is expressed via `shariahCompliant`, **not** a third type), `planTier`. `src/app/api/console/settings/route.ts` already validates/saves vendor webhook + Shariah (reuse, don't fork).
- Knowledge base = vendor (ElevenLabs) KB applied by `scripts/agent-apply.ts`, surfaced statically from `src/lib/operator/manifest.ts`. Pinecone is used **only** for transcript indexing/search: `src/lib/pinecone/transcript-index.ts` (embed via `pc.inference.embed`, `inputType: "passage"|"query"`, upsert ids + `metadata.orgId`, strict `filter: { orgId }`, post-filter re-check). Mirror this exactly for documents.
- QStash job bus exists: `JOB_KINDS` in `src/lib/queue/envelope.ts`, handlers in `src/app/api/queue/dispatch/handlers.ts`, switch in `src/app/api/queue/dispatch/route.ts:94-99`, producer helper `publishEnvelope` in `src/lib/queue/qstash.ts`, `qstashConfigured()` gate, DLQ via `/api/queue/dead-letter`.
- Roles come from Better Auth org membership; `requireOperator()` (403) guards settings/billing. Org id is **always** server-derived from the session (`requireOperator()` → `guard.profile.orgId`), never from a body/header.
- Secrets are AES-256-GCM via `src/lib/byok.ts` (`encryptSecret`/`decryptSecret`/`maskKey`); stored secrets are never returned, only masked flags.
- Seed: `scripts/seed-demo.mjs` creates the demo user from `NEXT_PUBLIC_DEMO_LOGIN_EMAIL/_PASSWORD` + org `demo-bank` (owner) + `userProfile.credits = 25`. Migration naming convention for new changes: `9zzz…` suffix folders.

## Build order & tasks

Order: **T1 → T4 → T3 → T2 → T5** (T2's wizard step 4 embeds T3's uploader; T4's wallet is the demo-flow backbone; T1 is the 5-second wow and is independent).

---

### T1 — Live browser-mic widget on the landing page (#11, D1-A)

1. **Extract the shared panel.** Create `src/components/demo/LiveVoicePanel.tsx` by moving the `ConversationPanel` implementation out of `src/views/Demo.tsx:1050-1482` (turns/phases, mic → ASR → agent → streaming TTS, barge-in, typed fallback, error + permission states, `aria-live="polite"` transcript, latency chips). Public props: `{ callLang: CallLang; heading?: string }`. No auth, no new state ownership — behavior must be identical to today's panel.
2. **Re-wire the Demo view.** `src/views/Demo.tsx` imports and renders `<LiveVoicePanel callLang={callLang} />` where `<ConversationPanel …/>` was (line 743). Delete the local copy.
3. **Landing widget.** In `src/views/Home.tsx`, insert a full-width section between the hero (ends line 368) and the "Try it now" grid (line 371):
   - Heading: "Talk to the agent now — headphones on, no phone number" (+ AR string, matching the file's `t(en, ar, lang)` convention).
   - Render `<LiveVoicePanel />` with `callLang` local state defaulting to `"en"` and the 6-language pills (reuse the pill markup from Demo.tsx:567-592).
   - Secondary CTA next to the heading: "See how a bank uses this" → `setView("auth")` (the judge-login transition from the blueprint).
   - Keep the guardrail footer ("No PINs · No OTPs · Ever · same pipeline production calls use").
4. **No API changes.** `/api/asr`, `/api/agent`, `/api/tts/stream` already accept anonymous callers with IP rate limits; the mic click is the user gesture audio playback needs.
5. **Follow-up (spec only, do not build):** full-duplex path = new `src/worker/browser-voice.ts` (Bun WS server; browser sends PCM16@16k frames from an AudioWorklet; server runs `DeepgramLiveClient` streaming → `routeAgentIntent` → `ElevenLabsStream` returns `audio/mpeg` chunks; barge-in on interim transcript), a `NEXT_PUBLIC_VOICE_WS_URL` env, a compose service, and a client hook. Preconditions: live `DEEPGRAM_API_KEY` + non-dry-run `ELEVENLABS_API_KEY`. Record it in `docs/POST-LAUNCH-TODO.md`.
6. **Tests:** `tests/unit/demo/live-voice-panel.test.ts` — renders (mock fetch) typed-fallback path, error state, and `aria-live` region. Extend the surface test that enumerates views/nav only if the landing DOM contract is asserted there.

---

### T4 — Org wallet + Contact-Sales modal + demo/operator org split (#15–17, #81, D2)

1. **Migration** `prisma/migrations/9zzzzzzzzzzzzz_enterprise_onboarding/migration.sql` (covers T4+T2+T3 schema in one file — matches the repo's combined-migration style):
   ```sql
   ALTER TABLE "organization" ADD COLUMN "credits" INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE "organization" ADD COLUMN "region" TEXT;
   ALTER TABLE "organization" ADD COLUMN "twilioAuthTokenEnc" TEXT;
   ALTER TABLE "organization" ADD COLUMN "setupStep" INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE "organization" ADD COLUMN "setupCompletedAt" TIMESTAMP(3);
   ALTER TABLE "user_profile" ADD COLUMN "llmKeyEnc" TEXT;
   ALTER TABLE "user_profile" ADD COLUMN "llmBaseUrl" TEXT;
   CREATE TABLE "Document" ( ... see T3 schema ... );
   ```
   Mirror the column types/nullability in `prisma/schema.prisma` exactly (Prisma 7 + `postgresql` datasource; no `db push` on real deployments — use `bun run db:migrate`).
2. **`prisma/schema.prisma`:** add to `Organization`: `credits Int @default(0)`, `region String?`, `twilioAuthTokenEnc String?`, `setupStep Int @default(0)`, `setupCompletedAt DateTime?`. Add to `UserProfile`: `llmKeyEnc String?`, `llmBaseUrl String?`.
3. **Org-aware wallet** in `src/lib/credits.ts`:
   - `deductCredit(userId: string, orgId?: string | null)` — when `orgId` is present, atomically decrement `Organization.credits` (`updateMany where { id, credits: { gt: 0 } }`, return -1 on count 0); otherwise the existing `UserProfile` path. Same shape for `refundCredit` (increment). Keep the atomic claim-before-spend semantics (comment at fire route:130-136 stays true).
   - `auditWallet` gains `orgId` in `meta` (never raw key material).
   - Add `walletScope: "org" | "user"` to `PlatformProfile` and make `getProfile()` return the **effective** balance (`Organization.credits` when `orgId` is set, else `UserProfile.credits`).
4. **Fire route** `src/app/api/console/fire/route.ts`: pass `profile.orgId` into `deductCredit`/`refundCredit` (lines 137, 155, 308, 324). The 402 body (`paymentRequired(..., { credits: 0 })`) already matches `walletEmptyNotice`'s matcher — do not change its wording.
5. **Effective balance in readers:** `/api/console/me` (Console's credits chip) and the `credits` field of `/api/console/settings` GET (Settings billing tab) must return the effective balance from `getProfile()`.
6. **Wire the modal** in `src/views/Console.tsx`:
   - In `fire()`'s response handling (after line 557): `if (walletEmptyNotice(data)) setTopUp(true);`
   - Render `<TopUpDialog open={topUp} onOpenChange={setTopUp} />` before the closing `</div>` (line 1075).
   - Add `session?.session?.activeOrganizationId` to the main effect deps (line 465) so credits/branding/cases/audit refetch on org switch (cleaner than the checklist's `window.location.reload()`; note the alternative in a comment).
7. **`TopUpDialog` copy tweak** (`src/components/console/TopUpDialog.tsx`): say the wallet is reconciled per organisation (not per seat); keep Contact Sales (mailto to `SUPPORT_EMAIL`) + BYOK path; add a "Open Settings → API Keys" button that closes the dialog and calls `setView("settings")` (accept an optional `onOpenSettings` prop; `Console` passes it).
8. **Seed split** in `scripts/seed-demo.mjs`:
   - Second org: `operator-desk` ("Operator Desk", `credits: 0`, `institutionType: "bank"`), idempotent upsert like `demo-bank`.
   - Demo/judge user becomes a member of **both** orgs (owner of `demo-bank`; `member` of `operator-desk`) so the OrgSwitcher renders.
   - Set `demo-bank` org `credits: 10000`. Keep `userProfile.credits: 25` (org-less fallback only).
   - Keep the "no invented phone number" rule for enrollment untouched.
9. **OrgSwitcher no-active-org dead end** (`src/components/shell/OrgSwitcher.tsx:48`): render when `list.length >= 2` even with no `activeId`; button label "Select workspace"; `choose()` unchanged. This also soft-closes edge case #99.
10. **Tests:** update `tests/billing/billing.test.ts` + `tests/console/fire.test.ts` for org-scoped claim/refund/402 and "wallet follows the active org"; add a fire test that a 0-credit org returns 402 with `credits: 0` and that `creditsRemaining` refunds on upstream rejection.

---

### T3 — Documents / RAG full pipeline (#62–64, #96, D3)

1. **Dependency:** `bun add unpdf` (pure-JS PDF text extraction, no native deps, works under Bun/Next route handlers). Fallback if it fails to install: `pdf-parse`.
2. **Schema (in the same migration):**
   ```prisma
   model Document {
     id           String    @id @default(cuid())
     orgId        String
     title        String
     fileName     String
     mimeType     String    @default("application/pdf")
     sizeBytes    Int
     lang         String    @default("en")
     status       String    @default("PENDING") // PENDING | CHUNKING | EMBEDDING | READY | FAILED
     chunkCount   Int       @default(0)
     error        String?
     pdfBytes     Bytes?    // raw upload kept so Retry works without re-upload; hard cap 8 MB
     vectorizedAt DateTime?
     createdAt    DateTime  @default(now())
     updatedAt    DateTime  @updatedAt
     @@index([orgId, createdAt])
   }
   ```
   Never store raw PII here beyond what the bank uploads (policy PDFs); `redactedText`/audit rules unchanged.
3. **`src/lib/knowledge/documents.ts`** (mirror `src/lib/pinecone/transcript-index.ts` conventions):
   - `extractPdfText(bytes: Uint8Array): Promise<string>` (unpdf).
   - `chunkText(text, { maxChars = 1200, overlap = 150 }): string[]` — pure, exported, unit-tested.
   - `vectorizeDocument(documentId: string)` — transitions PENDING → CHUNKING → EMBEDDING → READY, or FAILED with `error` (including `pinecone_not_configured` when `!pineconeConfigured()`). Embed chunks (`inputType: "passage"`, model `env.pineconeEmbeddingModel`), upsert ids `doc:{documentId}:{i}` with `metadata: { orgId, documentId, title, lang, chunkIndex, text }`. Idempotent: a READY document is a no-op (QStash retries).
   - `searchDocuments(orgId, question, topK = 5)` — embed (`inputType: "query"`), `filter: { orgId }`, `includeMetadata: true`, **post-filter** matches by `metadata.orgId === orgId`, return `{ documentId, title, lang, chunkIndex, text, score }`.
   - `forgetDocument(documentId)` — delete vectors by metadata filter (`deleteMany({ documentId })`; verify against the installed `@pinecone-database/pinecone` SDK version) + delete the row.
4. **Queue:** add `"doc.vectorize"` to `JOB_KINDS` (`src/lib/queue/envelope.ts`), handler `handleDocumentVectorize` (`payload: { documentId }`; reads orgId from the envelope; throws on failure so QStash's ladder + DLQ apply) in `src/app/api/queue/dispatch/handlers.ts`, and register it in the map at `src/app/api/queue/dispatch/route.ts:94-99`. Producer: `publishEnvelope({ jobKind: "doc.vectorize", idempotencyKey: \`doc:${id}:vectorize:${attempt}\`, caseRef: \`DOC-${id}\`, orgId, payload: { documentId: id } })`. If `!qstashConfigured()`, run `vectorizeDocument` via `after()` from `next/server` (confirm the API in the Next 16 docs first); if unavailable there, inline-await with the 8 MB cap (admin-only uploads).
5. **Endpoints** (all `requireOperator()`, org derived from `guard.profile.orgId`, 409 when absent — same rule as the settings route's tenant fields):
   - `src/app/api/console/documents/route.ts` — GET list (org-scoped, masked statuses), POST `multipart/form-data` (`file`, `title`, `lang`): validate `application/pdf` + ≤ 8 MB, create Document (PENDING), enqueue.
   - `src/app/api/console/documents/[id]/route.ts` — DELETE (org-scoped; cross-org → 404, never 403-with-body).
   - `src/app/api/console/documents/[id]/retry/route.ts` — POST: reset to PENDING, clear `error`, re-enqueue with `attempt + 1`.
   - `src/app/api/console/documents/test/route.ts` — POST `{ question }` → `searchDocuments` (existing rate limiter).
6. **UI** `src/views/settings/DocumentsSection.tsx` (shared component, used by Settings and the wizard):
   - Drag-and-drop dropzone + keyboard-accessible file input (`accept="application/pdf"`).
   - Table: title, lang, size, chunks, status pill (Pending → Chunking → Embedding → Ready), `Failed` row shows the error + **Retry** button, uploaded-at.
   - "Test Knowledge Base" search bar → results list with score, doc title, chunk text.
   - Wire as a new `knowledge` tab in `src/views/Settings.tsx` (TABS array line 171-176 + branch alongside the existing tabs).
7. **Tests:** `tests/unit/knowledge/chunk.test.ts` (chunkText boundaries/overlap); `tests/console/documents.test.ts` (401 anonymous; 409 no-org; cross-org GET/DELETE → 404; status transition happy path + `pinecone_not_configured` FAILED + retry; test-search scoping with a stubbed Pinecone client).

---

### T2 — Multi-step onboarding wizard (#61–70)

1. **`src/lib/setup.ts`** (server-only): `SETUP_STEPS` (5 steps), `getSetup(orgId)` (progress + masked prefill: `elevenKeyMasked`, `twilioAuthTokenConfigured`, `llmKeyMasked`, current org/telecom/webhook values), `saveSetupStep(orgId, step, data)` (per-step Zod **strict** schemas — reject unknown fields, mirroring the settings route), `completeSetup(orgId)`.
2. **`src/app/api/console/setup/route.ts`**: GET (progress + prefill), POST `{ step, ...fields }` → validate → write → return `{ progress, nextStep }`. `requireOperator()`; no-org → 409. Write-only secrets never returned (masked flag only), matching the settings route contract.
3. **View + routing:** add `"setup"` to `View` (`src/lib/store.ts:5-18`), `VIEW_ACCESS.setup = "operator"`, and the `VIEWS` entry in `src/app/page.tsx:25-39`. Entry points: "Run setup wizard" button in the Settings header; a dismissible banner in Command Center when `setupCompletedAt` is null. Keep the product tour (`/api/onboarding`) untouched — different concern, different table.
4. **Wizard steps** (`src/views/SetupWizard.tsx`, step rail + progress + Lottie transition from T5, inline validation, "Skip for now" → `createSetupSkip`, resume from Settings):
   - **1 Institution profile** — org display name (writes `Organization.name` **and** mirrors `userProfile.orgName`/`orgLogoUrl` so the console header updates through the existing read path), logo URL (CDN URL — no blob storage exists in this stack; say so in the hint), institution type (`bank|insurer`; UI hint: Islamic/Takaful operators pick their type + the Shariah switch, which drives the speech gate — there is deliberately no third type), region (new closed set `UAE | GCC | MENA | OTHER`), Shariah-compliant switch (existing column).
   - **2 Telecom** — Twilio voice number (E.164), alphanumeric sender ID (`^[A-Za-z0-9 -]{2,16}$`), messaging service SID (optional), Twilio auth token → `twilioAuthTokenEnc` via `encryptSecret` (GET returns only `twilioAuthTokenConfigured`). Existing `twilioVoiceNumber`/`twilioSmsSenderId`/`twilioMessagingServiceSid` columns are consumed by `getTelecomIdentity` — saving them changes live call/sms identity, which is the point.
   - **3 AI (BYOK)** — ElevenLabs key (existing `userProfile.elevenKeyEnc`, already consumed by `src/lib/tts-quota.ts:65-77`) + optional OpenAI-compatible LLM key + base URL (new `llmKeyEnc`/`llmBaseUrl`). Wire consumption in `src/lib/llm.ts`: a `resolveLlmCredentials(userId)` that prefers the profile's stored key/baseUrl over the env chain (Groq → LiteLLM → Gemini), threaded into `draftAgentReply` as optional credentials. Unit-test the precedence.
   - **4 Compliance & documents** — embed `<DocumentsSection />` from T3 + a PDPL acknowledgement checkbox (data residency note: Supabase/Database in-region).
   - **5 Webhooks** — vendor webhook URL (`assertVendorUrlSaveable`, existing) + secret (write-only) + **"Send test webhook"** → new `POST /api/console/webhooks/test`: sign a sample envelope (HMAC-SHA256 + timestamp, mirroring the outbox signing) and POST with `AbortSignal.timeout(3000)`; return `{ ok, status, ms, error? }`. "Finish" → `completeSetup`.
5. **Tests:** `tests/console/setup.test.ts` — strict-schema rejection of unknown fields; step mapping writes the right columns; no-org 409; secrets never in GET; E.164/sender-ID/URL validation; test-webhook timeout path (stubbed fetch).

---

### T5 — Polish: Lottie loading (#19, D5) + seeded playable recordings (#13, D6)

1. `bun add lottie-react`. Hand-author minimal valid Lottie JSON in `public/lottie/`: `sonar.json` (3 expanding rings) and `bars.json` (5 equalizer bars) — `v: "5.7.4"`, shape layers only, ~2–4 KB each, `fr: 30`.
2. `src/components/fx/LottieIcon.tsx`: **dynamic `import()` of lottie-react** (keeps it out of the initial bundle), fetch `animationData` from the JSON path, and on any error render the existing CSS spinner (`sv-pulse-ring`/`animate-spin`) so a missing asset can never blank a screen.
3. Replace spinners: Settings loading state (`src/views/Settings.tsx:187-190`), Console `!isLoaded` (`src/views/Console.tsx:467-473`), the Demo busy indicator, and the `LoadingScreen` center emblem (`src/components/shell/LoadingScreen.tsx:56-58`) → `<LottieIcon name="sonar" />`, keeping the existing progress bar and step copy.
4. **Recordings** — new `scripts/seed-demo-audio.mjs`: for the first 5 `CASES` in `scripts/seed-demo.mjs` (SV-8642…SV-8638), synthesize a short 3–4 line demo call (agent disclosure/verification line + customer denial + closure line) with `@elevenlabs/elevenlabs-js` (already a dependency; per-language voices mirroring `TTS_VOICE` in `src/lib/voice-client.ts`), write `public/demo-audio/{ref}.mp3`. If `ELEVENLABS_API_KEY` is unset or a call fails: warn, write nothing, leave `recordingUrl` null. Idempotent (skip existing files). Add `bun run db:seed:audio` to package.json scripts.
5. **Data + UI:** add `recordingUrl: string | null` to `RecentCall` (`src/lib/data.ts:6-16`) and set it for the 5 seeded refs (null elsewhere). Add a "Recording" column to the dashboard table (`src/views/Dashboard.tsx:327-359`, before CSAT) with `src/components/dashboard/RecordingPlayer.tsx` (one active `<audio>` at a time; Play/Pause toggle; resets on `ended`; `null` → a muted "sealed" chip with `title` explaining 30-day retention). Keep the existing "mock data" chip honest.

## API surface added (summary)

| Route | Method | Guard | Purpose |
|---|---|---|---|
| `/api/console/setup` | GET/POST | operator + org | Wizard progress, per-step save |
| `/api/console/documents` | GET/POST | operator + org | List / upload (PDF ≤ 8 MB) |
| `/api/console/documents/[id]` | DELETE | operator + org | Delete doc + vectors |
| `/api/console/documents/[id]/retry` | POST | operator + org | Re-run vectorization |
| `/api/console/documents/test` | POST | operator + org | Semantic test search |
| `/api/console/webhooks/test` | POST | operator + org | Signed 3s-timeout test delivery |
| queue kind `doc.vectorize` | POST (QStash) | Upstash signature | Background vectorization |

Changed: `deductCredit`/`refundCredit` gain optional `orgId`; `getProfile()` returns the effective wallet; `/api/console/me` + settings GET return it.

## Env / ops

- No strictly new env vars. Optional: nothing — Pinecone/QStash/ElevenLabs keys already exist in `.env.example`. Document in `.env.example` comments: documents show FAILED (`pinecone_not_configured`) without `PINECONE_API_KEY` + `PINECONE_INDEX`; the audio seed needs `ELEVENLABS_API_KEY` once.
- IaC (#49) already exists (`docker-compose.yml` + realtime + workers) — nothing to add; the sovereign-deployment story stands as-is.
- Out of scope: the two VPS ops already queued in `docs/POST-LAUNCH-TODO.md` (domain swap, operator account provisioning) — deployment steps, not code.
- Doc touch-ups: `docs/SURFACE.md` (new setup view + Knowledge tab + recording column) and `docs/POST-LAUNCH-TODO.md` (full-duplex voice follow-up).

## Risks & mitigations

- **Pinecone unconfigured on the demo host** → every document ends FAILED. Mitigation: the status pipeline + reason + Retry is itself the demo of the machinery; SURFACE.md states the keys required for READY.
- **unpdf under Bun/Next standalone** → verify early with a fixture PDF in `tests/fixtures/`; fallback `pdf-parse`.
- **lottie-react bundle weight** → dynamic import + CSS fallback.
- **Org wallet changes billing semantics** → mirrors the existing `UserProfile.credits` pattern (atomic conditional claim, audited); `UsageLedger` remains the enterprise-billing record; billing tests updated in T4.
- **Next 16 API drift** (`after()`, multipart, `NextRequest`) → read `node_modules/next/dist/docs/` first (AGENTS.md).
- **Judge-flow coupling**: wallet + seed + OrgSwitcher changes must land together (T4) or the org-switch → 0-credit modal script breaks.

## Validation

1. `bun run db:migrate` (new migration) → `bun run db:seed` → `bun run db:seed:audio` when a key exists.
2. `bun run verify` (format:check, lint, `tsc --noEmit`, auth:cutover, unit/integration/e2e suites, realtime tests, build). Add the new tests listed per task; update `tests/billing/*` + `tests/console/fire.test.ts`.
3. **Manual judge walkthrough (the Part-1 script):**
   - Landing page (signed out): headphones on → "Talk to the agent" → speak "that transaction is not mine" → ASR ms + turn ms chips render, neural voice replies, guardrail chips show intent `deny_fraud`.
   - "See how a bank uses this" → one-click demo login (env `NEXT_PUBLIC_DEMO_LOGIN_*`) → Command Center shows 🟡 Demo Mode, wallet **10,000**, seeded interventions + playable recordings in the dashboard.
   - OrgSwitcher → "Operator Desk" → wallet **0** → Fire → **Contact Sales modal** (not a raw error) → BYOK path mention → Settings.
   - Settings → run setup wizard: 5 steps save with validation errors shown inline; secrets never re-displayed; "Send test webhook" returns a status.
   - Knowledge tab: upload a real policy PDF → watch Pending → Chunking → Embedding → Ready → ask a question in Test Knowledge Base → a scored chunk is retrieved (org-scoped).
   - Cross-checks: analyst/non-operator session hits `/api/console/documents` and `/api/console/setup` → 403; cross-org document id → 404; two concurrent fires on a 1-credit org → exactly one 202 and one 402.
