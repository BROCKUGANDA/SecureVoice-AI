#!/usr/bin/env bun
/**
 * agent-snapshot — GET the agent from the ElevenLabs Agents Platform,
 * canonicalise the JSON (sorted keys, no whitespace), and write the snapshot
 * + its sha256 into evidence/. This is the graded evidence artifact: the
 * snapshot hash proves which agent configuration was live at evidence time.
 *
 *   bun run agent:snapshot
 *
 * The snapshot is byte-stable across runs when the config is unchanged —
 * the canonical form sorts all keys and strips all whitespace.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

const API = process.env.ELEVENLABS_API_BASE ?? "https://api.elevenlabs.io";
const AGENT_ID = process.env.ELEVENLABS_AGENT_ID;
const API_KEY = process.env.ELEVENLABS_API_KEY;

if (!AGENT_ID) {
  console.error("✗ ELEVENLABS_AGENT_ID is not set.");
  process.exit(1);
}
if (!API_KEY) {
  console.error("✗ ELEVENLABS_API_KEY is not set.");
  process.exit(1);
}

const ROOT = resolve(import.meta.dir, "..");
const EVIDENCE_DIR = resolve(ROOT, "evidence/agent");

/** Recursively sort object keys so the JSON is canonical. */
function canonicalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalise);
  if (value && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort())
      sorted[k] = canonicalise((value as Record<string, unknown>)[k]);
    return sorted;
  }
  return value;
}

/**
 * Strip platform-bookkeeping fields that change on every write. The snapshot
 * fingerprints the CONFIGURATION, not the platform's version metadata —
 * `version_id` and `metadata.updated_at_unix_secs` change on every PATCH, so
 * including them would make the hash diverge between identical applies and
 * break the idempotency gate.
 */
const VOLATILE_KEYS = new Set([
  "metadata",
  "version_id",
  "branch_id",
  "main_branch_id",
  "access_info",
  "access_permissions",
]);

function stripVolatile(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripVolatile);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (VOLATILE_KEYS.has(k)) continue;
      out[k] = stripVolatile(v);
    }
    return out;
  }
  return value;
}

async function main() {
  console.log(`▶ agent:snapshot — GET /v1/convai/agents/${AGENT_ID}`);
  const res = await fetch(`${API}/v1/convai/agents/${AGENT_ID}`, {
    headers: { "xi-api-key": API_KEY! },
  });
  if (!res.ok) {
    const text = await res.text();
    console.error(`✗ GET failed ${res.status}: ${text.slice(0, 500)}`);
    process.exit(1);
  }
  const agent = await res.json();

  const canonical = JSON.stringify(canonicalise(stripVolatile(agent)));
  const sha256 = createHash("sha256").update(canonical).digest("hex");

  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const snapPath = resolve(EVIDENCE_DIR, "snapshot.json");
  const shaPath = resolve(EVIDENCE_DIR, "snapshot.sha256");
  writeFileSync(snapPath, canonical);
  writeFileSync(shaPath, `${sha256}\n`);

  const versionId: string | null = agent.version_id ?? null;
  console.log(`  ✓ snapshot → evidence/agent/snapshot.json (${canonical.length} bytes)`);
  console.log(`  ✓ sha256   → evidence/agent/snapshot.sha256`);
  console.log(`  ✓ version_id: ${versionId ?? "(none)"}`);
  console.log(`  ✓ sha256: ${sha256}`);
  console.log("\n✓ agent:snapshot complete");
}

main().catch((err) => {
  console.error("✗ agent:snapshot failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
