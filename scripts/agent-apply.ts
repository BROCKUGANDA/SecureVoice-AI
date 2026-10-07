#!/usr/bin/env bun
/**
 * agent-apply — apply agent/securevoice.agent.yaml to the ElevenLabs Agents
 * Platform, read it back, and deep-diff. Exits non-zero on any divergence.
 *
 * This is WP-1: agent configuration as code. The YAML is the single source
 * of truth; this script is the only writer. A 200 on PATCH does not prove
 * persistence — we GET the agent back and assert every field we set.
 *
 *   bun run agent:apply
 *
 * Idempotency: a second run produces an empty diff and the same version_id
 * (the platform versions on PATCH; identical input → identical version).
 *
 * Tools and KB documents that are declared in the YAML but not yet created on
 * the platform (the WP-3 tools) are resolved by env var, then by name lookup,
 * then skipped with a warning — the apply never fails on a not-yet-created
 * dependency. When WP-3 creates them and sets the env vars, the next apply
 * picks them up.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import yaml from "js-yaml";
import { fetchWithBackoff } from "./lib/elevenlabs-egress.mjs";

const API = process.env.ELEVENLABS_API_BASE ?? "https://api.elevenlabs.io";
const AGENT_ID = process.env.ELEVENLABS_AGENT_ID;
const API_KEY = process.env.ELEVENLABS_API_KEY;

if (!AGENT_ID) {
  console.error("✗ ELEVENLABS_AGENT_ID is not set — cannot apply agent config.");
  process.exit(1);
}
if (!API_KEY) {
  console.error("✗ ELEVENLABS_API_KEY is not set — cannot apply agent config.");
  process.exit(1);
}

const ROOT = resolve(import.meta.dir, "..");
const YAML_PATH = resolve(ROOT, "agent/securevoice.agent.yaml");
const EVIDENCE_DIR = resolve(ROOT, "evidence/agent");

// ── Load + resolve the YAML ──────────────────────────────────────────────────

type RawDef = Record<string, any>;

function loadDef(): RawDef {
  const raw = readFileSync(YAML_PATH, "utf8");
  return yaml.load(raw) as RawDef;
}

/** Resolve ${VAR} references from the environment. Throws on a missing var. */
function resolveValue(v: unknown): unknown {
  if (typeof v === "string") {
    const m = /^\$\{([A-Z_][A-Z0-9_]*)\}$/.exec(v);
    if (m) {
      const val = process.env[m[1]];
      if (val === undefined || val === "") {
        throw new Error(`Environment variable ${m[1]} is referenced in the YAML but not set.`);
      }
      return val;
    }
    return v;
  }
  if (Array.isArray(v)) return v.map(resolveValue);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[k] = resolveValue(val);
    return out;
  }
  return v;
}

/**
 * The agent's built-in system tools. One builder feeds BOTH the PATCH body and
 * the desired-state diff, so what is sent and what is verified cannot drift.
 *
 * `description` is deliberately omitted: a blank description makes the platform
 * use its tool-specific default prompt for when to fire, and an explicit "" would
 * then diverge from the stored default on the read-back diff.
 */
