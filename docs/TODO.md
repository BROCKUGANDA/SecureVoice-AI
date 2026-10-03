# TODO — expansion notes

Working notes for the areas that are **deliberately not finished**. Each item says
what exists, what is missing, and what decision is still owed. Nothing here is
blocked on code; most of it is waiting on a commercial or legal answer.

Last updated: 2026-10-03.

---

## 1. Pricing model — overages and invoices

### What ships today

- `src/lib/payments/manual-invoice.ts` — the primary payment path for the actual
  business (UAE banks and exchange houses paying by bank transfer). Dual control:
  operator A records the transfer, operator B verifies it, and **A may never
  verify their own entry**. Deduped on the bank reference, so a double-typed
  transfer cannot be counted twice. Both steps append to the audit chain.
- `src/lib/payments/overage.ts` — **new**. Ranks a period's usage against the
  bundle allowance and raises an overage invoice.
  - `summariseOverage()` is read-only and safe to call from a quote screen, a
    scheduled job, or a test.
  - `raiseOverageInvoice()` is idempotent on a deterministic reference
    (`OVG-{org}-{from}_{to}`), so re-running the rater cannot bill a bank twice
    for one period.
  - An overage invoice carries **no entitlements** — it is a charge, so settling
    it must never credit wallet units.
  - Covered by `tests/billing/overage.test.ts` (11 tests).
- Pricing shape: an included allowance per commitment period, then a per-unit
  overage rated after the period closes. Usage inside the allowance is not billed
  per unit.

### The decision that is still owed

**The rate.** `OVERAGE_RATE_MINOR_PER_UNIT` is intentionally unset, and while it
is unset `raiseOverageInvoice()` **refuses** with `rate_not_configured` rather
than defaulting to zero or to a number from an old document.

This is a deliberate choice: billing a bank at an invented rate is a trust
failure that surfaces months later as a disputed invoice, whereas refusing is
visible immediately and costs one env var to fix.

Before this goes live we need:

- [ ] A real per-unit overage rate from the commercial conversation, not a guess.
- [ ] `INCLUDED_UNITS_PER_PERIOD` — what the bundle actually includes.
- [ ] `BILLING_CURRENCY` — defaults to `AED`; confirm.
- [ ] Whether the overage rate is per intervention, per dialled minute, or per
      attempt. **This matters more than the number**: a per-attempt rate on a
      failed call is a pricing argument a bank will raise in procurement.
- [ ] Carrier-level per-minute rates to complete `docs/UNIT-ECONOMICS.md`. These
      are still placeholders and must not be invented.

### Expansion, when there is time

- [ ] **Proration** for mid-period sign-up and cancellation.
- [ ] **Mid-period top-ups** — currently a topup is units, not money, so a bank
      that exhausts its bundle mid-campaign waits for the invoice.
- [ ] **Credits** — a negative invoice is currently clamped to zero rather than
      issued as a credit note. Deliberate: a credit note wearing a bill's clothes
      is worse than no document. Real refunds need their own flow.
- [ ] **Multi-currency** — `Money.currency` is already carried end to end, but
      there is no FX or rate-lock logic.
- [ ] **Dunning** — an overdue overage has no escalation path yet.
- [ ] **Usage export** — a bank will want a CSV of the units behind an invoice.
      `docs/UNIT-ECONOMICS.md` promises the artifact is the authority; the
      per-invoice export is the same idea one level down.
- [ ] **Gateway adapters** — `PaymentProvider` already has `createCheckout`,
      `chargeStoredAuthorization` and `verifyWebhook` seams, and the manual
      adapter returns explicit refusals for each. Paystack / Flutterwave / Paddle
      would slot in there. The card path is the reason
      `StoredAuthorization` exists; it is currently unused.

---

## 2. Payments and invoices — infrastructure

- [ ] **Gateway webhook signature verification is untested against a live
      gateway.** The seam refuses cleanly; nothing has ever called Paystack.
- [ ] **Refund flow is a status flip**, not a money movement. `refund()` sets
      `status = "refunded"` and does not credit units back. A real refund must
      also write a `UsageLedger` row or the wallet and the ledger disagree.
