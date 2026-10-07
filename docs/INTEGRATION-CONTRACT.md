# Integration contract — connecting a bank's systems to SecureVoice

> **Everything an integration team needs, and nothing they do not.**
> Machine-readable forms of this document are served by the running deployment:
> `GET /openapi` (OpenAPI 3.1) and `GET /asyncapi` (AsyncAPI 3.0). Both are
> GENERATED from the code, so they cannot disagree with it; the gate that proves
> it is `bun test tests/contracts`.

---

## 0. Scope boundary — read this before anything else

This section is first because every expensive misunderstanding in a payments
integration starts by skipping it.

**SecureVoice sits DOWNSTREAM of your fraud engine.** It dials the customer to
verify a suspicious transaction and reports what happened. That is the whole
product.

Specifically, SecureVoice:

- **Does not terminate ISO 8583 or ISO 20022.** If your core banking speaks only
  those, this is not a replacement for your authorisation switch — it is _fed by_
  it. You POST a risk signal; you keep the rails, the ledger, the settlement, the
  scheme membership and the authorisation decision.
- **Does not approve or decline transactions.** A `202` means _accepted for a
  verification attempt_. It is not a decision, a recommendation, or a commitment.
  A staged card freeze is **staged**: it is reversible and a human fraud
  specialist finalises it. Nothing here moves money.
- **Carries no sub-100 ms authorisation SLA, and cannot.** The response you get
  back from the ingest is a queue acceptance. Before a carrier call exists, the
  platform has run a policy gate, an abuse gate, an admission-control decision
  and a durable enqueue. **Do not put a card authorisation on this path.** If you
  need a sub-100ms answer, that is your authorisation switch, and it must not
  depend on a voice call.
- **Never sees an account number, a balance, or account state** — in either
  direction. It does not need one to call someone, so it refuses one: the ingest
  schema is `.strict()` and an undeclared field is rejected rather than ignored.
- **Is an asynchronous verification channel, not a synchronous one.** Its unit of
  value is a completed conversation and a verdict in your case system minutes
  later. It does not reduce authorisation latency; it adds a channel you can act
  on while a case is open.

If any of that is the wrong shape for your programme, the honest answer is that
this is not the right component — and finding that out in week one is cheaper
than in month three.

---

## 1. The three integration tiers

Pick one. They differ in where the code runs and who provisions the tenant, not
in the contract: **all three speak the identical `/v1/interventions` and bank
webhook contract**, so moving up a tier is a deployment change and not an
integration rewrite.

|                                | **Tier 1 — Hosted**                       | **Tier 2 — Self-hosted**             | **Tier 3 — Embedded**                     |
| ------------------------------ | ----------------------------------------- | ------------------------------------ | ----------------------------------------- |
| Where the platform runs        | SecureVoice's deployment                  | Your VPC / Kubernetes / compose      | Your network, your egress, your telephony |
| Who provisions the org         | **A SecureVoice operator, today**         | Operator, once                       | Operator, once                            |
| Your fraud engine connects to  | `https://<deployment>/v1/interventions`   | Your internal URL                    | An internal URL, no public ingress at all |
| Bank events delivered to       | `https://your-bank.example/...`           | internal                             | internal; outbound egress allow-listed    |
| Database                       | Managed                                   | Yours                                | Yours, colocated with the app             |
| Voice provider key             | SecureVoice's                             | BYOK (your key, AES-256-GCM at rest) | BYOK                                      |
| Data residency                 | SecureVoice's region                      | Your region                          | Your region                               |
| Conformance checker            | `POST /v1/conformance/run`                | same                                 | same (or run it internally)               |
| Realistic time to first signal | **Half a day**                            | A day                                | Two to three days                         |
| Honest constraint              | No automated self-serve signup exists yet | You run the upgrades                 | You also own carrier relationships        |

