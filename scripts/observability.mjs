#!/usr/bin/env bun
/**
 * Local observability stack — Prometheus (metrics) + Grafana (UI), both on loopback.
 *
 * Why a script and not a README paragraph: every fact in here was measured the hard
 * way on this machine, and each one is a wrong turn if you have to rediscover it.
 *
 *   · `grafana.exe` is the FULL server and CLI (v13.2.0: `grafana server`,
 *     `grafana cli`). It registers ~30 bundled plugins before it listens, so it
 *     takes 60-90s to answer /api/health. Polling anything earlier reads as a
 *     crash that never happened.
 *   · Run the real binary, not the scoop shim: the shim injects its own
 *     `--config.file`, and passing one too gives
 *     "flag 'config.file' cannot be repeated" and a usage dump in the log.
 *   · `grafana server` needs `--homepath` when invoked directly, or it cannot find
 *     its web assets.
 *   · Prometheus 3.x OTLP ingestion is `--web.enable-otlp-receiver`. The
 *     `--enable-feature=otlp-write-receiver` form is the 2.x name; 3.13.2 answers
 *     "otlp write receiver needs to be enabled with --web.enable-otlp-receiver".
 *   · That receiver is METRICS ONLY. `POST /api/v1/otlp/v1/traces` returns 404, so
 *     traces need a real backend (Tempo, or Grafana Cloud). Pointing the app's
 *     `OTEL_BETTERSTACK_ENDPOINT` at Prometheus ships metrics and fails the trace
 *     leg, which surfaces as `[otel] shutdown failed: Not Found` — an error that
 *     names neither the signal nor the URL. See docs/OBSERVABILITY.md.
 *   · Port 3000 belongs to Next.js dev, so Grafana listens on 3001. Binding it to
 *     3000 makes the `securevoice-dev` scrape job hit Grafana's 404 instead of the
 *     app's /api/metrics (measured: target health "down", "server returned HTTP
 *     status 404 Not Found").
 *
 * Secrets: nothing here holds one. Anonymous admin is enabled because both servers
 * bind 127.0.0.1 only. The OTLP token used for loopback is a literal
 * "loopback-not-a-secret" and never leaves the machine.
 *
 * Usage:
 *   bun scripts/observability.mjs up        # start both, wait until they answer
 *   bun scripts/observability.mjs status    # what is actually listening
 *   bun scripts/observability.mjs env       # the exports that point the app at it
 *   bun scripts/observability.mjs down      # stop both
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = resolve(import.meta.dir, "..");
const RUNTIME = join(ROOT, ".observability");
const DATA = join(RUNTIME, "grafana-data");
const PROM_DATA = join(RUNTIME, "prom-data");
const PROVISIONING = join(RUNTIME, "provisioning");
const DASHBOARDS = join(RUNTIME, "dashboards");

const PROM_PORT = 9090;
const GRAFANA_PORT = 3001;
const APP_DEV_PORT = 3000;

// ---------------------------------------------------------------- binaries ---

/**
 * Resolve a scoop-installed executable without trusting the shim.
 *
 * `where.exe` finds the shim first; the shim then injects flags. So look for the
 * real binary under the app's `current` link, and fall back to the shim only if
 * nothing else exists — and say which one was used, because the difference is a
 * startup failure that looks like a broken install.
 */
function findBinary(name, rel) {
  for (const r of rel) {
    const p = resolve(process.env.HOME ?? process.env.USERPROFILE ?? "", ...r.split("/"));
    if (existsSync(p)) return { path: p, how: "scoop app dir" };
  }
  const w = spawnSync("where.exe", [name], { encoding: "utf8" });
  const first = (w.stdout ?? "").split(/\r?\n/).filter(Boolean)[0];
  return first ? { path: first, how: "PATH shim (may inject flags)" } : null;
}

function prometheusBin() {
  return findBinary("prometheus", [
    "scoop/apps/prometheus/current/prometheus.exe",
    "scoop/shims/prometheus.exe",
  ]);
}

function grafanaBin() {
  // homepath is the versioned install dir; the shim's path contains it.
  const found = findBinary("grafana", [
    "scoop/apps/grafana/current/bin/grafana.exe",
    "scoop/shims/grafana.exe",
  ]);
  if (!found) return null;
  const homepath = found.path.includes("/current/")
    ? found.path.split("/current/")[0] + "/current"
    : found.path.replace(/[/\\](bin[/\\])?grafana(\.exe)?$/i, "");
  return { ...found, homepath: homepath.replace(/\\/g, "/") };
}

// ------------------------------------------------------------------ health ---

function httpCode(url, ms = 4000) {
  const r = spawnSync(
    "curl.exe",
    ["-s", "-m", String(Math.floor(ms / 1000)), "-o", "/dev/null", "-w", "%{http_code}", url],
    { encoding: "utf8" },
  );
  return Number((r.stdout ?? "").trim()) || 0;
}

