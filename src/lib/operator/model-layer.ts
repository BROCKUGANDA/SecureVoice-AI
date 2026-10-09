import "server-only";
/**
 * Model-layer surface — the voice stack is LLM-agnostic, and this exposes WHICH
 * models answer and in what order WITHOUT any credential.
 *
 * Two planes answer a call:
 *   · the outbound ElevenLabs AGENT plane, whose LLM is set on the vendor
 *     dashboard under the bank's OWN key (BYOK);
 *   · the continuity/fallback plane, which drafts replies through a
 *     latency-ordered PROVIDER CASCADE (groq → lite_llm → gemini) — the first
 *     configured provider answers and the rest are failover (src/lib/llm.ts).
 *
 * We surface the cascade ORDER (mirroring selectProvider) and which provider is
 * currently ACTIVE by NAME only. provider() resolves the active provider with
 * its key and URL; only `.name` is read out, so a failover is observable to an
 * operator without a key or endpoint ever leaving the server.
 */

import { provider } from "@/lib/llm";

export type ModelLayer = {
  ok: true;
  agent_plane: { llm: string; note: string };
  fallback_cascade: {
    /** Provider names in precedence order — mirrors selectProvider(). */
    order: string[];
    /** The currently-resolved primary (its NAME, never its key/URL). */
    active: string | null;
    note: string;
  };
  byok_note: string;
};

/** The cascade order in selectProvider() — kept in one place so the two cannot drift. */
const CASCADE_ORDER = ["groq", "lite_llm", "gemini"] as const;

export function readModelLayer(): ModelLayer {
  let active: string | null = null;
  try {
    // NAME only. provider() carries the key/url; neither is surfaced.
    active = provider()?.name ?? null;
  } catch {
    active = null;
  }
  return {
    ok: true,
    agent_plane: {
      llm: "gpt-4o-mini",
      note: "The outbound agent's brain, set on the ElevenLabs dashboard under the bank's own key (BYOK).",
    },
    fallback_cascade: {
      order: [...CASCADE_ORDER],
      active,
      note: "Latency-ordered failover for the continuity plane; the first configured provider answers and the rest are failover. Each turn records which provider answered, so a failover is auditable.",
    },
    byok_note:
      "Banks bring their own provider keys (BYOK, encrypted at rest); SecureVoice bills the intervention wallet, not the underlying AI usage.",
  };
}
