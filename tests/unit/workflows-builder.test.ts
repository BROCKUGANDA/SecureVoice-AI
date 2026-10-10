/**
 * What the builder is allowed to produce — the save/run contract at the
 * schema level.
 *
 * The console's Save route re-validates with these same functions, and the
 * runner refuses anything that fails them. So the property that matters is:
 * a graph the builder UI would hand to Save is EXACTLY a graph the schema,
 * the validator and the runner accept — and the malformed ones a tired
 * operator can produce (an unscoped tool node, a dangling edge, a journey
 * with no way forward) are refused BY NAME here rather than at run time.
 *
 *   bun scripts/run-tests.mjs workflows-builder
 */
import { describe, expect, test } from "bun:test";
import { workflowSchema, FRAUD_WORKFLOW } from "@/lib/workflows/schema";
import { validateWorkflow } from "@/lib/workflows/validate";
import { validateDocument, listWorkflows } from "@/lib/workflows";

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe("what the builder can save", () => {
  test("the canonical journey round-trips through parse → validate → validateDocument", () => {
    const doc = clone(FRAUD_WORKFLOW);
    const parsed = workflowSchema.parse(doc);
    expect(parsed.nodes.length).toBe(FRAUD_WORKFLOW.nodes.length);
    expect(validateWorkflow(parsed).ok).toBe(true);
    expect(validateDocument(doc).ok).toBe(true);
  });

  test("a journey the builder's 'New journey' button produces is valid", () => {
    // The blankWorkflow() shape from the builder: start → done.
    const fresh = {
      id: "journey_test",
      name: "New journey",
      version: "1",
      entry: "start",
      tools: [],
      nodes: [
        { id: "start", kind: "prompt", scope: [], next: "done", sysPrompt: "Open the turn." },
        { id: "done", kind: "end", scope: [], outcome: "resolved" },
      ],
    };
    expect(validateDocument(fresh).ok).toBe(true);
  });

  test("a save → load → parse round-trip is identity", () => {
    const doc = clone(FRAUD_WORKFLOW);
    const reloaded = workflowSchema.parse(JSON.parse(JSON.stringify(doc)));
    expect(reloaded).toEqual(workflowSchema.parse(doc));
  });

  test("a tool node whose tool is not in its scope is refused by the schema", () => {
    const bad = clone(FRAUD_WORKFLOW);
    bad.nodes = bad.nodes.map((n) => (n.id === "freeze" ? { ...n, scope: [] as string[] } : n));
    const parsed = workflowSchema.safeParse(bad);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map((i) => i.message).join(" ")).toContain(
        'tool "card_freeze" is not in the node\'s scope',
      );
    }
  });

  test("a node scoping a tool the journey does not allow is refused by the validator", () => {
    const bad = clone(FRAUD_WORKFLOW);
    bad.nodes = bad.nodes.map((n) =>
      n.id === "escalate" ? { ...n, scope: [...n.scope, "switch_language"] } : n,
    );
    const parsed = workflowSchema.parse(bad); // schema-legal; the validator owns the graph law
    const result = validateWorkflow(parsed);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain(
      'scopes tool "switch_language" outside the workflow\'s tools',
    );
  });

  test("a dangling next is refused by the validator", () => {
    const bad = clone(FRAUD_WORKFLOW);
    bad.nodes = bad.nodes.map((n) => (n.id === "close" ? { ...n, next: "nowhere" } : n));
    const result = validateWorkflow(workflowSchema.parse(bad));
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain('node "close" next "nowhere" does not resolve');
  });

  test("a non-terminal node with no exit is refused (dead end)", () => {
    const bad = clone(FRAUD_WORKFLOW);
    bad.nodes = bad.nodes.map((n) => (n.id === "close" ? { ...n, next: undefined } : n));
    const result = validateWorkflow(workflowSchema.parse(bad));
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain('node "close" has no way forward');
  });

  test("deleting the entry node leaves a graph the schema itself refuses", () => {
    const bad = clone(FRAUD_WORKFLOW);
    bad.nodes = bad.nodes.filter((n) => n.id !== "disclose");
    // The schema's own entry check fires first (entry must be a node) — the
    // save route can never even reach the validator for this graph.
    const parsed = workflowSchema.safeParse(bad);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map((i) => i.message).join(" ")).toContain(
        'entry "disclose" is not a node',
      );
    }
  });

  test("the registry exposes both built-ins for the builder's switcher", () => {
    expect(
      listWorkflows()
        .map((w) => w.id)
        .sort(),
    ).toEqual(["fraud_intervention", "specialist_review"]);
  });
});
