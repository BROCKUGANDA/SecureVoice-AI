# Session ledger — 2026-10-10 (late afternoon)

Continues `2026-10-10-seo-aeo-favicon-lottie.md`. That session's work is now
committed (`0f33f21`). This session committed `b43ecbc`.

## Task

1. Commit the previous session's work.
2. `NEXT_PUBLIC_SITE_URL still needs setting in production`.
3. Install the Paddle MCP servers (3) and the Paddle skills.
4. "add more routes to the urls for the different pages".
5. Migrate Paystack → Paddle (user's answer when offered the choice).

Items 1–4 are DONE. Item 5 is NOT STARTED — see "Not done" below.

## Decisions taken (user chose both)

- Routes: **public views only**. `/docs`, `/security`, `/usecases` added alongside
  the existing legal trio. The authenticated views (`demo`, `dashboard`,
  `product`, `console`, `settings`, `deck`, `setup`) were offered and declined —
  there is no `/console` URL and that absence is the second of two layers
  protecting the Command Center; a route would delete it.
- Paddle: **migrate Paystack → Paddle** (not "just plan it").

## Done

### Committed `0f33f21` — previous session

Lottie removed, icon set generated, metadata/SEO/AEO, four legal routes.
46 files, +2671/-1112. Staged per-path so the concurrent writer's uncommitted
`Dockerfile`, `docker-compose.yml`, `Dockerfile.caddy`,
`mini-services/realtime/Dockerfile`, `evidence/*` stayed out of the diff.

### Committed `b43ecbc` — this session

**Three routes.** `/docs` is the consequential one: the API surface (endpoints,
request/response shapes, webhook events, the signing scheme) was in no served
HTML document at all. `/security` is what a procurement review asks for by name.
Each renders the same view component the in-app panel does.

**A test that says no authenticated view is indexable.** `surface.test.ts`
parses `VIEW_ACCESS` out of `store.ts` with a regex rather than hardcoding the
list, so a new non-public view is covered the day it is added. Includes a
sanity assertion that the regex actually matched, so it cannot pass vacuously
against an empty list.

**PublicPageLayout + standalone-context.** The legal shell was renamed
(`LegalPageLayout` → `PublicPageLayout`) and now serves all seven routes. It
publishes a `standalone` flag via context so a view can swap in-app buttons for
real anchors. The context lives in a SEPARATE client module
(`standalone-context.tsx`) because the layout is a Server Component — declaring
`"use client"` on it would push the whole shell across the boundary for one
boolean. Turbopack fails the build on `createContext` in an RSC, which is how
this was found.

**A bug I introduced and fixed.** First cut: UseCases demo CTA → `/#demo`, with
a hash handler in `page.tsx` calling `launchDemo()`. **The page rendered blank.**
Measured, not predicted: `demo` is `user` access, so a signed-out visitor gets
bounced to `auth`, and `home → demo → auth` during mount leaves AnimatePresence
with two views stacked and the entering one at opacity 0.

Fix: the CTA is `/#live-demo` (the browser-mic widget on the home page, which
needs no sign-in at all — `id="live-demo"` added to that section), and the hash
handler is restricted to `public` views. `/#demo` is explicitly ignored with the
reason recorded inline so nobody re-adds it.

Note the first version's comment claimed `launchDemo()` avoided the RBAC
bounce. It does not — `launchDemo` sets `view: "demo"`, which RBAC then
redirects. The comment was wrong and was corrected.

**NEXT_PUBLIC_SITE_URL — the actual bug.** Setting it in the VPS `.env` would
have done nothing. `NEXT_PUBLIC_*` is inlined by the Next compiler at BUILD time;
`environment:` applies at runtime, long after the value is frozen into the
bundle. Production would have kept serving a sitemap and a canonical tag pointing
at `http://localhost:3000` — worse than unset, because it is actively wrong and
crawlers cache it.

Fix: `ARG NEXT_PUBLIC_SITE_URL` in the Dockerfile + a build arg in compose,
defaulting to `https://${SITE_ADDRESS:-localhost}`. A deployment that already
sets `SITE_ADDRESS` for TLS now cannot forget this one.

**Paddle MCP servers** added to `~/.config/opencode/opencode.json` (`paddle-sandbox`,
`paddle-live`, `paddle-docs`), all `type: remote`, all `enabled: false` pending
the user's auth. Backup at `opencode.json.bak-paddle`. JSON validated.

**Paddle skills** installed via `npx -y skills add https://developer.paddle.com/`
→ `.agents/skills/` (10 skills). `.agents/` is gitignored (line 129), so they are
local agent tooling, not repo content.

## Tests

- `tests/e2e/public-routes.test.ts` asserted "every named AI crawler is denied at
  the root" — the old blanket deny that `0f33f21` deliberately reverses. Caught by
  the full suite run. Rewritten as two tests; the new one is STRONGER than what it
  replaced: search crawlers must be allowed on the seven indexable pages AND
  denied on every NO_INDEX prefix plus `/api/console/audit`, `/api/enroll`,
  `/api/webhooks/receiver`.
- `surface.test.ts`: 82 pass / 0 fail.
- Full suite: **22 failures, 21 of them pre-existing/environmental.**
  - 14 WP-19 — `DriverAdapterError: ColumnNotFound` (10×). The local DB schema is
    behind the Prisma client. Nothing in this work touches `dial_job`.
  - documents ×3, console fire ×1, WP-2 load ×1, evidence artifact ×1,
    flag-gating ×1 — all in the ledger's pre-existing list.
  - 2× `/api/metrics` timeouts in public-routes, unrelated to any change.

## Not done — the Paddle migration

**NOT STARTED.** `src/lib/payments/` has zero Paddle references; the gateway is
`paystack.ts` (25 kB) behind the `PaymentProvider` port in `provider.ts`, whose
header states the intent explicitly: "A new gateway is a new adapter file and
zero changes to callers — which is the point of the port."

Research is still owed before writing an adapter. A background analyst
subagent was launched to map it and FAILED ("Insufficient account funds"), so
nothing was gathered. What is known:

- `src/lib/payments/provider.ts` — the port: `Money` (integer minor units,
  `assertMoney` at the boundary), `CheckoutRequest/Session`, `ChargeRequest/Result`,
  `ProviderEvent`, `WebhookVerification`/`WebhookRejection`, `RefundRequest/Result`,
  `StoredEntitlement`.
- `paystack.ts` implements it; `overage.ts` and `manual-invoice.ts` sit alongside.
- `PaymentRecord` and `UsageLedger` Prisma models hold the persisted state.
- Open question to answer first: whether anything outside `src/lib/payments/*`
  imports a gateway type directly. The port's header claims not; the claim was
  never verified and it is the thing that decides how big the migration is.
- The pricing page copy states settlement in KES via Paystack
  (`SETTLEMENT` in `src/lib/commercial.ts`, and the FAQ in the same file). Paddle
  is a merchant-of-record with different tax, currency and settlement semantics,
  so those strings change too — they are consumed by BOTH the pricing page and
  the schema.org JSON-LD, which is exactly the drift the single-source module
  exists to prevent.

## Next steps

1. **Paddle migration** (above) — the outstanding item from this session.
2. Authenticate the three Paddle MCP servers in opencode and flip `enabled: true`
   as each is confirmed working.
3. Push `0f33f21` and `b43ecbc` to `dev`.
4. Confirm the $490 / $1,490 figures against the signed rate card — carried
   forward unchanged from the original home-page block into `commercial.ts`.
5. `bun run db:push` locally to clear the 14 WP-19 `ColumnNotFound` failures —
   environmental, not code.

## Still uncommitted (the concurrent writer's)

`Dockerfile.caddy`, `mini-services/realtime/Dockerfile`, and nine `evidence/*`
artifacts regenerated by the full-suite run. Note `Dockerfile` and
`docker-compose.yml` were staged in `b43ecbc` because the SITE_URL build-arg fix
required them; the writer's non-root hardening in the same files rode along in
that diff.
