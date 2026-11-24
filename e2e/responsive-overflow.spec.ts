import { expect, test } from "@playwright/test";

// Guards the mobile/tablet overflow regressions: every configured project
// (desktop engines, Pixel 7, iPhone 12 and iPad) must fit the viewport without
// horizontal scrolling, on both the document and the body.
test("home has no horizontal overflow", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });

  const widths = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
    viewport: window.innerWidth,
  }));

  expect(widths.document).toBeLessThanOrEqual(widths.viewport);
  expect(widths.body).toBeLessThanOrEqual(widths.viewport);
});
