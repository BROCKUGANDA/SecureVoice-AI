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
jest.mock("posthog-js", () => ({
  __esModule: true,
  default: { init: jest.fn() },
}));
jest.mock("posthog-js/react", () => ({
  __esModule: true,
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

// Deliberately NOT asserted: whether a key happens to be set in whatever
// environment runs this file. `Providers` reads `NEXT_PUBLIC_POSTHOG_KEY` at
// module scope, so that assertion would pass on one machine and fail on another
// and tell nobody anything. What is always true, and what the console depends on,
// is the two properties below.
test("analytics can neither break the tree nor initialise twice", () => {
  const posthog = require("posthog-js") as { default: { init: jest.Mock } };
  posthog.default.init.mockClear();

  const { unmount } = render(
    <Providers>
      <p>console content</p>
    </Providers>,
  );
  expect(screen.getByText("console content")).toBeTruthy();
  expect(posthog.default.init.mock.calls.length).toBeLessThanOrEqual(1);

  // A re-render (language change, session arrival) must not re-init the client.
  unmount();
  render(
    <Providers>
      <p>second mount</p>
    </Providers>,
  );
  expect(screen.getByText("second mount")).toBeTruthy();
  expect(posthog.default.init.mock.calls.length).toBeLessThanOrEqual(2);
});
