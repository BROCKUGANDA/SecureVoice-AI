# Trust model — answering the caller-ID paradox

> *"An anti-fraud system that phones me from a number I don't recognise is
> indistinguishable from the fraud call it is meant to stop. Why should I
> answer it?"*

This is the first objection in every meeting, and a fraud head will raise it
within five minutes. This document is the answer. It is also the cheapest
differentiator we have: almost no competitor has thought it through, and
addressing it converts scepticism faster than any demo.

---

## 1. Why the objection is legitimate

Caller ID is trivially spoofable. A fraudster running a smishing or SIM-swap
campaign *will* present your institution's number if they can obtain a
credential or persuade an employee to leak it. A customer who has been trained
to distrust unknown numbers is right to distrust ours, and training them to
trust "the bank always calls from this number" is exactly the social engineering
that got them targeted.

So the design rule is: **never rely on caller identity alone.** Caller ID is one
signal in a set, and it is the weakest of the set.

## 2. The five layers

Each layer holds independently. If any one is spoofed or fails, the customer
can still verify — and can still be protected.

### Layer 1 — Institutional caller ID (requires their authorisation)

The call presents the institution's published inbound number, so the customer
sees the same number they would see from their own fraud team. This requires:

- the institution's **written authorisation** to present the number (carrier
  policy; some jurisdictions require the number to be textually associated with
  the brand),
- **carrier verification** of that association, and
- the number being genuinely theirs — not one we rent.

**This is the layer with lead time, and it is the reason to start the request on
day 1 of the pilot conversation.** It can take weeks with the carrier. Until it
grants, the pilot runs on layers 2–5 alone, which is a viable product.

### Layer 2 — Pre-notification, immediately before the dial

Sixty to ninety seconds before the call, the customer receives a push or SMS on
the channel they already trust: *"Your bank will call you shortly about a
transaction on your card. The agent will never ask for your PIN or OTP."*

The customer now expects the call. An unsolicited call becomes an expected one,
which is the entire difference. This works with the institution's existing
channels and requires no carrier cooperation at all — so it is available in
Phase 1, not Phase 3.

### Layer 3 — A verification token the customer can check independently

The agent states a case reference, and that reference is confirmable through
the institution's *own* channels — the app, the authenticated portal, or the
IVR. The customer is never asked to trust the caller; they are given a way to
check.

This is the layer that defeats a convincing spoof, because a spoofed caller
cannot produce a reference that validates in the bank's own app.

### Layer 4 — Structural incapability, enforced server-side

The agent **never** asks for, and is structurally unable to obtain:

- PIN or password · OTP or one-time passcode · CVV · full card number ·
  security question answers · remote-access requests

It cannot move money, change a limit, or read a balance. It can only warn,
verify, and hold. This is not a prompt instruction — it is enforced by the tool
allow-list and the server-side tool guards, and a request for one of those
values is refused by the server and recorded in the audit chain as a refusal.

The agent also **states this in its opening seconds**: *"I will never ask for
your PIN or one-time passcode."* Telling the customer what *will not* happen is
as important as telling them what will — because the fraud call they are being
protected from *does* ask for exactly those things.

### Layer 5 — A published callback number

A number published on the institution's own website and card, which reaches a
human at the institution. A suspicious customer can hang up and verify
independently, without calling back the number that just called them — and they
are still protected, because the intervention does not depend on them staying
on the line.

## 3. What the customer hears, in order

1. Disclosure: automated system, calling on behalf of the institution, call recorded.
2. The reason: a specific transaction, amount and merchant.
3. The promise: *"I will never ask for your PIN, password, or one-time passcode."*
4. The reference: a case number they can verify in the app.
5. The action: what is being held, and what happens next.

## 4. Failure behaviour

If the customer does not answer, we do not escalate to pressure. The retry
ladder is time-boxed, channel-limited, and stops. Opt-out is honoured
immediately and permanently for that account. No call is repeated after an
explicit refusal, and refusal is recorded as an outcome, not an error.

## 5. What we need from the institution to enable each layer

| Layer | Needs from them | Lead time | Available in |
| --- | --- | --- | --- |
| 1 · Institutional caller ID | Written authorisation + carrier verification | weeks | Phase 1–2 |
| 2 · Pre-notification | Send one push/SMS via their channel | days | Phase 1 |
| 3 · Verification token | Case reference visible in their app/IVR | 1–2 weeks | Phase 1 |
| 4 · Structural incapability | Nothing — ours, already built | none | Phase 0 |
| 5 · Published callback number | A published number | days | Phase 1 |

**Phase 0 needs none of them.** The shadow phase places no calls at all.