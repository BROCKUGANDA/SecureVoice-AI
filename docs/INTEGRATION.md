# Integration guide — connecting SecureVoice to a bank (and to ElevenLabs)

Two separate questions, and they have different answers:

| You want to… | Use | Difficulty |
|---|---|---|
| **Call SecureVoice** from your fraud engine / core banking | [`POST /api/interventions`](#1-bank--fraud-engine--core-banking) — signed webhook | Half a day |
| **Let SecureVoice call your customers** | [`POST /api/enroll`](#2-customer-enrolment-for-outbound-calls) | An hour |
| **Receive every phase transition** back in your systems | [`POST /api/webhooks`](#3-outbound-events-back-to-your-bank) | An hour |
| **Run it inside your own VPC / cloud** | [`docker compose`](#5-run-it-yourself) | A day |
| **Give your staff their own console + keys** | [Multi-tenant onboarding](#6-multi-tenant--self-serve-onboarding) | Product work |
| **Use it right now, no deployment** | [`securevoice.ai`](#7-use-the-hosted-demo) | Seconds |

---

## 1. Bank / fraud engine → core banking

`POST /api/interventions` is the ingest contract. Anything that can POST JSON and
HMAC-sign it can drive the platform — no SDK, no agent install.

### The signing scheme (do not skip this)

Untrusted or unsigned risk signals are rejected with **401**. The platform never acts
on a signal it cannot attribute.

```
SV-Signature: t={unix_seconds},v1={hmac_sha256(WEBHOOK_SECRET, "{t}.{rawBody}")}
```

- `rawBody` is the **exact bytes** you send — sign before serialising, or capture
  the raw body. Re-serialising JSON changes key order and breaks the signature.
- `t` has a **5-minute replay window**. Clock-skewed producers should sync to NTP.
- Comparison is constant-time.

```bash
# Node — sign and send a risk signal
import { createHmac } from "node:crypto";

const url = "https://securevoice.ai/api/interventions";
const secret = process.env.WEBHOOK_SECRET;           // shared with SecureVoice

const body = JSON.stringify({
  signal: {
    caseId: "FRAUD-2026-08612",
    riskScore: 0.94,
    channel: "card",
    customer: { ref: "CUST-8642", lang: "ar" },      // your internal id, NOT PII
    transaction: { amountAed: 2500, merchant: "Electronics World" },
    callbackUrl: "https://bank.example/webhooks/securevoice",
  },
});

const t = Math.floor(Date.now() / 1000);
const v1 = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");

const res = await fetch(url, {
  method: "POST",
  headers: { "content-type": "application/json", "SV-Signature": `t=${t},v1=${v1}` },
  body,
});
console.log(res.status, await res.json());
```

### Optional: a producer key instead of the shared secret

For per-team attribution and instant revocation, mint a producer key in the console
(**Settings → API Keys**) and send it as `Authorization: Bearer svb_…`. The key is
scoped to an `orgId`, so you can tell which team fired a signal and revoke one team
without rotating the global secret. Both schemes are supported; the HMAC path is the
one the demo exercises.

When a producer key carries an `orgId`, that organisation wins for tenant scoping —
HMAC producers may instead declare `orgId` in the payload.

### What comes back

```json
{
  "caseRef": "SV-INT-…",
  "status": "accepted",
  "slaSeconds": 30,
  "actionPlan": ["verify_identity", "card_freeze", "human_handoff"]
}
```

The **SLA clock starts on acceptance**, not on call completion — that is the metric
box M tracks (`AuditLog.first_contact_at − alert_received_at`).

### From a core-banking sandbox, claims engine, or case-management mock

You do not need those systems to have a SecureVoice plugin. Model them as **producers**
(→ `/api/interventions`) and **consumers** (← `/api/webhooks`). If you want a real
tool-call surface instead of push, the ElevenLabs agent's server tools hit
`/api/elevenlabs/tools/card-freeze` — see [tool auth](#4-elevenlabs-agent--tool-authorisation).

---

## 2. Customer enrolment for outbound calls

`POST /api/enroll` registers a number and — critically — the **consent record** that
permits the platform to dial it. Without a consent record the platform will not place
a call.

```json
{
  "enroll": {
    "customerRef": "CUST-8642",
    "phone": "+971501234567",
    "lang": "ar",
    "channel": "call",
    "consentRecordId": "CN-2026-04-1183"
  }
}
```

`lang` accepts `en · ar · hi · ur · fr · sw`. `channel` is `call` or `sms`.
Opt-out is first-class and immediate. It is the *same* endpoint with a different body:

```json
{ "action": "optout", "customerRef": "CUST-8642" }
```

That persists a do-not-call flag the platform honours on every subsequent
intervention — the intervention is refused rather than re-dialled.

Twilio trial accounts can only dial numbers verified in the Twilio console. For
unrestricted delivery use a paid account and set `TWILIO_*` in your deployment.

---

## 3. Outbound events back to your bank

`POST /api/webhooks` emits every phase transition to your `callbackUrl`. The same
`SV-Signature` header proves authenticity, and **PII is redacted before signing**, so
you receive evidence, not customer data.

| Event | Meaning |
|---|---|
| `intervention.started` | case accepted, SLA clock running |
| `identity.verified` | customer passed the zero-knowledge check |
| `customer.confirmed` | customer said "yes, that was me" |
| `account.frozen` | freeze staged — **see the human-approval note below** |
| `escalated.human` | specialist queued, `sla_seconds` included |
| `case.closed` | terminal state, with `action_taken` and `prevented_loss_aed` |

> **`account.frozen` does not mean the card is blocked.** The agent can only stage a
> reversible `pending_specialist` state. A human fraud specialist finalises it in the
> bank's console. This is deliberate — see the guardrails table in
> [docs/SUBMISSION.md](SUBMISSION.md#k-guardrails-every-row-is-a-code-level-mechanism-not-a-comment).

---

## 4. ElevenLabs agent & tool authorisation

If you want the **ElevenLabs conversational agent** (rather than the SecureVoice state
machine) to drive actions, it calls your deployment over signed webhooks.

### Tool endpoints

| Endpoint | What it does | Irreversible? |
|---|---|---|
| `POST /api/elevenlabs/tools/card-freeze` | stages a reversible freeze request | **No** — returns `committed:false` |
| `POST /api/elevenlabs/tools/human-handoff` | queues a fraud specialist | No |
| `POST /api/elevenlabs/signed-url` | mints a browser session credential | No |

### Authentication

Every tool call must present a shared secret **and** be named in the allow-list:

```
x-agent-tool-secret: {AGENT_TOOL_SECRET}
```

Two independent conditions must hold:

1. the secret matches `AGENT_TOOL_SECRET` (SHA-256 hashed, then compared in constant
   time), **and**
2. the tool name appears in `AGENT_TOOL_ALLOWED`.

A secret valid for `human_handoff` therefore **cannot** authorise `card_freeze`. This
is the "tool scoping and trust context" requirement — an agent serving untrusted
callers cannot reach a privileged action with a leaked read-only credential.

### Browser sessions without exposing your key

`/api/elevenlabs/signed-url` mints a **15-minute** `wss://` signed URL (or a WebRTC
token) so the browser connects directly to ElevenLabs and your `ELEVENLABS_API_KEY`
never reaches client-side code. It also **pins** the agent: any `agent_id` other than
`ELEVENLABS_AGENT_ID` is rejected with `403 agent_not_allowed`.

Verified behaviour (see [`evidence/guardrails-runtime-2026-10-01.json`](evidence/guardrails-runtime-2026-10-01.json)):

| Call | Result |
|---|---|
| no secret / wrong secret | `401 unauthorized` |
| `card_freeze` authorized | `200`, `committed:false`, `stage:pending_specialist` |
| `human_handoff` | `200`, `sla_seconds:30` |
| signed URL, non-pinned agent | `403 agent_not_allowed` |
| signed URL, websocket / webrtc | `200` real credential |

---

## 5. Run it yourself

### Docker (recommended)

```bash
git clone <your-fork> && cd SecureVoiceai
cp .env.example .env        # optional — the demo runs without any keys
docker compose up --build   # → http://localhost:3000
```

That brings up Postgres, applies the Prisma schema, seeds demo cases, and serves the
Next.js standalone bundle. There is **no SQLite mode** — Prisma rejects a `file:` URL
against this schema's `postgresql` provider (`P1012`). Reset to a factory-fresh demo
with `docker compose down -v`.

### Point it at your own database

Put the connection string in `.env` as `DATABASE_URL`, then:

```bash
bunx prisma db push        # apply schema
bun scripts/seed-demo.mjs  # optional demo data
```

For Supabase specifically, the **direct host is often IPv6-only**. If Prisma fails
with `P1001` on a project you know is healthy, use the IPv4 pooler — the project is
fine, your host just has no IPv6 route:

```
postgresql://postgres.<ref>:<pw>@aws-0-<region>.pooler.supabase.com:5432/postgres?sslmode=require
```

---

## 6. Multi-tenant & self-serve onboarding

**Honest status: the multi-tenant groundwork exists, the self-serve signup flow does
not.** This is the honest state as of this commit — read it before planning around it.

### What already works

| Piece | State |
|---|---|
| `orgId` scoping on `AuditLog`, `Customer`, `ProducerKey`, `UserProfile` | ✅ in the schema |
| Per-team producer keys, revocable, `orgId`-scoped | ✅ `/api/console/producer-keys` |
| **BYOK** — a bank brings its own ElevenLabs key | ✅ AES-256-GCM encrypted at rest, Console → Settings |
| Per-organisation branding | ✅ |
| Credits wallet per organisation | ✅ |
| Clerk organisations for staff login | ✅ |
| Lead capture (`PilotRequest`) | ✅ `/api/pilot` |

### What is missing to let a stranger self-serve

1. **Automated provisioning.** An org is created by an operator today. There is no
   signup → org → first-producer-key flow; someone with console access does it.
2. **Onboarding UI.** No guided "connect your core banking" wizard — the integration
   above is documentation, not a form.
3. **Self-serve verification.** `PilotRequest` captures intent but nothing closes the
   loop automatically.

### The shortest honest path to self-serve

```
POST /api/pilot                      → creates PilotRequest (already live)
  ↓ operator approval (already live, Console)
org + Clerk organization created       ← INSERT here
  ↓ auto-mint
first ProducerKey handed to the bank   ← INSERT here (nonce + one-time display)
  ↓ bank runs
POST /api/enroll per customer, then POST /api/interventions on risk
```

The three `INSERT` points are the whole product gap. Everything they need —
`orgId` columns, key minting, encryption, revocation — is already in the codebase.

### If you want the hosted path instead

`https://securevoice.ai` runs the full surface publicly with seeded demo data. Judges
can click through with no key, no account, and no setup. For a real bank the
deployment is yours to run (§5) — the hosted demo deliberately does **not** accept
real customer data.

---

## 7. Use the hosted demo

<http://securevoice.ai> — landing page, live Command Center, Docs and Security pages,
and the guided pilot flow. Nothing to install. Runs in dry-run/audit-only mode, so no
Twilio numbers are dialled and no ElevenLabs quota is burned unless you supply keys.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `401` from `/api/interventions` | Signature mismatch. Sign the **exact raw body**, not a re-serialised object. Check the replay window. |
| `P1001` from Prisma on a healthy DB | Direct DB host is IPv6-only and your host has no IPv6 route. Use the IPv4 pooler. |
| Tool call returns `405` | ElevenLabs signed-URL endpoints are `GET` with `agent_id` as a **query param**, not a JSON body. (Already handled in `/api/elevenlabs/signed-url`.) |
| Agent has no tools available | Free-tier accounts get HTTP 200 while silently dropping `tool_ids`. Attach tools in the ElevenLabs **dashboard**, not the API. |
| Every route 404s after a restart | Stale Turbopack `.next`. `rm -rf .next`. |
| `env_file` warning in compose | `.env` is absent. It is optional by design. |