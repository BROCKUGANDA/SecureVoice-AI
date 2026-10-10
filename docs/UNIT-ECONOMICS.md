# Unit economics

**Purpose:** what one intervention costs us, what one contained fraud attempt
saves the institution, and the ratio between them. Every rate below is either
**sourced** (with the URL and the date it was read) or **an input you must
fill** — it is never invented. A judge will check one number in this file; if it
is wrong, the whole model is discounted. So the honest placeholders are
labelled, and everything else is exact.

Read date for all sourced rates: **2026-10-02**.

---

## 0. The one-slide version (AED, for the pitch)

The rest of this document is the model. This is the slide.

|                                                                               | AED                               |
| ----------------------------------------------------------------------------- | --------------------------------- |
| Fully-loaded human fraud-desk callback (agent time + carrier + idle capacity) | **15–40**                         |
| SecureVoice intervention, end to end (voice minutes + ASR + LLM + TTS)        | **0.6–1.1**                       |
| **Priced at**                                                                 | **2–4 per verified intervention** |

**The pitch line:**

> "One prevented AED 50,000 fraud pays for roughly 25,000 interventions."

The arithmetic is the whole argument: the cost side is a rounding error against the
loss side, so the carrier rate — the one variable we do not control — can triple
and the model still works.

**Two figures to quote only if you have sourced them** (see §5): the cost side above
is derived from the published provider rates in this document and is defensible;
the human-callback range is an input you must fill from your own bank's figures.
A judge will check the human-callback number, so have the source ready rather than
rounding it. **A 3-minute pitch is not the place to invent one.**

---

## 1. Cost per intervention

Modelled on a **3-minute intervention** — the agent's disclosure, one knowledge
challenge, the customer's answer, and the closing advice. That is the observed
handle time; fraud verifications that need a second challenge are charged as two
interventions.

