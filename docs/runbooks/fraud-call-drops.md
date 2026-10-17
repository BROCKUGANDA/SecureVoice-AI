# Runbook: fraud calls dropping or hanging

Manual incident response. Read in order; each step is the cheapest check that
distinguishes the candidate causes. For a vendor-side outage with a known cause,
use the playbook instead: [`../playbooks/elevenlabs-outage.md`](../playbooks/elevenlabs-outage.md).

## 0. Triage in one command

```sh
curl -s https://securevoiceai.me/api/readyz | jq '{status, checks: [.checks[] | {name, ok, detail}]}'
```

`status: "degraded"` names the failing check. `database` failing is a different
incident from `voice_provider` failing — do not start here and read everything.

## 1. Are calls not starting at all?

A signal that never becomes a call is an intake or gate problem, not a voice
problem.

```sh
docker compose -f docker-compose.yml -f docker-compose.bluegreen.yml logs --tail=300 app-blue | grep -i 'refus\|gate\|409\|402'
```

Every refusal carries a machine-readable code. The three that mean "correctly
refused, not broken":

| Code                  | Meaning                        | Action                                      |
| --------------------- | ------------------------------ | ------------------------------------------- |
| `credits_exhausted`   | Wallet empty (402)             | Fund the org; the call was never dialled    |
| `policy_precondition` | Consent/DNC/calling-hours gate | Expected on retries; do not retry unchanged |
| `transaction_repeat`  | Duplicate transaction (409)    | Expected; the first signal owns the case    |

A refusal rate near 100% with no successful dials is an ingest secret or policy
mismatch, not a carrier fault.

## 2. Are calls starting and then dying?

```sh
docker compose -f docker-compose.yml -f docker-compose.bluegreen.yml logs --tail=300 app-blue | grep -i 'twilio\|carrier\|callSid'
```

- **Reached carrier, no `answer` callback** — the carrier accepted it and the
  handset never rang. Check the destination format and the geo allowlist; a
  `blocked` carrier status is a policy answer, not a bug.
- **`answer` then immediate `hangup`** — the callee hung up. The platform sends
  the blind-ping SMS (`src/lib/sms-verdict.ts`) and waits for YES/NO.
- **No `answer` and no carrier error** — the media path. Continue to step 3.

## 3. Is the voice pipeline failing after answer?

```sh
docker compose -f docker-compose.yml -f docker-compose.bluegreen.yml logs --tail=300 app-blue | grep -i 'stt\|tts\|llm\|timeout\|budget'
```

The pipeline degrades on purpose, in this order:

1. **LLM timeout** → breaker opens (`src/lib/llm.ts`); the scripted-reply path
   keeps the call alive and coherent rather than silent.
2. **TTS timeout** → the per-request budget (`TTS_REQUEST_BUDGET_MS`) aborts the
   request instead of letting it run to completion, then the next key in the pool
   is tried.
3. **Both vendors cold** → SMS fallback. The customer still gets the alert and a
   way to answer.

A call that ends in a hangup with no SMS and no handoff is the real bug class:
it means the failure path itself threw. That is a Sev-1 and the trace to file is
in this repository's issue tracker.

## 4. Latency, not failure

If calls connect but customers interrupt ("are you still there?"), measure before
changing anything:

```sh
curl -s https://securevoiceai.me/api/status/spans | jq '.spans[] | select(.name=="answered_to_first_agent_word")'
```

`p95` against the 1 200 ms budget in
`src/lib/voice/latency-budget.ts` says whether the pipeline is slow or the
network is. A budget breach with no producer for the STT hop means the hop is
unmeasured, not fast — see `docs/LATENCY-BUDGET.md` for which hops have
producers today.

## 5. Escalation

- Customer-impacting and no fallback engaged → page immediately.
- Voice-only, SMS fallback covering every case → hold, but post the incident.
- One tenant only → check that tenant's policy gate and calling hours before
  treating it as a platform fault.

## After

Capture: the case reference, the span window, and the first failing log line. The
audit chain already holds the state transitions, so a post-mortem does not depend
on anybody remembering what happened.
