import { expect, test } from "@playwright/test";

/**
 * Playwright tier - mirrors cypress/e2e/primary-flow.cy.ts.
 *
 * Locators are role/label/visible text only; src/ has no data-testid attrs.
 */

test.describe("SecureVoice AI - browser tier (Playwright)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded", timeout: 60_000 });
    // Wait for splash to clear into the hero.
    await page.waitForSelector("main#main-content", { timeout: 60_000 });
  });

  test("boots past the splash into the fraud-intervention hero", async ({ page }) => {
    await expect(page.locator("h1")).toContainText("Fraud detected.");
    await expect(page.locator("h1")).toContainText("Call placed.");
    await expect(page.getByRole("button", { name: "Run the live simulation" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Explore the dashboard" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign in to run the platform" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Skip to content" })).toBeAttached();
  });

  test("switches public views without a route change", async ({ page }) => {
    await expect(page).toHaveURL(/\/$/);

    await page
      .getByRole("navigation", { name: "Primary" })
      .getByRole("button", { name: "Docs" })
      .click();
    await expect(page.locator("h1")).toContainText("Integrate SecureVoice in an afternoon");
    await expect(page).toHaveURL(/\/$/);

    await page
      .getByRole("navigation", { name: "Primary" })
      .getByRole("button", { name: "Security" })
      .click();
    await expect(page.locator("h1")).toContainText("Built for the regulator, proven in the region");
    await expect(page).toHaveURL(/\/$/);

    await page
      .getByRole("navigation", { name: "Primary" })
      .getByRole("button", { name: "Overview" })
      .click();
    await expect(page.locator("h1")).toContainText("Fraud detected.");
  });

  test("enforces the view gate: signed-out click lands on auth, not the console", async ({
    page,
  }) => {
    await page.getByRole("button", { name: "Explore the dashboard" }).click();
    await expect(page.locator("h1")).toContainText("Welcome to SecureVoice");
    await expect(page.getByRole("button", { name: "Simulate fraud alert" })).toHaveCount(0);
  });

  test("flips the document language and the copy from the labelled toggle", async ({ page }) => {
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    const langGroup = page.locator('[role="group"][aria-label="Language"]');

    await langGroup.getByRole("button", { name: "AR" }).click();
    await expect(page.locator("html")).toHaveAttribute("lang", "ar");

    await langGroup.getByRole("button", { name: "EN" }).click();
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.getByRole("button", { name: "Run the live simulation" })).toBeVisible();
  });

  test("holds the pilot intake shut until the fields are valid, then posts them", async ({
    page,
  }) => {
    await page.route("**/api/pilot", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, ref: "SV-PW-0001" }),
      });
    });

    await page.getByRole("button", { name: "Book a pilot" }).click();
    await expect(page.locator('[role="dialog"]')).toContainText("Book a 30-day pilot");

    const submit = page.getByRole("button", { name: "Request pilot" });
    await expect(submit).toBeDisabled();

    await page.locator("#pilot-name").fill("Playwright Operator");
    await page.locator("#pilot-email").fill("bad-email");
    await page.locator("#pilot-bank").fill("Test Bank");
    await expect(submit).toBeDisabled();
    await expect(page.locator("#pilot-email")).toHaveAttribute("aria-invalid", "true");

    await page.locator("#pilot-email").fill("operator@pw.test");
    await expect(submit).toBeEnabled();
    await expect(page.locator("#pilot-email")).toHaveAttribute("aria-invalid", "false");

    await submit.click();
    await expect(page.locator('[role="dialog"]')).toContainText("Request received");
    await expect(page.locator('[role="dialog"]')).toContainText("SV-PW-0001");
  });
});
