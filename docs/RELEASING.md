# Releasing SecureVoice AI

The **git tag is the version authority.** `package.json`'s `version` is kept in
step with it, and CI refuses to publish a tag that disagrees — so a mismatched
release fails loudly instead of shipping a mislabelled image.

## One-time setup

The release workflow publishes to GitHub Container Registry as a package linked to
this repo. Enable it once:

**Settings → Packages → Permissions → Add GitHub Actions** (or, for an org, grant
the `Actions` role to the workflow's `GITHUB_TOKEN`).

`GITHUB_TOKEN` is already granted `contents: write` and `packages: write` by the
workflow itself — no PAT to create.

## Cutting a release

```bash
bun run verify                 # the same gates CI runs; do this first
bun run version:bump 0.3.0     # rewrites package.json
git commit -am "chore: release v0.3.0"
git tag v0.3.0
git push origin main --follow-tags
```

Pushing the tag triggers `.github/workflows/release.yml`, which:

1. Rejects the tag if `package.json` says something else.
2. Logs into GHCR and builds the `runner` target, pushing `:<tag>` and `:latest`
   with SBOM and provenance attestations.
3. Smoke-tests **the image it just published** — not a locally rebuilt copy —
   through Caddy over TLS.
4. Creates the GitHub release from the commit body.

Then verify:

```bash
gh release view v0.3.0
docker pull ghcr.io/BROCKUGANDA/SecureVoice-AI:0.3.0
```

`bun run version:bump` refuses to move to a version that is not strictly greater,
so a re-tag or a typo cannot quietly republish an older number.

## What CI gates

`bun run verify` is the local equivalent of the `verify` job:

| Gate                 | Command                                                  | Catches                                                        |
| -------------------- | -------------------------------------------------------- | -------------------------------------------------------------- |
| Lint                 | `bun run lint`                                           | unused vars, bad hooks, `require` in ESM                       |
| Typecheck (app)      | `bunx tsc --noEmit -p tsconfig.json`                     | cross-file type drift                                          |
| Typecheck (realtime) | `cd mini-services/realtime && bunx tsc -p tsconfig.json` | errors the root project deliberately excludes                  |
| Realtime tests       | `cd mini-services/realtime && bun test`                  | 48 cases over grants, channels, ingest signatures, live socket |
| Build                | `bun run build`                                          | Next compile + standalone packaging                            |
| Proxy config         | `caddy validate` on both Caddyfiles                      | a proxy typo that only shows at deploy time                    |
| Compose parse        | `docker compose config`                                  | invalid service graph                                          |

The realtime service has its **own** job in CI because it is a separate package
with its own dependencies and `tsconfig` — the root `tsc` deliberately excludes
`mini-services`, so without that job its type errors would only ever appear on a
deploy host.

## Smoke tests on a real stack

`compose-smoke` builds and starts the whole topology, then asserts the things that
are easy to break silently:

- `https://localhost/api/health` returns 200 **through Caddy** — the real ingress.
- The SPA is served.
- `/realtime/?EIO=4&transport=polling` answers — the socket route is wired to the
  realtime service, proven without a signing secret or a browser.
- `docker compose ps realtime` shows **no host binding**. If someone publishes
  `:4000`, the edge rate-limit trust model in `src/proxy.ts` quietly breaks, so
  this is asserted rather than assumed.

## Deploying a release

```bash
SITE_ADDRESS=voice.example.com \
ACME_EMAIL=you@example.com \
REALTIME_INGEST_SECRET="$(openssl rand -base64 32)" \
  docker compose up -d
```

Caddy is the only published service. `app` and `realtime` stay on the internal
network — which is what lets `src/proxy.ts` trust `X-Forwarded-For` only when the
request carries the marker Caddy sets.

`REALTIME_INGEST_SECRET` is optional: without it the realtime service refuses
every connection and the console falls back to SSE. Nothing breaks.

## Versioning policy

`0.x` is pre-1.0: minor bumps may carry breaking changes to the compose topology
or environment-variable names. The audit chain's on-disk format and the signed
bank-webhook contract are the two things treated as stable — changing either needs
a `1.0.0` and a migration note in the release body.
