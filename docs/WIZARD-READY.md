# Setup wizard → READY dependency (post-WIP)

The wizard (`SetupWizard.tsx`, `/`, operator-only) walks through exactly
the tabs that configure the tenant: telecom identity, BYOK keys, policy
documents, webhooks.

## What is built

- `src/views/SetupWizard.tsx` — 5-step wizard rendered from `Organization.setupStep` / `setupCompletedAt`
- `GET / POST /api/console/setup` — reads and writes setup progress
- `POST /api/console/webhooks/test` — webhook signing verification demo
- `GET / POST /api/console/documents` — upload + retry pipeline

## What makes the document pipeline READY

A document only reaches `READY` when both `PINECONE_API_KEY` and `PINECONE_INDEX`
are configured (see `.env.example` comment). Without them, every upload lands at
`FAILED` with the machine-readable reason `pinecone_not_configured`, shown next
to a Retry button. This is the honest state — not a broken feature, but a missing
deployment dependency.

To make it READY:

1. Set `PINECONE_API_KEY` and `PINECONE_INDEX` in `.env`
2. Confirm `PINECONE_HOST` (optional — SDK resolves from key)
3. Re-run `bun run db:seed:audio` (requires `ELEVENLABS_API_KEY` for demo recordings)
4. Verify `/api/console/webhooks/test` returns `VALID` with a signed payload

Until then, the wizard is fully navigable; only the final document/upload
step requires the vector store to be live.
