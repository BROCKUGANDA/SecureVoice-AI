/**
 * The Workflow builder view — surfaces the two guardrails the brief names:
 * per-node tool scoping and branch resolution. Presentational over
 * src/lib/workflows (validated separately), so these assert the design-time
 * truth an operator reads. Uses testids to avoid id/edge label ambiguity.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

  it("exposes the authoring surface — add node, save, and run on the live plane", () => {
    render(<WorkflowGraph workflow={FRAUD_WORKFLOW} />);
    expect(screen.getByText("+ Add node")).toBeTruthy();
    expect(screen.getByText("Save journey")).toBeTruthy();
    // Run is offered without a session by design; the console API is the guard.
    expect(screen.getByText("Run on live plane")).toBeTruthy();
  });

  it("opens the node editor with per-node scope toggles", async () => {
    render(<WorkflowGraph workflow={FRAUD_WORKFLOW} />);
    const editButtons = screen.getAllByText("edit");
    await userEvent.click(editButtons[0]);
    // The editor's scope chips are the guardrail made editable.
    expect(screen.getByText("tool scope for this node")).toBeTruthy();
    expect(screen.getByTestId("workflow-global-tools")).toBeTruthy();
  });

  it("live validation surfaces an invalid graph as issues, not as silence", () => {
    // The canonical journey with the freeze node's scope emptied: the schema
    // refuses the graph, and the builder says so on screen.
    const broken = JSON.parse(JSON.stringify(FRAUD_WORKFLOW)) as typeof FRAUD_WORKFLOW;
    broken.nodes = broken.nodes.map((n) => (n.id === "freeze" ? { ...n, scope: [] } : n));
    render(<WorkflowGraph workflow={broken} />);
    expect(screen.getByTestId("workflow-validity").textContent).not.toBe("valid");
    expect(screen.getByTestId("workflow-errors").textContent).toContain("card_freeze");
  });
});