/**
 * Blocking wait, in-process.
 *
 * The first version called `spawnSync("sleep", ["3"])`, which is a no-op that
 * FAILS on Windows — there is no sleep.exe on PATH — so the readiness loop below
 * spun as fast as it could, spawning one `curl` per iteration: `up` looked hung
 * and burned four minutes doing what should take ninety seconds.
 */
function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitHttp(url, deadlineMs, label) {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    if (httpCode(url) === 200) return true;
    pause(3000);
  }
  console.log(`  TIMEOUT ${label} did not answer ${url} within ${deadlineMs / 1000}s`);
  return false;
}

// --------------------------------------------------------------- generate ----

/**
 * The provider file needs an ABSOLUTE dashboard path, which is machine-specific.
 * So the committed artifact is the datasource + the dashboard JSON, and the
 * provider is generated into .observability/ on every `up` — never committed,
 * never wrong about a path.
 */
function writeRuntimeFiles() {
  for (const d of [
    RUNTIME,
    DATA,
    PROM_DATA,
    PROVISIONING,
    join(PROVISIONING, "datasources"),
    DASHBOARDS,
  ])
    mkdirSync(d, { recursive: true });

  writeFileSync(
    join(PROVISIONING, "datasources", "prometheus.yml"),
    `apiVersion: 1
datasources:
  - name: Prometheus
    uid: securevoice-prom
    type: prometheus
    access: proxy
    url: http://127.0.0.1:${PROM_PORT}
    isDefault: true
    editable: true
    jsonData:
      httpMethod: POST
      timeInterval: 15s
`,
  );

  writeFileSync(
    join(PROVISIONING, "dashboards", "dashboards.yml"),
    `apiVersion: 1
providers:
  - name: securevoice
    folder: SecureVoice
    type: file
    disableDeletion: false
    updateIntervalSeconds: 30
    allowUiUpdates: true
    options:
      path: ${join(ROOT, ".observability", "dashboards").replace(/\\/g, "/")}
`,
  );

  const src = join(ROOT, "observability", "dashboards", "securevoice-runtime.json");
  if (existsSync(src)) {
    const text = readFileSync(src, "utf8");
    JSON.parse(text); // fail here, not 90 seconds into a Grafana plugin load
    writeFileSync(join(DASHBOARDS, "securevoice-runtime.json"), text);
  }
  return DASHBOARDS;
}

function prometheusConfig() {
  const committed = join(ROOT, "observability", "prometheus.yml");
  return existsSync(committed) ? committed : join(RUNTIME, "prometheus.yml");
}

// ------------------------------------------------------------------- up -----

async function up() {
  writeRuntimeFiles();
  const pb = prometheusBin();
  const gb = grafanaBin();
  if (!pb) throw new Error("prometheus.exe not found — scoop install prometheus first");
  if (!gb) throw new Error("grafana.exe not found — scoop install grafana first");

  console.log(`binaries: prometheus=${pb.path} (${pb.how}) grafana=${gb.path} (${gb.how})`);
  if (httpCode(`http://127.0.0.1:${PROM_PORT}/-/ready`) === 200)
    console.log("prometheus already answering — leaving it alone");
  else {
    const args = [
      `--config.file=${prometheusConfig()}`,
      "--web.enable-otlp-receiver",
      `--web.listen-address=127.0.0.1:${PROM_PORT}`,
      `--storage.tsdb.path=${PROM_DATA}`,
    ];
    console.log("starting prometheus:", args.join(" "));
    start(pb.path, args, join(RUNTIME, "prom.log"));
  }

  if (httpCode(`http://127.0.0.1:${GRAFANA_PORT}/api/health`) === 200)
    console.log("grafana already answering — leaving it alone");
  else {
    const env = {
      ...process.env,
      GF_PATHS_DATA: DATA,
      GF_PATHS_PROVISIONING: PROVISIONING,
      GF_PATHS_LOGS: join(DATA, "log"),
      GF_PATHS_PLUGINS: join(DATA, "plugins"),
      GF_SERVER_HTTP_ADDR: "127.0.0.1",
      GF_SERVER_HTTP_PORT: String(GRAFANA_PORT),
      GF_SERVER_ROOT_URL: `http://127.0.0.1:${GRAFANA_PORT}/`,
      GF_AUTH_ANONYMOUS_ENABLED: "true",
      GF_AUTH_ANONYMOUS_ORG_ROLE: "Admin",
      GF_ANALYTICS_REPORTING_ENABLED: "false",
    };
    console.log("starting grafana server (expect 60-90s: it registers its bundled plugins first)");
    start(gb.path, ["server", `--homepath=${gb.homepath}`], join(RUNTIME, "grafana.log"), env);
  }

  const okProm = waitHttp(`http://127.0.0.1:${PROM_PORT}/-/ready`, 30_000, "prometheus");
  const okGraf = waitHttp(`http://127.0.0.1:${GRAFANA_PORT}/api/health`, 150_000, "grafana");
  status();
  if (!okProm || !okGraf) process.exit(1);
}

