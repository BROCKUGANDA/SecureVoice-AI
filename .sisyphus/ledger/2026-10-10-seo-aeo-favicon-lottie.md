# Session ledger — 2026-10-10 (afternoon)

## Task

Four asks, in the user's words: has the runtime been updated; remove the Lottie
loading animations ("its fucking everything up"); add the favicon back ("where is
my favicon"); and find the metadata / SEO / AEO — with an explicit
publication checklist (product description, pricing page, deliverables, Terms +
Refund + Privacy reachable via navigation, legal entity named in the T&C, live
HTTPS, enterprise pricing sheet).

Context recovered from `.sisyphus/ledger/2026-10-10-security-rules-latency.md`:
SecureVoice AI, real-time voice fraud-intervention platform for UAE banks,
operated by SecureVoice Technologies FZ-LLC. `src/app/page.tsx` is a single-page
app with NO URL routing — every view is a client-side `view` state. That
architectural fact drove most of the decisions below.

## What was done

### 1. Lottie removed

- DELETED `src/components/fx/LottieIcon.tsx`, `public/lottie/sonar.json`,
  `public/lottie/bars.json`.
- NEW `src/components/fx/LoadingIndicator.tsx` — three CSS rings, zero JS, zero
  network, and **no `"use client"` boundary** (the old one required one).
- NEW `.sv-loading-rings` in `globals.css`. The stagger rides on a custom
  property because `::after` declares its own `animation` shorthand, so an
  inline `animation-delay` on the host cannot reach it. Added to the
  `prefers-reduced-motion` block.
- Swapped 4 call sites: `SetupWizard`, `Settings`, `Console`, `LoadingScreen`.
- `lottie-react` removed from package.json; `bun.lock` regenerated. Only delta
  was lottie-react + lottie-web.
- Docs: `SURFACE.md` loading-states entry rewritten, `SCOPE-TRIAGE.md` row fixed.

Why it went, beyond "it was heavy": its CSS fallback was already what users saw
whenever the dynamic import or the asset fetch lost the race, it had four
separate ways to silently not appear, and `LoadingScreen` covers the viewport on
boot so anything it fetched competed with first paint.

### 2. Favicon restored — the real gap was the icon SET

The site had exactly two SVGs (`src/app/icon.svg`, `public/logo.svg`) and
nothing else. That is not a favicon set: Safari and iOS do not render SVG
favicons, and Windows asks for `/favicon.ico` unprompted. Both failures are
silent — a blank tab, not a console error, which is why it looked like "the
favicon disappeared" rather than "the favicon was never complete".

- NEW `scripts/build-icons.mjs` (`bun run icons`), rasterising `public/logo.svg`
  with sharp so there is one source of truth, plus a hand-assembled multi-frame
  ICO (sharp writes no ICO and there is no encoder in the tree).
- Emits `src/app/favicon.ico` (16/32/48), `src/app/apple-icon.png` (180, opaque
  — iOS tints and rejects alpha), `public/icon-192.png`, `icon-512.png`,
  `icon-maskable-512.png` (padded to the launcher's safe zone), and
  `public/og-image.png` (1200x630 social card, composed as SVG then rasterised).
- `metadata.icons` in layout.tsx now declares the whole set; `site.webmanifest`
  now points at real rasters instead of SVG with `sizes: "any"`.
- Verified on a running production server: `/favicon.ico` → 200 `image/x-icon`
  3637 bytes; `/apple-icon.png`, `/icon.svg`, `/icon-192.png`, `/og-image.png`,
  `/site.webmanifest` all 200.

### 3. Metadata / SEO

Full rewrite of the `metadata` export in `src/app/layout.tsx`: `metadataBase`,
`title.default` + `template`, `description` with the price, `applicationName`,
`authors`/`creator`/`publisher` set to the **legal name** (not the brand),
`category`, a full keyword set, the icon set, `manifest`, `robots`, canonical,
complete OpenGraph incl. a real 1200×630 image, and a `twitter: summary_large_image`
card — which Twitter/X reads from its own tags, not OG.

- NEW `src/lib/site-origin.ts` — ONE origin resolver, previously duplicated in
  `robots.ts` and `sitemap.ts` and held together by a test. layout.tsx needed it
  too; a third copy was the obvious outcome. Both route files re-export it under
  the name the surface test already imports.
- `NEXT_PUBLIC_SITE_URL` documented in `.env.example` as the value to set — it
  was flagged in code comments as "the one config gap" and was never filled in.

### 4. AEO — the actual work

- NEW `src/lib/commercial.ts`: plans, FAQ (7 Q&A), company identity, settlement.
  Single source for THREE renderers.
- NEW `src/components/seo/JsonLd.tsx`: schema.org graph — Organization →
  WebSite → SoftwareApplication (+ one `Offer` per tier) → FAQPage → WebPage,
  cross-linked by `@id`, rendered server-side in the root layout's `<head>`.
  Enterprise emits an Offer with **no price**: a placeholder publishes a fact.
  `<`, `>`, `&` escaped so the script element cannot be closed early
  (`JSON.stringify` does not escape `<`).
- **robots.txt policy reversed, deliberately.** It denied GPTBot, ClaudeBot,
  PerplexityBot and Google-Extended outright, justified as protecting
  `/api/console/*`. It protected nothing — `/api/` was already disallowed for
  every crawler in the general rule — while making the pricing, FAQ and JSON-LD
  uncitable. Now: search/answer indexers allowed (with the same path disallows),
  training-only crawlers denied. Flagged to the user as a posture change.
- **Real routes, per the user's choice.** `/pricing`, `/terms`, `/privacy`,
  `/refund` each got `src/app/<name>/page.tsx` with their own `metadata`, all
  statically prerendered, rendering the SAME view component the in-app panel does
  so the two cannot drift. Allowlisted in `src/proxy.ts`, listed in
  `sitemap.ts`.
- NEW `src/views/Pricing.tsx`: 3 tiers, what's included on every plan, the
  KES/Paystack settlement note, an enterprise pricing sheet, a feature
  comparison table, the FAQ, closing CTA.
- NEW `Refund` policy in `src/views/Legal.tsx` (EN + MSA) — the site had Terms
  and Privacy and **no refund policy at all**.
- `Footer.tsx` legal column is now real `<a href>` anchors (plus a new LEGAL &
  PRICING column). `Home.tsx` and `Security.tsx` privacy links likewise.
- `LegalShell`'s cross-links became anchors showing all three documents; they
  were `setView` buttons, which are inert on a standalone route.
- NEW `src/components/shell/LegalPageLayout.tsx` — deliberately does NOT reuse
  the app Navbar/Footer, because those drive the SPA via `setView` and would
  render as dead controls on a standalone route.

### 5. Stale "the site is broken" comments corrected

- `Caddyfile` claimed TLS was "NOT WIRED YET" because Cloudflare's orange cloud
  blocks ACME HTTP-01. Measured live 2026-10-10: all three hostnames serve HTTPS
  with a verifying cert, `http://` 308s, and `Via: 1.1 Caddy` shows the zone is
  DNS-only so Cloudflare is not in the path. Replaced with the measurement and
  with the two paths if the zone ever goes back behind the proxy. Left as-is it
  would have invited someone to "fix" working TLS by mounting an Origin CA cert,
  which is a startup-time change to the edge serving every hostname.
- `SURFACE.md`: the robots.txt 500 conflict and the unlinked manifest were both
  recorded as open; both are closed and the text now says so.

## Verification

| Check                        | Result                                                     |
| ---------------------------- | ---------------------------------------------------------- |
| `bunx tsc --noEmit`          | clean                                                       |
| `bun run lint`               | **0 errors** (108 pre-existing warnings)                   |
| `bun run format:check`       | clean for every file touched                                |
| `bun run build`              | green; 4 new routes prerendered as static                  |
| `bun run test:jest`          | 67/67                                                        |
| `tests/surface/surface.test.ts` | 78 pass / 0 fail (3 pre-existing assertions were RED and updated — they asserted the gaps this work closes) |
| `tests/unit/commercial-consistency.test.ts` | 15/15 (new)                                    |
| Live server (`PORT=3111`)    | all 11 asset + route paths 200; JSON-LD parsed: 5 nodes, 3 offers (Enterprise price-less), 7 FAQ Q&A, `legalName` correct |
| Live TLS                     | `https://securevoiceai.me` 200 cert verifies; `http://` 308; `www.` 200 |

## Facts corrected along the way

- The FAQ and the Pro tier originally claimed **ten** languages. `SUPPORTED_LANGS`
  in `src/lib/languages.ts` is six: `en, ar, hi, ur, fr, sw`. Corrected. This is
  exactly the kind of thing that ends up quoted by an answer engine.

## Tests

Updated (asserted gaps this work closes):
- `tests/surface/surface.test.ts` — allowlist contents, sitemap entry count,
  training-vs-search crawler split, manifest link, favicon set on disk, manifest
  icons are rasters, `dangerouslySetInnerHTML` allowlist now includes
  `JsonLd.tsx`, plus a new test pinning the `<` escaping.
- `tests-jest/Home.test.tsx` — the privacy link test inverted from
  "button swaps view state" to "anchor points at `/privacy`". Note this suite
  does NOT load jest-dom, so `toHaveAttribute`/`toBeInTheDocument` do not exist.

New: `tests/unit/commercial-consistency.test.ts` (15 tests) — price parity
between the card and the graph, no hardcoded price in the graph, no placeholder
price, EN/AR list index alignment, no latin fragments in Arabic FAQ answers.

## Next steps

1. `bun run test` full suite — was still running at session end; jest, surface,
   the new unit file and tsc are all green.
2. **Set `NEXT_PUBLIC_SITE_URL=https://securevoiceai.me` in production env.**
   Everything else derives a usable origin from `SITE_ADDRESS`, but the explicit
   value is the correct one and is a one-line change.
3. **Decide the robots.txt posture change is what you want.** Allowing
   `OAI-SearchBot` / `ChatGPT-User` / `PerplexityBot` / `ClaudeBot` while denying
   `GPTBot` / `Google-Extended` is a judgement call about being quotable vs.
   being training material. It is reversible by deleting one array in
   `src/app/robots.ts`.
4. The prices ($490 / $1,490 / custom) came from the existing home-page pricing
   block and were carried into `src/lib/commercial.ts` unchanged. **Confirm they
   match the signed rate card before this ships.**
5. `COMPANY.sameAs` is empty on purpose. Populate it from profiles that actually
   exist; a wrong URL there is a structured-data lie.
6. `public/security.txt` still routes disclosures to a placeholder address — noted
   in SURFACE.md, not touched.

## Not committed

Nothing has been committed or pushed. The tree also carries the repo owner's
uncommitted work (`Dockerfile`, `Dockerfile.caddy`, `docker-compose.yml`,
`mini-services/realtime/Dockerfile`, `src/lib/telemetry/store.ts`,
`.github/actionlint.yaml`, and the files they left unformatted). Formatting was
applied per-file, never repo-wide, to avoid sweeping their changes into a diff.