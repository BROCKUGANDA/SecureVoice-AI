/**
 * The artifact's "is telemetry shipping" must be the runtime's own answer, and
 * the answer must be reached through one door.
 *
 * WHY THIS FILE EXISTS. `report.ts` published `exporterConfigured: boolean` in the
 * SLO evidence artifact, and computed it in `src/lib/telemetry/export.ts` from
 * `OTEL_EXPORTER_OTLP_ENDPOINT`. The OTLP exporters were never built from that
 * variable: `otel.ts` derived its URL from `OTEL_BETTERSTACK_ENDPOINT` /
 * `OTEL_BETTERSTACK_HOST` and refused to construct anything unless
 * `OTEL_BETTERSTACK_TOKEN` (or `OTEL_SOURCE_TOKEN`) was set. Two files asked two
 * different questions about one fact, so:
 *
 *   · set the documented token and traces, metrics and logs ship — the artifact
 *     still says `exporterConfigured: false`;
 *   · set `OTEL_EXPORTER_OTLP_ENDPOINT` and nothing ships — the artifact says
 *     `true`.
 *
 * Measured rather than reasoned: no `OTEL_*` variable existed in any container on
 * the production host (`docker exec … env | grep OTEL` is empty for app, dial,
 * email, outbox, overage, retention, voice-stream and realtime), which is the
 * accident that kept the two halves agreeing on `false` and hid the divergence.
 *
 * WHAT CHANGED. The destination is now Grafana Cloud, and the config surface is
 * the OpenTelemetry standard names — `OTEL_EXPORTER_OTLP_ENDPOINT` and
 * `OTEL_EXPORTER_OTLP_HEADERS`, which is what a stack's OpenTelemetry tile hands
 * you. That retires rule C in its original form: those variables used to name a
 * dead transport and are now the live one. They did not get a free pass — they got
 * the same rule, pointed at the right thing. The names are read in exactly one
 * file, and the retired Better Stack names are banned from coming back.
 *
 * THE RULES.
 *   A. `remoteTelemetryStatus()` answers every state, and ships only when an
 *      endpoint AND an Authorization header are both present.
 *   A2. `initOtel()` decides from that predicate and reads the config nowhere else.
 *   B.  The artifact's `remoteTelemetry` field is filled from the same function,
 *      and typed from its return type, so a future field cannot quietly become a
 *      guess.
 *   C.  Only `otlp-config.ts` reads `OTEL_EXPORTER_OTLP_ENDPOINT` / `_HEADERS`.
 *      The rule is on reads, not on mentions: a log line that names a variable is
 *      how an operator learns what to set, and a ban on the text would be a ban on
 *      the fix.
 *   D.  The retired `OTEL_BETTERSTACK_*` / `OTEL_SOURCE_TOKEN` names appear nowhere
 *      in `src/`. A knob that is documented nowhere and read by nothing is a
 *      rumour; one that is read by something is a second door.
 *   E.  Signal routing: base + spec path by default, a per-signal override used
 *      verbatim.
 *
 * Deliberately NOT the check: "the gateway received a span". That would put a
 * vendor endpoint in the build, and §20 of the gap register already records what a
 * build-time network dependency does to a deploy. The gateway's own shape was
 * verified out of band instead: an unauthenticated POST to the stack's
 * `/otlp/v1/traces` answers 401, and a made-up region answers 530.
 */
import { expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  hasAuthorization,
  otlpBaseEndpoint,
  otlpHeaders,
  remoteTelemetryStatus,
  signalEndpoint,
} from "@/lib/telemetry/otlp-config";

/** Strip line and block comments so a prose mention cannot satisfy a code rule. */
function code(body: string): string {
  return body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

const SRC = walk("src");
const CONFIG = join("src", "lib", "telemetry", "otlp-config.ts");
// `join`, not a literal slash: `walk` builds its paths with `join`, and on Windows
// a forward-slash expectation matches nothing — a gate that reads "absent".
const OWNERS = [
  CONFIG,
  join("src", "lib", "telemetry", "otel.ts"),
  join("src", "lib", "telemetry", "report.ts"),
  join("src", "lib", "telemetry", "slo.ts"),
];

function body(path: string): string {
  return readFileSync(path, "utf8");
}

/** The body of a function, by brace matching from its signature. */
function fnBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  if (start < 0) return "";
  let depth = 0;
  let seen = false;
  for (let i = source.indexOf("{", start); i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") {
      depth++;
      seen = true;
    } else if (ch === "}") {
      depth--;
      if (seen && depth === 0) return source.slice(start, i + 1);
    }
  }
  return "";
}

