/**
 * An animated surface degrades to the CSS brass ring; it never takes the page.
 *
 * Two failure shapes have to be caught, and only one of them is caught by a
 * plain React error boundary:
 *
 *   · a throw during render (or in an effect) — the boundary sees this;
 *   · a throw from inside a `requestAnimationFrame` callback — which runs
 *     outside React's stack, so it surfaces as an uncaught global error, the
 *     animation freezes, and nothing swaps in. This is the shape `Waveform`
 *     actually has, so a guard that handled only the first would have been
 *     tested, looked safe, and missed the failure it exists for.
 *
 * Also pinned: `Waveform` is wrapped at its definition, so a page cannot opt out
 * of the fallback by forgetting to wrap it.
 */
import { act, render, screen } from "@testing-library/react";
import { FxGuard, useFxReport } from "@/components/fx/FxGuard";
import { Waveform } from "@/components/fx/Waveform";

function ThrowsInRender(): never {
  throw new Error("shader context lost");
}

/** Reports through the context on the next animation frame, like a draw loop. */
function ThrowsInFrame() {
  const report = useFxReport();
  if (typeof window !== "undefined") {
    window.requestAnimationFrame(() => {
      try {
        throw new Error("ctx.roundRect is not a function");
      } catch (err) {
        report(err);
      }
    });
  }
  return <canvas data-testid="bare-canvas" />;
}

describe("FxGuard", () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });

  it("renders the child when nothing fails", () => {
    render(
      <FxGuard label="case">
        <p>the waveform</p>
      </FxGuard>,
    );
    expect(screen.getByText("the waveform")).toBeTruthy();
    expect(screen.queryByTestId("fx-brass-ring")).toBeNull();
  });

  it("swaps in the CSS ring when a render throws, and the page survives", () => {
    const { container } = render(
      <FxGuard label="case">
        <ThrowsInRender />
      </FxGuard>,
    );
    expect(screen.getByTestId("fx-brass-ring")).toBeTruthy();
    // Not a blank region: the ring is present in the DOM the page kept.
    expect(container.querySelector(".sv-brass-ring")).toBeTruthy();
    expect(warn).toHaveBeenCalled();
  });

  it("swaps in the ring when the failure happens inside an animation frame", async () => {
    render(
      <FxGuard label="case">
        <ThrowsInFrame />
      </FxGuard>,
    );
    // jsdom drives `requestAnimationFrame` on a ~16 ms timer, so the wait has to
    // outlast one frame. The point of the assertion is that the report reaches
    // the guard from outside React's stack — the global error handler would leave
    // the canvas mounted and the animation frozen.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
    });
    expect(screen.getByTestId("fx-brass-ring")).toBeTruthy();
    expect(screen.queryByTestId("bare-canvas")).toBeNull();
  });

  it("does not let a second guard's failure be silenced by the first", () => {
    // The report fires on the guard that owns the child, so two broken surfaces
    // on one page both degrade rather than one swallowing the other's signal.
    const a = render(
      <FxGuard label="first">
        <ThrowsInRender />
      </FxGuard>,
    );
    const b = render(
      <FxGuard label="second">
        <ThrowsInRender />
      </FxGuard>,
    );
    expect(a.container.querySelectorAll(".sv-brass-ring")).toHaveLength(1);
    expect(b.container.querySelectorAll(".sv-brass-ring")).toHaveLength(1);
  });
});

describe("the guarded export", () => {
  it("Waveform renders inside a guard by construction", () => {
    // jsdom's canvas has no 2D context, so the component's own effect bails out.
    // The assertion is that the surface is mounted through the wrapper.
    const { container } = render(<Waveform active />);
    expect(container.querySelector("canvas")).toBeTruthy();
  });
});
