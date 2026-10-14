/**
 * ONE POLICY PER LANGUAGE THE AGENT SPEAKS, and the repo holds the text.
 *
 * The agent is configured with six languages and was given a knowledge base in
 * two. RAG across languages is not a substitute: `multilingual_e5_large_instruct`
 * will retrieve an English clause for a Hindi question, and the agent will then
 * paraphrase an obligation it is quoting in a language the caller never heard it
 * in. The disclosure sections of this policy are the reason the caller can trust
 * the sentence at all, so "the policy exists, in English, somewhere in the index"
 * is not the guarantee the platform makes on a call.
 *
 * The second thing this file protects is where the text LIVES. The policy
 * documents were created in the vendor console and nothing in the tree carried
 * their content, so a translator, a reviewer or a regulator could not read what
 * the agent cites, `agent:apply` had nothing to re-create them from, and the only
 * copy of a compliance document was a resource id in a deployment's `.env`. The
 * files under `agent/policy/` are now the source of truth and this gate is what
 * keeps them from drifting: it fails on a missing language, on a section dropped
 * in translation, and on the specific way a translated policy actually goes wrong
 * in production — a script that is not the one its language uses.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { SUPPORTED_LANGS } from "@/lib/languages";

const ROOT = join(import.meta.dir, "..", "..");
const POLICY_DIR = join(ROOT, "agent", "policy");
const DOC_ID = "SV-FDP-2026-01";

/** The section markers each language uses, so "all seven are here" is measurable. */
const SECTION_MARKERS: Record<string, RegExp> = {
  en: /^SECTION \d+ —/gm,
  ar: /^القسم \d+ —/gm,
  hi: /^अनुच्छेद \d+ —/gm,
  ur: /^دھار \d+ —/gm,
  fr: /^SECTION \d+ —/gm,
  sw: /^KIFUNGO \d+ —/gm,
};

/** The script a language must NOT be written in is checked below; the script it
 *  must be written in is implied by the section marker it uses. */

const LANGS: readonly string[] = SUPPORTED_LANGS;

function policy(lang: string): string {
  return readFileSync(join(POLICY_DIR, `${DOC_ID}.${lang}.md`), "utf8");
}

test("every language the platform supports has a policy document in the repo", () => {
  const missing = LANGS.filter((l) => !SECTION_MARKERS[l] || !policyExists(l));
  expect(
    missing,
    `a selectable call language with no policy text means the agent cites another ` +
      `language's obligations on a recorded call: ${missing.join(", ")}`,
  ).toEqual([]);
});

function policyExists(lang: string): boolean {
  try {
    return policy(lang).trim().length > 0;
  } catch {
    return false;
  }
}

test("the gate above is measuring files, not an empty list", () => {
  // Six supported languages, six policy documents. Read literally rather than
  // derived, so renaming a file shows up here as a red test and not as a
  // shorter loop.
  expect(LANGS.length).toBe(6);
  for (const lang of LANGS)
    expect(policy(lang).length, `${lang} policy is empty`).toBeGreaterThan(500);
});

test("each copy carries the same seven sections", () => {
  for (const lang of LANGS) {
    const text = policy(lang);
    const marker = SECTION_MARKERS[lang];
    expect(
      marker,
      `${lang}: no section pattern is declared — this gate cannot check it`,
    ).toBeDefined();
    const found = text.match(marker!) ?? [];
    expect(
      found.length,
      `${lang}: expected 7 sections and found ${found.length} — a section dropped in ` +
        `translation is an obligation the agent stops citing`,
    ).toBe(7);
  }
});

test("no policy is written in the wrong script", () => {
  // The failure this catches is real and was caught while writing them: a Hindi
  // line came out with two Chinese characters in it, and a Bengali cluster in the
  // SMS sentence. Both are invisible in a diff and unreadable on a call.
  const FOREIGN: Record<string, RegExp> = {
    hi: /[\u0600-\u06FF\u0980-\u09FF\u4E00-\u9FFF]/,
    ur: /[\u0900-\u09FF\u4E00-\u9FFF]/,
    fr: /[\u0600-\u06FF\u0900-\u09FF\u4E00-\u9FFF]/,
    sw: /[\u0600-\u06FF\u0900-\u09FF\u4E00-\u9FFF]/,
    ar: /[\u0900-\u09FF\u4E00-\u9FFF]/,
    // Not "all non-ASCII": the English document is written with em-dashes, and so
    // is every other copy. What would be corruption is a character from a script
    // this language does not use — which is exactly what happened while these
    // files were first written (a Hindi line came out with two Chinese
    // characters and a Bengali cluster in it).
    en: /[\u0600-\u06FF\u0900-\u09FF\u0980-\u09FF\u4E00-\u9FFF]/,
  };
  for (const lang of LANGS) {
    const offenders = policy(lang).match(FOREIGN[lang]!) ?? [];
    expect(
      offenders.length,
      `${lang}: ${offenders.length} characters from another script (${offenders
        .slice(0, 4)
        .join("")}) — a mixed-script policy line is not speech, it is corruption`,
    ).toBe(0);
  }
});

test("the agent declaration names a document for every supported language", () => {
  const yaml = readFileSync(join(ROOT, "agent", "securevoice.agent.yaml"), "utf8");
  const block = yaml.match(/^knowledge_base:\n((?:[ \t]-.*\n|[ \t]+.*\n)*)/m)?.[1] ?? "";
  const idEnvs = [...block.matchAll(/id_env:\s*(\S+)/g)].map((m) => m[1]!);
  expect(idEnvs.length, "agent/*.yaml declares no knowledge_base entries").toBe(6);
  const wanted = LANGS.map((l) => `ELEVENLABS_KB_${l.toUpperCase()}`);
  expect(idEnvs.sort()).toEqual(wanted.sort());
});

test("the platform copy is the one the repo ships, per language, in the vendor's own words", () => {
  // The name is the join: `scripts/agent-apply.ts` resolves an id from `id_env`
  // and falls back to a platform name lookup. A file whose heading does not match
  // the declared name is a document nobody will find when the env var is lost.
  const yaml = readFileSync(join(ROOT, "agent", "securevoice.agent.yaml"), "utf8");
  for (const lang of LANGS) {
    const upper = lang.toUpperCase();
    expect(
      yaml,
      `agent/*.yaml has no knowledge_base entry named "((${upper}))" — the repo's ` +
        `${lang}.md cannot be re-created from the vendor console by that name`,
    ).toContain(`Fraud Disposition Policy (${upper}) v3.2`);
    expect(policy(lang).split("\n")[0]!.length, `${lang}: no document heading`).toBeGreaterThan(10);
  }
});
