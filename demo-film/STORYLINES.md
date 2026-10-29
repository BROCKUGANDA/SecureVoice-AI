# Storylines — SecureVoice demo film

Three different films, not three titles on one film. Each has its own world, device and
form. **A is the recommendation** — it is the only one whose first frame is the product
already working, which is the whole point of a demo built from real screens.

Every frame referenced here is a real capture of production (`securevoiceai.me`, version
`160001a74cde`), taken by `scripts/walkthrough/capture-real.mjs`. No mockups.

**Assumption line (everything else is decided here unless you say otherwise):** 30–40 s,
1920×1080 at 30 fps, music bed plus the product's own recorded voices, no voiceover
narration, and no paid voice or avatar (the product's own TTS is free and is the real
thing).

---

## A · "The line stayed open" — RECOMMENDED

_Device:_ the result first. _Form:_ one continuous take, no cuts.

**What the viewer sees and feels:** the film opens on the agent already speaking — the
real Arabic reply, mid-sentence — and the camera pulls back to reveal a browser tab where
a person spoke to it and got a staged freeze plus a human review. It feels like a call
that happened, not a demo that was staged.

**First two seconds:** the agent's real Arabic reply fills the frame ("هذه المكالمة
مسجلة لحمايتك…"), then a fast pull-back reveals the live panel with the transcript and
the intent chips.

**Beats:** hook (the agent speaking) → pull back to the panel → the spoken turn (ASR
2.2 s) → the agent answers and the chips land → the six languages match-cut → the
one-line claim → end card.

**Look:** the product's own light ground (cream), dark ink, the site green as the single
accent; the site's own type; the real panel is the only material.

**Sound:** the agent's own recorded voice under a low bed; no narration.

**Frames:** `conversation-ar-replied` (hook), `conversation-spoken` + `-panel` (the turn),
`conversation-{en,hi,ur,fr,sw}-panel` (the languages), `home` (end card context).

---

## B · "Sixty seconds, then a human"

_Device:_ a number lands. _Form:_ cut on the beat.

**What the viewer sees and feels:** the real SLA clock against the real frames — a signal,
the agent calling, the customer saying no, the freeze staged, a specialist taking over.
The clock is the antagonist.

**First two seconds:** the hero line "no phone number, no sign-up" over the mic circle,
then a hard cut on the beat to the agent's reply.

**Beats:** hook (the promise) → the signal → the call (spoken turn) → the freeze staged →
the human specialist → the number → end card.

**Look:** the same ground and type; the number as the only overlay, in the site green.

**Sound:** the real agent voice lands on the cut; music cuts with it.

**Frames:** `home` (hero), `conversation-spoken` (the call), `conversation-en-replied`
(the freeze staged), `pricing` (the number's context).

**Known gap:** the alert→queue→specialist beats live in the signed-in console, which the
bot gate keeps out of capture. Those beats would be the real numbers as text over real
frames, not screens — honest, but weaker than A.

---

## C · "Six languages, one outcome"

_Device:_ one object across apps. _Form:_ match cuts.

**What the viewer sees and feels:** the same card question asked in six languages; each
gets its own agent voice; the outcome never changes. It feels like one product speaking
to every customer in the UAE.

**First two seconds:** the mic circle in the panel, then a match cut on that circle into
the first reply.

**Beats:** hook (the mic) → EN → AR → HI → UR → FR → SW (match cuts on the panel) → the
identical outcome → the claim → end card.

**Look:** the same ground and type; the match cut carries on the mic circle; each
language's real reply.

**Sound:** six real agent voices in sequence, one per beat — the product's own voices, so
no music is needed under them.

**Frames:** the six `conversation-*-panel` crops, then `conversation-spoken-panel`.

---

## Verified facts available to any storyline (all from real sources)

- Agent routing latency on a typed turn: **127–147 ms** in English/Arabic, **999 ms** in
  Swahili (the slowest voice, still sub-second).
- Spoken turn: **ASR 2.2 s**, **turn 2.3 s** — the customer speaking to a live answer.
- Agent locales spoken, each with its own disclosure: **EN-UK, AR-GULF, HI-IN, UR-UAE,
  FR-FR, SW-KE**.
- Intent chips the agent actually produced: `intent: deny_fraud`, `action: card_freeze`,
  `routed by rules`.
- The agent's real reply: disclosure, apology, _"I have flagged this transaction as fraud
  and placed a temporary restriction on your card while a human fraud specialist reviews
  it."_
- Agent-testing evidence (from `evidence/guardrails/`): **86.2 %** multi-run pass rate in
  English, **89.3 %** in Arabic; tool-call criterion **87.5 %** / **100 %**.
