# Integration matrix - connecting any institution or agency

**Canonical contract:** `docs/INTEGRATION-CONTRACT.md`.
**Machine-readable:** `GET /openapi` (OpenAPI 3.1) and `GET /asyncapi`
(AsyncAPI 3.0). There is no `/openapi.json` alias.
**Last reviewed:** 2026-10-20.

SecureVoice is a **downstream verification channel**. It does not sit in the
authorisation path, terminate card-network messages, move money or decide a
transaction. The institution keeps its fraud engine, core banking, ledger and
authorisation switch.

---

## 1. Pick the integration pattern

| System you have                     | What it does                                       | SecureVoice connection                                                                                               | Change required                                                       |
| ----------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Fraud engine / risk platform        | Detects a suspicious event                         | `POST /v1/interventions` with a signed risk signal                                                                   | One outbound HTTPS call and a shared secret or producer key.          |
| Core banking / authorisation switch | Approves, declines and settles                     | **No direct integration.** Feed SecureVoice from the fraud engine or case system, never from the authorisation path. | None to the switch. Keep its latency budget untouched.                |
| CRM / case management               | Owns the customer and investigation record         | Receive `case.notified` webhooks; link `case_ref` to the case                                                        | One HTTPS receiver, signature verification and idempotent processing. |
| Contact centre / telephony          | Owns agents, queues and the institution's DIDs     | Import the institution's number as caller ID; warm transfer to a specialist number; handle status callbacks          | Number ownership and transfer destination.                            |
| SIEM / observability                | Correlates security and operational events         | Audit export, `/api/readyz`, signed event mirror to the SIEM                                                         | Read-only collector; no customer data in logs.                        |
| Agency / BPO operating for a bank   | Runs fraud operations for one or more institutions | Separate `org_id`, producer keys, console roles and data scope per institution                                       | Operator provisions each tenant; no shared login.                     |
| Regulator / internal audit          | Needs evidence, not live access                    | Controlled audit and regulatory export by an authenticated operator                                                  | Named approver and lawful request; never a standing API key.          |
| Shariah supervisory board           | Approves product terms, scripts and disclosures    | Document review and sign-off; terminology is a tenant-scoped configuration                                           | No API integration. The board remains the approving authority.        |

### What not to connect

- Do not put `/v1/interventions` in a card-authorisation, payment or claim
  approval path. A `202` is queue acceptance, not a decision.
- Do not send PANs, IBANs, balances, full account numbers, PINs, passwords or
  OTPs. The schema rejects unknown fields and the platform redacts before
  persistence.
- Do not give SecureVoice a standing credential to the core banking system. The
  minimum viable integration is one outbound signal and one signed webhook.
- Do not treat an SMS `YES` as identity. It proves possession of the handset,
  not that the right person replied.

---

## 2. The two-endpoint minimum

```
institution fraud engine
        |
        |  POST /v1/interventions
        |  Idempotency-Key: <stable per alert>
        |  SV-Signature: t=...,v1=...   or   Authorization: Bearer svb_...
        v
   SecureVoice  ----> voice verification ----> case + audit chain
        |
        |  POST <your callback_url>
        |  SV-Signature: t=...,v1=...
        v
institution CRM / case management / SIEM
```

The outbound event today is `case.notified`. Treat unknown event types as
non-fatal and ignore them; new types are additive.

### Required inbound fields

| Field               | Rule                                                             |
| ------------------- | ---------------------------------------------------------------- |
| `transaction_ref`   | Institution's alert or transaction reference. Stable and unique. |
| `risk_score`        | Number from 0 to 1. It drives priority, not a licence to dial.   |
| `language`          | Supported call language.                                         |
| `phone`             | E.164 only.                                                      |
| `currency`          | ISO-4217 alphabetic code.                                        |
| `amount`            | Integer in minor units. `2500` means 25.00.                      |
| `merchant`          | Display-only merchant descriptor. Do not include account data.   |
| `consent_record_id` | Required reference to the institution's consent record.          |
| `callback_url`      | Public HTTPS receiver for signed events.                         |
| `org_id`            | Tenant. Required for HMAC producers; a producer key carries it.  |

Optional `call_category` selects the conversation policy. Absent it, the
audited `time_critical_fraud` baseline applies.

### Webhook receiver requirements

1. Read the **raw body bytes**. Do not re-serialise JSON before verifying.
2. Verify `SV-Signature` over `{timestamp}.{rawBody}` within the replay window.
3. Deduplicate on `event_id`.
4. Return `2xx` quickly and process asynchronously.
5. Reject unknown `schema_version` values with `4xx`; ignore unknown event types.
6. Do not assume ordering. Key state on `event_id` and tolerate late events.

---

## 3. Deployment choices

| Tier        | Where it runs                             | Best for                              | Constraint                                             |
| ----------- | ----------------------------------------- | ------------------------------------- | ------------------------------------------------------ |
| Hosted      | SecureVoice's deployment                  | Fastest pilot; no infrastructure work | Operator provisions the org; no self-serve signup yet. |
| Self-hosted | Institution VPC / Kubernetes / compose    | Data residency, network isolation     | Institution runs upgrades and owns the database.       |
| Embedded    | Institution network, egress and telephony | Maximum control                       | Institution owns carrier relationships and on-call.    |