- [ ] **`settlePayment` is assumed atomic.** It does a conditional UPDATE and
      relies on a unique insert. It has not been raced under load.

---

## 3. Idempotency and concurrency

### Fixed in this pass

The intervention ingest had a genuine **TOCTOU race**: it read the idempotency
key, dialled, and only _then_ wrote the key in a `setImmediate`. Two requests with
the same `Idempotency-Key` arriving together both read "no stored response", both
executed `armAndDial`, and both placed a real call. The unique index on
`(scope, key, callerId)` did not prevent it — it rejected the second _row_, after
the call had already been placed, so it was deduplicating bookkeeping rather than
the side effect.

Now the key is **claimed atomically before any side effect**
(`INSERT ... ON CONFLICT ("scope","key","callerId") DO NOTHING RETURNING id`).
Exactly one concurrent requester proceeds; the loser gets a replay if the winner
finished, or an explicit `idempotent_request_in_flight` refusal. The claim is
released on every failure path, so a failed signal does not poison the key for
24 hours.

Proven by `tests/e2e/interventions-idempotency-race.test.ts`, which races two
identical requests at the real route. Verified by mutation: making the claim key
unique per request makes the test fail, so it genuinely detects the regression.

### Still open

- [ ] **The same read-then-write shape elsewhere.** The audit sweep covered the
      hot ingest path; other routes that read a dedupe key and act on it have
      not had the same treatment. Worth a deliberate pass.
- [ ] **`transaction_ref` is not unique.** A bank sending the same transaction
      under two different idempotency keys will be dialled twice. The policy
      gate should refuse a repeat rather than relying on the caller being
      correct.
- [ ] **In-flight refusals need a retry contract.** `idempotent_request_in_flight`
      is correct but the bank needs to know how long to wait and whether to
      retry. This belongs in the integration contract, not in a comment.
- [ ] **Claim TTL vs long operations.** The claim TTL is 24h. A dial that takes
      longer than that would allow a second execution.

---

## 4. Retry, dedup and failure behaviour

### Reviewed and found adequate

- **Dial queue** — `SKIP LOCKED`, lease expiry, bounded retries, dead-letter,
  replay, and the crash-window guard that completes a job instead of re-dialling
  when the case already carries a `conversation_id`. This is the double-call
  guard and it is the right one.
- **Outbox** — lease-based claiming, dead-letter, replay.
- **Idempotent replay** — returns the stored response with
  `X-Idempotent-Replay: true`.
- **Policy refusals return 409, never 5xx.** Correct: a consent or geography
  refusal is a decision, not an outage, and a bank that retries it re-dials a
  customer it was told not to contact.

### Fixed in this pass

The Docs status chip swallowed its fetch failure with `.catch(() => {})` and had
no timeout, so a failed request was **indistinguishable from loading** — the
skeleton stayed up forever. It now aborts after 5s, retries in 5s when degraded
(30s when healthy), and shows `status unavailable — retrying` instead of an
infinite placeholder. The dot greys out when a later poll fails, so it never shows
green next to stale data.

### Still open

- [ ] **No exponential backoff anywhere.** Retries are fixed-interval. A database
      blip gets hammered at a constant rate from every instance.
- [ ] **No circuit breaker on provider calls.** ElevenLabs and Twilio failures
      surface as errors; they do not trip an open circuit.
- [ ] **Dead-letter alerting.** The dead-letter table exists. Nothing pages when
      it fills.
- [ ] **`/api/meta` reported a version it could not know.** It read
      `process.env.npm_package_version`, which is an npm lifecycle variable and
      is undefined under `bun .next/standalone/server.js`. It fell back to a
      hardcoded `"0.2.1"` that happened to match `package.json` — correct today,
      silently stale after the next version bump. Now read from `package.json`.

---

## 5. Latency gates and the test database

`tests/e2e/dial.test.ts` currently **fails**: p95 signal→provider is ~5.8s
against a 1500ms target.

This is **not** a regression. Measured on the same database:

| Route version              | p95     |
| -------------------------- | ------- |
| With the idempotency claim | 5756 ms |
| Unmodified `HEAD`          | 6852 ms |

