"use client";
/**
 * A failure in an animated surface degrades to a CSS ring. It never takes the
 * page with it.
 *
 * ## Why a boundary is not enough on its own
 *
 * React's error boundaries catch errors thrown during render and in lifecycle
 * methods. They do NOT catch anything thrown from a `requestAnimationFrame`
 * callback — that runs outside React's call stack, so an exception in a draw
 * loop surfaces as an uncaught global error, the animation silently freezes, and
 * in development the whole route is replaced by an overlay. `Waveform` is exactly
 * that shape (`src/components/fx/Waveform.tsx:87-89`), so a boundary alone would
 * have looked like protection while the most likely failure mode walked straight
 * past it.
 *
 * This component therefore has two halves, and the child must be able to use the
 * second one:
 *
 *   1. `getDerivedStateFromError` / `componentDidCatch` for render-time throws;
 *   2. `reportFxFailure(cause)` through context, which the animated child calls
 *      from inside its own `try/catch` around each frame.
 *
 * ## Why the fallback is CSS and not another canvas
 *
 * The fallback is the thing that must work when the rendering path has just
 * failed. A second WebGL context or a second `requestAnimationFrame` loop would
 * depend on the subsystem that is already suspect — and it would be a second
 * animated surface to guard. A border-radius ring with a `transform: rotate`
 * animation is composited by the browser, needs no script, and cannot throw.
 *
 * It is brass because that is the product's accent: a fallback that changes the
 * colour of a page mid-demo reads as a different kind of failure.
 *
 * ## Motion
 *
 * `@media (prefers-reduced-motion: reduce)` freezes the ring into a static arc
 * rather than removing it, so the "audio is live" affordance survives for
 * vestibular-sensitive users instead of being replaced by an empty box.
 *
 * The fallback is decorative by design. The page's meaning never depended on the
 * waveform: it is an illustration beside text that already says what is happening.
 */

import { Component, createContext, useContext, type ReactNode } from "react";

type Report = (cause: unknown) => void;

const FxReportContext = createContext<Report | null>(null);

/**
 * Lets an animated child report a failure React cannot see — a throw from inside
 * a `requestAnimationFrame` callback, a lost canvas context, an audio node that
 * cannot be created. A no-op outside a guard, so an unwrapped component still
 * runs; the guard is what makes the report mean something.
 */
export function useFxReport(): Report {
  const report = useContext(FxReportContext);
  return (
    report ??
    (() => {
      /* empty */
    })
  );
}

type Props = { children: ReactNode; label: string };
type State = { failed: boolean };

export class FxGuard extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error): void {
    this.warnOnce(this.props.label, error);
  }

  private reported = false;

  /**
   * Once per guard instance, not once per module. A page with two broken
   * animated surfaces must degrade twice and say so twice; a module-level flag
   * would have the second failure swap in the ring silently, which is exactly
   * the kind of swallowed signal this repo has been bitten by elsewhere.
   */
  private warnOnce(label: string, cause: unknown): void {
    if (this.reported) return;
    this.reported = true;
    try {
      console.warn(`[fx] ${label} failed; showing the CSS fallback`, cause);
    } catch {
      /* a console that cannot be written to is not worth a second failure */
    }
  }

  private readonly report: Report = (cause: unknown) => {
    if (this.state.failed) return;
    this.warnOnce(this.props.label, cause);
    this.setState({ failed: true });
  };

  render(): ReactNode {
    if (this.state.failed) return <BrassRing label={this.props.label} />;
    return (
      <FxReportContext.Provider value={this.report}>{this.props.children}</FxReportContext.Provider>
    );
  }
}

/** The CSS-only fallback. No script, no canvas, nothing that can throw. */
export function BrassRing({ className = "" }: { label?: string; className?: string } = {}) {
  return (
    <span
      data-testid="fx-brass-ring"
      aria-hidden="true"
      className={`sv-brass-ring inline-block rounded-full border-2 border-[#c9a227]/30 border-t-[#c9a227] ${className}`}
    />
  );
}