**What is honest about Tier 1's provisioning row.** The multi-tenant groundwork
exists (org-scoped tables, per-team revocable producer keys, BYOK encryption, a
credits wallet) but the _signup → org → first producer key_ flow does not. Today
an operator with console access creates the org and hands you a key. That is a
product gap, tracked, and it is why Tier 1 says "half a day" and not "five
minutes". Do not plan a self-serve onboarding funnel on top of this until it
exists.

**Tier selection rule of thumb.** Tier 1 unless a data-residency or
network-isolation requirement forces Tier 2. Tier 3 only if you intend to own the
telephony relationship and the on-call burden as well.

---

## 2. The contract, in one page

### Inbound — your fraud engine to us

```
POST /v1/interventions
Idempotency-Key: <required, >= 8 chars, reuse on every retry>
SV-Signature: t={unix_seconds},v1={hmac_sha256(WEBHOOK_SECRET, "{t}.{rawBody}")}
Content-Type: application/json
```

Or `Authorization: Bearer svb_…` instead of the signature — a per-team,
org-scoped, revocable producer key. They are alternatives, not a pair.

```json
{
  "transaction_ref": "FRAUD-2026-08612",
  "risk_score": 0.94,
  "language": "ar",
  "phone": "+971501234567",
  "currency": "AED",
  "amount": 2500,
  "merchant": "Electronics World",
  "consent_record_id": "CN-2026-04-1183",
  "callback_url": "https://bank.example.com/hooks/securevoice",
  "org_id": "bank-core-uae"
}
```

Non-negotiable rules, each of which is enforced rather than documented:

| Rule                                                         | Why it is a rejection, not a warning                                                                                                                                                                                                                      |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `amount` is an **integer in minor units** (2500 = 25.00 AED) | A float here is a rounding bug that surfaces as a disputed amount months later.                                                                                                                                                                           |
| `phone` is **E.164** (`+971501234567`)                       | It is also the input to the geography control, so an un-routable number is refused before any carrier is contacted.                                                                                                                                       |
| `currency` is **ISO-4217 alphabetic**                        | Same reason.                                                                                                                                                                                                                                              |
| `consent_record_id` is **required**                          | Without a consent record we will not place a call. A customer who has opted out is refused with `409 policy_precondition` and is never dialled.                                                                                                           |
| **Unknown fields are rejected** (`422`)                      | Silently ignoring a field you believed was stored is how a customer gets no call and no error. This is also what makes "we never receive account numbers" enforceable rather than aspirational.                                                           |
| `Idempotency-Key` is **required and reused**                 | A replay returns the stored `202` with `duplicate: true` and the `X-Idempotent-Replay: true` header, and creates nothing. A fresh key per retry creates a second case and a second call — the single most common integration bug on this endpoint.        |
| `callback_url` is validated by **resolution, not pattern**   | HTTPS only, port 443, no credentials in the URL, and every address it resolves to must be public. Private, loopback, link-local and cloud-metadata targets are refused. A name that resolves into your VPC is the actual attack, and no regex catches it. |

### Responses

| Status                    | Meaning                                                                                       | `code`                   |
| ------------------------- | --------------------------------------------------------------------------------------------- | ------------------------ |
| `202`                     | Accepted and **queued**. `status: "queued"` or `status: "degraded_to_async"`.                 | —                        |
| `202` + `duplicate: true` | An idempotent replay of a key we already stored. Not an error.                                | —                        |
| `400`                     | Unparseable body, or missing/short `Idempotency-Key`.                                         | `malformed_request`      |
| `401`                     | No acceptable credential. Deliberately ONE code for a bad signature and a revoked key.        | `unauthenticated`        |
| `409`                     | Refused by policy: opt-out, country not allowed, cooldown, cap, spend ceiling, credits.       | `policy_precondition`    |
| `422`                     | Well-formed JSON that failed validation, or a `callback_url` the outbound-URL policy refused. | `semantically_invalid`   |
| `429`                     | Caller budget spent. Honours `Retry-After`.                                                   | `rate_limited`           |
| `503`                     | A dependency failed while the case was being armed. Honours `Retry-After`.                    | `dependency_unavailable` |

Errors use one envelope, with every field always present:

