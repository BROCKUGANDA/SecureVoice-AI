/**
 * The console's "Knowledge Base + RAG" panel vs what the agent is told to use.
 *
 * Two files describe the same knowledge base, in two shapes, with nothing between
 * them: `agent/securevoice.agent.yaml` declares the documents that get attached to
 * the ElevenLabs agent (`scripts/agent-apply.ts` resolves `id_env` and PATCHes them),
 * while `src/lib/operator/manifest.ts` publishes a hand-written list that
 * `/api/operator/manifest` serves to the operator dashboard — whose panel header
 * says it is showing "which documents ground the agent".
 *
 * That second list is configuration someone maintains by hand, so it drifts the way
 * all hand-kept copies do: silently, and in the direction of looking fine. Today the
 * two agree (two documents, English and Arabic, RAG enabled, one embedding model);
 * this test is what keeps "we added the refund policy to the agent" from becoming a
 * panel that still shows two.
 *
 * What it deliberately does NOT claim: that either list reflects a bank's own
 * uploaded documents. Those live in the `Document` table and the tenant's Pinecone
 * namespace, are retrieved by `src/lib/llm.ts`, and are not the same knowledge base
 * as the platform-side policy the agent cites. A panel that showed the platform
 * policy while the tenant uploaded nothing would read exactly like one that showed
 * the tenant's documents, which is why the count and language comparison is asserted
 * here rather than a nicer-looking "documents: N" taken from the database.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { KNOWLEDGE_BASE, RAG_CONFIG } from "@/lib/operator/manifest";
import { SUPPORTED_LANGS } from "@/lib/languages";

const ROOT = join(import.meta.dir, "..", "..");
const yaml = readFileSync(join(ROOT, "agent", "securevoice.agent.yaml"), "utf8");

/** The `knowledge_base:` block's `- type:` entries, up to the next top-level key. */
function declaredKb(): { name: string; idEnv: string }[] {
  const block = yaml.match(/^knowledge_base:\n((?:[ \t]+- .*(?:\n[ \t]+.*)*)+)/m)?.[1];
  if (!block) return [];
  const entries: { name: string; idEnv: string }[] = [];
  for (const chunk of block.split(/\n(?=[ \t]+- )/)) {
    const name = chunk.match(/name:\s*"(.*?)"/)?.[1];
    const idEnv = chunk.match(/id_env:\s*(\S+)/)?.[1];
    if (name && idEnv) entries.push({ name, idEnv });
  }
  return entries;
}

function declaredRag(): { enabled: boolean } {
  const block = yaml.match(/^rag:\n((?:[ \t]+.*\n?)+)/m)?.[1] ?? "";
  return { enabled: /enabled:\s*true/.test(block) };
}

describe("the operator manifest and the agent declaration agree", () => {
  test("the yaml really declares a knowledge base", () => {
    // Without this the comparisons below could pass on two empty lists, which is
    // the shape of every vacuous agreement test.
    expect(declaredKb().length).toBeGreaterThan(0);
  });

  test("same number of documents", () => {
    expect(KNOWLEDGE_BASE.length).toBe(declaredKb().length);
  });

  test("every language the agent has a policy for is in the panel, and vice versa", () => {
    const fromYaml = new Set(
      declaredKb().map((d) => d.idEnv.replace(/^ELEVENLABS_KB_/, "").toLowerCase()),
    );
    const fromManifest = new Set(KNOWLEDGE_BASE.map((d) => d.lang));
    expect([...fromManifest].sort()).toEqual([...fromYaml].sort());
  });

  test("RAG is enabled in both, or disabled in both", () => {
    expect(RAG_CONFIG.enabled).toBe(declaredRag().enabled);
  });

  test("the panel never names a language the product cannot speak", () => {
    for (const doc of KNOWLEDGE_BASE) {
      expect(
        (SUPPORTED_LANGS as readonly string[]).includes(doc.lang),
        `${doc.title} is declared for "${doc.lang}", which is not a supported call language`,
      ).toBe(true);
    }
  });

  test("the coverage gap stays visible: policy languages vs spoken languages", () => {
    // Not a failure — a stated count. The agent speaks six languages and cites a
    // policy written in two; the platform's multilingual embedding model means a
    // French or Urdu turn can still RETRIEVE the English/Arabic document, but the
    // text it quotes back is not in the caller's language. Recorded here so the
    // number is checked on every run rather than rediscovered in a demo.
    const policyLangs = new Set(KNOWLEDGE_BASE.map((d) => d.lang)).size;
    const spoken = SUPPORTED_LANGS.length;
    expect(policyLangs).toBeLessThanOrEqual(spoken);
    if (policyLangs < spoken) {
      console.warn(
        `[kb-coverage] agent speaks ${spoken} languages, policy documents exist for ${policyLangs} ` +
          `(${[...new Set(KNOWLEDGE_BASE.map((d) => d.lang))].join(", ")}). ` +
          `Untranslated turns retrieve cross-lingually and quote the ${
            policyLangs === 1 ? "only" : "nearest"
          } language's text.`,
      );
    }
  });
});
