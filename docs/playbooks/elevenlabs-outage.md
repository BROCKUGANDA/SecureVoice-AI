# Playbook: TTS vendor outage (ElevenLabs)

Automated-response playbook. Everything here is a command an operator can run
without editing code. For a call that is dropping rather than a vendor that is
down, see [`../runbooks/fraud-call-drops.md`](../runbooks/fraud-call-drops.md).

## Preconditions

- SSH on the VPS.
- `.env` holds the vendor keys. Never print them; `grep -c` counts lines only.

## 1. Confirm the failure is the vendor

```sh
curl -s https://securevoiceai.me/api/readyz | jq '.checks[] | select(.name=="voice_provider")'
```

`detail` reports the provider, whether the LLM breaker is closed, and the TTS key
count. A `cooling=N` value means keys are already being rotated through
`src/lib/elevenlabs/pool.ts`.

Vendor-side confirmation:

```sh
curl -sS -o /dev/null -w '%{http_code}\n' https://api.elevenlabs.io/v1/models
```

A `429` here with `cooling` climbing locally is rate limiting, not an outage —
the pool already fails over per key, so the useful action is to wait, not to
switch vendors.

## 2. Switch the TTS provider

The secondary provider is PlayHT (`src/lib/elevenlabs/playht.ts`). It is selected
by key presence, so the switch is two env edits and a restart:

```sh
# 1. add the secondary vendor's credentials
printf '\nPLAYHT_API_KEY=%s\n' "$PLAYHT_KEY" >> .env

# 2. restart both colours; traffic is NOT moved by this
docker compose -f docker-compose.yml -f docker-compose.bluegreen.yml \
  up -d --no-deps app-blue app-green
```

Readiness is gated on `/api/readyz`, so an instance that came up without a usable
voice path never receives traffic. If both colours fail the gate they stay down
and the previous colour keeps serving — check `APP_UPSTREAM` in
`.deploy/active.env` before assuming traffic moved.

## 3. Verify

```sh
curl -s https://securevoiceai.me/api/readyz | jq '.status'
# expect: "ok" (or "degraded" with voice_provider ok=false and an explanation)
```

```sh
docker compose -f docker-compose.yml -f docker-compose.bluegreen.yml logs --tail=100 app-blue | grep -i 'tts\|playht'
```

Then place one real test call and confirm audio on both legs:

```sh
docker compose -f docker-compose.yml -f docker-compose.bluegreen.yml logs --tail=200 app-blue | grep 'first_agent_word'
```

An `answered_to_first_agent_word` span with a real duration is the proof. No
span means the call never reached the speech step — that is a different incident.

## 4. Degraded mode is a real mode

With every voice vendor unavailable the platform still acts: it sends the SMS
alert (`src/lib/elevenlabs/sms-fallback.ts`) and the customer answers YES/NO by
text. That path is not a placeholder, so an outage degrades the channel without
dropping the intervention.

## 5. Roll back

```sh
# remove the secondary key
sed -i '/^PLAYHT_API_KEY=/d' .env
docker compose -f docker-compose.yml -f docker-compose.bluegreen.yml \
  up -d --no-deps app-blue app-green
```

## What this playbook does not do

It does not edit prompts, raise rate limits, or disable the opening disclosure to
make a call go through. A fraud call that cannot state that it is recorded is not
a cheaper call, it is an unlawful one.
