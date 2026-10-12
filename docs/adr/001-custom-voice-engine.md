# ADR-001: Custom Node.js voice engine over Retell AI / Vapi

## Context

A fraud-verification call has to bridge four vendors the customer never sees: Twilio
carries the audio, Deepgram transcribes it, an LLM classifies intent, ElevenLabs speaks
the answer. Off-the-shelf orchestration platforms exist for exactly this and would
have removed weeks of work.

The reason not to buy is not cost or pride. It is that this product's obligations are
specific and its failure modes are audible:

- The disclosure that the caller may hang up and phone the number on the back of the
  card is a compliance requirement, not a UX preference. It has to be the _first_
  thing said, and it has to survive the agent being mid-sentence.
- The agent must never ask for an OTP, password or card number — enforced in the
  transcriber's own output path, not in a prompt that can be argued with
  (`src/lib/compliance/never-ask.ts`).
- A prayer-time window defers a non-critical call; the do-not-call registry outranks
  the fraud score except for time-critical verification. Both are routing rules
  inside the call pipeline.
- Silence is the worst outcome. Every layer must answer with something, and the
  customer must hear it within a bounded time.

A wrapper exposes a callback surface. Anything that is not in that surface —
barge-in on interim transcripts, the word cap on spoken output, the freeze-staged
audit write that must complete before the confirmation sentence is spoken — becomes a
feature request against someone else's roadmap.

## Decision

Run our own Bun WebSocket worker against Twilio Media Streams:
`src/worker/voice-stream.ts` receives μ-law frames, `src/lib/voice/mulaw-codec.ts`
decodes, `src/lib/voice/deepgram-client.ts` streams to nova-2 pinned to the _call's_
language, intent is routed deterministically in `src/lib/ai/router.ts`,
and `src/lib/voice/elevenlabs-stream.ts` streams synthesis back as the same encoding
Twilio asked for.

Two consequences of owning it, both deliberate:

- The worker is a separate compose service, so a long chain verification or a slow
  vendor can never occupy an HTTP request or stall the web tier.
- The plane is not one path. A TwiML turn loop (`src/app/api/twilio/turn/route.ts`)
  serves the LLM plane, and the ElevenLabs agent with MCP tools serves the other. The
  duplication that created a fourth, dead path is being removed, not defended.

## Consequences

**Positive.** Every compliance rule above is a line of code with a test, not a
configurable knob in another company's console. Latency is measured where the promise
is made (`answered_to_first_agent_word` starts when the turn is decided, not when the
request arrives). A vendor outage is handled in our own process: the ElevenLabs key
pool fails over, PlayHT is next, and pre-recorded emergency audio is last.

**Negative, stated plainly.**

- We own binary audio transcoding and a WebSocket state machine, including the bugs
  that only appear on a real carrier: a dropped transcription socket now redials once
  and then ends the call aloud, and idle-timeout behaviour had to be measured against
  a live leg, not reasoned about.
- Barge-in is not true full duplex. It interrupts on an interim transcript; it cannot
  mix our audio and the caller's into one stream.
- A pre-warmed socket pool per language is our latency optimisation, which means it
  is also our leak to bound and our stale state to invalidate.
- The dead duplicate plane still ships, and a caller can reach it. Tracked, not
  fixed.

## Evidence

`src/worker/voice-stream.ts` · `src/lib/voice/deepgram-client.ts` ·
`src/lib/voice/elevenlabs-stream.ts` · `src/lib/voice/mulaw-codec.ts` ·
`src/lib/ai/router.ts` · `src/lib/compliance/never-ask.ts` ·
`src/lib/elevenlabs/pool.ts` · `src/lib/elevenlabs/emergency-audio.ts` ·
`src/lib/compliance/prayer-times.ts` · `src/app/api/twilio/turn/route.ts` ·
`docker-compose.yml` (`voice-stream-worker`)