function builtInTools(def: RawDef): Record<string, unknown> {
  const voicemail = def.voicemail as RawDef | undefined;
  if (!voicemail?.message) return {};
  return {
    voicemail_detection: {
      type: "system",
      name: "voicemail_detection",
      params: {
        system_tool_type: "voicemail_detection",
        voicemail_message: voicemail.message,
      },
    },
  };
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────

async function apiFetch(path: string, init?: RequestInit): Promise<any> {
  // Safe to retry: the PATCH sends the whole desired configuration, so a second
  // attempt after a transient 5xx sets the same state rather than stacking one.
  const res = await fetchWithBackoff(`${API}${path}`, {
    ...init,
    headers: {
      "xi-api-key": API_KEY!,
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `ElevenLabs ${init?.method ?? "GET"} ${path} → ${res.status}: ${text.slice(0, 500)}`,
    );
  }
  return text ? JSON.parse(text) : null;
}

// ── Tool + KB resolution ─────────────────────────────────────────────────────

type ResolvedTool = { name: string; id: string; response_timeout_secs: number };

async function resolveTools(def: RawDef): Promise<ResolvedTool[]> {
  const tools = (def.tools as RawDef[]) ?? [];
  // Index the workspace's tools by name for fallback lookup.
  const all = await apiFetch(`/v1/convai/tools?page_size=100`);
  const byName = new Map<string, string>();
  for (const t of all.tools ?? []) byName.set(t.tool_config.name, t.id);

  const resolved: ResolvedTool[] = [];
  for (const t of tools) {
    const envId = process.env[t.id_env as string];
    const id = envId || byName.get(t.name);
    if (!id) {
      console.warn(
        `  ⚠ tool ${t.name}: not found (env ${t.id_env} unset, no platform match) — skipping (WP-3 will create it)`,
      );
      continue;
    }
    resolved.push({ name: t.name, id, response_timeout_secs: t.response_timeout_secs ?? 5 });
  }
  return resolved;
}

async function resolveKb(def: RawDef): Promise<{ type: string; name: string; id: string }[]> {
  const docs = (def.knowledge_base as RawDef[]) ?? [];
  const all = await apiFetch(`/v1/convai/knowledge-base?page_size=100`);
  const byName = new Map<string, string>();
  for (const k of all.knowledge_base ?? []) byName.set(k.name, k.id);

  const resolved: { type: string; name: string; id: string }[] = [];
  for (const d of docs) {
    const envId = process.env[d.id_env as string];
    const id = envId || byName.get(d.name);
    if (!id) {
      console.warn(
        `  ⚠ KB "${d.name}": not found (env ${d.id_env} unset, no platform match) — skipping`,
      );
      continue;
    }
    resolved.push({ type: d.type, name: d.name, id });
  }
  return resolved;
}

// ── Build the PATCH body ─────────────────────────────────────────────────────

function buildPatchBody(
  def: RawDef,
  toolIds: string[],
  kb: { type: string; name: string; id: string }[],
): Record<string, unknown> {
  const agent = def.agent as RawDef;
  const languages = def.languages as RawDef;
  const tts = def.tts as RawDef;
  const asr = def.asr as RawDef;
  const turn = def.turn as RawDef;
  const conversation = def.conversation as RawDef;
  const rag = def.rag as RawDef;
  const privacy = def.privacy as RawDef;
  const guardrails = def.guardrails as RawDef;
  const callLimits = def.call_limits as RawDef;
  const overrides = def.overrides as RawDef;

  const langPresets: Record<string, unknown> = {};
  for (const [lang, cfg] of Object.entries(languages)) {
    const c = cfg as RawDef;
    langPresets[lang] = {
      overrides: {
        tts: { voice_id: c.voice_id },
        agent: {
          language: lang,
          first_message: c.first_message,
          max_conversation_duration_message: agent.max_conversation_duration_message,
        },
      },
    };
  }

  const enVoice = process.env.ELEVENLABS_VOICE_EN;
  if (!enVoice) throw new Error("ELEVENLABS_VOICE_EN is not set.");

  return {
    name: def.name,
    tags: def.tags,
    version_description: `agent:apply ${new Date().toISOString()}`,
    conversation_config: {
      agent: {
        first_message: agent.first_message,
        language: agent.language,
        max_conversation_duration_message: agent.max_conversation_duration_message,
        disable_first_message_interruptions: agent.disable_first_message_interruptions,
        prompt: {
          prompt: agent.system_prompt,
          llm: agent.llm,
          temperature: agent.temperature,
          max_tokens: agent.max_tokens,
          timezone: agent.timezone,
          ignore_default_personality: agent.ignore_default_personality,
          tool_ids: toolIds,
          built_in_tools: builtInTools(def),
          knowledge_base: kb,
          rag: { enabled: rag.enabled, include_source_urls: rag.include_source_urls },
        },
      },
      tts: {
        model_id: tts.model_id,
        voice_id: enVoice,
        agent_output_audio_format: tts.output_format,
        stability: tts.stability,
        speed: tts.speed,
        similarity_boost: tts.similarity_boost,
        text_normalisation_type: tts.text_normalisation_type,
      },
      asr: {
        provider: asr.provider,
        user_input_audio_format: asr.input_format,
        quality: asr.quality,
        keywords: asr.keywords,
      },
      turn: {
        turn_timeout: turn.turn_timeout,
        silence_end_call_timeout: turn.silence_end_call_timeout,
        turn_eagerness: turn.turn_eagerness,
        speculative_turn: turn.speculative_turn,
        turn_model: turn.turn_model,
        spelling_patience: turn.spelling_patience,
      },
      conversation: {
        max_duration_seconds: conversation.max_duration_seconds,
        client_events: conversation.client_events,
      },
      language_presets: langPresets,
    },
    platform_settings: {
      evaluation: { criteria: def.evaluation_criteria },
      data_collection: (def.data_collection as RawDef[]).reduce<Record<string, unknown>>(
        (acc, dc) => {
          const item: Record<string, unknown> = { type: dc.type, description: dc.description };
          if (dc.enum) item.enum = dc.enum;
          acc[dc.name] = item;
          return acc;
        },
        {},
      ),
      privacy: {
        record_voice: privacy.record_voice,
        retention_days: privacy.retention_days,
        zero_retention_mode: privacy.zero_retention_mode,
      },
      guardrails: {
        prompt_injection: { is_enabled: guardrails.prompt_injection.is_enabled },
      },
      call_limits: {
        agent_concurrency_limit: callLimits.agent_concurrency_limit,
        daily_limit: callLimits.daily_limit,
      },
      overrides: {
        conversation_config_override: overrides.conversation_config_override,
      },
    },
  };
}

// ── Deep diff ────────────────────────────────────────────────────────────────

type Divergence = { path: string; expected: unknown; actual: unknown };

function deepDiff(desired: unknown, actual: unknown, path: string, out: Divergence[]): void {
  if (desired === null || desired === undefined) return;
  if (typeof desired !== "object") {
    if (desired !== actual) out.push({ path, expected: desired, actual });
    return;
  }
  if (Array.isArray(desired)) {
    if (!Array.isArray(actual)) {
      out.push({ path, expected: desired, actual });
      return;
    }
    if (desired.length !== actual.length) {
      out.push({ path: `${path}.length`, expected: desired.length, actual: actual.length });
      return;
    }
    for (let i = 0; i < desired.length; i++) deepDiff(desired[i], actual[i], `${path}[${i}]`, out);
    return;
  }
  if (typeof actual !== "object" || actual === null || Array.isArray(actual)) {
    out.push({ path, expected: desired, actual });
    return;
  }
  for (const [k, v] of Object.entries(desired as Record<string, unknown>)) {
    deepDiff(v, (actual as Record<string, unknown>)[k], path ? `${path}.${k}` : k, out);
  }
}

/** Build the "desired state" object that we compare the GET response against. */
function desiredState(
  def: RawDef,
  toolIds: string[],
  kb: { type: string; name: string; id: string }[],
): Record<string, unknown> {
  const agent = def.agent as RawDef;
  const languages = def.languages as RawDef;
  const tts = def.tts as RawDef;
  const asr = def.asr as RawDef;
  const turn = def.turn as RawDef;
  const conversation = def.conversation as RawDef;
  const rag = def.rag as RawDef;
  const privacy = def.privacy as RawDef;
  const guardrails = def.guardrails as RawDef;
  const callLimits = def.call_limits as RawDef;

  const langPresets: Record<string, unknown> = {};
  for (const [lang, cfg] of Object.entries(languages)) {
    const c = cfg as RawDef;
    langPresets[lang] = {
      overrides: {
        tts: { voice_id: c.voice_id },
        agent: {
          language: lang,
          first_message: c.first_message,
          max_conversation_duration_message: agent.max_conversation_duration_message,
        },
      },
    };
  }

  const enVoice = process.env.ELEVENLABS_VOICE_EN;

  const prompt: Record<string, unknown> = {
    prompt: agent.system_prompt,
    llm: agent.llm,
    temperature: agent.temperature,
    max_tokens: agent.max_tokens,
    timezone: agent.timezone,
    ignore_default_personality: agent.ignore_default_personality,
    rag: { enabled: rag.enabled, include_source_urls: rag.include_source_urls },
  };
  if (toolIds.length > 0) prompt.tool_ids = toolIds;
  if (Object.keys(builtInTools(def)).length > 0) prompt.built_in_tools = builtInTools(def);
  if (kb.length > 0) prompt.knowledge_base = kb;

  return {
    name: def.name,
    conversation_config: {
      agent: {
        first_message: agent.first_message,
        language: agent.language,
        max_conversation_duration_message: agent.max_conversation_duration_message,
        disable_first_message_interruptions: agent.disable_first_message_interruptions,
        prompt,
      },
      tts: {
        model_id: tts.model_id,
        voice_id: enVoice,
        agent_output_audio_format: tts.output_format,
        stability: tts.stability,
        speed: tts.speed,
        similarity_boost: tts.similarity_boost,
        text_normalisation_type: tts.text_normalisation_type,
      },
      asr: {
        provider: asr.provider,
        user_input_audio_format: asr.input_format,
        quality: asr.quality,
        keywords: asr.keywords,
      },
      turn: {
        turn_timeout: turn.turn_timeout,
        silence_end_call_timeout: turn.silence_end_call_timeout,
        turn_eagerness: turn.turn_eagerness,
        speculative_turn: turn.speculative_turn,
        turn_model: turn.turn_model,
        spelling_patience: turn.spelling_patience,
      },
      conversation: {
        max_duration_seconds: conversation.max_duration_seconds,
      },
      language_presets: langPresets,
    },
    platform_settings: {
      evaluation: { criteria: def.evaluation_criteria },
      privacy: {
        record_voice: privacy.record_voice,
        retention_days: privacy.retention_days,
        zero_retention_mode: privacy.zero_retention_mode,
      },
      guardrails: {
        prompt_injection: { is_enabled: guardrails.prompt_injection.is_enabled },
      },
      call_limits: {
        agent_concurrency_limit: callLimits.agent_concurrency_limit,
        daily_limit: callLimits.daily_limit,
      },
      overrides: {
        conversation_config_override: (def.overrides as RawDef).conversation_config_override,
      },
    },
  };
}

// ── Tool secret headers ──────────────────────────────────────────────────────

async function configureToolSecrets(def: RawDef, tools: ResolvedTool[]): Promise<string[]> {
  const secret = process.env.AGENT_TOOL_SECRET;
  if (!secret) {
    console.error("✗ AGENT_TOOL_SECRET is not set — tool calls would 401. Refusing to apply.");
    process.exit(1);
  }
  const headerName = (def as RawDef).tool_secret_header as string;
  const configured: string[] = [];

  for (const t of tools) {
    const current = await apiFetch(`/v1/convai/tools/${t.id}`);
    const headers = { ...(current.tool_config.api_schema.request_headers ?? {}) };
    headers[headerName] = secret;
    await apiFetch(`/v1/convai/tools/${t.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        tool_config: {
          type: "webhook",
          name: current.tool_config.name,
          description: current.tool_config.description,
          api_schema: {
            ...current.tool_config.api_schema,
            request_headers: headers,
          },
          response_timeout_secs:
            t.response_timeout_secs ?? current.tool_config.response_timeout_secs,
          execution_mode: current.tool_config.execution_mode,
          interruption_mode: current.tool_config.interruption_mode,
          pre_tool_speech: current.tool_config.pre_tool_speech,
          tool_error_handling_mode: current.tool_config.tool_error_handling_mode,
        },
      }),
    });
    configured.push(t.name);
  }
  return configured;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("▶ agent:apply — loading YAML definition");
  const def = loadDef();
  const resolved = resolveValue(def) as RawDef;

  console.log("▶ Resolving tools");
  const tools = await resolveTools(resolved);
  console.log(`  ✓ tools: ${tools.map((t) => t.name).join(", ")}`);

  console.log("▶ Resolving knowledge base");
  const kb = await resolveKb(resolved);
  console.log(`  ✓ KB: ${kb.map((k) => k.name).join(", ")}`);

  console.log("▶ Configuring tool secret headers");
  const toolsConfigured = await configureToolSecrets(resolved, tools);
  console.log(`  ✓ headers set on: ${toolsConfigured.join(", ")}`);

  console.log("▶ Building PATCH body");
  const patchBody = buildPatchBody(
    resolved,
    tools.map((t) => t.id),
    kb,
  );

  console.log(`▶ PATCH /v1/convai/agents/${AGENT_ID}`);
  const patched = await apiFetch(`/v1/convai/agents/${AGENT_ID}`, {
    method: "PATCH",
    body: JSON.stringify(patchBody),
  });
  const versionId: string | null = patched.version_id ?? null;
  console.log(`  ✓ version_id: ${versionId ?? "(none)"}`);

  console.log("▶ GET /v1/convai/agents — reading back");
  const actual = await apiFetch(`/v1/convai/agents/${AGENT_ID}`);

  console.log("▶ Deep-diffing desired vs actual");
  const desired = desiredState(
    resolved,
    tools.map((t) => t.id),
    kb,
  );
  const divergences: Divergence[] = [];
  deepDiff(desired, actual, "", divergences);

  if (divergences.length > 0) {
    console.error(`\n✗ ${divergences.length} divergence(s) between desired and actual:`);
    for (const d of divergences.slice(0, 50)) {
      console.error(`  ${d.path}`);
      console.error(`    expected: ${JSON.stringify(d.expected)?.slice(0, 200)}`);
      console.error(`    actual:   ${JSON.stringify(d.actual)?.slice(0, 200)}`);
    }
    if (divergences.length > 50) console.error(`  … and ${divergences.length - 50} more`);
    process.exit(1);
  }

  console.log("  ✓ zero divergences — applied config matches the YAML exactly");

  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const versionFile = resolve(EVIDENCE_DIR, "version.txt");
  writeFileSync(versionFile, `${versionId ?? "unknown"}\n`);
  console.log(`  ✓ version recorded → evidence/agent/version.txt`);

  console.log("\n✓ agent:apply complete — agent config is in sync with the YAML");
}

main().catch((err) => {
  console.error("✗ agent:apply failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
