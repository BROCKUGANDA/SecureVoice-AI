#!/usr/bin/env bun
/**
 * GO / NO-GO preflight — run before a demo, a deploy, or a go-live.
 *
 *   bun run preflight
 *
 * Prints one line per check and exits 1 if any GO-LIVE blocker is present.
 * The point: "remember to flip the flag" is not a process. This script is.
 * Wire it into the deploy runbook (docs/HETZNER.md) and run it before judges
 * touch the platform — a red row is impossible to miss.
 */

const checks = [];
const add = (name, ok, detail, blocker = false) =>
  checks.push({ name, ok, detail, blocker });

const env = process.env;
const set = (v) => !!(v && v.trim() && !v.includes("..."));

/* ── Identity / auth ── */
const pk = env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ?? "";
const sk = env.CLERK_SECRET_KEY ?? "";
add("Clerk publishable key", set(pk), set(pk) ? (pk.startsWith("pk_live") ? "production (pk_live)" : "DEV INSTANCE (pk_test) — fine for demo, swap = rebuild + wallet reset") : "MISSING", !set(pk));
add("Clerk secret key", set(sk), set(sk) ? (sk.startsWith("sk_live") ? "production" : "dev instance") : "MISSING", !set(sk));
add("AUTH_SECRET (BYOK encryption)", set(env.AUTH_SECRET), set(env.AUTH_SECRET) ? "set" : "MISSING — BYOK storage throws without it", !set(env.AUTH_SECRET));
add("WEBHOOK_SECRET (ingest signing)", set(env.WEBHOOK_SECRET), set(env.WEBHOOK_SECRET) ? "set" : "MISSING — /api/interventions rejects every signal", !set(env.WEBHOOK_SECRET));

/* ── Voice provider ── */
const hasKey = set(env.ELEVENLABS_API_KEY);
const dryRun = env.ELEVENLABS_DRY_RUN === "true";
add(
  "Voice mode",
  hasKey && !dryRun,
  dryRun
    ? "DRY-RUN — no real ElevenLabs voice. THE thing to flip before judges/users."
    : hasKey
      ? "LIVE (real ElevenLabs quota burns)"
      : "no API key — dev backend only",
  false, // dry-run is a deliberate demo mode, not a blocker
);
add("Agent id (ELEVENLABS_AGENT_ID)", set(env.ELEVENLABS_AGENT_ID), set(env.ELEVENLABS_AGENT_ID) ? "set" : "unset — conversational agent path disabled");
const voices = ["EN", "AR", "HI", "UR", "FR", "SW"].filter((l) => set(env[`ELEVENLABS_VOICE_${l}`]));
add("Per-language voices", voices.length >= 2, voices.length ? `${voices.join("/")} configured` : "none — prod TTS 422s");

/* ── Telephony ── */
const twilio = set(env.TWILIO_ACCOUNT_SID) && (set(env.TWILIO_AUTH_TOKEN) || (set(env.TWILIO_API_KEY_SID) && set(env.TWILIO_API_KEY_SECRET)));
add("Twilio telephony", twilio, twilio ? "configured — REAL calls possible" : "unconfigured — audit-only, nothing dials");
add("TWILIO_AUTH_TOKEN (inbound webhook verify)", set(env.TWILIO_AUTH_TOKEN), set(env.TWILIO_AUTH_TOKEN) ? "set" : "unset — /api/twilio/turn signatures CANNOT be verified");

/* ── Realtime ── */
add("REALTIME_INGEST_SECRET", set(env.REALTIME_INGEST_SECRET), set(env.REALTIME_INGEST_SECRET) ? "set" : "unset — console falls back to SSE (works, no push)");

/* ── Deployment surface ── */
const site = env.SITE_ADDRESS ?? "";
add("SITE_ADDRESS", set(site) && site !== "localhost", set(site) && site !== "localhost" ? site : "localhost — internal CA cert, no Let's Encrypt");
add("Agent tool allow-list", env.AGENT_TOOL_ALLOWED !== "card_freeze,human_handoff", env.AGENT_TOOL_ALLOWED ?? "human_handoff (default)");

/* ── Report ── */
let blockers = 0;
console.log("\nSecureVoice preflight\n" + "─".repeat(60));
for (const c of checks) {
  const mark = c.ok ? " GO " : c.blocker ? "NO-GO" : "warn";
  if (!c.ok && c.blocker) blockers++;
  console.log(`[${mark}] ${c.name}: ${c.detail}`);
}
console.log("─".repeat(60));
if (dryRun) {
  console.log("REMINDER: ELEVENLABS_DRY_RUN=true — flip to false for live voice.");
}
if (pk.startsWith("pk_test")) {
  console.log("REMINDER: Clerk dev instance — swap to pk_live/sk_live BEFORE real users (swap = rebuild + wallet reset).");
}
console.log(blockers ? `\n${blockers} NO-GO blocker(s).\n` : "\nNo hard blockers.\n");
process.exit(blockers ? 1 : 0);
