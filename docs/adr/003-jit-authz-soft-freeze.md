# ADR-003: Just-in-time AuthZ with a reversible soft freeze

## Context

The stated product promise is that a suspicious transaction is verified within about
sixty seconds. Speed alone is easy; what makes it an enterprise decision is what the
AI is allowed to _do_ at the moment it is most confident.

A permanently blocked card reversed after a false positive is a customer complaint,
a regulator's question, and — under CBUAE Consumer Protection — potentially an
unfair outcome attributable to us. An irreversible punitive action taken by an
automated agent on the strength of a transcript is not defensible however accurate
the model is.

## Decision

The agent may place a **hold**, never a punishment:

1. A scoped, short-lived token from the institution authorises exactly one action on
   exactly one card (`src/lib/agent-tool-auth.ts`, producer keys, replay window).
2. The hold is staged durably before the customer is told about it.
   `executeSoftFreeze` returns an outcome, and the worker chooses its sentence from
   that outcome — `FREEZE_CONFIRMATION` when it staged, `FREEZE_UNSTAGED` when it did
   not. An earlier version awaited the freeze, discarded the result, and confirmed a
   hold to the caller while the function it had called was a stub that wrote nothing.
   A customer was told their account was protected, and none of it was true.
3. A human fraud specialist finalises or releases. The escalation queue and the
   handoff path exist for this; the agent's holding lines say it will hand off rather
   than attempting the conversation itself.
4. Both writes are audit-chained before they are audible: the refusal that cannot be
   recorded is refused (`intervention_refused_degraded`), because an unrecorded
   intervention is unenforceable and unauditable.

The refusal to _ask_ is part of the same decision. The agent never requests an OTP,
password or full card number, and it is structurally unable to: the rule is enforced
in the classification path and the guard prompt, and a caller who volunteers a
verification token is answered without echoing it.

## Consequences

**Positive.** Sixty-second protection without irreversible automated punishment;
the customer is blocked reversibly and a named human owns the decision; every stage
is in the chain, so the sequence "held, then told, then released" is reconstructable
per call.

**Negative, stated plainly.**

- False positives still cost a real person their card for the duration of the hold.
  The mitigation is human speed, not the architecture, which is why the queue and the
  handoff SLA matter more than the model's precision.
- Staging durably before speaking adds a database round trip inside the turn budget,
  and when the database is slow the agent says the unstaged sentence instead.
- A scoped token that cannot be verified fails closed, so an institution with a
  misconfigured key gets refusals rather than degraded holds.

## Evidence

`src/app/api/v1/interventions/route.ts` · `src/lib/ai/ai-authz.ts` ·
`src/worker/voice-stream.ts` (`executeSoftFreeze`, `FREEZE_UNSTAGED`) ·
`src/lib/agent-tool-auth.ts` · `src/lib/compliance/never-ask.ts` ·
· `src/lib/audit-chain.ts` ·
`src/app/api/elevenlabs/tools/card-freeze/route.ts` · `docs/JUDGE-QA.md`
