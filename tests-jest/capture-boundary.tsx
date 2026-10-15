/**
 * Test-only error boundary for the view tier.
 *
 * WHY IT EXISTS: a component that throws while React is rendering an async
 * update — the shape of `next/dynamic` handing the reconciler a bad element type
 * — does not make `render()` throw. The chunk resolves after the commit, the
 * throw happens in a later render pass, and with no boundary in the tree React
 * reports it as an uncaught error while the test keeps asserting against a
 * half-mounted DOM. `src/app/error.tsx` is the boundary that swallows it in
 * production, which is exactly why the signed-out `/sign-in` crash surfaced as
 * "Something interrupted this view" instead of a failed page load.
 *
 * So the specs below mount through a boundary of their own and assert on what it
 * caught: "no error" is a real, checkable verdict, and the message it captures
 * is the one an error boundary would have hidden.
 */
import { Component, type ErrorInfo, type ReactElement, type ReactNode } from "react";
import { render, screen } from "@testing-library/react";

class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  // React logs the throw itself; keeping the info out of state is deliberate —
  // the specs only ever need to know whether the render failed and with what
  // message, not which fiber.
  componentDidCatch(_error: Error, _info: ErrorInfo): void {/* empty */}

  render(): ReactNode {
    if (this.state.error) {
      return <div data-testid="boundary-error">{this.state.error.message}</div>;
    }
    return this.props.children;
  }
}

/** Renders `ui` inside the capture boundary. */
export function renderCapturing(ui: ReactElement): void {
  render(<Boundary>{ui}</Boundary>);
}

/** The message React threw into the boundary, or null when the render was clean. */
export function boundaryError(): string | null {
  const el = screen.queryByTestId("boundary-error");
  return el ? String(el.textContent) : null;
}
