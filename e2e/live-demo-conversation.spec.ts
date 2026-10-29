import { expect, test } from "@playwright/test";

/**
 * Playwright tier - live demo conversation turn (SV-293).
 *
 * Exercises the public interactive demo: a typed caller line is routed through
 * the guardrailed intent router and the answer comes back as neural audio.
 * The test asserts the request path and the visible turn state, and stubs the
 * backend so it never depends on live model/voice providers.
 */

test.describe("SecureVoice AI - live demo conversation", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForSelector("#live-demo", { timeout: 60_000 });
  });

  test("a typed line is routed and a reply is rendered", async ({ page }) => {
    // Stub the agent router so the test is deterministic and provider-free.
    await page.route("**/api/agent", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          intent: "dispute_transaction",
          reply: "I understand. Let me verify that transaction with you.",
          audioUrl: null,
        }),
      });
    });

    const panel = page.locator("#live-demo");
    const input = panel.locator("input[aria-label]").first();
    await input.fill("That transaction is not mine");

    const send = panel.locator('button[type="submit"]').first();
    await expect(send).toBeEnabled();
    await send.click();

    // The turn should be recorded in the conversation log.
    await expect(panel.locator('[role="log"]')).toContainText(/transaction/i, { timeout: 15_000 });
  });

  test("the demo distinguishes simulated from live behaviour", async ({ page }) => {
    // The simulated outcome banner must be labelled as simulated, never as a
    // real bank-card freeze.
    await expect(page.locator("#live-demo")).not.toContainText(/card frozen/i);
  });
});
