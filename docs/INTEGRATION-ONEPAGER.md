# Integration one-pager

**For:** the institution's security, risk and integration reviewers
**Scope:** what SecureVoice connects to, what crosses the boundary in each
direction, and what we never touch. Two endpoints. No inbound access to your
network. No change to your authorisation path.

---

## 1. The surface

```
   your fraud engine                    SecureVoice                     your CRM/SIEM
  ────────────────────         ───────────────────────────         ─────────────────────
       │                            │                                  │
       │  ①  POST /v1/interventions │  (signed, idempotency-keyed)     │
       ├───────────────────────────►│                                  │
       │                            │── verify HMAC, policy gate ──►  │
       │                            │── idempotency claim ──────────► │
       │                            │── enqueue intervention ───────► │
       │                            │                                  │
       │                            │                     ②  POST (signed callback)
       │                            │─────────────────────────────────►│
```

**Two endpoints total.** No agents, no scanners, no inbound connections from
your network, no VPN, no credentials inside your perimeter. Everything
initiates outward from us.

---

## 2. Inbound — your risk signal

`POST /v1/interventions`

```http
POST /v1/interventions HTTP/1.1
Host: api.securevoice.ai
Content-Type: application/json
SV-Signature: t=1790920000,v1=5257a869e…
Idempotency-Key: your-case-reference
```

```json
{
  "signal": {
    "caseId": "FRAUD-2026-08612",
    "transactionId": "TRX-99127",
    "riskScore": 0.94,
    "channel": "card",
    "customer":  { "ref": "CUST-8642", "lang": "ar", "consentRecordId": "CN-8812" },
    "transaction": { "amountAed": 2500, "merchant": "Electronics World" },
    "callbackUrl": "https://your-bank.example/securevoice/verdict"
  }
}
```

### Authentication — two options, both supported

**(a) Per-organisation API key (recommended for production).**
`Authorization: Bearer svb_…` — 24 random bytes, SHA-256 at rest, shown once
at creation, independently revocable, scoped to your organisation.

**(b) HMAC signature.**
`SV-Signature: t={unix},v1={hmac_sha256(secret, "{t}.{raw_body}")}`

| Property | Implementation |
| --- | --- |
| Signed over | The **exact raw request bytes** — never a re-serialised body |
| Replay window | 300 s. Timestamps older *or ahead of* our clock are rejected |
| Comparison | Constant-time (`timingSafeEqual`) over SHA-256 digests |
| Unsigned signals | Rejected with 401. We never act on an unsigned signal |

### Idempotency

`Idempotency-Key` (your case reference) is required. A retried delivery replays
the original response and creates nothing — enforced by a unique-index claim in
the database, not by application logic, so two concurrent retries still produce
exactly one intervention and one call. **Double-dialing a customer is treated as
a defect, not a retry.**

### Validation

Strict schema, unknown fields rejected, no type coercion: risk score in [0,1],
amount as an integer in minor units, ISO-4217 currency, E.164 phone, BCP-47
language. Callback URLs must be **public HTTPS** — private, loopback and
link-local destinations are refused at validation (SSRF control).

---

## 3. Outbound — the verdict

One signed callback per terminal case:

```http
POST https://your-bank.example/securevoice/verdict
Content-Type: application/json
SV-Signature: t=1790920600,v1=9a1c…
```

```json
{
  "schema_version": "2026-10-01",
  "event_id": "evt_8f3c…",
  "event_type": "case.verdict",
  "case_ref": "SV-F-5MZV4C",
  "org_id": "org_8812",
  "occurred_at": "2026-10-02T07:10:35.211Z",
  "data": {
    "verdict": "fraud_confirmed",
    "state": "FREEZE_STAGED",
    "freeze_committed": false,
    "reversal_window_secs": 900,
    "time_to_contact_secs": 41,
    "audit_ref": "https://api.securevoice.ai/audit/SV-F-5MZV4C"
  }
}
```

- Signed with the same HMAC scheme, replay-windowed, constant-time verified.
- Delivered from a transactional outbox: the state transition and the event
  commit in **one** database transaction, so a verdict can never exist without
  its notification, or vice versa.
- Retried with exponential backoff over ~24 h, then dead-lettered with an alert
  and a manual replay path for your operators.

### What is deliberately NOT in the event body

**No transcript content, no audio, no customer contact details, no account data.**
Only a **signed retrieval link**. Transcripts are reachable through an
authenticated, permissioned endpoint — which is what stops a webhook relay, a
log aggregator, or a compromised CRM from becoming a PII exfiltration path.

---

## 4. Data minimisation — the complete list

**We receive:**

| Field | Why |
| --- | --- |
| Alert / case reference | join key, dedupe |
| Customer reference (your token) | **Your token, never a real identifier** |
| Phone number (E.164) | the only way to place the call |
| Language (BCP-47) | select the agent's voice |
| Transaction amount + currency | read the amount aloud for verification |
| Merchant descriptor | read the merchant for verification |
| Risk score | triage and, if you enable it, load-shedding priority |
| Consent record reference | evidences lawful outbound contact |

**We never receive, and never ask for:** card number / PAN, CVV, PIN, OTP,
passwords, security-question answers, account balances, full customer names,
transaction history.

**PCI DSS:** the platform is designed so that no PAN ever transits or is stored
by it — identifiers arrive as tokens and last-4. The applicable self-assessment
is **SAQ A**, not SAQ D.

---

## 5. Processing location

| Element | Location |
| --- | --- |
| Application, database, audit chain | European infrastructure (Frankfurt, `eu-central-1`) |
| Speech synthesis / transcription | United States and United Kingdom (our processors) |
| Your deployment option | **In your VPC or on-prem** — the container topology is unchanged, so transcripts and case data never leave your perimeter |

An institution requiring in-country (UAE) processing deploys the same images
inside its own network. Nothing in the integration surface changes.

---

## 6. Retention and deletion

| Data | Default | Configurable |
| --- | --- | --- |
| Raw call audio | 30 days | **down to zero** — keep only the audit hash |
| Transcripts | 90 days | yes |
| Redacted case records | 7 years | yes |
| Audit chain (hashes only) | retained | no — it is the evidence |

**Erasure** destroys the per-case encryption key. The transcript becomes
unreadable immediately and permanently, while the hash chain still verifies from
genesis — so a deletion request can be honoured *and* the record of the action
remains provable. That is the answer to "how do you reconcile right-to-erasure
with an immutable audit log", and it is a question every bank's DPO will ask.

---

## 7. Availability and failure behaviour

| Failure | Behaviour |
| --- | --- |
| Your receiver returns 5xx | Exponential backoff, ~24 h of retries, then dead-letter + alert |
| Webhook lost | Reconciler completes the case from the conversation record |
| Voice provider unavailable | Degraded mode: no call is placed; the case records the failure and the alert escalates to your channel |
| Burst beyond capacity | Load shedding in audited bands: highest expected loss first, remainder falls to SMS/app push, **every shed decision is an audit row** |
| Duplicate delivery | Idempotent replay — no second call, no double charge |

---

## 8. What we need from you to start Phase 0

1. A producer key (or an HMAC secret).
2. A callback URL.
3. One alert type and its threshold.
4. Pseudonymised historical or mirrored alerts.

**That is the entire list.** No credentials, no network access, no procurement
cycle required to begin.