```json
{
  "code": "policy_precondition",
  "message": "The request was refused by policy. cooldown: destination in cooldown (300s)",
  "retryable": false,
  "requestId": "req_01HQ8Z7V3M9K2R4T6Y8W0X2B4D",
  "docsUrl": "https://securevoice.ai/docs/errors/policy_precondition"
}
```

`x-request-id` is also returned as a header, and is what you quote in a ticket.

**Branch on `code`, never on `message`.** `message` may embed a specific cause
(the policy-gate reason, an outbound-URL verdict) but it is sanitised and
length-capped, so it is advisory. Two consequences worth internalising:

- `retryable` in the envelope is fixed **per code**, so `policy_precondition` is
  always `false` — most policy refusals must never be retried. For the _transient_
  causes inside it (cooldown, concurrency caps, spend ceiling) a **delayed** retry
  is correct; the cause is named in `message` and the full table, with per-cause
  retryability, is `x-error-catalog` in `GET /openapi`.
- `429` and `503` carry `Retry-After`. Honour it and add jitter.

### Outbound — us to your receiver

```
POST https://<your receiver>
sv-signature: t={unix_seconds},v1={hex64}
content-type: application/json
```

```json
{
  "schema_version": "2026-10-01",
  "event_id": "9f1b7c2e-4a3d-4f6b-8c1a-2d3e4f5a6b7c",
  "event_type": "case.notified",
  "case_ref": "SV-F-7K2M9Q",
  "org_id": "bank-core-uae",
  "occurred_at": "2026-10-02T09:15:00.000Z",
  "data": {
    "state": "NOTIFIED",
    "outcome": "confirmed_legitimate",
    "duration_seconds": 84,
    "freeze_staged": false,
    "freeze_reference": null,
    "handoff_queued": false,
    "handoff_specialist": null,
    "tool_calls_observed": 2,
    "audit_ref": "SV-F-7K2M9Q",
    "resolution_method": "voice_call",
    "customer_response": null,
    "evidence": { "transcript": "withheld", "note": "…" }
  }
}
```

`resolution_method` and `customer_response` are **additive and optional**. `state`
is unchanged, so a receiver that ignores them behaves exactly as before — but note
the `data` object is declared strict in the OpenAPI document, so a receiver that
validates with `additionalProperties: false` must add both fields.

| `resolution_method`            | Meaning                                                                                                  |
| ------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `voice_call`                   | Resolved on the call. The verdict is in `outcome`.                                                       |
| `sms_reply_yes`                | Voice failed; the customer answered the fallback SMS **YES**.                                            |
| `sms_reply_no`                 | Voice failed; the customer answered **NO**. `handoff_queued` is `true`; nothing is frozen automatically. |
| `unreachable_no_reply`         | Voice failed, the SMS went out, and nobody answered within 24 hours.                                     |
| `voice_failed_sms_unavailable` | Voice failed and no SMS could be sent (opted out, SMS not configured, invalid number, provider error).   |

An SMS reply proves possession of the phone, **not identity** (SIM swap, a lost
handset, a family member). Treat `sms_reply_*` as evidence for your fraud team, not
as an authorisation. The fallback SMS itself carries no merchant and no amount, only
the last four digits you supply as `ref_last4`.

Your receiver's obligations, in the order they are most often got wrong:

1. **Read the raw body bytes and verify the signature before acting.** Verify
   against what arrived; never re-serialise.
2. **Dedupe on `event_id`.** Retries are routine, not exceptional.
3. **Return 2xx quickly, then do the work asynchronously.** We retry network
   errors, `408`, `429` and `5xx` on a six-step ladder spanning ~21 hours, then
   dead-letter the event for operator replay. Any other `4xx` stops the ladder.
   A slow 2xx is a **lost** event, not a delayed one.
4. **Reject malformed payloads and unknown `schema_version` values with a 4xx.**
   Acknowledging what you cannot process loses it silently.
5. **Ignore unknown `event_type` values.** Do not treat one as fatal.

