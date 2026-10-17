/**
 * The artifact's "is telemetry shipping" must be the runtime's own answer.
 *
 * WHY THIS FILE EXISTS. `report.ts` published `exporterConfigured: boolean` in the
 * SLO evidence artifact, and computed it in `src/lib/telemetry/export.ts` from
 * `OTEL_EXPORTER_OTLP_ENDPOINT`. The OTLP exporters were never built from that
 * variable: `otel.ts` derives its URL from `OTEL_BETTERSTACK_ENDPOINT` /
 * `OTEL_BETTERSTACK_HOST` and refuses to construct anything unless
 * `OTEL_BETTERSTACK_TOKEN` (or `OTEL_SOURCE_TOKEN`) is set. Two files asked two
 * different questions about one fact, so:
 *
 *   · set the documented token and traces, metrics and logs ship — the artifact
 *     still says `exporterConfigured: false`;
 *   · set `OTEL_EXPORTER_OTLP_ENDPOINT` and nothing ships — the artifact says
 *     `true`.
 *
 * Measured rather than reasoned: no `OTEL_*` variable exists in any container on
 * the production host (`docker exec … env | grep OTEL` is empty for app, dial,
 * email, outbox, overage, retention, voice-stream and realtime), which is the
 * accident that kept the two halves agreeing on `false` and hid the divergence.
 *
 * THE RULES.
 *   A. `initOtel()` decides from `remoteTelemetryStatus()`. It must not read the
 *      token or the disable switch itself — a second reader of the same config is
 *      how the first one went stale.
 *   B. The artifact's `remoteTelemetry` field is filled from that same function,
 *      and its type is the predicate's own return type, so a future field cannot
 *      quietly become a guess.
 *   C. Nothing under `src/` reads `OTEL_EXPORTER_OTLP_*`. Those three variables
 *      configured a hand-rolled second transport (`exportOtlp`) that had no
 *      caller while three real SDK exporters existed. Dead, and now banned from
 *      coming back as an unread knob.
 *
 * Deliberately NOT the check: "the collector received a span". That would put a
 * vendor endpoint in the build, and §20 of the gap register already records what
 * a build-time network dependency does to a deploy.
 */
import { expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { remoteTelemetryStatus } from "@/lib/telemetry/otlp-config";

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
// `join`, not a literal slash: `walk` builds its paths with `join`, and on Windows
// a forward-slash expectation matches nothing — a gate that reads "absent".
const OWNERS = [
  join("src", "lib", "telemetry", "otlp-config.ts"),
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

test("the scan is not looking at an empty set", () => {
  // Tripwire: every rule below reads files. A walk that returns nothing — or
  // skips the four files that own this fact — turns the suite green over a check
  // guarding nothing, which is the failure this repo has now documented four times.
  expect(SRC.length).toBeGreaterThan(200);
  for (const owner of OWNERS) {
    expect(SRC).toContain(owner);
    expect(code(body(owner)).length).toBeGreaterThan(0);
  }
});

test("A. the predicate answers all three states, and only the token state ships", () => {
  const saved = {
    disabled: process.env.OTEL_SDK_DISABLED,
    token: process.env.OTEL_BETTERSTACK_TOKEN,
    source: process.env.OTEL_SOURCE_TOKEN,
  };
  const clear = () => {
    delete process.env.OTEL_SDK_DISABLED;
    delete process.env.OTEL_BETTERSTACK_TOKEN;
    delete process.env.OTEL_SOURCE_TOKEN;
  };
  try {
    clear();
    expect(remoteTelemetryStatus()).toEqual({ shipping: false, reason: "no_ingestion_token" });

    // The alias counts: a deployment that set OTEL_SOURCE_TOKEN is shipping.
    process.env.OTEL_SOURCE_TOKEN = "s0000000";
    expect(remoteTelemetryStatus()).toEqual({ shipping: true, reason: null });
    delete process.env.OTEL_SOURCE_TOKEN;

    process.env.OTEL_BETTERSTACK_TOKEN = "token";
    expect(remoteTelemetryStatus().shipping).toBe(true);

    // An empty value is not a token. `env()` trims; a blank line in .env.example
    // must not read as "configured".
    process.env.OTEL_BETTERSTACK_TOKEN = "   ";
    expect(remoteTelemetryStatus()).toEqual({ shipping: false, reason: "no_ingestion_token" });

    // The switch overrides a present token, and names itself.
    process.env.OTEL_BETTERSTACK_TOKEN = "token";
    process.env.OTEL_SDK_DISABLED = "true";
    expect(remoteTelemetryStatus()).toEqual({ shipping: false, reason: "sdk_disabled" });
  } finally {
    clear();
    for (const [k, v] of [
      ["OTEL_SDK_DISABLED", saved.disabled],
      ["OTEL_BETTERSTACK_TOKEN", saved.token],
      ["OTEL_SOURCE_TOKEN", saved.source],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("A. initOtel decides from the predicate and reads the config nowhere else", () => {
  const otel = code(body(join("src", "lib", "telemetry", "otel.ts")));
  const init = fnBody(otel, "export function initOtel(");
  expect(init.length).toBeGreaterThan(0);
  expect(init).toContain("remoteTelemetryStatus()");

  // The ban is on *reads*, not on the names: the warning that tells an operator
  // what to set has to spell the variable out. A rule over bare names would fail
  // on the honest line and teach the next author to reword the log instead of
  // keeping one reader.
  const READS = [
    /env\(\s*"OTEL_BETTERSTACK_TOKEN"\s*\)/,
    /env\(\s*"OTEL_SOURCE_TOKEN"\s*\)/,
    /env\(\s*"OTEL_SDK_DISABLED"\s*\)/,
    /process\.env\.OTEL_(BETTERSTACK_TOKEN|SOURCE_TOKEN|SDK_DISABLED)\b/,
  ];
  const readers = READS.filter((re) => re.test(init));
  expect(readers.length, `initOtel reads config directly: ${readers.join(", ")}`).toBe(0);
  // ...and nowhere else in the module that decides whether to build the SDK.
  expect(READS.filter((re) => re.test(otel)).length).toBe(0);
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

test("C. no src file reads the variables that configured the dead transport", () => {
  const readers = SRC.filter((path) =>
    /OTEL_EXPORTER_OTLP_(ENDPOINT|HEADERS|TIMEOUT_MS)/.test(code(body(path))),
  );
  expect(
    readers.join("\n"),
    "these files read an OTLP knob nothing exports any more (see src/lib/telemetry/otlp-config.ts)",
  ).toBe("");
});

test("controls: each rule fires on a planted violation", () => {
  // Positive controls, so a rotting predicate is caught here rather than by the
  // next person who trusts a green suite. Every case is a string, never a write.
  const READS = [
    /env\(\s*"OTEL_BETTERSTACK_TOKEN"\s*\)/,
    /env\(\s*"OTEL_SOURCE_TOKEN"\s*\)/,
    /env\(\s*"OTEL_SDK_DISABLED"\s*\)/,
    /process\.env\.OTEL_(BETTERSTACK_TOKEN|SOURCE_TOKEN|SDK_DISABLED)\b/,
  ];

  // A second reader, in the shape the bug actually had.
  const secondReader = `export function initOtel(): null {
  const token = env("OTEL_BETTERSTACK_TOKEN") ?? env("OTEL_SOURCE_TOKEN");
  if (!token) return null;
  return null;
}`;
  const init = fnBody(secondReader, "export function initOtel(");
  expect(init.length).toBeGreaterThan(0);
  expect(init).not.toContain("remoteTelemetryStatus()");
  expect(READS.filter((re) => re.test(init)).length).toBeGreaterThan(0);

  // A log line naming the variable must NOT be what the rule catches, or the rule
  // is a text ban the next author works around by rewording. This line is clean.
  const honestWarning = `logWarn("[otel] no token set", { detail: "Set OTEL_BETTERSTACK_TOKEN." });`;
  expect(READS.filter((re) => re.test(honestWarning)).length).toBe(0);

  const guessedField = `const snapshot = { exporterConfigured: endpoint() !== null };`;
  expect(guessedField).not.toContain("remoteTelemetry: remoteTelemetryStatus()");
  expect(guessedField).toContain("exporterConfigured");

  const orphanKnob = `const raw = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;`;
  expect(/OTEL_EXPORTER_OTLP_(ENDPOINT|HEADERS|TIMEOUT_MS)/.test(code(orphanKnob))).toBe(true);

  // A comment must not satisfy the ban — the doc header names what it forbids.
  expect(code("// reads OTEL_EXPORTER_OTLP_ENDPOINT")).toBe("");
});
