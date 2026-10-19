# Local observability — Grafana, Prometheus, and what the app can actually ship

Set up on 2026-10-19 with what was already installed on this machine: **Grafana
13.2.0** (`scoop/apps/grafana/13.2.0/bin/grafana.exe`, which is the server _and_ the
CLI) and **Prometheus 3.13.2**. No new software was installed to get here, and nothing
in this stack holds a secret — both servers bind `127.0.0.1` only.

```
  app (bun dev, :3000)
     ├── OTLP metrics ──▶ Prometheus :9090/api/v1/otlp/v1/metrics   ✅ lands
     ├── OTLP traces ───▶ Prometheus …/v1/traces                    ❌ 404, metrics-only receiver
     └── /api/metrics ◀── Prometheus scrape job "securevoice-dev"    ✅ the product signal
                                          ▲
                              Grafana :3001 (datasource securevoice-prom,
                                          dashboard uid securevoice-runtime)
```

Start, stop, inspect:

```bash
bun scripts/observability.mjs up       # ~90s; Grafana registers ~30 plugins before it listens
bun scripts/observability.mjs status   # what is really answering
bun scripts/observability.mjs env      # the exports that point the app at it
bun scripts/observability.mjs down
```

UI: <http://127.0.0.1:3001/> → folder **SecureVoice** → **SecureVoice — runtime**.
Anonymous admin is on _because it is loopback-bound_; do not reuse this config on a host
that listens on a network interface.

## Three things the launcher had to get right

`up` was written, tested, and found broken twice before it worked. Each failure was a
Windows fact, not a bug in Grafana, and all three cost real time:

1. **A detached child dies with the shell that made it.** `spawn(..., { detached: true,
windowsHide: true })` looked correct — the script printed `UP`, and by the next
   command the process was gone. The child is created inside the launching shell's job
   object, so reaping that shell kills the whole tree; Grafana's log ended mid-way
   through registering its bundled plugins with nothing to show for it. `Start-Process`
   creates the process outside the job, which is why `status` from a _different_ shell
   now reports both servers up.
2. **`spawnSync` must not capture the starter's stdout.** With the default pipes, the
   started server inherits the handle, so `spawnSync` waits for EOF from a process that
   never exits — `up` hung at `starting prometheus` while prometheus itself came up
   fine. `stdio: "ignore"` is what makes the call return.
3. **There is no `sleep.exe` on PATH.** The readiness loop called
   `spawnSync("sleep", ["3"])`, which fails instantly on Windows, so the loop spun as
   fast as it could, one `curl` per iteration — four minutes of noise that read as a
   hang. `Atomics.wait` on a `SharedArrayBuffer` is the in-process pause.

Grafana also takes **60–90 seconds** before it answers `/api/health`, because it
registers ~30 bundled plugins first. A short timeout there reports a working install as
failed, which is how this was misdiagnosed the first time.

---

## What was proven, with the numbers

**1. The app's own OTLP exporter works end-to-end.** `initOtel()` is genuinely wired —
`src/instrumentation.ts:128` calls it, and the voice-stream worker calls it at
`src/worker/voice-stream.ts:1491`. Run with `OTEL_BETTERSTACK_ENDPOINT` pointed at
Prometheus, it logged:

    [otel] OpenTelemetry SDK started  endpoint=http://127.0.0.1:9090/api/v1/otlp service=securevoice-proof sampleRate=1

and one counter emitted through it landed as a queryable series:

    {"__name__":"securevoice_proof_ticks_total","job":"securevoice-proof","proof_kind":"loopback"} → 3

So the earlier "the exporter is declared but never constructed" finding (gap register
§32) is **outdated**: it constructs, and it exports.

**2. The scrape path carries the product signal.** Prometheus scraping the live
origin's `/api/metrics` returned real state within one interval:

    sv_db_up = 1
    sv_cases_total{state="confirmed_fraud"} = 279, {state="closed"} = 16, {state="answered"} = 23, {state="dialing"} = 12
    sv_llm_breaker_open = 0

and Grafana serves those through its own datasource proxy — verified by querying
`sum by (state) (sv_cases_total)` at
`/api/datasources/proxy/uid/securevoice-prom/api/v1/query`, not by assuming the panel
renders.

