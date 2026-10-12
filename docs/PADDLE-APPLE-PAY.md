# Apple Pay domain verification (Paddle)

Apple Pay only shows up on a domain that has completed **merchant ID domain
association**. For a Paddle merchant, that means serving Paddle's own association
file at exactly:

```
https://<your-domain>/.well-known/apple-developer-merchantid-domain-association
```

Without it, Apple Pay silently does not appear at checkout. On a bank's fraud
console that reads as "the payment options are broken" rather than "a config
file is missing", which is why it is worth verifying before a demo rather than
during one.

## What is already done in this repo

The route is implemented:

- `src/app/.well-known/apple-developer-merchantid-domain-association/route.ts`

It serves the file with `Content-Type: application/json` (Apple's verifier
rejects other content types even when the bytes are correct) and a short
`max-age` so Paddle picks up a reissued blob. When the file is absent it returns
a **404 with an explanatory body**, not a 500 — Apple's crawler and Paddle's
verifier both read the response, and a generic error tells neither of them what
is wrong.

## What you must do (I cannot)

The file's contents come from Paddle. I cannot generate, derive, or guess them —
they are a signed blob Apple issued to Paddle for your merchant ID.

1. **Paddle → My account → Settings → Website approval**
2. Download the Apple Pay domain association file
3. Put it at `src/app/.well-known/apple-developer-merchantid-domain-association`

### Deploying it (Docker)

The runner stage copies **only** `.next/standalone` (`Dockerfile:134`) — `public/`
is never copied into the image. A file committed under `public/.well-known/`
would therefore work locally and **404 in production**.

Three options, in order of preference:

| Approach                        | How                                                                                         | Trade-off                                                                 |
| ------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| **Docker volume (recommended)** | `docker-compose.yml` → `app.volumes: - ./apple-pay/association:/app/src/app/.well-known:ro` | No rebuild when Paddle reissues; keeps a Paddle-issued blob out of git    |
| **Bake it in**                  | Add the file before `docker compose build app`                                              | Simplest, but rebuilds on every reissue and risks committing it           |
| **Commit it**                   | Add the file to the repo                                                                    | Works, but it is a Paddle artefact in version control — prefer the volume |

Recommended compose snippet:

```yaml
app:
  volumes:
    - ./apple-pay/apple-developer-merchantid-domain-association:/app/src/app/.well-known/apple-developer-merchantid-domain-association:ro
```

Keep the local directory out of git:

```bash
echo "apple-pay/" >> .gitignore
```

## Verify

```bash
curl -i https://<your-domain>/.well-known/apple-developer-merchantid-domain-association
```

You want **HTTP 200** with `Content-Type: application/json`. A 404 with the
explanatory body means the file is not mounted — that is the route working
correctly and reporting a missing file, not a bug.

Then back in Paddle → Website approval, click **Confirm verification** next to
your domain.

## Related Paddle go-live steps

This file is one of several manual dashboard steps. Also confirm, per Paddle's
go-live checklist:

- **Default payment link** — must be a real domain (not localhost) that has
  passed domain verification. Checkout will 400 with
  `transaction_checkout_url_domain_is_not_approved` otherwise.
- **Notification destination** — the webhook your `/api/billing/webhook` serves.
- **Webhook signature verification** — already implemented; see
  `src/lib/payments/paddle.ts`.
- **Tax settings** — inclusive or exclusive of tax; drives what the pricing page
  should display.