The cause is topology, not code. The test database is a remote Supabase instance
where a round trip is hundreds of milliseconds, and this path issues many
sequential queries. `tests/tools/guard.test.ts` was already made topology-aware
for exactly this reason; this gate has not had the same treatment.

- [ ] **Decide whether to make this gate topology-aware**, the way the tools
      guard is. Deliberately _not_ done unilaterally: relaxing a latency gate to
      make it pass is the kind of change that should be a human decision, and the
      honest alternative is to run this gate against a co-located database, which
      is what production actually is.
- [ ] The number above is from the shared test database, not from the deployed
      host. Re-measure on the box before quoting any latency figure to a bank.

---

## 6. Languages and the knowledge base

### Fixed in this pass

The Docs page claimed French and Bengali were roadmap items while **both were
wrong about French and right by accident about Bengali**:

- `SUPPORTED_LANGS` is `en, ar, hi, ur, fr, sw` — the sixth language is
  **Swahili**, fully wired (telephony voice, compliance script, demo persona).
- **Bengali exists nowhere in the codebase.** It appeared only as that Docs line.

A bank counting the languages on the page against the ones a customer hears is
exactly the kind of gap that ends a pilot. The page now lists the six that ship
and says plainly that Bengali is not among them.

Added the explanation that was missing: the agent knows which language to use
**before the call is placed** (resolved from the enrolled customer profile and
tenant routing rules, confirmed on the opening line, switched mid-call if the
customer answers in another language), and what it says comes from a knowledge
base the bank controls — either uploaded to the provider's KB, or resolved live
from the bank's internal systems.

### Still open

- [ ] **Per-language compliance scripts are not all reviewed by a native speaker.**
      Each script carries the recorded-call disclosure and the never-ask-for-a-PIN
      line in that language, enforced server-side. That wording should be
      reviewed per market before a live call.
- [ ] **Urdu and Hindi share a script but not a voice**; the register differs.
- [ ] **Dialect coverage.** Arabic is Gulf dialect. A Levantine or Egyptian
      caller is currently served Gulf phrasing.
- [ ] **The knowledge-base integration is described, not built.** Both paths in
      the new copy — uploaded documents and live internal-system resolution —
      need an implementation and a tenant-isolation test each.
- [ ] **Code-switching for financial terms** is claimed in the UI. Confirm it is
      wired in the agent prompt and not only in the demo script.

---

## 7. Platform polish

### Fixed in this pass

- Dialogs and top/bottom sheets had no height bound, so on a short viewport the
  footer scrolled out of reach and the only escape was the backdrop. Both are now
  capped at `calc(100dvh - 2rem)` with internal scroll. `dvh` rather than `vh`
  because mobile browsers collapse the URL bar.
- Checked and deliberately left alone: `Demo.tsx`'s `min-w-[680px]` phase
  stepper is inside an `overflow-x-auto` container, so it scrolls rather than
  breaking the page.

### Still open

- [ ] **No real responsive testing.** The viewport checks above were reasoned
      from the code, not exercised on a device. A pass on narrow viewports is
      still wanted.
- [ ] **Touch targets** were not audited. Several controls are `text-[12px]`
      with small hit areas, below the 44px comfortable minimum on mobile.
- [ ] **Modal focus management and escape** were not re-verified after the height
      change.
- [ ] **Tables** (`Dashboard.tsx`) use `max-w-[190px]` / `max-w-[340px]` cells.
      These were not checked at narrow widths.

---

## 8. Carried over from earlier passes

- [ ] **Dependabot**: `sharp` / libvips and `sharp` / libheif advisories still open.
- [ ] **`SECUREVOICE TECHNOLOGIES FZ-LLC`** must be verified or replaced before
      any bank uses it. This is a legal blocker, not a copy fix.
- [ ] **Clerk is still installed.** The Better Auth cutover has the schema,
      adapter and config in place; the packages, `ClerkProvider` surfaces, env
      vars and CSP entries have not been removed, and the mandatory
      cross-tenant isolation suite has not been re-run since the change. Do not
      remove Clerk before that suite passes — an unauthenticated route will not
      announce itself.
- [ ] **Full suite has not been run green end to end** since the test database
      was reset. Individual files pass; the aggregate has not been confirmed.