**3. The label vocabulary is small and bounded**, which is what makes the dashboard
safe to keep: `sv_cases_total{state}`, `sv_tts_rung_total{rung}`, and the rest unlabeled.
That matches the endpoint's own design rules (`src/app/api/metrics/route.ts:34-48`): no
`callRef`, no `orgId`, no customer data as labels.

---

## What does not work, and it is the destination's fault

**Traces and logs have nowhere to go.** Prometheus' OTLP receiver is metrics-only:
`POST /api/v1/otlp/v1/traces` answers **404**. Grafana 13 ships the `tempo` and `jaeger`
datasource _plugins_ — they are registered in the startup log — but a plugin is a query
UI, not a store. So this stack can show you **metrics today** and **cannot show spans**
until one of these is chosen:

| Option                                                                   | What it costs                                                                                       | Notes                                                                                                                                  |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Install a trace store locally (Grafana Tempo, or Alloy as the collector) | a new binary via scoop, which is a machine-level change I have not made                             | cleanest offline path; Tempo writes to a local dir, Grafana queries it over HTTP                                                       |
| Grafana Cloud (Traces + Metrics + Logs free tier)                        | a stack API key **from you** — I cannot mint one, and `secrun` reads secrets but cannot create them | zero installs; the app needs no code change, only `OTEL_BETTERSTACK_ENDPOINT` + `OTEL_BETTERSTACK_TOKEN` pointed at the Cloud OTLP URL |
| Docker Desktop + collector + Tempo                                       | the local Docker daemon is **not running** today (`docker info` fails on the named pipe)            | works, but starts a hypervisor to do it                                                                                                |

Worth naming plainly: **`OTEL_BETTERSTACK_*` is a misnomer for this use.** The variable
names say Better Stack, the code just uses them as a generic OTLP base URL + bearer
token. That is why pointing at Grafana/Prometheus needed no code change — and it is a
small trap for the next reader, so it is documented rather than silently relied on.

---

## Two operational traps found on the way, both recorded so they stop costing time

**`[otel] shutdown failed` with `error: "Not Found"` names neither the signal nor the
URL** (`src/lib/telemetry/otel.ts:196-205` logs `err.message` alone). Pointing the
exporter at a metrics-only receiver produced exactly that line, and reading it you
cannot tell whether traces, metrics or logs failed, or where. The fix is one field —
log `betterStackBaseUrl()` alongside the error — and it is not done here because it
touches the instrumentation path and nobody asked me to.

**Port 3000 is contested.** Next.js dev and Grafana both default to 3000. Binding
Grafana there made the `securevoice-dev` scrape job hit **Grafana's 404** instead of the
app's `/api/metrics` — target health `down`, `server returned HTTP status 404 Not Found`
— which looks like a broken app. So Grafana listens on **3001** and the script says so.

**An unrelated `otel-agent` is listening on `127.0.0.1:4318`** on this machine (PID
5980; its executable path is not readable by my process, and no `otel-agent` binary was
found in the usual install directories). It is the standard OTLP HTTP port, so the
temptation is to point the app at it. **Do not.** A receiver whose destination cannot be
named is not an acceptable sink for SecureVoice telemetry: the spans of a bank-fraud
call are the exact data `docs/ROPA.md` §3 records as crossing borders under named
processors, and shipping them into an unaccounted pipeline would quietly add a
sub-processor that the register does not list. Identify it first, or bind this stack to
its own port — which is what Prometheus on 9090 already does.

---

## Production, for contrast

Measured on the box: `OTEL_BETTERSTACK_TOKEN` is **unset**, so the app logs
`[otel] no token set — traces, metrics and logs stay local` and exports nothing. The
`/api/metrics` endpoint is reachable and unauthenticated by default (the code's stated
default for a same-network scraper); setting `METRICS_TOKEN` locks it down, and that is
the switch to pull **before** production metrics are exposed to the internet — today
they are, and the body carries no customer data by design, but it does carry operational
shape: queue depth, breaker state, case counts.

Related: `docs/RUNBOOK.md` for the live stack, `docs/ROPA.md` activity A11 for the
telemetry register entry.