/**
 * What counts as reading the OTLP config, as opposed to naming it.
 *
 * The distinction is the whole point of rules A2 and C, and it is not subtle: a
 * warning that says which variable to set is the only thing standing between an
 * operator and a grep through src. A ban on the bare name would be a ban on the
 * fix, and the next author would answer it by rewording the log — leaving the
 * second reader in place and the rule green.
 */
const OTLP_READS = [
  /env\(\s*"OTEL_EXPORTER_OTLP_(ENDPOINT|HEADERS)"\s*\)/,
  /read\(\s*"OTEL_EXPORTER_OTLP_(ENDPOINT|HEADERS)"\s*\)/,
  /process\.env\.OTEL_EXPORTER_OTLP_(ENDPOINT|HEADERS)\b/,
  /process\.env\.OTEL_SDK_DISABLED\b/,
];

/** Every OTLP variable this suite sets, so one helper can put the world back. */
const OTLP_VARS = [
  "OTEL_SDK_DISABLED",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
  "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
  "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
  "OTEL_BETTERSTACK_TOKEN",
  "OTEL_SOURCE_TOKEN",
] as const;

/**
 * Run `fn` with the OTLP variables cleared, then restore exactly what was there —
 * including "absent". A leaked `OTEL_EXPORTER_OTLP_ENDPOINT` would make every
 * later "not configured" assertion pass for the wrong reason, and a leaked blank
 * would do it in the other direction.
 */