There is **no ordering guarantee** — a case's events can arrive out of order
across retries. Key state on `event_id` and tolerate `occurred_at` regressing
relative to arrival order.

---

## 3. The signature scheme

```
SV-Signature: t={unix_seconds},v1={hex64}
v1 = HMAC_SHA256(secret, "{t}." + raw_request_bytes)
```

| Property                      | Value                                                                      |
| ----------------------------- | -------------------------------------------------------------------------- |
| Algorithm                     | `HMAC-SHA256`. Fixed — no negotiation, no downgrade.                       |
| Signed message                | The timestamp, a literal `.`, then the **exact raw bytes**.                |
| Inbound secret                | `WEBHOOK_SECRET`, shared out of band.                                      |
| Outbound secret               | `BANK_WEBHOOK_SECRET` — a **different** secret.                            |
| Replay window                 | 300 s, enforced in **both** directions. A future timestamp is refused too. |
| Comparison                    | Constant time on both sides.                                               |
| Header names accepted inbound | `SV-Signature`, `sv-signature`, `x-securevoice-signature`.                 |
| Alternative to the secret     | `Authorization: Bearer svb_…` — org-scoped, per-team, revocable.           |

**The one rule that causes every integration failure:** sign the exact bytes you
transmit. Parse the object, then serialise once, then sign that string and send
that string. Re-serialising a parsed object changes key order and number
formatting, and the digest will not match — which looks exactly like a rotated
secret and sends people looking in the wrong place for a week.

Reference implementations, all three verified to agree on the same delivery:

| Language         | File                                                   | For                                       |
| ---------------- | ------------------------------------------------------ | ----------------------------------------- |
| TypeScript / Bun | `scripts/verify_sv_signature.ts`                       | Node shops, including us                  |
| Python 3         | `scripts/verify_sv_signature.py`                       | Python shops                              |
| **Java**         | **`scripts/verify-signatures/SignatureVerifier.java`** | **Core-banking platforms — not optional** |

The Java file is the one to hand to a platform team: JDK-only with no
dependencies, embeds as a static `verify(byte[], String, String)`, and documents
the servlet filter that captures raw bytes before anything parses them — which is
where the Java-specific version of the bug above actually lives.

---

## 4. Data minimisation

This is the list a bank's privacy review asks for, stated as a contract.

**What we accept:**

| Field                            | Note                                                                                                                                       |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `transaction_ref`                | Your own opaque reference. Not an account number.                                                                                          |
| `risk_score`                     | 0–1. Used for queue triage, never as a decision.                                                                                           |
| `language`, `currency`, `amount` | BCP-47 / ISO-4217 / integer minor units.                                                                                                   |
| `phone`                          | E.164. Required to place the call; returned to you only **redacted**.                                                                      |
| `merchant`                       | Sanitised before it becomes a spoken dynamic variable.                                                                                     |
| `consent_record_id`              | The legal basis for outbound contact.                                                                                                      |
| `signal_kind`                    | Optional: `card_transaction`, `claim_payout`, `policy_change`, `account_takeover`. Insurers use the claim / policy kinds.                  |
| `ref_last4`                      | Optional: exactly four digits of a card, policy or account reference. Lets the customer recognise the fallback SMS. Never a longer number. |
| `org_id`, `callback_url`         | Tenancy and delivery routing.                                                                                                              |

**What we never send you:**

- Account numbers, IBANs, card PANs or track data
- Balances, available credit, or any account state
- The counterparty's bank account or any settlement detail
- Transcript content — verbatim or redacted
- Recordings or recording URLs
- Date of birth, address, email, document numbers, or any other customer PII
- The webhook secret or any signing material
- The unmasked destination number (only a redacted form is echoed)

**What we never accept either**, because the schema is `.strict()` and an
undeclared field is a `422`: the same categories, inbound. We do not need an
account number to telephone somebody, so accepting one would only create a
breach surface.

Evidence is **pull-based**: an event carries `audit_ref` and a `transcript:
"withheld"` pointer, and the redacted transcript plus the signed audit chain are
retrievable through the signed case export. The push side carries the verdict;
the pull side carries the evidence.

