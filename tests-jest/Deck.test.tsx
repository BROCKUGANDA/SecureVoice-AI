/**
 * Deck.tsx — presenter deck view.
 *
 * Behaviour under test, not rendering: slide indexing and its two clamp bounds,
 * the two input channels that drive it (click controls and the window keyboard
 * listener), the EN/AR language switch that re-renders the slide in place, and
 * the presenter-script panel toggle.
 *
 * Timing note, because it is load-bearing: the slide stage is wrapped in
 * framer-motion's <AnimatePresence>, so a slide change leaves the outgoing node
 * mounted until its exit animation resolves. Absence assertions therefore wait
 * for the removal rather than checking it synchronously, and presence assertions
 * go through findBy / waitFor with an explicit budget. A synchronous
 * `expect(query()).toBeNull()` here would be a race, not a test.
 *
 * The slide count comes from DECK rather than a literal: it is the structure the
 * component promises to honour (01..N with Next disabled at N), and a deck that
 * gained a slide is not a defect. Visible copy is hardcoded — if it changes the
 * assertion has to change with it, which is the point.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DECK } from "@/lib/deck";
import { useApp } from "@/lib/store";
import { Deck } from "@/views/Deck";

/** Budget for an animation-driven DOM change. */
const ANIMATED = { timeout: 4000 };

/** The counter in the control bar, e.g. "01 / 16". Outside AnimatePresence, so
 *  it tracks `idx` synchronously. */
function counter(): HTMLElement {
  return screen.getByText(/\d{2} \/ \d{2}/);
}

function nth(n: number): string {
  return `${String(n).padStart(2, "0")} / ${DECK.length}`;
}

describe("Deck", () => {
  it("opens on slide 01 with the cover heading and the full slide count", () => {
    render(<Deck />);

    expect(counter().textContent).toBe(nth(1));
    expect(
      screen.getByRole("heading", { level: 1, name: /Intervention Voice Agent/ }),
    ).toBeTruthy();
    expect(screen.getByText("Press → or Space to begin")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Previous slide" }).hasAttribute("disabled")).toBe(
      true,
    );
  });

  it("advances with the Next control and re-enables Previous", async () => {
    const user = userEvent.setup();
    render(<Deck />);

    expect(screen.getByRole("button", { name: "Next slide" }).hasAttribute("disabled")).toBe(false);

    await user.click(screen.getByRole("button", { name: "Next slide" }));

    // Counter is immediate; the slide body arrives once the exit animation clears.
    expect(counter().textContent).toBe(nth(2));
    expect(screen.getByText("01 · The Problem")).toBeTruthy();
    await screen.findByRole("heading", { level: 2, name: "minutes of open door" }, ANIMATED);
    expect(screen.getByRole("button", { name: "Previous slide" }).hasAttribute("disabled")).toBe(
      false,
    );
    await waitFor(() => expect(screen.queryByText("Press → or Space to begin")).toBeNull(), ANIMATED);
  });

  it("clamps at the final slide: End jumps there and Next stops working", async () => {
    const user = userEvent.setup();
    render(<Deck />);

    fireEvent.keyDown(window, { key: "End" });
    await waitFor(() => expect(counter().textContent).toBe(nth(DECK.length)), ANIMATED);
    expect(screen.getByRole("button", { name: "Next slide" }).hasAttribute("disabled")).toBe(true);

    // A further click must not run past the end or corrupt the counter.
    await user.click(screen.getByRole("button", { name: "Next slide" }));
    expect(counter().textContent).toBe(nth(DECK.length));
  });

  it("walks the deck from the keyboard: ArrowRight, Space, ArrowLeft, Home", () => {
    render(<Deck />);

    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(counter().textContent).toBe(nth(2));

    fireEvent.keyDown(window, { key: " " });
    expect(counter().textContent).toBe(nth(3));

    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(counter().textContent).toBe(nth(2));

    fireEvent.keyDown(window, { key: "Home" });
    expect(counter().textContent).toBe(nth(1));
    expect(screen.getByRole("button", { name: "Previous slide" }).hasAttribute("disabled")).toBe(
      true,
    );
  });

  it("switches the slide text to Arabic through the labelled language group", async () => {
    const user = userEvent.setup();
    render(<Deck />);

    // English cover: English headline and subtitle, plus the mirrored Arabic line
    // the cover only renders while lang is "en".
    expect(screen.getByText(DECK[0].subEn)).toBeTruthy();
    expect(screen.getAllByText(DECK[0].subAr)).toHaveLength(1);

    const group = screen.getByRole("group", { name: "Deck language" });
    await user.click(within(group).getByRole("button", { name: "عربي" }));

    await screen.findByRole("heading", { level: 1, name: DECK[0].titleAr }, ANIMATED);
    // The English-only mirror is gone, so subAr now appears once (as the
    // subtitle) and the English subtitle has left the slide entirely.
    await waitFor(() => expect(screen.queryByText(DECK[0].subEn)).toBeNull(), ANIMATED);
    expect(screen.getAllByText(DECK[0].subAr)).toHaveLength(1);

    await user.click(within(group).getByRole("button", { name: "EN" }));
    await screen.findByText(DECK[0].subEn, {}, ANIMATED);
  });

  it("toggles the presenter script from both the button and the S key", async () => {
    const user = userEvent.setup();
    render(<Deck />);

    expect(screen.getByText(DECK[0].scriptEn)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /Script shown · S/ }));
    expect(screen.getByRole("button", { name: /Script hidden · S/ })).toBeTruthy();
    await waitFor(() => expect(screen.queryByText(DECK[0].scriptEn)).toBeNull(), ANIMATED);

    // The same panel, driven by its documented shortcut.
    fireEvent.keyDown(window, { key: "s" });
    expect(screen.getByRole("button", { name: /Script shown · S/ })).toBeTruthy();
    await screen.findByText(DECK[0].scriptEn, {}, ANIMATED);
  });

  it("exits the deck by handing the home view back to the app store", async () => {
    const user = userEvent.setup();
    useApp.setState({ view: "deck" });
    render(<Deck />);

    await user.click(screen.getByRole("button", { name: "Exit" }));
    expect(useApp.getState().view).toBe("home");
  });
});
