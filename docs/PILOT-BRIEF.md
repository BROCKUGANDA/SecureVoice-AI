# SecureVoice AI — pilot brief

**SecureVoice Technologies** · real-time voice fraud intervention · [email] · [phone]

---

## The problem, in the customer's words

When your customer is on the phone with a scammer, you have roughly **ninety
seconds** between your alert firing and the money leaving. Today that window is
spent in a call queue. By the time your fraud team reaches the customer, the
transaction has settled and the loss is real — the only question left is how
large.

The cost of that gap is not the call. It is the **uncontested loss**: the cases
your customer could have stopped, if only someone had reached them while they
were still on the line.

## What SecureVoice does

When a transaction crosses your risk threshold, SecureVoice calls the customer
within that window, in their language, and verifies the transaction against the
same knowledge challenge your policy already defines. If the customer denies
it, a reversible freeze is staged and a specialist is escalated. If they confirm
it, the review closes and they are told, plainly, how to spot the scam that
targeted them.

**One sentence:** an AI voice agent that calls your customer inside the ninety
seconds your fraud alert buys you.

## What it will not do

This is the part that makes procurement comfortable, and it is worth saying
early:

- It **cannot move money**, change a limit, or read a balance.
- It **never asks for** a PIN, password, one-time passcode, CVV or full card
  number — and this is enforced server-side, not by prompting the model.
- **No model sits in the authorization path.** The model speaks; deterministic
  server-side code decides, under your policy, and writes an append-only audit
  record. Every turn is hash-chained and verifiable.
- A freeze requested by the agent is **staged and reversible** — a second actor
  (your system or a human specialist) commits it.

## Integration surface: two endpoints

| Direction | What |
| --- | --- |
| Inbound | `POST /v1/interventions` — your risk signal, HMAC-signed, idempotency-keyed |
| Outbound | One signed callback with the verdict, case reference and signed transcript link |

**That is the whole integration.** No inbound access to your network. No
connectors. No change to your authorization path. We sit downstream of your fraud
engine; you keep deciding what is suspicious, we only intervene with the human.

Payload we send you: alert identifier, verdict, case reference, timestamps,
confidence, and a signed link to the transcript. **No transcript content in the
event body**, no account numbers, no card data.

## What we need from you in Phase 0: nothing

Phase 0 is shadow mode. You send pseudonymised alerts — identifier, timestamp,
amount, merchant, risk score. We place **no calls**, touch **no customer**, and
need **no access** to your systems. The risk of Phase 0 to you is zero, which is
why it is the whole strategy: an institution can say yes to it without spending
a rupee of budget or a day of risk committee time.

## The Phase 0 deliverable that matters

A readout against **your own historical cases**: for the fraud attempts you
already handled, which of them SecureVoice would have contained, and which the
script would have looked like. Transcripts included.

That readout is the thing that makes a Phase 1 decision — because it is your
data, not our assertion, and it converts a pilot into a number your committee
can act on.

## Pilot design

| Phase | Duration | What | Gate |
| --- | --- | --- | --- |
| **0 · Shadow** | 2 weeks | No calls. Decision + script produced for every alert. | Your review of the readout |
| **1 · Limited live** | 4 weeks | One alert type. Opt-in cohort. Hard cap of N calls/day. Every dial approved by a human. Kill switch held by you. | Containment vs. control group |
| **2 · Expanded** | 6 weeks | Auto-dial on the proven alert type. Your fraud team on the console. | Weekly containment report |

### Metrics — agreed before Phase 1, not after

| Metric | Definition |
| --- | --- |
| Time to contact | alert fired → customer on the line (**target < 90 s**) |
| Containment rate | fraud stopped ÷ fraud attempted, **treated cohort vs. a held-out control group** |
| Contact rate | answered ÷ dialled |
| False-positive friction | legitimate customers called unnecessarily |
| Deflection | cases closed with no human agent |
| Post-call sentiment | customer reaction to being called |

**A control group is mandatory.** Without one, the pilot yields an anecdote.
With one, it yields a number your board will act on. It cannot be retrofitted
after Phase 1 starts, which is why it is written into this document.

## Data handling

- SecureVoice acts as a **processor** on your documented instructions; you
  remain the controller.
- Data minimised to what the intervention needs. No PAN, ever.
- **Retention is yours to set** — audio down to zero, once the tamper-evident
  audit hash is written. Erasure destroys the encryption key; the hash chain
  still verifies from genesis.
- Sub-processors listed and under contract. Processing location disclosed.
- We register as a data processor in your jurisdiction before Phase 1 begins.
- Full security questionnaire answered in advance, honestly.

## Commercials

Phase 0 at no cost. Later phases under a signed MSA and DPA. Priced on
contained cases, not minutes — you are not buying audio, you are buying the
ninety seconds.

## Timeline

| | |
| --- | --- |
| Signature | [DD Month YYYY] |
| Phase 0 starts | [DD Month YYYY] |
| Phase 0 readout | [DD Month YYYY] |
| Phase 1 decision | [DD Month YYYY] |

## What we are asking for now

**Thirty minutes with your Head of Fraud**, and permission to run Phase 0.
Nothing else. No commitment of budget, no procurement cycle, no security review
required to begin.