/**
 * Shallow-render coverage for the static marketing + legal views.
 *
 * Home, Demo and Deck have behavioural specs under tests-jest/. This file
 * covers the rest of the e2e tier that mounts without a session or a database:
 * Product, UseCases, Security, Legal (fully static) and Docs (fetches
 * /api/meta inside an effect, which the stubbed fetch satisfies). The e2e tier
 * is `src/views/**`, so mounting each view credits the large majority of its
 * render-path lines under the same V8 provider `bun test --coverage` uses.
 *
 * Auth / Console / Dashboard / Settings are NOT here: they read a session or
 * hit console endpoints on mount and belong behind a session fixture.
 */
import { render, screen } from "@testing-library/react";
import { useApp } from "@/lib/store";
import { Product } from "@/views/Product";
import { UseCases } from "@/views/UseCases";
import { Security } from "@/views/Security";
import { Privacy, Terms } from "@/views/Legal";
import { Docs } from "@/views/Docs";

beforeEach(() => {
  useApp.setState({ view: "home", lang: "en", highContrast: false });
  // Docs fetches /api/meta on mount; the render itself is synchronous, so a
  // benign stub is enough — the assertion below never waits on the response.
  global.fetch = (async () => ({
    ok: true,
    status: 200,
    json: async () => ({}),
  })) as unknown as typeof fetch;
});

const VIEWS = { Product, UseCases, Security, Privacy, Terms, Docs } as const;

for (const [name, View] of Object.entries(VIEWS)) {
  describe(`${name} view`, () => {
    it("mounts and renders its primary heading", () => {
      render(<View />);
      expect(screen.getByRole("heading", { level: 1 })).toBeTruthy();
    });
  });
}
