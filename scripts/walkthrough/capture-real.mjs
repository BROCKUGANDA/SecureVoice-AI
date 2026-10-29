/**
 * Capture REAL product screens from production for the showcase film.
 *
 * Everything that claims to be the product IS the product — a launch film built
 * from invented UI loses everyone who uses it. So every frame in the film comes
 * from the live origin at securevoiceai.me, not from a mockup.
 *
 * Usage: node scripts/walkthrough/capture-real.mjs
 */
import fs from "node:fs";
import path from "node:path";

const { chromium } = await import("playwright");

const BASE = process.env.FILM_BASE_URL || "https://securevoiceai.me";
const OUT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "..", "demo-film", "assets");
const W = 1920;
const H = 1080;

fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: ["--hide-scrollbars", "--force-device-scale-factor=1", "--disable-gpu"],
});

async function shoot(page, name, { settle = 900 } = {}) {
  await page.waitForTimeout(settle);
  const file = path.join(OUT, name + ".png");
  await page.screenshot({ path: file });
  console.log("  captured " + name);
  return file;
}

async function capturePage(url, name, opts = {}) {
  const ctx = await browser.newContext({
    viewport: { width: W, height: H },
    deviceScaleFactor: 1,
    reducedMotion: "no-preference",
  });
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 90_000 });
  } catch {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 });
  }
  await shoot(page, name, opts);
  await ctx.close();
}

console.log("Capturing real product screens from " + BASE);

// ── the public surfaces ──────────────────────────────────────────────────────
await capturePage(BASE + "/", "home");
await capturePage(BASE + "/pricing", "pricing");
await capturePage(BASE + "/security", "security");

// ── the live demo: the product actually performing an action ─────────────────
{
  const ctx = await browser.newContext({
    viewport: { width: W, height: H },
    deviceScaleFactor: 1,
  });
  const page = await ctx.newPage();
  await page.goto(BASE + "/#live-demo", { waitUntil: "networkidle", timeout: 90_000 });
  await page.waitForTimeout(2500);
  await shoot(page, "demo-idle", { settle: 300 });

  // Run the simulation if a control is present.
  const runBtn = page
    .getByRole("button", { name: /simulate fraud alert/i })
    .first();
  if (await runBtn.count()) {
    await runBtn.click();
    console.log("  started the live simulation");
    // Catch the run mid-flight: the phase rail advancing IS the product acting.
    for (const [wait, name] of [
      [3500, "demo-phase-1"],
      [4500, "demo-phase-2"],
      [5000, "demo-phase-3"],
    ]) {
      await page.waitForTimeout(wait);
      await shoot(page, name, { settle: 200 });
    }
  } else {
    console.log("  (no run control found — captured the idle demo)");
  }
  await ctx.close();
}

await browser.close();

console.log("\nAssets written to " + OUT);
console.log(
  fs
    .readdirSync(OUT)
    .filter((f) => f.endsWith(".png"))
    .map((f) => "  " + f + "  " + (fs.statSync(path.join(OUT, f)).size / 1024).toFixed(0) + " KB")
    .join("\n"),
);
