import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Providers } from "@/app/providers";
import { ThemeToggle } from "@/components/shell/ThemeToggle";

/**
 * Dark mode has to actually reach the document.
 *
 * `tailwind.config.ts` declares `darkMode: "class"`, `globals.css` carries a full
 * `.dark` token block, and `src/components/ui/sonner.tsx` reads `useTheme()` —
 * but nothing mounted a provider, so no code path could ever put `.dark` on
 * `<html>`. The palette was dead CSS behind a promise the product tour makes.
 * A test that only renders the toggle and finds a button would still pass in
 * that broken state, so this one asserts the thing the customer experiences: the
 * class lands on the document element, and the tokens it selects exist.
 *
 * PostHog is mocked because the module imports the browser SDK at load; the
 * analytics half of `Providers` has its own contract (children render with no
 * key configured) asserted below without touching the network.
 */
jest.mock("posthog-js", () => ({ default: { init: jest.fn() } }));
jest.mock("posthog-js/react", () => ({
  PostHogProvider: ({ children }: { children: React.ReactNode }) => children,
}));

const htmlClass = () => document.documentElement.className;

beforeEach(() => {
  document.documentElement.className = "";
});

test("the theme provider cycles light → dark → system on the document element", async () => {
  render(
    <Providers>
      <ThemeToggle />
    </Providers>,
  );

  const button = screen.getByRole("button", { name: /colour theme/i });

  // The starting point is `system`, so the first press lands on `light` rather
  // than on the dark palette. Asserting each step is what catches a provider
  // that mounted but never writes the attribute — the state this repo shipped
  // with, where `.dark` was dead CSS behind a promise the tour makes.
  await userEvent.click(button);
  await waitFor(() => {
    expect(htmlClass()).toContain("light");
  });

  await userEvent.click(button);
  await waitFor(() => {
    expect(htmlClass()).toContain("dark");
  });

  await userEvent.click(button);
  await waitFor(() => {
    expect(htmlClass()).not.toContain("dark");
  });
});

test("the dark tokens the class selects actually exist", () => {
  const css = readFileSync(resolve(process.cwd(), "src/app/globals.css"), "utf8");
  expect(css).toMatch(/\.dark\s*\{/);
  // The toggle is only meaningful if the block restates the colour variables,
  // not just a stray override.
  const darkBlock = css.slice(css.indexOf(".dark {"));
  expect(darkBlock.slice(0, 1_500)).toContain("--background");
});

test("the label is a word, not only an icon", async () => {
  render(
    <Providers>
      <ThemeToggle />
    </Providers>,
  );
  const button = screen.getByRole("button", { name: /colour theme/i });
  // Colour-plus-text is the same accessibility rule the risk chips follow
  // (checklist 369): a control that changes the whole screen cannot be a glyph.
  expect(button.textContent?.trim().length).toBeGreaterThan(0);
});

test("children render when no analytics key is configured", () => {
  const spy = jest.requireMock("posthog-js").default.init;
  spy.mockClear();
  render(
    <Providers>
      <p>console content</p>
    </Providers>,
  );
  expect(screen.getByText("console content")).toBeTruthy();
  // No key in the test environment means no transport initialised at all — a
  // local or CI build ships no analytics, rather than a half-configured one.
  expect(spy).not.toHaveBeenCalled();
});
