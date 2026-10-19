# Observability — the destination is Grafana Cloud, not a laptop

SecureVoice-AI ships OpenTelemetry traces, metrics and logs over OTLP/HTTP to the
**Grafana Cloud stack** at `brockuganda` (region `prod-ca-east-0`). Nothing runs locally:
the loopback Grafana + Prometheus stack that stood up on 2026-10-19 has been retired, and
its launcher is gone with it. The Windows lessons it taught are kept where they belong —
gap register §46 and §49 — because they are facts about this machine, not about the
product.

```
  app / worker ── OTLP/HTTP ──▶ https://otlp-gateway-prod-ca-east-0.grafana.net/otlp
                                          │
                          ┌───────────────┼────────────────┐
                          ▼               ▼                ▼
                    Mimir (metrics)  Tempo (traces)   Loki (logs)
                          uid grafanacloud-prom  …-traces  …-logs
                                          │
                                     Grafana Cloud (dashboards, alerts, Application Observability)
```

## Configuring it

Two variables, both named exactly as the OpenTelemetry specification names them, and
exactly as the stack's own **OpenTelemetry tile → Configure** hands them to you:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT="https://otlp-gateway-prod-ca-east-0.grafana.net/otlp"
OTEL_EXPORTER_OTLP_HEADERS="Authorization=Basic <access-policy token>"
```

Three rules the code enforces, each covered by
[`tests/telemetry/remote-telemetry-status.test.ts`](../tests/telemetry/remote-telemetry-status.test.ts):

- **Both are required, or nothing ships.** An endpoint without an `Authorization` header
  reports `no_authorization` rather than pretending to be configured — that state sends a
  batch of 401s and publishes a healthy-looking artifact, which is the worst combination
  available.
- **There is no default host.** A hardcoded ingestion host means an unconfigured
  deployment still ships telemetry to whoever owns that name. For a product whose
  compliance posture is data residency that is a defect, so `otlp-config.ts` returns
  `undefined` and `initOtel()` builds no exporters.
- **The credential is carried verbatim.** Grafana Cloud authenticates with **Basic**, and
  the token from the tile is already the base64 credential. Re-encoding it is how a
  working token becomes a 401 that reads like a broken one.

Per-signal overrides (`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` and friends) are used
**exactly as given** — no path appended — so one signal can be routed elsewhere or left
unshipped without touching code.

The token is an **Access Policy** token with metrics/logs/traces write, created in the
Grafana Cloud portal. It cannot be minted from here, and it does not belong in this
repository, in `.env` in git, or in a shell history line: put it in the deployment
environment on the box.

## What is verified, and what is not

Verified, from this machine, without a token:

- The gateway for this stack's region is real and demands auth: an unauthenticated
  `POST /otlp/v1/traces` to `otlp-gateway-prod-ca-east-0.grafana.net` answers **401**,
  while a made-up region answers **530**. The pair matters — 401 against a host that
  resolves is a different fact from a host that does not.
- The stack already has the three backends provisioned as datasources: `grafanacloud-prom`
  (Mimir), `grafanacloud-traces` (Tempo), `grafanacloud-logs` (Loki), plus
  `grafanacloud-profiles`. That is what retires gap register §47: spans and logs have a
  destination, so no local Tempo/Alloy install is needed.
- The exporters themselves work end to end. Measured on the loopback stack before it was
  retired: a counter emitted through the SDK's OTLP path landed as a queryable series, and
  the live origin's scraped metrics returned real state. See §46.

**Not yet verified: that this deployment is actually shipping.** It is not. The token does
not exist yet, so `remoteTelemetryStatus()` answers `no_endpoint` in production and the
boot log says so. Setting the two variables is the whole remaining step, and the first
span in Tempo is the proof.

## The dashboard

[`observability/dashboards/securevoice-runtime.json`](../observability/dashboards/securevoice-runtime.json)
is written against the product's own series and now points at `grafanacloud-prom`, so it
imports into the stack as-is (Dashboards → Import → paste JSON). Its panels read
`sv_cases_total{state}`, `sv_tts_rung_total{rung}`, breaker and pool gauges.

The label vocabulary is deliberately small and bounded, which is what keeps a dashboard
safe to publish: no `callRef`, no `orgId`, no customer data as a label value — the design
rules are stated in `src/app/api/metrics/route.ts`.

## The decision that is not mine to make

**Traces and logs from this product can carry caller data.** A span's attributes and a log
line from the voice path are exactly the material `docs/ROPA.md` records as crossing
borders under named processors, and the stack lives in **Canada East**. Metrics are
aggregate counters and are a different risk entirely.

So shipping all three signals to this stack is a residency decision, not a configuration
detail, and it belongs beside the ROPA entry rather than being defaulted on by whoever
wires the token. The mechanism for shipping less already exists: set only
`OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` and leave traces and logs without a destination.
Until that is answered, the honest state is "nothing ships", which is where the deployment
sits today.

## Two things still true about the code

- **A shutdown failure names neither the signal nor the URL.**
  `shutdownOtel()` logs `err.message` alone, so a rejected batch at teardown reads as
  `Not Found` with no destination. The start log now prints the resolved per-signal
  `endpoints`, which covers most of it; the shutdown path is still thin.
- **`/api/metrics` is reachable and unauthenticated on the live origin.** That is the
  code's stated default for a same-network scraper, and the body carries no customer data
  by design — but it does carry operational shape: queue depth, breaker state, case
  counts. `METRICS_TOKEN` is the switch to pull, and it should be pulled before anyone
  points a hosted Prometheus at it. With Grafana Cloud receiving via OTLP push, there is
  no longer a reason for the public scrape surface to stay open.

Related: `docs/RUNBOOK.md` for the live stack, `docs/ROPA.md` activity A11 for the
telemetry register entry, gap register §46 (what the local stack proved) and §49 (why it
is gone).
