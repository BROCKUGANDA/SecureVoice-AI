# Paddle sandbox — end-to-end verification

The tests in `tests/billing/paddle.test.ts` prove signature verification, the
price map and the event decoding. They do **not** prove Paddle accepts our
transaction payload, because nothing has been through the real gateway.

This is the sequence that closes that gap. Every step is read-only or
sandbox-only until step 6, which takes a real (sandbox) charge.

## Prerequisites

```bash
# 1 — the catalog must exist
bun run paddle:seed      # prints pro_/pri_ ids
bun run paddle:verify    # reads them back and shows the amounts

# 2 — .env
PADDLE_API_KEY="pdl_sdbx_..."
PADDLE_WEBHOOK_SECRET="pdl_notif_..."     # from Dashboard > Notifications > Webhooks
PAYMENT_PROVIDER="paddle"
PADDLE_PRICES='{"usd_1000_month":"pri_..."}'
```

The webhook secret is the **notification secret**, not the API key. Confusing
them makes every webhook arrive as `digest_mismatch`, which looks exactly like
an attacker.

## 1 — start the app

```bash
docker compose up --build app db-setup db redis
# or, without Docker:
bun run db:push && bun run db:seed && bun run dev
```

`GET /api/health` → 200. `GET /api/status` should not show a billing error.

## 2 — the negative path first

With `PAYMENT_PROVIDER` **unset**:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:3000/api/billing/checkout \
  -H 'content-type: application/json' \
  -H 'cookie: <a signed-in session>' \
  -d '{"amountMinor":1000,"currency":"USD"}'
```

Expect **503**, not 400. A 400 would tell a customer their request was wrong.

## 3 — an amount with no configured price

With the gateway bound but `PADDLE_PRICES='{}'`:

```bash
curl -s -X POST localhost:3000/api/billing/checkout -H 'content-type: application/json' \
  -H 'cookie: <session>' -d '{"amountMinor":777,"currency":"USD"}'
```

Expect `502` with `checkout_failed`, and a server-side log line naming the
missing key (`usd_777_month or usd_777_year`). The **client must not** see the
price key — the route deliberately redacts it.

## 4 — a real sandbox checkout

```bash
curl -s -X POST localhost:3000/api/billing/checkout -H 'content-type: application/json' \
  -H 'cookie: <session>' -d '{"amountMinor":1000,"currency":"USD"}'
```

Expect `{ "url": "https://checkout-service-sandbox.paddle.com/...", "reference":
"org_<orgId>_<purpose>_<ULID>", "provider": "paddle" }`.

Open the URL in a browser. The price shown should be **$10.00**, not $1000 — the
minor-unit conversion is the single most common Paddle bug.

**What this proves:** our transaction payload is accepted by Paddle. Nothing
before this step does.

## 5 — pay it

Paddle sandbox test card (Dashboard > Developer tools > Test transactions):

```
4242 4242 4242 4242   future expiry   any CVC   any ZIP
```

Use a card that completes. Keep the browser open.

## 6 — the webhook, which is the only thing that credits

Configure the webhook destination **before** paying:

```
Dashboard > Notifications > Webhooks
  Destination: https://<your-tunnel-host>/api/billing/webhook
```

Locally, use a tunnel — the route must be reachable from the internet:

```bash
ngrok http 3000      # or cloudflared, or the paddle webhook simulator
```

Paddle retries with backoff, so a missed delivery usually arrives on its own —
but a delivery that returns 2xx is never retried, which is why step 8 matters.

On a successful sandbox charge, the log should show:

```
[billing-webhook] settled { applied: true, duplicate: false, units: 10000 }
```

Then check the database:

```sql
SELECT provider, reference, "amountMinor", currency, status, "verifiedBy"
  FROM "PaymentRecord" ORDER BY "createdAt" DESC LIMIT 1;

SELECT kind, units, reason, "balanceAfter"
  FROM "UsageLedger" ORDER BY "id" DESC LIMIT 3;
```

`PaymentRecord.provider` must be `paddle`, `status` `success`, `verifiedBy`
`gateway`. `UsageLedger` must show one `topup` row of `10000` units — the amount
in **minor units**, per `settlePayment`'s `unitsCredited = money.amountMinor`.

## 7 — replay the same webhook

Resend the identical signed payload from step 6 (Paddle's dashboard can re-send,
or curl the same body with the same `Paddle-Signature`).

Expect `applied: false, duplicate: true`, and **no second** `UsageLedger` row.
This is the idempotency guarantee, and it is the reason `settlePayment` exists —
Paddle retries by default.

## 8 — the negative webhook cases

| Case                                                           | Expected                                                       |
| -------------------------------------------------------------- | -------------------------------------------------------------- |
| No `Paddle-Signature` header                                   | 400 `missing_signature`                                        |
| `Paddle-Signature: garbage`                                    | 400 `malformed_signature`                                      |
| Valid header, wrong body                                       | 400 `digest_mismatch`                                          |
| Valid header, body signed **without** the `ts:` prefix         | 400 `digest_mismatch`                                          |
| Correct signature, `ts` more than 300s stale                   | 400 `digest_mismatch` (the replay guard fires before the HMAC) |
| Correct signature, event type `subscription.updated`           | 400 `unsupported_event`                                        |
| Correct signature, `custom_data.reference` from another tenant | 400 `unsupported_event`                                        |

Every one of these is covered by a unit test **and** should be re-checked
through the real HTTP layer, because a framework that parses the body before the
signature check will break all of them at once while the unit tests stay green.

**The re-serialisation trap.** If every signature fails but the body looks
correct, something parsed and re-stringified it. The route reads `req.text()`
once and never re-serialises — but any `bodyParser` middleware or a logging
plugin that touches the body will break it. Check that first.

## 9 — a refund

Refunds need the Paddle transaction id, which settlement stored on the
entitlement envelope:

```sql
SELECT "entitlementsJson" FROM "PaymentRecord" ORDER BY "createdAt" DESC LIMIT 1;
```

It should contain `{"key":"paddle_transaction","metadata":{"paddleTransactionId":"txn_..."}}`.

`paddleTransactionIdFor(reference)` reads it back. With it missing, `refund()`
returns `missing_paddle_transaction_id` — a refusal, not a silent no-op.

## What is NOT verified by any of this

- **Production.** Sandbox and live catalogs are separate; `pri_` ids do not
  cross over. Anything verified here must be re-verified against live.
- **`chargeStoredAuthorization`.** Deliberately unimplemented. Paddle has no
  stored card auth, so `overage.ts` cannot run against it. It must return
  `stored_authorization_unsupported_by_paddle` and a caller must handle that.
- **Tax.** Paddle collects and remits sales tax as Merchant of Record, so a
  transaction's `unit_price` is gross. `settlePayment` credits `money.amountMinor`
  — the gross figure — as units. Whether a GBP buyer should be credited
  GBP-minor units or a USD-normalised figure is an open decision.
- **Regional prices.** The catalog has GBP/EUR/AUD overrides; they are unseen by
  the browser checkout until a buyer is actually in that country. Verify one per
  currency with a test account.
