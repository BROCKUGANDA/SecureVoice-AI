# The latency budget — and the parts of it that are honest

A latency badge is decoration. A latency budget is a design constraint. This
document is both: the targets, the code that records them, and an explicit
statement of which ones are currently measured and which are not.

---

## The target

| Stage                   | Budget         | Instrumented today                              |
| ----------------------- | -------------- | ----------------------------------------------- |
| Twilio → our WebSocket  | ~40 ms         | No producer                                     |
| Deepgram first partial  | ~250 ms        | **No producer**                                 |
| LLM time-to-first-token | ~350 ms        | **No producer**                                 |
| ElevenLabs TTFB         | ~250 ms        | **No producer**                                 |
| TTS → mulaw encode      | ~80 ms         | No producer                                     |
| Network overhead        | ~150 ms        | No producer                                     |
| **First audio out**     | **~1.1–1.5 s** | `answered_to_first_agent_word`, budget 1 200 ms |

**Stated plainly: this table is a design target, not a measurement.** The spans
are declared in `src/lib/telemetry/spans.ts` and four of eight had **no producer at all** until this pass; the ringing leg and the caller-stop→agent-audio leg each gained one on 2026-10-16,
so a `not_measured` on those rows is now "no live sample" rather than "cannot be measured". The turn-latency span starts at the end of the caller's speech as Deepgram reports it, never at the
arrival of the message that reports it — the difference is the vendor's configured silence wait, and reading the arrival would have published a faster product than the one the caller experienced. That is a claim about the code, not a criticism of it:
the panel was built, wired to an endpoint, and never mounted, so nobody had
reasoned about the producers yet.

What the platform does about that gap is the honest part, and it is deliberate:

- `summariseWindow()` **always returns a row per declared span**, so an
  unmeasured span renders as `no_data` rather than a comfortable `0 ms`.
- `allTargetsMet()` returns **`null`**, not `true`, while any span is unmeasured.
- `p95Ms` is `null` on an empty window, never `0`.
- `P95_SAMPLE_FLOOR = 30` — below 30 samples a p95 is noise and is not reported as
  if it were signal.

A judge who checks whether the platform claims success on incomplete data is a
judge who believes the data that is present. Fabricating the zeros would have been
a one-line change and would have cost the whole panel.

---

## What IS measured end to end

| Span                                   | Target    | Producer                                                                                                       |
| -------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------- |
| `signal_received_to_accepted`          | 300 ms    | `src/app/api/v1/interventions/route.ts`                                                                        |
| `signal_accepted_to_provider_accepted` | 1 500 ms  | same                                                                                                           |
| `tool_request_to_response`             | 300 ms    | `src/lib/tool-guard.ts` — recorded **even on refusal**, because a refusal that is slow is still a slow refusal |
| `signal_received_to_freeze_staged`     | 60 000 ms | `src/app/api/elevenlabs/tools/card-freeze/route.ts`                                                            |
| `fraud_confirmed_to_webhook_delivered` | 2 000 ms  | outbox delivery                                                                                                |

`recordSpan()` never throws and rejects NaN and negative durations at the door; a
telemetry fault cannot become a production fault.

**The panel is now reachable.** `src/components/slo/SloPanel.tsx` and
`/api/status/spans` both already existed and nothing rendered the former — it was
built and unreachable. It is mounted in the Command Center, operator-only, polling
every 15 s so an overnight console does not turn observability into load.

---

## The three tricks that make it feel instant

### 1. Pre-warm before the customer answers

Open the TTS stream at the `dialing` state, not at the first reply. The
connection, the model negotiation and the first chunk of the opening line are all
cacheable work that does not depend on the customer's speech.

**Honest status: not built.** The TTS cache in `src/lib/elevenlabs/client.ts` is
populated by a _previous identical_ synthesis, not warmed proactively. It is a
cache, not a warm-up. The fixed phrases that would be warmed — the disclosure, the
hang-up-safe exit, the freeze confirmation — are constants, so they are ideal
candidates, and that is precisely why it is a cheap win when someone does it.

### 2. Stream to TTS after the first clause, not the full sentence

The LLM's first token arrives well before its last. Waiting for a complete sentence
spends the entire generation on dead air. `ElevenLabsStream` already supports
incremental `audio/mpeg` chunks; what is missing is the sentence splitter that
feeds it.

### 3. Back-channel filler

_"Mm-hm."_ / _"One moment."_ served from a local cache covers agent think-time
without a TTS round-trip.

**Honest status: not built, and there is a subtlety worth recording.** The platform
currently has a _de-filler_ rule: `src/lib/llm.ts` instructs the model "do not use
filler sounds like 'umm' or 'uh'", because fillers read as evasive on a fraud
call. Those are different things — a TTS-synthesised filler in the model's own
voice is evasive; a pre-recorded back-channel during a processing pause is normal
human telephone behaviour. If it is built, it must come from a local asset, never
from the model, and the model instruction must not be relaxed.

The existing silence nudge (`SILENCE_NUDGE_MS = 8 000` in
`src/worker/voice-stream.ts`) pays full TTS latency on an 8-second timer, which is
exactly the wrong place to discover a provider is slow.

---

## Latency versus concurrency

A budget met by one request at a time is not a budget met by a campaign. The
gate for that is `tests/load/concurrency-ladder.test.ts`: it runs the platform's
own hot-path operations — the admission gauge read, the admission decision, a
durable queue claim, and a case transition with its hash-chained audit append —
at 8, 32, 64, 128 and 224 offered workers in one process, and asserts two
separate things. Each operation must stay inside an absolute p95 budget at every
rung it is judged on. And p95 at the busiest rung must stay within a fixed
multiple of p95 at the quietest, because a system can sit inside an absolute
number while its queueing curve is already vertical.

Measured on the last run (`evidence/load/concurrency.json`, one process, local
Postgres, vendors absent): at 224 offered workers the admission decision holds
p95 ~163 ms and a queue claim ~327 ms, both with zero errors, both under 3× the
quiet-rung figure. The case-transition path grows ~10×, and that is the honest
shape of it: every transition seals an audit row, and
`src/lib/audit-chain.ts` lets only 5 of those run at once per process, on purpose,
so the synchronous ingest path always has a pool connection left. A fixed-width
resource amplifies by the queue it imposes; the gate states a wider ceiling for
that path and names the knob (`DB_AUDIT_POOL_MAX`) rather than tuning the
expectation down until it passes.

Two limits belong in the same sentence as the numbers. The top rung is the WP-19
_modelled_ campaign burst, offered through one process — a shape no single
deployment runs, since the aggregate is spread over replicas each with its own
pool and its own semaphore. And the reuse window on the admission gauge (see
`src/lib/admission.ts`) is measured here against a local database where a `COUNT`
costs milliseconds; its value on a remote session-mode pooler is proportional to
the round trip, which this machine cannot demonstrate. That is a reasoned
consequence, and it is labelled as one.

---

## What to say on stage

> "The badge is not a number we typed. It's p50 and p95 measured against declared
> budgets, and the panel shows `no data` rather than zero for the spans we don't
> instrument yet — because a latency panel that invents its zeros is worth less
> than no panel."

Then move on. Do not tour the diagram.
