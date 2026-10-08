import { defineConfig } from "cypress";

/**
 * Cypress e2e harness — the browser tier.
 *
 * Scope, stated plainly: `src/app/page.tsx` is the ONLY route. There is no URL
 * per view — navigation is a client-side switch over the zustand `view` field —
 * and the tree carries no `data-testid` attributes anywhere. So every locator in
 * the specs under cypress/e2e is a role, a label, or visible text. That is a
 * constraint on the app, not a style choice here, and it means these specs break
 * when copy changes; the alternative would be adding test hooks to src/, which
 * this task does not permit.
 *
 * baseUrl is overridable because the app must already be running: Cypress has no
 * dev server of its own.
 *
 *   terminal 1:  bun run dev            # next dev on :3000
 *   terminal 2:  bun run test:e2e:cypress
 *
 * or against a deployment: `CYPRESS_BASE_URL=https://… bun run test:e2e:cypress`.
 * `video: false` because the self-hosted runner has no codec and the artefact is
 * 40 MB of nobody watching.
 */
export default defineConfig({
  e2e: {
    baseUrl: process.env.CYPRESS_BASE_URL ?? "http://localhost:3000",
    specPattern: "cypress/e2e/**/*.cy.ts",
    supportFile: "cypress/support/e2e.ts",
    viewportWidth: 1366,
    viewportHeight: 900,
    video: false,
    screenshotOnRunFailure: true,
    // The boot splash runs a ~1.5s interval before it unmounts; a tight default
    // timeout makes the first spec fail for a reason that is not a defect.
    defaultCommandTimeout: 12000,
    retries: { runMode: 1, openMode: 0 },
  },
});
