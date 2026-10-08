# The recorded walkthrough (submission box L)

A narrated, scripted tour of the platform, recorded against the running app —
not slides. The final cut is `scripts/walkthrough/out/video/take.webm`
(**2:37**). Everything on screen is the product: the public overview, the
operator console, the guided simulation, the Security page and the compliance
dashboard, in that order, with the narration and the agent's own call audio
mixed under the screen capture.

> The `out/` directory is **generated** (gitignored). The cut currently on
> disk was recorded **before the identity cutover to self-hosted auth**, so its
> scene-03 caption still reads "Clerk holds the identity". The authoritative
> script (`scripts/walkthrough/scenes.mjs`) already says "Self-hosted identity —
> no stored passwords". Re-run the pipeline before submitting so the take
> matches the source (see [Re-recording](#re-recording)).

## What the video shows

| #   | Scene                                | On screen                    | The point                                                                                                                                                                         |
| --- | ------------------------------------ | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 01  | The gap — _38 minutes vs 60 seconds_ | Title card                   | A fraud case takes an analyst 38 minutes to work; a fraudster needs seconds.                                                                                                      |
| 02  | The pitch                            | Public overview, scrolled    | The claim is narrow by design: detect, call the customer, freeze the account, leave a verifiable audit trail. Docs and Security ship with the product.                            |
| 03  | Access                               | Sign-in → operator console   | Role-gated access: an operator seat gets full access, a demo seat only the guided simulation. Self-hosted identity; no stored passwords.                                          |
| 04  | Command Center                       | Live intervention feed       | Recent interventions with risk score and language, delivery state per leg, the audit chain behind each case. Pushed over SSE, not polled.                                         |
| 05  | The voice agent                      | Guided simulation, full call | A signed risk signal (AED 2,500, new device, high-risk location) becomes an outbound call in seconds. The agent discloses, verifies, freezes — phase by phase.                    |
| 06  | Compliance                           | Security page                | Every call opens with a disclosure; PIN/OTP/password requests are refused server-side, not by asking the model nicely; PII is redacted before persistence.                        |
| 07  | Multilingual                         | Same simulation, Arabic      | The customer's language is the agent's language — Arabic routes to a different voice identity (Fatima, Gulf Arabic), same disclosure, same guardrails, bilingual transcript.      |
| 08  | Evidence                             | Compliance dashboard         | Every action is a row in an immutable audit log: sha256 over the canonical serialisation, chained to the row before it. Editing any field breaks the link from that point onward. |
| 09  | Outcome                              | Title card                   | Frozen in 60 seconds — in the customer's own language, with a chain that proves itself afterwards.                                                                                |

## The narration script

The full voiceover, verbatim from `scripts/walkthrough/scenes.mjs` (the source
of truth the pipeline speaks):

> **01** — A bank's fraud engine flags a case; an analyst takes nine minutes to
> see it and thirty-eight to work it. A fraudster needs seconds. SecureVoice AI
> closes that gap — the platform, live.
>
> **02** — The public overview, and the claim is narrow by design: detect, call
> the customer, freeze the account, leave an audit trail a regulator can
> verify. Docs and Security sit right beside it.
>
> **03** — Access is role-gated. This session is stamped operator — full
> access. A demo seat gets a different badge and only the guided simulation.
> Identity is self-hosted; no passwords live in the browser.
>
> **04** — That's the Command Center: recent interventions with risk score and
> language, delivery state for every leg, and the audit chain behind each case.
> The feed is pushed, not polled.
>
> **05** — The guided simulation replays a real case without dialling anyone.
> A signed risk signal arrives — twenty-five hundred dirhams, new device,
> high-risk location. The agent opens with a disclosure, verifies the payment,
> then freezes the card.
>
> **06** — Three things make this safe to put in front of a customer. Every
> call opens with a disclosure. The agent never asks for a PIN, an OTP or a
> password, and that is enforced on the server rather than by asking the model
> nicely. And personal data is redacted before it reaches the database.
>
> **07** — The customer's language is the agent's language. Switching the call
> to Arabic routes to a different voice identity — Fatima, Gulf Arabic — same
> disclosure, same guardrails, a bilingual transcript on screen. Each language
> carries its own voice, so it never sounds translated.
>
> **08** — And on the compliance side, every action is sealed as a row in an
> immutable audit log: a sha256 hash over the canonical serialisation, chained
> to the row before it, so editing any field breaks the link from that point
> onward. Filter, actor, detail, hash — the list an auditor recomputes.
>
> **09** — Fraud detected, customer called, account frozen — sixty seconds
> instead of thirty-eight minutes, in the customer's own language, with an
> audit trail that proves itself afterwards. That is SecureVoice AI.

## Every claim in the video is gated in the repo

| Claim made on screen                     | Where the repo proves it                                                              |
| ---------------------------------------- | ------------------------------------------------------------------------------------- |
| Signal → call in seconds                 | `evidence/dial/summary.json` (dial-path latency gate, WP-2)                           |
| Disclosure, verification, freeze phases  | `tests/e2e/dial.test.ts`, agent pipeline in the guided simulation                     |
| No PINs/OTPs/passwords — server-enforced | `evidence/guardrails/tools.json`, `evidence/guardrails/redteam-server.json`           |
| PII redacted before persistence          | `evidence/privacy/privacy.json`; payloads sealed at rest (`evidence/` privacy gates)  |
| Voice identity per language              | Scene 07 of the simulation; `docs/VERIFICATION.md`                                    |
| Immutable sha256 audit chain             | `evidence/` chain-verification invariants (I-6), re-verified by every retention sweep |

## Re-recording

The pipeline lives in `scripts/walkthrough/` and refuses to record on a red
light: preflight checks `/api/status` and **fails if telephony is configured**
(a product demo must never dial a real customer) or the voice provider is not
ElevenLabs.

```sh
cd scripts/walkthrough
npm install            # once; pulls the pinned Playwright
node run.mjs           # full preflight + capture + narrate + assemble
node run.mjs --dry-run # preflight only
```

Before recording:

1. Start the app (`bun run dev` on port 3001 — the capture base URL) with
   `TWILIO_*` blank and a real `DATABASE_URL`.
2. Sign in once manually in the capture browser profile; the session is
   reused, the scripted scenes never type credentials.
3. The step list is data (`scenes.mjs`), so a scene that fails its
   `text:`/`click:` assertion fails the take rather than recording a broken
   screen.

Outputs land in `scripts/walkthrough/out/`: per-scene narration in `audio/`,
rendered title/caption cards in `card/`, per-scene cuts in `clip/`, per-scene
still frames in `frame-*.png`, the timing manifest in `manifest.json`, and the
final mux in `video/take.webm`.
