# Public surface

What a crawler, an AI trainer and a browser can reach, what they must not, and
which of those claims are measured rather than asserted.

Evidence: `evidence/surface/surface.json`. Gate: `bun test tests/surface`.

---

## The thing to understand first

**There is no `/console` URL in this application.**

`src/app/page.tsx` renders every view — home, product, use cases, docs,
security, privacy, terms, deck, auth, demo, dashboard, console, settings — from
a single client-side `view` state held in `src/lib/store.ts`. There is no
`usePathname`, no `router.push` and no `history.pushState` anywhere in the tree.

Three consequences run through this entire document:

1. **The console cannot be de-indexed by path.** There is no path to exclude. It
   is protected by Clerk gating the data, and by never handing a crawler a URL
   that resolves to it.
2. **There are exactly two HTML routes in the tree:** `/` and `/inspector`.
   `/inspector` is a webhook signature-verification debug tool, so `/` is the
   only indexable page.
3. **A sitemap listing `/console`, `/docs` or `/pricing` would be inventing URLs
   that 404.** The marketing, docs and legal views are panels inside `/`.

The authenticated half of the product is still there — it is just not a route.

---

## Middleware lives in `src/proxy.ts`, not `src/middleware.ts`

Next.js 16 renamed the `middleware` file convention to `proxy` and deprecated
it; only one proxy file is supported per project. Creating
`src/middleware.ts` would have produced a second, dead edge layer.