function withCleanEnv<T>(fn: () => T): T {
  const saved = OTLP_VARS.map((name) => [name, process.env[name]] as const);
  try {
    for (const name of OTLP_VARS) delete process.env[name];
    return fn();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("the scan is not looking at an empty set", () => {
  // Tripwire: every file rule below reads files. A walk that returns nothing — or
  // skips the four files that own this fact — turns the suite green over a check
  // guarding nothing, which is the failure this repo has now documented four times.
  expect(SRC.length).toBeGreaterThan(200);
  for (const owner of OWNERS) {
    expect(SRC).toContain(owner);
    expect(code(body(owner)).length).toBeGreaterThan(0);
  }
});

test("A. the predicate answers every state, and only endpoint+auth ships", () => {
  withCleanEnv(() => {
    expect(remoteTelemetryStatus()).toEqual({ shipping: false, reason: "no_endpoint" });

    // An endpoint with no credential is the state an operator hits when they copy
    // one line of the tile and not the other. It must not read as configured:
    // every batch would 401, and the artifact would claim telemetry.
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT =
      "https://otlp-gateway-prod-ca-east-0.grafana.net/otlp";
    expect(remoteTelemetryStatus()).toEqual({ shipping: false, reason: "no_authorization" });
    expect(hasAuthorization()).toBe(false);

    // Both halves: shipping.
    process.env.OTEL_EXPORTER_OTLP_HEADERS = "Authorization=Basic dGVzdDp0ZXN0";
    expect(remoteTelemetryStatus()).toEqual({ shipping: true, reason: null });

    // Header names are case-insensitive on the wire, so the predicate must be too.
    process.env.OTEL_EXPORTER_OTLP_HEADERS = "authorization=Basic dGVzdDp0ZXN0";
    expect(remoteTelemetryStatus().shipping).toBe(true);

    // An empty value is not a configuration. `read()` trims; a blank line in
    // .env.example must not read as "configured".
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "   ";
    expect(remoteTelemetryStatus()).toEqual({ shipping: false, reason: "no_endpoint" });
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT =
      "https://otlp-gateway-prod-ca-east-0.grafana.net/otlp";
    process.env.OTEL_EXPORTER_OTLP_HEADERS = "Authorization=";
    expect(remoteTelemetryStatus()).toEqual({ shipping: false, reason: "no_authorization" });

    // The switch overrides a fully configured pair, and names itself.
    process.env.OTEL_EXPORTER_OTLP_HEADERS = "Authorization=Basic dGVzdDp0ZXN0";
    process.env.OTEL_SDK_DISABLED = "true";
    expect(remoteTelemetryStatus()).toEqual({ shipping: false, reason: "sdk_disabled" });
  });
});

test("A. the env is genuinely clean before and after that test", () => {
  // Guards the guard: if restoration leaks, every assertion above about an
  // unconfigured state would still pass on a developer machine that set the
  // variable, and fail on CI, for reasons nobody can see.
  withCleanEnv(() => {
    expect(otlpBaseEndpoint()).toBeUndefined();
    expect(otlpHeaders()).toEqual({});
  });
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "https://example.invalid/otlp";
  withCleanEnv(() => {
    expect(otlpBaseEndpoint()).toBeUndefined();
  });
  // ...and the value survives the harness, because `withCleanEnv` restores.
  expect(otlpBaseEndpoint()).toBe("https://example.invalid/otlp");
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
});

test("A2. initOtel decides from the predicate and reads the config nowhere else", () => {
  const otel = code(body(join("src", "lib", "telemetry", "otel.ts")));
  const init = fnBody(otel, "export function initOtel(");
  expect(init.length).toBeGreaterThan(0);
  expect(init).toContain("remoteTelemetryStatus()");

  // The ban is on *reads*, not on the names — see OTLP_READS.
  const readers = OTLP_READS.filter((re) => re.test(init));
  expect(readers.length, `initOtel reads config directly: ${readers.join(", ")}`).toBe(0);
  // ...and nowhere else in the module that decides whether to build the SDK.
  expect(OTLP_READS.filter((re) => re.test(otel)).length).toBe(0);
});

test("B. the artifact field is the predicate, not a recomputation", () => {
  const report = code(body(join("src", "lib", "telemetry", "report.ts")));
  // Each assertion names the file it is judging. A `toContain` over a 500-line
  // body prints the whole body as "received", which is a wall of text with no
  // line in it — the shape of blocker people route around.
  const where = "src/lib/telemetry/report.ts";
  expect(report, `${where}: the field must be filled from remoteTelemetryStatus()`).toContain(
    "remoteTelemetry: remoteTelemetryStatus()",
  );
  expect(report, `${where}: must import the predicate from ./otlp-config`).toContain(
    'from "./otlp-config"',
  );
  expect(report, `${where}: the old guessed boolean is back`).not.toContain("exporterConfigured");

  const slo = code(body(join("src", "lib", "telemetry", "slo.ts")));
  // Typed from the predicate's own return type: widening the field without
  // widening the answer is a type error, not a review comment.
  expect(slo, "src/lib/telemetry/slo.ts: field is not typed from the predicate").toContain(
    "remoteTelemetry: RemoteTelemetryStatus",
  );
});

test("C. the endpoint and credential are read in exactly one file", () => {
  const offenders = SRC.filter(
    (path) => path !== CONFIG && OTLP_READS.some((re) => re.test(code(body(path)))),
  );
  expect(
    offenders.join("\n"),
    "a second reader of the OTLP config is how the artifact and the runtime diverged once already",
  ).toBe("");

  // The rule is only worth anything if the owner really does read them. An empty
  // offender list over a file that reads nothing is the same green.
  const owner = code(body(CONFIG));
  expect(owner).toContain('read("OTEL_EXPORTER_OTLP_ENDPOINT")');
  expect(owner).toContain('read("OTEL_EXPORTER_OTLP_HEADERS")');
});

test("D. the retired Better Stack names are gone from src", () => {
  const offenders = SRC.filter((path) =>
    /OTEL_(BETTERSTACK_[A-Z_]+|SOURCE_TOKEN)\b/.test(code(body(path))),
  );
  expect(
    offenders.join("\n"),
    "OTEL_BETTERSTACK_* / OTEL_SOURCE_TOKEN are retired; the destination is Grafana Cloud over the standard OTLP variables",
  ).toBe("");
});

test("E. signal routing: base plus the spec path, or an override verbatim", () => {
  withCleanEnv(() => {
    expect(signalEndpoint("traces")).toBeUndefined();

    process.env.OTEL_EXPORTER_OTLP_ENDPOINT =
      "https://otlp-gateway-prod-ca-east-0.grafana.net/otlp";
    expect(signalEndpoint("traces")).toBe(
      "https://otlp-gateway-prod-ca-east-0.grafana.net/otlp/v1/traces",
    );
    expect(signalEndpoint("metrics")).toBe(
      "https://otlp-gateway-prod-ca-east-0.grafana.net/otlp/v1/metrics",
    );
    expect(signalEndpoint("logs")).toBe(
      "https://otlp-gateway-prod-ca-east-0.grafana.net/otlp/v1/logs",
    );

    // A trailing slash must not become `//v1/traces`.
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "https://gateway.example/otlp///";
    expect(signalEndpoint("traces")).toBe("https://gateway.example/otlp/v1/traces");

    // A bare host gets a scheme, because an operator pastes hosts, not URLs.
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "gateway.example/otlp";
    expect(signalEndpoint("traces")).toBe("https://gateway.example/otlp/v1/traces");

    // A per-signal override is used EXACTLY as given — no path appended. This is
    // the knob that ships metrics only, so appending to it would send traces
    // somewhere the operator never pointed them.
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "https://gateway.example/otlp";
    process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT =
      "https://gateway.example/otlp/v1/metrics?tenant=1";
    expect(signalEndpoint("metrics")).toBe("https://gateway.example/otlp/v1/metrics?tenant=1");
    expect(signalEndpoint("traces")).toBe("https://gateway.example/otlp/v1/traces");
  });
});

test("E. headers parse on the first equals only", () => {
  withCleanEnv(() => {
    // A Basic credential is base64 and can carry `=` padding. Splitting on the
    // LAST equals, or on every equals, truncates it into a token that fails to
    // authenticate and reads like a broken credential.
    process.env.OTEL_EXPORTER_OTLP_HEADERS =
      "Authorization=Basic dXNlcjpzZWNyZXQ=,X-Scope-OrgID=stack-1";
    expect(otlpHeaders()).toEqual({
      Authorization: "Basic dXNlcjpzZWNyZXQ=",
      "X-Scope-OrgID": "stack-1",
    });
    expect(hasAuthorization()).toBe(true);

    // Junk entries are skipped rather than turned into an empty header.
    process.env.OTEL_EXPORTER_OTLP_HEADERS = ",=nope,nospace,";
    expect(otlpHeaders()).toEqual({});
    expect(hasAuthorization()).toBe(false);
  });
});

test("controls: each rule fires on a planted violation", () => {
  // Positive controls, so a rotting predicate is caught here rather than by the
  // next person who trusts a green suite. Every case is a string, never a write.

  // A second reader, in the shape the bug actually had.
  const secondReader = `export function initOtel(): null {
  const endpoint = env("OTEL_EXPORTER_OTLP_ENDPOINT");
  if (!endpoint) return null;
  return null;
}`;
  const init = fnBody(secondReader, "export function initOtel(");
  expect(init.length).toBeGreaterThan(0);
  expect(init).not.toContain("remoteTelemetryStatus()");
  expect(OTLP_READS.filter((re) => re.test(init)).length).toBeGreaterThan(0);

  // The negative half, and it is load-bearing: otel.ts really does name these
  // variables inside its own warning strings, and rule C must not fire on that.
  // This assertion was written after rule C first shipped as a name ban and
  // failed on the honest log line.
  const honestWarning = `logWarn("[otel] no OTEL_EXPORTER_OTLP_ENDPOINT — traces stay local", {});`;
  expect(OTLP_READS.filter((re) => re.test(honestWarning)).length).toBe(0);
  const honestHeaders = `: "endpoint set but no Authorization in OTEL_EXPORTER_OTLP_HEADERS — nothing is sent";`;
  expect(OTLP_READS.filter((re) => re.test(honestHeaders)).length).toBe(0);

  const guessedField = `const snapshot = { exporterConfigured: endpoint() !== null };`;
  expect(guessedField).not.toContain("remoteTelemetry: remoteTelemetryStatus()");
  expect(guessedField).toContain("exporterConfigured");

  // Rule D's detector, on the retired names.
  expect(
    /OTEL_(BETTERSTACK_[A-Z_]+|SOURCE_TOKEN)\b/.test(`const t = env("OTEL_BETTERSTACK_TOKEN");`),
  ).toBe(true);
  // ...and neither rule fires on a comment, because `code()` removes them first.
  expect(code("// reads OTEL_EXPORTER_OTLP_ENDPOINT and OTEL_BETTERSTACK_TOKEN")).toBe("");
});