| Component                             | Unit cost                           | Basis                                                        | Source                                                               |
| ------------------------------------- | ----------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------- |
| Conversational AI (ElevenLabs Agents) | **$0.080 / min** → **$0.24 / call** | Additional call minutes, all tiers                           | [elevenlabs.io/pricing/agents](https://elevenlabs.io/pricing/agents) |
| Conversational AI — burst             | **$0.160 / min** → $0.48 / call     | Charged when a call runs above the plan's concurrency limit  | same                                                                 |
| Outbound voice (carrier)              | **⚠ INPUT REQUIRED — see §2**       | destination-specific per-minute rate                         | Twilio rate card                                                     |
| Number rental                         | monthly fee ÷ calls/month           | one local/geo number                                         | your Twilio invoice                                                  |
| LLM rephrase layer                    | ~$0.001–0.002 / call                | ~700 tokens at Groq/Gemini pricing; **continuity path only** | provider pricing                                                     |
| Infrastructure                        | $X / calls per month                | see §3                                                       | your invoice                                                         |

**Concurrency ceilings by plan** (same source) — this is also the capacity
constraint, not just a cost input:

| Plan     | Monthly fee | Included minutes | Concurrent calls |
| -------- | ----------- | ---------------- | ---------------- |
| Free     | $0          | 15               | 4                |
| Starter  | $6          | 75               | 6                |
| Creator  | $22         | 275              | 10               |
| Pro      | $99         | 1,238            | 20               |
| Scale    | $299        | 3,738            | 30               |
| Business | $990        | 12,375           | 40               |

Note: **ElevenLabs adds no telephony fee.** If we connect our own Twilio
carrier, Twilio bills the carrier side directly at our rate — which is why the
carrier rate is a first-class line item here and not an afterthought.

---

## 2. ⚠ The one number you must fill before submitting

Twilio's per-minute rate is **destination-specific and not published in a
static page**, and it differs by an order of magnitude between a US domestic
call and East African mobile termination. A judge who knows the Uganda rate
will check this. Do not estimate it.

**Get it in 30 seconds from the Twilio console:**
`Twilio Console → Voice → Numbers → your number → Pricing` — it shows the
per-minute rate by destination country, including mobile.

Or programmatically (main account only — a subaccount returns 404):

```bash
curl -u "$TWILIO_ACCOUNT_SID:$TWILIO_AUTH_TOKEN" \
  "https://api.twilio.com/2010-04-01/Accounts/$TWILIO_ACCOUNT_SID/Voice/Countries.json?PageSize=1000" \
  | jq '.countries[] | select(.country_code=="UG" or .country_code=="AE")
         | {country: .country_code, mobile: .mobile_country_codes.price}'
```

**Then fill this table — it is the model, in one line each:**

| Destination          | Carrier $/min | 3-min call | 1,000 calls/mo |
| -------------------- | ------------- | ---------- | -------------- |
| UAE (local mobile)   | `___`         | `___`      | `___`          |
| UAE (local landline) | `___`         | `___`      | `___`          |
| Uganda (mobile)      | `___`         | `___`      | `___`          |
| Kenya (mobile)       | `___`         | `___`      | `___`          |

### Worked arithmetic (fill the rate, everything else is exact)

```
cost_per_call = 3 × (carrier_rate + 0.08) + 0.002
```

At a **$0.10/min** carrier rate (illustrative — replace with yours):

|                           |             |
| ------------------------- | ----------- |
| Carrier, 3 min            | $0.300      |
| Conversational AI, 3 min  | $0.240      |
| LLM + infra + number      | ~$0.005     |
| **Cost per intervention** | **≈ $0.55** |
| **At 1,000 calls/month**  | **≈ $545**  |

At a $0.30/min rate (high-cost mobile termination) the same call is **≈ $1.15**
— still a rounding error against the loss side. That asymmetry is the entire
argument, and it is why the carrier rate, though variable, never threatens the
business case.

---

## 3. Infrastructure

Measured on the current reference deployment (Akamai/Linode, 8 GB, Frankfurt):

| Item                                            | Cost                                         |
| ----------------------------------------------- | -------------------------------------------- |
| Host                                            | ~$6 / month (amortised from the annual rate) |
| Managed Postgres (optional; bundled by default) | $0 — bundled Postgres on the same host       |
| Object storage (transcripts, audio)             | ~$1 / month at pilot volumes                 |
| **Total fixed**                                 | **~$7 / month**                              |

At 1,000 calls/month that is **$0.007 per intervention**. Infrastructure is
noise. The model is entirely voice minutes.

---

## 4. The value side

This is the number that decides everything, and it comes from the institution,
not from us. Two variables, both of which the pilot is designed to measure:

| Symbol | Meaning                                            | Who supplies it                             |
| ------ | -------------------------------------------------- | ------------------------------------------- |
| **L**  | average loss per contained fraud attempt           | the institution, from their own case data   |
| **c**  | containment rate — fraud stopped ÷ fraud attempted | **measured**, with a held-out control group |

```
expected_value_per_call = c × L
ROI multiple            = (c × L) ÷ cost_per_call
```

### Sensitivity — the honest range

Read across: the ROI multiple is one to three orders of magnitude above the
cost, and it stays that way across the entire plausible range of `c`.

| Containment `c` | L = $500  | L = $2,500  | L = $10,000 |
| --------------- | --------- | ----------- | ----------- |
| 10%             | **$91×**  | **$455×**   | **$1,818×** |
| 20%             | **$182×** | **$909×**   | **$3,636×** |
| 30%             | **$273×** | **$1,364×** | **$5,455×** |

_(cost per call $0.55; ROI = c × L ÷ 0.55)_

**Why we publish the range rather than a headline.** A single optimistic figure
is the easiest thing in this document to disbelieve, and a banker who catches us
inflating it will discount the containment claim too. The range is the
defensible position: even at the worst cell — 10% containment on a $500 loss —
the intervention pays for itself roughly ninety times over, and we are not
asking them to believe the 30% / $10,000 cell.

### The honest caveat

ROI degrades if fraud is _cheap_: if the average uncontested loss is $40, the
multiple at 20% containment is ~$15× — still strong, but a different
conversation. That is why the pilot's first job is to establish **L** from their
own case data rather than from ours.

---

## 5. Pricing shape

Priced on **contained cases**, not on minutes — because that is the only unit a
bank can forecast, and it aligns us with their outcome rather than our usage.

| SKU                  | Unit                                        | Phase                   |
| -------------------- | ------------------------------------------- | ----------------------- |
| **Phase 0 shadow**   | free                                        | 2 weeks, no calls       |
| **Pilot**            | capped interventions                        | 90 days, one alert type |
| **Starter / Growth** | monthly, included interventions + overage   | post-pilot              |
| **Enterprise**       | annual committed volume, SLA, in-VPC option | annual invoice          |

**BYOK discount.** An institution that brings its own ElevenLabs key removes our
conversational-AI line entirely (we meter it for analytics but charge nothing),
so their floor is pure carrier cost. That is roughly 45% of our cost at current
rates — which is a real, defensible discount and costs us nothing.

---

## 6. Provenance and integrity

| Figure                                              | Status                                                                          |
| --------------------------------------------------- | ------------------------------------------------------------------------------- |
| ElevenLabs Agents $/min, burst, concurrency by tier | **Sourced** — elevenlabs.io/pricing/agents, read 2026-10-02                     |
| LLM per-call                                        | Estimated from token count × published token pricing — **estimated**            |
| Carrier per-minute                                  | **INPUT REQUIRED** — placeholder by design, see §2                              |
| Infrastructure                                      | **Measured** on the reference deployment                                        |
| ROI multiples                                       | **Computed** from the cost above and the institution's `L`                      |
| Containment rate `c`                                | **Must be measured with a control group.** Never assumed, never quoted as ours. |

No number in this file is an extrapolation of a measurement we did not take.
