/**
 * `Counter` respects `prefers-reduced-motion`, because MotionConfig does not.
 *
 * `src/app/page.tsx:297` wraps the tree in `MotionConfig reducedMotion="user"`,
 * which is why `Reveal` needs no local preference check — that config
 * neutralises framer-motion transforms and opacity for the whole subtree.
 *
 * It has no effect on `Counter`. The count-up is a `requestAnimationFrame` loop
 * written by hand (`src/components/fx/core.tsx`), not a framer animation, so the
 * preference never reached it: a visitor who had asked the OS to reduce motion
 * still watched the hero figure tick from 0 to 38 over 1.4 s while every CSS
 * effect on the page correctly froze. The gap was easy to miss because the
 * *reason* the rest of the page was calm was the same *reason* this one was not —
 * one mechanism, one blind spot.
 *
 * What is asserted is the mechanism, not the appearance:
 *   1. once effects have run the figure is the target value — and note the
 *      component still renders `0` on the server, because the observer cannot fire
 *      during SSR, so writing the value at render time would have been a hydration
 *      mismatch rather than a fix (`src/components/fx/core.tsx` explains why the
 *      write happens in the effect);
 *   2. no frame callback is ever requested — the loop is not started and then
 *      stopped, it never exists.
 * Delete the `reduce` branch in `Counter` and this goes red on both: the value
 * stays at 0 until a frame loop carries it up, and that loop is exactly what
 * assertion 2 forbids. Proven that way: with the branch removed the suite fails
 * on `Unable to find an element with the text: 38`, and passes again once the
 * file is restored byte-identical.
 *
 * Why the preference is installed by an imported module rather than by a
 * statement in this file. swc compiles these `import`s to `require` calls in
 * source order, so the side-effect module below runs before `@/components/fx`
 * is loaded and framer reads the preference from a stub that already answers
 * `true`. A statement placed above the imports would have run *after* them and
 * tested nothing.
 *
 * And why there is exactly one preference per file: framer-motion resolves the
 * reduced-motion reader once per module instance, so the first test in a file
 * fixes the answer for every later test in it. Both cases were tried in one file
 * first — the non-reduced case passed alone and failed after the reduced one,
 * and `jest.isolateModules` could not fix it without loading a second copy of
 * React (`useRef` on null). One preference per file is the shape that is
 * deterministic in any order.
 */
import "./fxPrefReducedMotion";
import { act, render, screen } from "@testing-library/react";
import { Counter } from "@/components/fx/core";

describe("fx/Counter under prefers-reduced-motion", () => {
  it("renders the final figure and starts no frame loop", () => {
    const frames = jest.spyOn(window, "requestAnimationFrame");
    try {
      act(() => {
        render(<Counter to={38} />);
      });
      expect(screen.getByText("38")).toBeTruthy();
      expect(frames).not.toHaveBeenCalled();
    } finally {
      frames.mockRestore();
    }
  });
});
