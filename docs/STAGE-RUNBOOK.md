# The 3-minute stage runbook

A demo is a **performance**, not a walkthrough. Everything below is scripted to
the second because improvisation costs the one thing a live demo cannot buy back:
the judge's attention.

**Total: 180 seconds. Three acts: the problem, the proof, the argument.**

---

## 0:00–0:20 — The Hook

1. Play a **10-second clip of a real vishing call** — _"Sir, please confirm the OTP
   we just sent…"_ — from the laptop speaker. No slides before this. It is the only
   ten seconds nobody can interrupt.
2. Land it: _"Last year, this call worked thousands of times. We built the
   anti-version."_

**Why it opens this way:** the product's hardest question is "you're another
impersonator". Opening with the attack means the answer is already on the table
before anyone has to ask it — so the demo reads as a defence rather than a demo
that needs defending.

---

## 0:20–0:50 — Live browser demo (the "Yes" path)

Teammate speaks to the AI in the widget. Show, in this order:

- The **emerald flash** as the state machine advances on screen.
- The **latency badge** — measured p50/p95, not a spinner.
- The **typewriter transcript** with interim/final distinction visible.

Do not narrate the UI. Point at the state transition and say nothing.

---

## 0:50–1:20 — The "No" path

Teammate says _"I didn't make this."_

- **Crimson flash** → "Account temporarily restricted" toast.
- **SMS fallback preview** — show that the customer has an out-of-band anchor.
- **Webhook payload visibly firing** in a terminal window.

Then say the line, unprompted, because nobody will remember it if you do not:

> "The call also tells the customer to hang up and call the bank back. A fraudster
> can never afford to say that."

---

## 1:20–2:00 — Command Center

In order, no detouring:

1. **Pre-seeded interventions** and the **audit trail** — "Fired by John, 10:04 AM".
   Scroll so the hash chain is visible.
2. **Org switcher → the Operator Desk org.** Watch the wallet go to **0**.
3. **Fire an intervention** → the **Contact Sales** modal appears.
4. Say the business line while the modal is up: _"We monetise per verified
   intervention."_
5. Settings → **Knowledge tab**: one uploaded policy, status pill **Ready**, then
   one test search returning a scored chunk.

The 0-credit org and the 10,000-credit demo org are the monetisation story and the
tenant-isolation story in the same twenty seconds.

---

## 2:00–2:40 — One architecture slide

Bank webhook → QStash → Twilio Media Streams → WS server → Deepgram → LLM →
ElevenLabs → mulaw. Then, only if asked:

- Redis pub/sub for multi-instance fan-out (Tier 3 — documented, not built).
- `me-central-2` for PDPL residency — see `docs/UAE-REALITY.md`.

**Do not tour the diagram.** Point at the three boxes that carry the argument:
QStash (the bank's HTTP request returns in milliseconds and never touches a
carrier), the audit chain (tamper-evident, per-case), and the vishing blocklist
(the last gate before audio).

---

## 2:40–3:00 — Close

Two sentences, in this order:

1. **Economics**: _"A human callback costs AED 15–40. We cost about a dirham. One
   prevented AED 50,000 fraud pays for roughly 25,000 interventions."_
2. **Trust**: _"We don't just stop fraud. We make the bank's voice verifiable
   again."_

---

## Failure contingencies — non-negotiable

| Risk                                          | Mitigation                                                                                                                                                                           |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Mic permission dialog on stage                | **Grant before you go on.** Leave the tab warm and the widget loaded.                                                                                                                |
| Live mic fails or the room is noisy           | **"Call my phone" is not a fallback — it is the better demo.** A teammate's phone ringing on the speaker is theatrically stronger than a browser widget. Keep the number pre-dialed. |
| ElevenLabs lags, or the network dies mid-call | **Pre-rendered screen recording of this exact demo**, cued on a second laptop.                                                                                                       |
| Intermittent network                          | **Local hotspot**, VPN off, tether the second laptop to it too.                                                                                                                      |
| TTS latency gap                               | The filler-audio path ("one moment, sir…") masks up to ~1.5s — and it is a real feature, not a trick: _"We mask TTS latency with natural back-channel audio."_                       |

**The rule behind the table:** never let an audience watch a loading spinner.
Either the demo works or you are already holding the pre-rendered clip.

---

## Rehearsal

- Rehearse **full**, standing, out loud, **five times**. Not reading the runbook.
- Time each act. An act over budget gets cut from the _next_ rehearsal, not from
  the live run.
- The person driving the browser is not the person talking. Two roles, always.
- Before every run: **reload the tab, re-grant the mic, confirm the org switcher
  flips, confirm the 0-credit modal still fires.** All four, every time. A
  rehearsed demo that breaks on a warm cache teaches you nothing about the demo.