All three use the same contract. Moving tier is a deployment change, not an
integration rewrite.

---

## 4. Identity, secrets and tenancy

| Control                   | How it works                                                                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Inbound authentication    | HMAC `SV-Signature` with `WEBHOOK_SECRET`, or a per-team `svb_...` producer key. They are alternatives, not a pair.                              |
| Tenant scoping            | `org_id` on the signal or the producer key; core tables and console queries are org-scoped.                                                      |
| Key rotation / revocation | Revoke a producer key without rotating the global secret.                                                                                        |
| Outbound authentication   | `SV-Signature` over the raw body.                                                                                                                |
| Agent tool authentication | `x-agent-tool-secret` plus the global `AGENT_TOOL_ALLOWED` allow-list. This is not per-tool scoping; a leaked secret reaches every allowed tool. |
| Console access            | Better Auth session, role-based access, operator-only exports.                                                                                   |
| BYOK                      | The institution can bring its own ElevenLabs key, encrypted at rest.                                                                             |

---

## 5. Data mapping by institution type

| Institution type     | Typical signal source                            | Customer reference      | Protective action                                         | Extra approval                                             |
| -------------------- | ------------------------------------------------ | ----------------------- | --------------------------------------------------------- | ---------------------------------------------------------- |
| Bank / card issuer   | Card or payment fraud engine                     | Internal customer token | Stage a reversible card hold; human commits               | Bank fraud-ops policy                                      |
| Insurer / Takaful    | Claims, policy-change or premium-diversion alert | Policy or claim token   | Stage a claim-payout or policy-change hold; human commits | Claims authority; Shariah board if Takaful wording is used |
| Agency / BPO         | Client's fraud platform                          | Client-scoped token     | Same as the underlying institution                        | Written authority from each represented institution        |
| Telecom / e-commerce | Account-takeover or payment fraud model          | Account token           | Stage an account or order hold; human commits             | Business's own customer policy                             |
| Public-sector agency | Case-management or fraud-reporting system        | Case reference          | Verification and escalation only                          | Agency data-protection and procurement approval            |

If the institution's product does not have a reversible hold, the integration
still works: the agent verifies, escalates to a human and returns evidence. Do
not invent a write action the institution cannot reverse.

---

## 6. Connectivity and operations

| Need                         | Endpoint / artifact                                          |
| ---------------------------- | ------------------------------------------------------------ |
| Readiness                    | `GET /api/readyz` (dependencies)                             |
| Liveness                     | `GET /api/health` (process only)                             |
| Status and environment gate  | `GET /api/status`                                            |
| Ingest discovery             | `GET /v1/interventions`                                      |
| OpenAPI                      | `GET /openapi`                                               |
| AsyncAPI                     | `GET /asyncapi`                                              |
| Human-readable guide         | `docs/INTEGRATION.md`                                        |
| Contract and error catalogue | `docs/INTEGRATION-CONTRACT.md`; `x-error-catalog` in OpenAPI |
| Webhook receiver reference   | `POST /api/webhooks/receiver`; UI at `/inspector`            |
| Audit export                 | `GET /api/console/audit` behind operator auth                |
| Regulatory export            | `/api/regulatory/export`; `/api/compliance/fatf-export`      |

Network requirements, retry ladders, error codes and the conformance checker are
in `docs/INTEGRATION-CONTRACT.md`. Do not duplicate them in a customer
spreadsheet; link the contract.

---

## 7. Six-step activation

1. **Choose the tier** and create the tenant (operator action today).
2. **Exchange the secret or issue a producer key.** Store it server-side.
3. **Enrol the pilot cohort** through `POST /v1/enroll` with a consent record.
4. **Implement the receiver** and prove signature verification with a test
   delivery.
5. **Run conformance** against `POST /v1/conformance/run` and fix every
   rejection.
6. **Start with a human-approved dial cap**, then review the first day's cases
   before expanding.

Do not skip step 4. A receiver that acknowledges an unverified payload is worse
than one that rejects it.

---

## 8. Integration readiness checklist

- [ ] Contract version pinned (`schema_version`).
- [ ] HMAC or producer-key auth tested, including replay and rotation.
- [ ] `Idempotency-Key` is stable across retries.
- [ ] Receiver verifies raw bytes and deduplicates `event_id`.
- [ ] Error handling branches on `code`, not `message`.
- [ ] Retry policy honours `Retry-After` and does not retry policy refusals.
- [ ] Callback URL is public HTTPS and passes the SSRF policy.
- [ ] No account numbers, PANs, balances or credentials cross the boundary.
- [ ] Tenant isolation tested with two orgs.
- [ ] Audit export and retention schedule agreed.
- [ ] Incident contacts and kill-switch owner named.
- [ ] Pilot gates in `docs/PILOT-READINESS.md` closed.
