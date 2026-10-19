# Observability — the destination is Grafana Cloud, not a laptop

SecureVoice-AI ships OpenTelemetry traces, metrics and logs over OTLP/HTTP to the
**Grafana Cloud stack** at `brockuganda` (region `prod-ca-east-0`). Nothing runs locally:
the loopback Grafana + Prometheus stack that stood up on 2026-10-19 has been retired, and
its launcher is gone with it. The Windows lessons it taught are kept where they belong —
gap register §46 and §49 — because they are facts about this machine, not about the
product.

```
  app / worker ── OTLP/HTTP ──▶ otlp-gateway-prod-ca-east-0.grafana.net/otlp/v1/metrics
                                          │
                                          ▼
                                    Mimir (metrics)  uid grafanacloud-prom
                                          │
                                     Grafana Cloud (dashboards, alerts)

   traces ──▶ no destination, no exporter built      (Tempo exists in the stack: uid grafanacloud-traces)
   logs   ──▶ no destination, no exporter built      (Loki exists in the stack: uid grafanacloud-logs)
```

## Configuring it

Production posture, decided 2026-10-19: **metrics only**. Two variables, named exactly as
the OpenTelemetry specification names them and as the stack's **OpenTelemetry tile →
Configure** hands them out:

```bash
OTEL_EXPORTER_OTLP_HEADERS="Authorization=Basic <access-policy token>"
OTEL_EXPORTER_OTLP_METRICS_ENDPOINT="https://otlp-gateway-prod-ca-east-0.grafana.net/otlp/v1/metrics"
```

`OTEL_EXPORTER_OTLP_ENDPOINT` is deliberately **not** set. It is the base URL, and every
signal inherits a destination from it — traces and logs would ship by accident, which is
the decision that was declined. A signal with no endpoint builds no exporter.

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

## Why the boundary is metrics-only, and how the code holds it

**Traces and logs from this product can carry caller data.** A span's attributes and a log
line from the voice path are exactly the material `docs/ROPA.md` records as crossing
borders under named processors, and the stack lives in **Canada East**. Metrics are
aggregate counters and are a different risk entirely.

The owner chose **metrics only** on 2026-10-19, so this stops being a configuration
preference and becomes something the code has to keep true. Two things do that:

- **No default host, and no base endpoint in production.** A destination exists only
  because someone wrote it down.
- **An unconfigured signal is suppressed, not defaulted.** `@opentelemetry/sdk-node`
  builds its own exporter from the environment when the processor option is _absent_, and
  that default resolves to `http://localhost:4318`. So "traces are not configured" would
  otherwise become "traces go to whatever is listening on this box's OTLP port" — and on
  this machine, something is. `otel.ts` therefore passes an **empty list** for every
  signal without a destination, and a rule in the telemetry suite fails if that branch is
  ever replaced by an omitted option.

Widening this — traces, then logs — re-opens the residency question against the ROPA. It
is not just another environment variable, and the per-signal endpoints are the mechanism
when that happens.

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
