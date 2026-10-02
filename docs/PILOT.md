# Pilot and scale — SecureVoice AI

> **Read the honesty note first.** This document is complete except for four
> fields that only a human can supply: **the named institution, the named
> contact, the date of your last conversation, and their fraud-loss figures.**
> They are marked `⬜ INPUT REQUIRED` throughout and are deliberately left blank.
>
> The Stage 2 rubric states plainly that *"we will approach banks" scores zero*.
> We are not going to fill those four boxes with a plausible-sounding guess.
> A named institution without a real conversation behind it is worse than an
> honest blank: it is discoverable, and it ends the relationship when it is
> discovered.
>
> Everything else here is real, sourced, and generated from measurement. Where
> a number is extrapolated rather than measured, it says so — because that
> distinction is the difference between a capacity model and a guess.

**Owner:** ⬜ INPUT REQUIRED — founder
**Last updated:** 2026-10-02

---

## 1. The named institution

| Field | Value |
| --- | --- |
| Institution | ⬜ **INPUT REQUIRED** |
| Contact (named human) | ⬜ **INPUT REQUIRED** |
| Role | Head of Fraud / Fraud Risk Manager preferred — *not* the CIO, who routes you to procurement, and *not* the CEO except at tier-3 institutions |
| Date of last conversation | ⬜ **INPUT REQUIRED** |
| Permission to name them publicly | ⬜ **INPUT REQUIRED** — written, in the same thread as the LOI |
| Commitment level (see §7) | ⬜ **INPUT REQUIRED** |

**Target set.** Insurers first. Track 1 is Banking *and* Insurance, almost
every entrant will chase banks, and insurers have real voice-channel fraud —
claims fraud, premium diversion, policyholder impersonation — with far less
competition for attention. That gap is the arbitrage. Second: tier-2/3 banks
and deposit-taking microfinance, where a Head of Risk can say yes in one
meeting. Third: SACCO apex bodies, where one relationship covers hundreds of
institutions and "apex body" reads as institutional.

Full 25-name list with a named human per institution: ⬜ **INPUT REQUIRED**.

### Their pain, in their words

⬜ **INPUT REQUIRED** — two sentences, quoted with consent.

Capture it on the call by asking directly: *"what did your worst fraud week
this year look like?"* A practitioner's sentence in their own words is worth
more in this document than a paragraph of ours, and you cannot reconstruct it
afterwards.

### Their numbers, quantified

⬜ **INPUT REQUIRED** — all four are the institution's, not ours:

| Metric | Their figure |
| --- | --- |
| Card / policy volume per month | ⬜ |
| Current flag rate | ⬜ |
| Mean time from alert to customer contact | ⬜ |
| Average fraud loss per uncontested case | ⬜ |

We have planning figures (0.35% flag rate on 200,000 transactions/month) but
they are **ours, not theirs**, and the honest opening line in the first meeting
is *"these are the assumptions we modelled — send us yours and we will re-run
the model."* A fraud head who corrects your assumptions is a fraud head who is
taking the meeting seriously.

---

## 2. What we do, stated as scope

SecureVoice sits **downstream of the fraud engine**, not inside the
authorization path. We do not terminate ISO 8583 or ISO 20022, we do not
approve or decline transactions, and we do not carry a sub-100 ms authorization
SLA. The fraud engine decides; we intervene with the human.

Saying this in the first integration call earns credibility and removes the
hardest objection a bank architect will raise.

Three facts that defuse nearly every objection:

1. **Additive, not substitutive.** We consume a risk signal from whatever fraud
   engine they already run. We replace nothing, so no incumbent vendor is
   displaced and no internal champion has to fight anyone.
2. **No model in the authorization path.** The model phrases sentences. Server-side
   tools decide — deterministically, under their policy, with an append-only
   audit trail. Invariant I-2: `stage_card_freeze` returns
   `409 precondition_failed` unless the state machine has already recorded an
   explicit fraud confirmation. Proven in `tests/redteam/redteam.test.ts`.