---

## 5. Versioning policy

The envelope carries `schema_version`, currently `2026-10-01`.

**Within a version** — no field is removed, renamed, or retyped. New _optional_
fields may appear, so:

- **Receivers must ignore unknown fields in an EVENT.** (The opposite rule
  applies to the ingest request, where unknown fields are rejected. Asymmetry is
  deliberate: a sender adding a field must not break your parser, while a producer
  sending a field we do not declare must not have it silently dropped.)
- New _optional_ request fields may appear; a new **required** request field is a
  breaking change and takes a new version.

**A breaking change** requires a new `schema_version`, published in `GET /openapi`
alongside a migration note, with the old version served for a stated overlap
period. We will not change a field's meaning in place.

**Endpoints are versioned by path.** `/v1/…` is stable; a `/v2/…` would be a new
namespace, not a second version of the same path.

**Retired endpoints get a 410, not a redirect and not a 404.** The retired
`POST /api/interventions` answers `410 endpoint_retired` with the successor path
and an itemised list of behavioural changes, so a producer can migrate
deliberately. It arms nothing and will never arm anything again.

**One known documentation gap, stated rather than hidden.** `docs/INTEGRATION.md`
still documents the retired endpoint (a nested `signal.{...}` body, an
`amountAed` float, and an event list this codebase does not emit). **This
document and `GET /openapi` are authoritative.** `docs/INTEGRATION.md` was written
before the ingest moved and was out of this work package's editing scope.

---

## 6. Connectivity and runbook

### Network requirements

| Direction | Destination                                                                                   | Purpose                                   |
| --------- | --------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Inbound   | Your fraud engine → our `443`                                                                 | `POST /v1/interventions`                  |
| Outbound  | our deployment → your receiver `443`                                                          | Signed bank events                        |
| Outbound  | our deployment → `api.elevenlabs.io:443`                                                      | Voice agent (BYOK in Tiers 2–3)           |
| Outbound  | our deployment → `api.twilio.com:443`                                                         | Carrier signalling and media              |
| (none)    | — staff sign-in is same-origin at `/api/auth/*`; the retired Clerk egress is no longer opened | Identity needs NO outbound egress         |
| Outbound  | our deployment → `api.paystack.co:443`                                                        | Credits wallet, if you self-serve top-ups |

Self-hosted topology: Caddy is the **only** published port; the app and realtime
services are reachable only on the internal network. That is what lets the
platform trust `X-Forwarded-For` — it believes the header only when a known
reverse proxy set it, so a caller hitting the origin directly cannot forge its
own rate-limit key. Do not publish the app port directly. If you must for local
work, the edge layer collapses to one shared rate-limit bucket and the
forwarded-IP trust is gone.

### Health and diagnosis

| Check                           | Use                                                                                                                         |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/health`               | Liveness.                                                                                                                   |
| `GET /api/readyz`               | Readiness — includes the database.                                                                                          |
| `GET /api/status`               | Operator-only: heap, DB latency, telephony mode, queue depth. Not for a bank's dashboard; it is authenticated and no-index. |
| `GET /openapi`, `GET /asyncapi` | This contract, machine-readable.                                                                                            |
| `POST /v1/conformance/run`      | Grade your receiver. See §7.                                                                                                |

### When something looks wrong

| Symptom                                       | Likely cause                                                         | First move                                                                                                        |
| --------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `401 unauthenticated` on every signal         | Clock skew, or re-serialising the body                               | Verify NTP; sign the exact transmitted bytes                                                                      |
| `422 semantically_invalid` you cannot explain | An undeclared field — usually `account_number` or a nested object    | Read `message`; it names the field                                                                                |
| `409 policy_precondition`                     | Consent, geography, cooldown, cap, spend ceiling, credits            | Read `message` for the cause; `x-error-catalog` has per-cause retryability                                        |
| `202 degraded_to_async`                       | Voice channel shed under load; the case degraded to SMS/app push     | Nothing — the case is accepted and auditable. Have an asynchronous step for the cases you cannot lose.            |
| Bank event never arrives                      | Your receiver answered outside the retryable set, or answered slowly | `408`, `429`, `5xx` and network errors retry for ~21 h; anything else stops the ladder. Slow 2xx is a lost event. |
| Duplicate bank events                         | Normal. Retries reuse `event_id` with a byte-identical body.         | Dedupe on `event_id`.                                                                                             |

**Quote these three, in this order, when you raise anything:** the `requestId`
from the error body (or the `x-request-id` header), the `caseRef` from the `202`,
and the `event_id` from a bank event. Together they resolve to the audit record
in one step. Nothing else is needed, and none of it is customer PII.

---

## 7. Prove your receiver before you go live

`POST /v1/conformance/run` fires five signed probes at a receiver you nominate and
grades the answers. Attach the report to your change record; it is a scored,
timestamped artefact, not a checklist.

```bash
curl -X POST https://<deployment>/v1/conformance/run \
  -H "Authorization: Bearer $PRODUCER_KEY" \
  -H "content-type: application/json" \
  -d '{"receiver_url":"https://bank.example.com/hooks/securevoice",
       "secret":"<the secret your receiver verifies with>",
       "org_id":"bank-core-uae",
       "budget_ms":2000}'