Verified against the bundled docs, not from memory:
`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/middleware.md`
("deprecated, renamed to proxy.js") and `.../proxy.md` ("While only one
`proxy.ts` file is supported per project").

The pre-existing `src/proxy.ts` also states this in its own header comment, and
`next.config.ts` refers to it as "Proxy". So the brief's instruction to extend
rather than duplicate the existing edge layer is satisfied by extending
`src/proxy.ts`. **No `src/middleware.ts` was created.**

---

## Indexing

### `X-Robots-Tag`

Set in `src/proxy.ts`, path-scoped, with an allowlist so a route added later is
noindex by default:

| Path | Header |
| --- | --- |
| `/`, `/sitemap.xml` | *absent* — indexable |
| `/api/*`, `/v1/*`, `/inspector`, `/__clerk/*` | `noindex, nofollow` |
| anything else | `noindex, nofollow` (fail-closed) |

Absence rather than `index, follow` on the marketing page is deliberate: if the
header ever disagreed with `src/app/sitemap.ts`, the disagreement would be
invisible in a diff.

`nofollow` is paired with `noindex` because those responses carry the audit
chain, DB latency and heap size — following links out of them would let a
crawler walk from a leaked internal URL to the rest of the site.

Verified live against `next dev`:

```
GET /              -> X-Robots-Tag: (absent)
GET /sitemap.xml   -> X-Robots-Tag: (absent)
GET /api/status    -> X-Robots-Tag: noindex, nofollow   (401)
GET /v1/status     -> X-Robots-Tag: noindex, nofollow   (401)
GET /api/metrics   -> X-Robots-Tag: noindex, nofollow   (200)
GET /inspector     -> X-Robots-Tag: noindex, nofollow   (200)
```

### `robots.txt` — BLOCKING CONFLICT

`src/app/robots.ts` generates the policy: `Allow: /` with `Disallow:` on
`/api/`, `/v1/`, `/inspector`, `/__clerk/`, `/_next/`; `Disallow: /` for
GPTBot, ClaudeBot, PerplexityBot and Google-Extended; and an absolute
`Sitemap:` line.

**It is currently not servable.** `public/robots.txt` already serves that path,
and Next.js refuses to resolve a path owned by both:

```
GET /robots.txt -> HTTP 500
"A conflicting public file and page file was found for path /robots.txt"
```

**Fix: delete `public/robots.txt`.** Its content is fully superseded. It was not
deleted here because it is outside this work package's granted file scope.

This also retires a false claim. The legacy file opened with *"The app and api
hosts override this with X-Robots-Tag: noindex headers"* — but no such header
existed anywhere in the repository. The file disallowed nothing app-scoped:
`Allow: /` plus four AI-crawler blocks. A crawler obeying it exactly was
welcome to walk `/api/*`. The header is real now.

Blast radius while unresolved: one dead URL. The crawl policy is independently
enforced by `X-Robots-Tag` on every response, so the console and API surface
stay closed. No data exposure.

### `sitemap.xml`

`src/app/sitemap.ts` declares exactly one URL — `/` — with `lastModified` pinned
to build time. A metadata route is cached by default, so `new Date()` would be
frozen at first evaluation while looking dynamic.

Origin resolution: `NEXT_PUBLIC_SITE_URL` → `SITE_ADDRESS` promoted to `https://`
→ `http://localhost:3000`. **This is the one config gap**: `NEXT_PUBLIC_SITE_URL`
is not in `.env.example`, so production currently falls back to `SITE_ADDRESS`,
which works but is a derived guess. Add it to `.env.example`.

Verified live: `GET /sitemap.xml` → 200, one `<loc>`, no `/console`, no `/api`.

---

## Security headers

### Observed on a running server

Measured with `GET http://localhost:3111/` against `next dev`:

| Header | Value |
| --- | --- |
| `Content-Security-Policy` | full policy, includes `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`, `form-action 'self'` |
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains; preload` |
| `X-Frame-Options` | `DENY` |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Cross-Origin-Opener-Policy` | `same-origin` |
| `Cross-Origin-Resource-Policy` | `same-origin` |
| `Permissions-Policy` | `camera=(), geolocation=(), payment=(), usb=(), midi=(), serial=(), hid=(), display-capture=(), microphone=(self)` |

`frame-ancestors 'none'` is present twice over — in the CSP and as
`X-Frame-Options: DENY` — and `Caddyfile` repeats HSTS, nosniff, X-Frame-Options
and Referrer-Policy at the edge, so a response stays hardened even if the app
behind the proxy is swapped out.

### CSP: what was verified and what was not

**The CSP already existed in `next.config.ts`. It was deliberately not
re-declared.** A second, divergent CSP from `src/proxy.ts` would be strictly
worse than none, and could not be merged with the existing one.

Verified — the directive is present on the wire:

`default-src 'self'`, `script-src 'self' 'unsafe-inline'` (plus `'unsafe-eval'`
in development only, correctly gated on `NODE_ENV`), `style-src 'self'
'unsafe-inline'`, `img-src`, `font-src`, `media-src`, `connect-src`,
`worker-src`, `frame-src`, `frame-ancestors 'none'`, `base-uri 'self'`,
`form-action 'self'`, `object-src 'none'`.

**Not verified** — needs a browser and a signed-in session, not a text edit:

- That `connect-src` actually covers every origin a live session reaches. The
  response was fetched unauthenticated, so no browser attempted any connection.
- That `style-src 'unsafe-inline'` is still required. Asserted from the source
  comment attributing it to framer-motion and Tailwind; not reproduced.
- That `script-src 'unsafe-inline'` is still required. In a production build
  Next normally hashes or nonces these; that substitution was **not observed**,
  because the build could not complete (see below).
- `frame-src` for Clerk component iframes — no authenticated Clerk session was
  available to trigger one.
- HSTS `preload` — the header is emitted with `preload`, but no token has been
  submitted to any browser vendor.

The honest summary: the policy is **declared and emitted**; it has not been
**proven not to break Clerk, next/font, or the websocket**. Do that in a browser
before a demo, not in this document.

### Permissions-Policy

Per-path, computed in `src/proxy.ts`:

- Denied on every path: `camera=()`, `geolocation=()`, `payment=()`, `usb=()`,
  `midi=()`, `serial=()`, `hid=()`, `display-capture=()`.
- `microphone=(self)` **only** on `MICROPHONE_ALLOWLIST`; `microphone=()`
  everywhere else.

Verified live: `/api/status` and `/inspector` both returned `microphone=()`.

**The caveat, stated plainly: the allowlist contains `/`, and it has to.**

`navigator.mediaDevices.getUserMedia` is called in exactly two places —
`src/views/Demo.tsx` and `src/lib/voice-client.ts`. Both are reachable from the
`demo` view, which `src/app/page.tsx` renders at path `/`. Denying the
microphone on `/` is denying it to the entire demo, which is the one thing this
app exists to show. So "microphone only on the widget route" is not currently
achievable: **there is no separate widget route.**

The policy is still written as an allowlist rather than a blanket
`microphone=(self)` because that is the shape that survives the obvious next
refactor. When the demo is split out to `/widget`, deleting `"/"` from
`MICROPHONE_ALLOWLIST` is the whole change, and until then `/api/*`, `/v1/*` and
every other path are provably denied.

### Header precedence — measured, not assumed

`src/proxy.ts` and `next.config.ts` both set `Permissions-Policy`. Which wins
was checked on a running server:

```
GET /            -> Permissions-Policy: camera=(), geolocation=(), payment=(), usb=(),
                    midi=(), serial=(), hid=(), display-capture=(), microphone=(self)
GET /api/status  -> Permissions-Policy: ... microphone=()
```

The header appears **once**, carrying the proxy's value. The proxy's response
header **replaces** the one from `headers()`; it does not append, and the two do
not intersect. So `src/proxy.ts` is the authoritative definition on every path
it matches, and next.config's global `microphone=(self)` is dead there.

An earlier draft of the proxy comment claimed the headers would intersect. That
was wrong, and it was corrected after measuring.

For completeness: `/site.webmanifest` bypasses the proxy entirely (the matcher
excludes that extension), so it carries next.config's header and no
`X-Robots-Tag`. Harmless — it is a static asset.

---

## Web app manifest

`public/site.webmanifest` parses and declares `name`, `short_name`, `description`,
`start_url`, `scope`, `display`, `orientation`, `theme_color`,
`background_color`, `lang`, `dir`, `categories` and `icons`. Verified served:
`GET /site.webmanifest` → 200, parses.

Two real bugs fixed:

- **Every install icon 404'd.** The manifest declared `/favicon-192.png` and
  `/favicon-512.png`. Neither file has ever existed in `public/` — only
  `logo.svg` does. Both entries now point at `/logo.svg` with `sizes: "any"` and
  `type: "image/svg+xml"`, plus a `maskable` purpose. A test now asserts every
  declared icon resolves on disk.
- **Two different dark greens.** `theme_color` was `#07100D`; the root layout's
  `viewport.themeColor` is `#0D1512`. Aligned, and asserted against
  `src/app/layout.tsx` by regex so they cannot drift again.

### HIGH: the manifest is never fetched by any browser

Next only auto-links a manifest placed in the `app/` root or named via
`metadata.manifest`. `src/app/layout.tsx` sets neither, so the file is served
and nothing references it.

**Fix: add `manifest: "/site.webmanifest"` to the `metadata` export in
`src/app/layout.tsx`.** Not done here — that file is outside this work
package's scope. A test asserts the gap so it cannot be forgotten.

---

## `security.txt`

`public/security.txt` exists per RFC 9116 but its `Contact:` is
`security@example.com` — **a placeholder**. There is no monitored mailbox wired
up in this repo. A `security.txt` routing a disclosure to a black hole is a
false promise of a working channel, which is worse than the file being absent.

Fill in a real contact before this deployment is public. A test asserts the
placeholder so it cannot ship unnoticed.

---

## Build status — honest

`bun run build` **exits 1**, for reasons outside this work package:

```
src/app/api/status/spans/route.ts(49,44): TS2322
src/lib/telemetry/slo.ts(332,13): TS2304 Cannot find name 'SpanRecorderDiagnostics'
src/lib/telemetry/slo.ts(345,42): TS2304 Cannot find name 'INDUSTRY_BASELINE'
```

Both paths are **untracked** in git (`?? src/app/api/status/spans/`,
`?? src/lib/telemetry/`) — created by other agents during this session.
`next.config.ts` sets `typescript.ignoreBuildErrors: false`, so they abort the
build.

This package does not break the build, on four independent pieces of evidence:

1. `bunx tsc --noEmit` reports exactly those 3 errors and none in `src/proxy.ts`,
   `src/app/robots.ts`, `src/app/sitemap.ts` or the test file. tsc reports every
   error it finds, so a clean result for these files is conclusive.
2. The Turbopack compilation stage ran and emitted no error for any file in this
   package; the only warnings were dynamic-filesystem-access warnings from
   `src/lib/telemetry/store.ts`.
3. Every route was exercised on a running `next dev`: `/`, `/api/status`,
   `/v1/status`, `/inspector`, `/api/metrics`, `/sitemap.xml` and
   `/site.webmanifest` all resolved. `/robots.txt` resolved to a 500
   attributable to the public-file collision and nothing else.
4. `bunx tsc --noEmit -p tests/tsconfig.json` reports one error in `src/proxy.ts`
   at line 106, inside `resolveLanguage()` — pre-existing untouched code that
   only surfaces under that project's stricter `noUncheckedIndexedAccess`.

**The build was not run to completion.** Re-run `bun run build` once the
concurrent work lands.

---

## Test results

```
bun test tests/surface
 67 pass, 0 fail, 5 skip (72 tests, 143 assertions)

SURFACE_BASE_URL=http://localhost:3111 bun test tests/surface
 71 pass, 1 fail, 156 assertions
```

The 5 skips are the live-deployment block, skipped when `SURFACE_BASE_URL` is
unset. **A skip is not a pass** — do not read a green unit run as proof the CSP
shipped.

The single live failure is `robots.txt is served and agree on the origin`, which
is the collision above being caught. That is the check working.

The `X-Robots-Tag` and `Permissions-Policy` assertions invoke the **real
exported proxy** with real `NextRequest` objects and read the headers back, so
they are genuine end-to-end assertions through the function Next runs — not a
reimplementation. The `next.config.ts` headers are asserted against the config
source and, separately, confirmed on the wire by the live block.

---

## Before the demo

- [ ] **Delete `public/robots.txt`** — `/robots.txt` is a 500 until then.
- [ ] **Add `manifest: "/site.webmanifest"` to `src/app/layout.tsx`** — the
      manifest is currently fetched by nobody.
- [ ] **Add `NEXT_PUBLIC_SITE_URL` to `.env.example`** — the sitemap and
      robots.txt origin is currently derived from `SITE_ADDRESS`.
- [ ] **Replace the `security.txt` placeholder contact.**
- [ ] Open the app in a browser and confirm the CSP does not block Clerk, fonts
      or the websocket. This has not been proven.
- [ ] Re-run `bun run build` once the concurrent type errors are fixed.
- [ ] Re-run with `SURFACE_BASE_URL` against the real deployment so the live
      block is not skipped.