3. **Phase 0 cannot hurt them.** Shadow mode. No calls placed, no access to
   their systems, pseudonymised alert data only.

Point 3 is the whole strategy. An institution says yes to Phase 0 because
Phase 0 carries no risk for them.

---

## 3. Integration surface

Two endpoints, no core-banking change.

| Direction | Endpoint | Notes |
| --- | --- | --- |
| Inbound | `POST /v1/interventions` | HMAC-signed, `Idempotency-Key` required, strict schema, unknown fields rejected |
| Outbound | signed webhook | `SV-Signature: t=…,v1=…` over `{timestamp}.{canonical_body}`; TypeScript and Python reference implementations in the README, both executed by the WP-5 gate |

Tier 0 (observe) is the pilot entry point. Never lead with Tier 2.

**Their changes:** two endpoints and a webhook secret. That is the whole ask.

---

## 4. 90-day pilot design

### Phase 0 — Shadow (weeks 1–2) · *their risk: zero*

They send pseudonymised historical or mirrored live alerts. We produce the
intervention decision and the script we **would** have used. No calls placed.

**Deliverable:** a readout showing which of their historical fraud cases would
have been contained, with transcripts. This readout is what sells Phase 1, and
it can start immediately at no cost — which is why it is also the best closing
tool we have.

### Phase 1 — Limited live (weeks 3–6)

One alert type. Opt-in cohort. Hard cap of N calls/day. **A human approves every
dial.** Kill switch held by the institution. Daily report.

### Phase 2 — Expanded (weeks 7–12)

Auto-dial for the proven alert type. Console access for their fraud team.
Weekly containment report. Defined SLA.

### Metrics — agreed before Phase 1 starts

| Metric | Definition |
| --- | --- |
| Contact rate | answered ÷ dialled |
| Time to contact | alert fired → customer on the line (target < 90 s) |
| Containment rate | fraud stopped ÷ fraud attempted, treated cohort vs control |
| False-positive friction | legitimate customers called unnecessarily |
| Deflection | cases resolved without a human agent |
| Post-call sentiment | customer reaction to being called |

**Insist on a holdout control group.** Without one the pilot produces an
anecdote; with one it produces a number the board will act on. This goes in the
metrics sheet before Phase 1 because a control group cannot be retrofitted.

**Data protection posture.** We register as a data processor in the pilot
jurisdiction before Phase 1 begins. Retention is per data class with a tested
purge job; erasure is crypto-shredding, which destroys a per-case key so the
audit chain still verifies from genesis. Full detail in `docs/TRUST-MODEL.md`
and the data-protection summary in `docs/SUBMISSION.md`.

---

## 5. Unit economics

Full model, with every rate sourced by URL and read-date:
**[`docs/UNIT-ECONOMICS.md`](UNIT-ECONOMICS.md)**.

The ratio that makes the case:

```
ROI multiple = (containment_rate × average_loss_prevented) ÷ cost_per_intervention
```

Two costs per 3-minute intervention, both sourced 2026-10-02:

| Component | Cost |
| --- | --- |
| Conversational AI (ElevenLabs Agents, Business tier) | **$0.080/min → $0.24/call** |
| Outbound voice (carrier) | ⬜ **INPUT REQUIRED** — destination-specific per-minute rate |

The carrier rate is the one a banker will know to the decimal, and East African
mobile termination is expensive enough that a US domestic rate would discredit
the entire model. Pull it for the exact country before the meeting.

The honest presentation is a sensitivity table across containment rates of
10% / 20% / 30%, not a single optimistic figure — the range is more credible
and still overwhelming, because a prevented social-engineering loss is two to
three orders of magnitude larger than a phone call.

---

## 6. Scale path

Full model: **[`docs/CAPACITY.md`](CAPACITY.md)**.

The claim is not "we handle N concurrent calls". It is:

> Our capacity target is not 10,000 concurrent. It is to absorb a **35× burst
> over steady state within 60 seconds**, and to degrade in a defined, audited,
> risk-prioritised way when the burst exceeds provisioned capacity.