/**
 * Launch so the server OUTLIVES this script.
 *
 * `spawn(..., { detached: true })` was tried first and it does not work here: the
 * process is created inside the launching shell's Windows job object, so it is
 * terminated when that shell's task is reaped — Grafana got as far as registering
 * its bundled plugins in the log and then vanished, and `status` reported it down.
 * `Start-Process` creates the process outside the job, which is the difference
 * between a stack you can keep using and one that dies with the command that
 * printed "UP". Measured both ways on this machine.
 */
function start(bin, args, log, env) {
  const psArgs = args.map((a) => `'${String(a).replace(/'/g, "''")}'`).join(",");
  const cmd =
    `Start-Process -FilePath '${bin.replace(/'/g, "''")}' -ArgumentList ${psArgs} ` +
    `-WindowStyle Hidden -RedirectStandardOutput '${log}.out' -RedirectStandardError '${log}.err'`;
  const r = spawnSync("powershell.exe", ["-NoProfile", "-Command", cmd], {
    encoding: "utf8",
    env,
    // MUST be "ignore", not the default pipe. With an inherited pipe the started
    // server keeps the handle open, so spawnSync waits for EOF from a process that
    // never exits — `up` hung at "starting prometheus" while prometheus itself came
    // up fine. Same reason the log redirection above goes to files.
    stdio: "ignore",
  });
  if (r.status !== 0) {
    throw new Error(`could not start ${bin}: ${(r.stderr || r.stdout || "").trim().slice(0, 200)}`);
  }
}

// ----------------------------------------------------------------- status ---

function status() {
  const prom = httpCode(`http://127.0.0.1:${PROM_PORT}/-/ready`);
  const graf = httpCode(`http://127.0.0.1:${GRAFANA_PORT}/api/health`);
  const dash = httpCode(`http://127.0.0.1:${GRAFANA_PORT}/api/dashboards/uid/securevoice-runtime`);
  const app = httpCode(`http://127.0.0.1:${APP_DEV_PORT}/api/health`);
  console.log("");
  console.log(
    `  prometheus  :${PROM_PORT}  ${prom === 200 ? "UP" : "down"} (OTLP metrics at /api/v1/otlp/v1/metrics)`,
  );
  console.log(
    `  grafana     :${GRAFANA_PORT}  ${graf === 200 ? "UP" : "down"}  http://127.0.0.1:${GRAFANA_PORT}/`,
  );
  console.log(`  dashboard   ${dash === 200 ? "provisioned" : `not visible yet (HTTP ${dash})`}`);
  console.log(
    `  app dev     :${APP_DEV_PORT}  ${app === 200 ? "UP — the scrape target is live" : "down (start with: bun dev)"}`,
  );
}

// ------------------------------------------------------------------- env ----

function envLines() {
  console.log(`
Point the app at this stack (a token is required just to construct the exporter;
over loopback its value is not a secret):

  export OTEL_BETTERSTACK_ENDPOINT=http://127.0.0.1:${PROM_PORT}/api/v1/otlp
  export OTEL_BETTERSTACK_TOKEN=loopback-not-a-secret
  export OTEL_SERVICE_NAME=securevoice-dev
  export OTEL_EXPORT_INTERVAL_MS=5000

What that actually buys, measured:
  · METRICS land. The app's own initOtel() -> OTLP HTTP -> Prometheus returned a
    series with the right value, and Grafana serves it.
  · TRACES and LOGS do not: Prometheus' receiver is metrics-only, and /v1/traces
    answers 404. A trace backend is required (Tempo locally, or Grafana Cloud) —
    until then this stack cannot show spans, and that is a fact about the
    destination, not about the app's instrumentation.
  · The scrape path is separate from OTLP and carries the product signal
    (sv_cases_total{state}, sv_tts_rung_total{rung}, sv_llm_breaker_open, ...),
    because src/ defines no custom OTel counters at all — grep createCounter returns
    nothing. /api/metrics is the surface with the labels worth charting.`);
}

function down() {
  for (const img of ["prometheus.exe", "grafana.exe"]) {
    const r = spawnSync("taskkill.exe", ["/F", "/IM", img], { encoding: "utf8" });
    console.log(`${img}: ${(r.stdout ?? r.stderr ?? "").split(/\r?\n/)[0]}`);
  }
}

const cmd = process.argv[2] ?? "status";
if (cmd === "up") await up();
else if (cmd === "down") down();
else if (cmd === "env") envLines();
else status();
