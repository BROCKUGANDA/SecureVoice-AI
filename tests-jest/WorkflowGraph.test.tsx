/**
 * The Workflow builder view — surfaces the two guardrails the brief names:
 * per-node tool scoping and branch resolution. Presentational over
 * src/lib/workflows (validated separately), so these assert the design-time
 * truth an operator reads. Uses testids to avoid id/edge label ambiguity.
 */
import { render, screen } from "@testing-library/react";
import { WorkflowGraph } from "@/views/WorkflowGraph";
import { FRAUD_WORKFLOW } from "@/lib/workflows/schema";
import { useApp } from "@/lib/store";

beforeEach(() => {
  useApp.setState({ view: "home", lang: "en", highContrast: false });
});

describe("WorkflowGraph", () => {
  it("renders the graph container for the canonical workflow", () => {
    render(<WorkflowGraph workflow={FRAUD_WORKFLOW} />);
    expect(screen.getByTestId("workflow-graph")).toBeTruthy();
  });

  it("shows per-node tool scoping as chips — the guardrail an operator reads", () => {
    render(<WorkflowGraph workflow={FRAUD_WORKFLOW} />);
    // freeze runs card_freeze; escalate can hand off (human_handoff/warm_transfer).
    expect(screen.getByTestId("scope-freeze-card_freeze")).toBeTruthy();
    expect(screen.getByTestId("scope-escalate-warm_transfer")).toBeTruthy();
    // A never-scoped tool is NOT shown for a node that cannot call it.
    expect(screen.queryByTestId("scope-close-card_freeze")).toBeNull();
  });

  it("summarises the reachable tool set for the whole journey", () => {
    render(<WorkflowGraph workflow={FRAUD_WORKFLOW} />);
    const tools = screen.getByTestId("reachable-tools").textContent ?? "";
    expect(tools).toContain("card_freeze");
    expect(tools).toContain("verify_transaction");
    expect(tools).toContain("warm_transfer");
  });

  it("reports a valid workflow", () => {
    render(<WorkflowGraph workflow={FRAUD_WORKFLOW} />);
    expect(screen.getByTestId("workflow-validity").textContent).toBe("valid");
  });
});