Worked from the model, with every input labelled EXTRAPOLATED or CALIBRATED:

| Case | Required concurrency | Verdict |
| --- | --- | --- |
| Steady state (200k txn/mo, 0.35% flag, 8× peak) | **0.38** | Trivial — and stopping here is how a platform meets a real campaign |
| Burst (8,000 customers in 40 min at 35% flag) | **210** | **5.25× over** the ElevenLabs Business ceiling of 40 |

Voice covers **57%** of that campaign. The remaining ~1,200 customers in a bank
whose cards are being attacked must be reached another way, in minutes, while
the attack is still happening — which is why the degradation ladder and the SMS
fallback exist, and why every shed decision writes an audit row.

**Horizontal scale.** Control plane is stateless behind Caddy; realtime uses the
Socket.IO Redis adapter so any instance serves any socket; the dial path is a
durable Postgres queue claimed with `FOR UPDATE SKIP LOCKED`. Connection
arithmetic is written out in `docs/CAPACITY.md` §8 rather than left to be
discovered under load.

**Deployment.** In-region (UAE) for a GCC pilot; the Docker/Caddy topology
already supports VPC deployment inside the bank's perimeter.

---

## 7. Integrity ladder — state it at its true level

| Level | What you have | Claim you may make |
| --- | --- | --- |
| **L1** | Discovery call with a named contact | "In active discussion with [institution], [role]" — only with written permission to name |
| **L2** | Letter of intent or support on letterhead | "Named pilot commitment from [institution]" + attach the letter |
| **L3** | Signed pilot agreement | "Contracted pilot, starting [date]" |
| **L4** | Shadow deployment on their data | "Pilot in production shadow mode since [date]" |

⬜ **INPUT REQUIRED** — which level are we actually at today?

**Target for submission (14 Oct):** one L2 plus two L1s.
**Target for Demo Day (26–27 Oct):** one L3, or an L4 shadow readout with real
transcripts.

Two hard rules:

1. **Never name an institution publicly without written permission.** It can end
   the relationship, and it looks worse to judges than having no name at all.
2. **Never inflate a level.** Financial-services judges detect this instantly,
   and once they do it contaminates how they read the other four scores. An
   honest L2 beats a dressed-up L1 by a wide margin.

---

## 8. The caller-ID paradox

Answer this before anyone raises it. An anti-fraud system that phones customers
from an unknown number is indistinguishable from a fraud call, and a fraud head
will spot this within five minutes.

1. Caller ID presents the institution's published inbound number — requires
   their written authorisation plus carrier verification, which has lead time.
2. Pre-notification via the institution's app or SMS immediately before the dial.
3. A case reference the institution's own channels can confirm.
4. The agent **never** requests PIN, password, OTP, CVV or full card number, and
   states this in the opening seconds. Enforced server-side by strict tool
   schemas, not by prompt.
5. A published callback number reaching the institution's real line, so a
   suspicious customer can verify independently and stay protected.

Full treatment: **[`docs/TRUST-MODEL.md`](TRUST-MODEL.md)**.

---

## 9. What still has to be written

Everything below is a real gap, not a formality.

| Artifact | Status |
| --- | --- |
| Named institution + contact + date | ⬜ INPUT REQUIRED |
| 25-name target list with a named human each | ⬜ INPUT REQUIRED |
| Their fraud loss per uncontested case | ⬜ INPUT REQUIRED |
| Carrier per-minute rate for the pilot country | ⬜ INPUT REQUIRED |
| LOI sent | ⬜ INPUT REQUIRED — template exists at `docs/LOI-TEMPLATE.md` |
| Phase 0 shadow readout | ⬜ INPUT REQUIRED — needs their data |

Supporting artifacts that **do** exist: `docs/PILOT-BRIEF.md`,
`docs/LOI-TEMPLATE.md`, `docs/SECURITY-QUESTIONNAIRE.md`,
`docs/TRUST-MODEL.md`, `docs/UNIT-ECONOMICS.md`, `docs/CAPACITY.md`.
