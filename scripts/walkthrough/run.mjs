/**
 * Preflight and orchestration.
 *
 * The pre-flight exists because this pipeline records a product demo: if the
 * platform is not actually working end to end, or telephony is armed, the take
 * is worthless or worse. So it refuses to record on a red light.
 *
 * Usage: node run.mjs [--dry-run] [--skip-capture]
 */
import path from "node:path";
import { BASE, OUT, run, readJson, writeJson } from "./lib.mjs";

const status = await fetch(BASE + "/api/status", { signal: AbortSignal.timeout(30000) }).then((r) => r.json());
const guard = { telephony: status.telephony, ingest: status.ingest, voiceProvider: status.voiceProvider, dbLatencyMs: status.dbLatencyMs };
console.log("platform:", JSON.stringify(guard));
const problems = [];
if (!status.ok) problems.push("/api/status not ok");
if (status.telephony !== "unconfigured") {
  problems.push("telephony is " + status.telephony + " - restart the capture server with TWILIO_* blanked");
}
if (status.voiceProvider !== "elevenlabs") problems.push("voiceProvider is " + status.voiceProvider);
writeJson(path.join(OUT, "preflight.json"), { at: new Date().toISOString(), guard, problems });
if (problems.length) {
  console.error("\npreflight failed:\n  - " + problems.join("\n  - "));
  process.exit(1);
}

const dry = process.argv.includes("--dry-run");
const skipCap = process.argv.includes("--skip-capture");
const node = process.execPath;
const py = process.env.PYTHON || "python";

await run(node, ["dump-story.mjs"]);
await run(py, ["cards.py"]);
await run(node, ["narrate.mjs", ...(dry ? ["--dry-run"] : [])]);
if (!skipCap) await run(node, ["capture.mjs"]);
await run(node, ["assemble.mjs"]);
console.log("\ndone.");
