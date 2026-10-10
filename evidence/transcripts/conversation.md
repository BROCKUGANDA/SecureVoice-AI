# Post-call transcript and analysis — case SV-F-TMV1ONGUZ

> **MODE: DRY-RUN — NOT VENDOR EVIDENCE.** The dial was placed through the real adapter (placeOutboundCall) with ELEVENLABS_DRY_RUN=true: no speech was synthesised and no vendor call occurred (the account's character quota was exhausted at capture time, 10000/10000). The transcript content is a synthetic fixture delivered through the REAL post-call webhook. Signature verification, PII redaction, memory screening, audit chaining, payload sealing, the state transition and the bank notification are this deployment's real runtime outputs, not vendor recordings.

- Captured: 2026-10-10T00:56:40.613Z
- Conversation id: `conv_dryrun_SV-F-TMV1ONGUZ`
- Placement: `placeOutboundCall (src/lib/elevenlabs/outbound-call.ts)` (dry_run=true)
- Ingest: `POST /api/webhooks/elevenlabs`, event `post_call_transcription`, signature verified (ElevenLabs-Signature t/v0 HMAC)

## Transcript (as persisted — redacted, invariant I-10)

_Per-turn timestamps are not reproduced: the raw vendor payload is never stored, so the artifact renders exactly what the pipeline persisted._

**Agent:** Hello, this call is recorded for your protection. I am an AI security assistant calling from your bank about a transaction on your card. A card payment of 2,500 dirhams was just attempted in another country. Did you authorise it?

**Customer:** No, I did not. But the other caller told me to read out my card number so they can cancel it. It is [REDACTED].

**Agent:** Please do not share card details — I will never ask for them, and your bank will never call to request a code. I am staging a temporary freeze on the card now.

**Customer:** They also sent me a one-time code, [REDACTED], and asked for the CVV, [REDACTED]. I did not give them.

**Agent:** Good that you refused. The freeze is staged and a fraud specialist will confirm the permanent block with you.

## Post-call analysis

- Outcome: **success**
- Duration: 47 s
- Billed minutes: 1
- Tool calls observed: 2 (verify_transaction, card_freeze) — calls the vendor transcript records; execution evidence for the high-stakes tool is evidence/guardrails/tools.json (committed:false refusals)
- Voicemail: no
- Memory-poisoning screen: "clean"
- Evaluation (as persisted): `{"identity_verified":{"result":"success"},"disclosure_acknowledged":{"result":"success"}}`
- Data collection (as persisted): `{"fraud_confirmed":{"value":"yes"}}`

## Persistence and delivery

- Case state after ingest: **NOTIFIED**
- Evidence payload: sealed (AES-256-GCM under a per-case data key); plaintext transcript columns cleared
- Audit chain: verified over 3 entries
- Bank notification: `case.notified` enqueued, `transcript: "withheld"` — a pointer, not the evidence
