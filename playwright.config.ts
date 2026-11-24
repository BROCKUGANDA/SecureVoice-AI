import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright end-to-end harness.
 *
 * Mirrors the Cypress harness (cypress.config.ts): the app must already be
 * running (or we boot it via webServer). Locators are role/label/visible text
 * only - src/ carries no data-testid attributes.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  /**
   * The device matrix, and why it is a matrix rather than the single
   * Chromium desktop project it replaced: the product's public surface is
   * what a judge opens, and a judge opens it from a laptop, a phone or an
   * iPad, in four engines. Every locator in ./e2e is role/label based, so the
   * specs run unchanged on every project; the one width-dependent control
   * (the language toggle) was made breakpoint-agnostic instead of skipped.
   *
   * Browsers are the four Playwright engines (Chromium, Firefox, WebKit);
   * WebKit is Safari's engine — no WebKit, no Safari claim. Phones and the
   * tablet come from Playwright's own device descriptors so viewport, DPR,
   * touch and UA stay coherent with the device being claimed.
   */
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
    { name: "mobile-chrome", use: { ...devices["Pixel 7"] } },
    { name: "mobile-safari", use: { ...devices["iPhone 12"] } },
    { name: "tablet", use: { ...devices["iPad (gen 7)"] } },
  ],
  webServer: {
    command: "bun run dev",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
