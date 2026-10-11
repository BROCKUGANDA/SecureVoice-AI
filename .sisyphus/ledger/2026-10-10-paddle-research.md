# Session ledger — 2026-10-10 (evening, Paddle)

Continues `2026-10-10-routes-paddle-mcp.md`. Nothing was committed this session.

## Task

1. Create a product catalog in the user's Paddle **sandbox** account.
2. Start the Paddle adapter research.

**Neither completed.** Research is done (below). Catalog creation is BLOCKED on
two things the user must resolve.

## BLOCKER 1 — the API key does not authenticate

`pdl_[REDACTED]`

`GET https://sandbox-api.paddle.com/products` → **HTTP 403, empty body**.
Tested both with and without the trailing `.` from the paste — 403 either way.
Network is fine (a real HTTP response came back from Paddle, not a timeout), so
the key is being rejected by Paddle itself.

Read-only GETs only. Nothing was created, nothing was mutated.

Also: the key is now in plaintext in a chat transcript. It is a sandbox key so
the blast radius is small, but it should be rotated once setup completes.

## BLOCKER 2 — the requested pricing contradicts the product

| User asked for | This product actually sells |
| --------------- | --------------------------- |
| Starter $10/mo, $100/yr | Starter **$490**/mo |
| Pro $40/mo, $400/yr      | Pro **$1,490**/mo |
| Advanced $120/mo, $1200/yr | **Enterprise** — "Custom", no published price |

~50x discrepancy, and "Advanced" is not a plan that exists. The message also said
"using the pricing and pricing model we already have", which contradicts the
numbers in the same message. Source of truth is `src/lib/commercial.ts` (PLANS),
which is also what the schema.org JSON-LD reads — so whichever numbers win, they
must be changed in ONE place.

## RESEARCH — the Paddle migration is not a swap

The single most important finding: **there is no payment HTTP surface at all.**

- Zero route handlers under `src/app/api/**` reference payments, billing,
  paystack, paddle, checkout or subscription. Verified by filename filter AND by
  content grep.
- `PaymentProvider` (`src/lib/payments/provider.ts`) is implemented and
  unit-tested (`tests/billing/billing.test.ts`) but **never called from a route**.
- `src/lib/ports/registry.ts` records `paystack` under `notBound`: "implemented
  and unit-tested against an injected HTTP client, but the BOUND adapter is
  manualinvoice — the only money adapter exercisable with no gateway and no
  credential".
- `TopUpDialog` — the only customer-facing payment UI — is a **`mailto:` link** to
  the support address. There is no checkout.

So "migrate Paystack → Paddle" is actually: write an adapter AND build the entire
billing HTTP surface that does not exist yet (checkout route, webhook route,
replace the mailto top-up). Estimated well beyond "add one adapter file".

### The port contracts a Paddle adapter must satisfy (`provider.ts`)

`Money` is INTEGER MINOR UNITS, ISO-4217, validated by `assertMoney` at the port
boundary so a float can never enter a `PaymentRecord`. `settlePayment` is the
only writer of a successful `PaymentRecord` and the only bridge from money to
prepaid units; three independent guards make a replayed webhook a no-op
(UNIQUE `reference`, conditional `UPDATE ... WHERE status IN ('pending','failed')`,
ledger top-up idempotent on the gateway event id). The payment row and the
ledger credit commit in ONE transaction.

Credits are denominated in minor units: `unitsCredited = money.amountMinor + sum(entitlement.units)`.

### Paddle-specific problems identified

1. **`chargeStoredAuthorization` may be unimplementable.** This port member backs
   computed overage (`src/lib/payments/overage.ts`). Paddle Billing has NO
   equivalent of a stored card authorization you can charge later — MoR billing
   with no vault-equivalent. This is the port member most likely to force a
   design change rather than an implementation.
2. **MoR changes what "money" means.** `amountMinor` becomes gross-of-tax rather
   than net, and settlement currency is Paddle's, not KES. Anything downstream
   that assumes the charged amount is the amount received needs review.
3. **Webhook signature maps cleanly.** Paddle's `Paddle-Signature`
   (`ts=...;h1=...`, HMAC-SHA256 over `ts:body`) fits the existing
   `WebhookRejection` union (`missing_signature | malformed_signature |
   digest_mismatch | malformed_body | unsupported_event`) almost exactly. This is
   the easy half.
4. **`reference` has no native home.** `CheckoutSession.reference` is OURS to
   generate. Paddle transactions carry `custom_data`, which is where it would go.
   The `accessCode` field also has no Paddle analogue.
5. **The schema already anticipated it.** `PaymentRecord.provider` is commented
   `manualinvoice | paystack | flutterwave | paddle`.

## The attached pasted-context guide is wrong for this codebase

It is generic AI boilerplate. Following it would break things:

| Guide says | This repo has |
|------------|---------------|
| "Next.js + Supabase stack" | Prisma + PostgreSQL (`provider = "postgresql"`, no Supabase client) |
| `supabase.from('organizations')` | `db.organization` (Prisma) |
| `ALTER TABLE organizations ADD COLUMN paddle_customer_id` | Prisma `Organization` model, camelCase; migrations are additive-by-policy under `prisma/migrations/` |
| `credits_balance INTEGER` mutated directly | `UsageLedger` + `src/lib/billing/ledger.ts`, append-only `topup/reserve/consume/release/refund` with signed weights |
| `newBalance = credits_balance + 7000` | exactly the mutation the ledger design forbids |
| `paddle.webhooks.parseEvent(rawBody, signature, secret)` | **deprecated Paddle Billing API**; current is `paddle.webhooks.unmarshal(rawBody, secret, { signatureHeader })` |
| `$499/mo Growth plan` | $490 / $1,490 / Enterprise-custom |
| `/api/worker-trigger-call` | does not exist |
| `session.session.activeOrganizationId` | CORRECT — that one matches Better Auth |

## Next steps

1. Get a working sandbox API key, or authenticate the `paddle-sandbox` MCP
   server (added earlier, `enabled: false`) and I can drive the catalog through
   MCP instead of raw HTTP.
2. Resolve the pricing conflict.
3. Then, and only then: the adapter. Start with `verifyWebhook` (easy, maps to the
   existing union) and `refund`, and settle the `chargeStoredAuthorization`
   question before writing code, because it may change the port.