```

| Graded check           | What it proves                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------ |
| `signature_verified`   | A tampered digest and an unsigned request are both refused with a 4xx.               |
| `idempotency_honoured` | You acknowledge the `event_id` you accepted, so your dedupe key is observable.       |
| `fast_2xx`             | A well-formed delivery is acknowledged inside your stated budget.                    |
| `replay_handled`       | A redelivery of an already-applied `event_id` is **not** applied again, and says so. |
| `rejects_malformed`    | A correctly signed but schema-invalid payload is refused, not acknowledged.          |

Notes that decide whether you trust it:

- **`200` means the run completed, not that you passed.** Read `score.verdict`. A
  failing grade is a _successful run_, which is what makes the report safe to
  attach.
- The probes are **signed by the production signer** over the same canonical
  bytes a real delivery uses, so you are graded against the scheme we actually
  send.
- The probes are **schema-valid on purpose** (the malformed one is the only
  exception) and tagged `x-securevoice-conformance-run`, with
  `data.outcome = "conformance_probe"`, so they are findable and droppable in a
  non-production environment.
- **Safe to run repeatedly**: every probe carries a fresh `event_id` except the
  deliberate replay pair, so a re-run never collides with a previous run's dedupe
  entries.
- Your `receiver_url` is validated by resolution before anything is dialled —
  HTTPS only, port 443, no credentials, public addresses only, every redirect hop
  re-validated. A refused target returns `422` and **zero** probes are sent.
- Your secret is used to sign the probes and appears in no log line, no report
  field and no error message.
- A producer key is required: an unauthenticated caller must not be able to make
  our deployment POST to a URL of their choosing. The shared HMAC secret is
  deliberately _not_ accepted here — the secret in this request is _your_ receiver
  secret, which we never had.
- Each run costs five outbound posts to a customer-controlled URL, so the budget
  is 12 per hour per producer key, with `Retry-After` on refusal.

---

## 8. What is deliberately not here

Stated so nobody goes looking for it and concludes it is a defect:

- **No sub-100 ms path, no ISO 8583/20022 termination, no authorisation
  decision.** See §0.
- **No account numbers or balances in either direction.** See §4.
- **No transcript content in an outbound event.** See §4.
- **No ordering guarantee** on bank events.
- **No self-serve tenant provisioning.** See §1.
- **No `/openapi.json`.** The document is served at `GET /openapi`, because an
  App Router route's URL is its directory name and a second path would mean a
  second copy to keep in sync — the exact drift this design exists to prevent.
  Point your codegen at `/openapi`. Adding an `openapi.json` alias is a
  one-line route if your tooling insists.
- **The conformance checker grades five named properties.** It does not drive
  TLS, retries or ordering, and it never claims a receiver is correct — only that
  those five properties hold.
