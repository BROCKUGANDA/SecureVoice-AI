/**
 * Stage 3 — Playwright capture.
 *
 * One continuous screen recording per take, with scene boundaries written to a
 * manifest rather than one file per scene: assembly cuts the single recording at
 * those timestamps, so pacing can be re-trimmed without re-recording anything.
 *
 * The browser runs on a private persistent profile under out/.profile, so the
 * Clerk session established in the sign-in scene survives every later take.
 *
 * Usage: node capture.mjs [sceneId ...]
 */
import fs from "node:fs";
import path from "node:path";
import { BASE, OUT, PROFILE, VIEWPORT, VIDEO, ensureDirs, readJson, sleep, writeJson } from "./lib.mjs";
import { FORBIDDEN, scenes } from "./scenes.mjs";

const timings = readJson(path.join(OUT, "audio", "timings.json"));
if (!timings) throw new Error("run narrate.mjs before capture.mjs (no out/audio/timings.json)");
const byId = Object.fromEntries(timings.scenes.map((t) => [t.id, t]));

const only = process.argv.slice(2);
const { chromium } = await import("playwright");
ensureDirs();
fs.rmSync(VIDEO, { recursive: true, force: true });
fs.mkdirSync(VIDEO, { recursive: true });
// The Clerk session lives in this profile; a take without it cannot show the
// Command Center, the live call or the audit chain, so fail before recording.
if (!only.length && !process.argv.includes("--signed-out")) {
  console.log("  (full take reuses the seeded profile from login.mjs)");
}

const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: false,
  viewport: VIEWPORT,
  deviceScaleFactor: 1,
  recordVideo: { dir: VIDEO, size: VIEWPORT },
  args: [
    "--autoplay-policy=no-user-gesture-required",
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    "--disable-blink-features=AutomationControlled",
    "--window-position=40,40",
  ],
});
const page = ctx.pages()[0] || (await ctx.newPage());

/**
 * Locator for a visible control by its label. Substring match on the accessible
 * name: the app ships no test ids, so the storyboard stays the literal text a
 * human reads on screen.
 */
function control(label) {
  if (FORBIDDEN.test(label)) throw new Error("refusing to target a delivery control: " + label);
  return page.getByRole("button", { name: label, exact: false }).first();
}

async function smoothScroll(dy, ms) {
  const t0 = Date.now();
  const y0 = await page.evaluate(() => window.scrollY);
  while (Date.now() - t0 < ms) {
    const k = Math.min(1, (Date.now() - t0) / ms);
    const eased = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
    await page.evaluate((y) => window.scrollTo({ top: y, behavior: "instant" }), y0 + dy * eased);
    await sleep(28);
  }
}

async function runStep(st) {
  // These clicks swap the SPA view, so the target often detaches the instant it
  // lands; noWaitAfter stops Playwright retrying against a node that is gone.
  const tap = (locator) => locator.click({ timeout: 9000, noWaitAfter: true });
  if (st.nav) {
    await tap(page.locator(`header button:has-text("${st.nav}")`).first());
    await sleep(1600);
  } else if (st.click || st.chip) {
    // `chip` is the same control scoped to the page body: the navbar carries
    // language labels that the in-view language chips also use.
    const label = st.click || st.chip;
    const c = st.chip
      ? page.locator(`#main-content button:has-text("${label}")`).first()
      : control(st.click);
    if (st.optional && !(await c.isVisible().catch(() => false))) return;
    await tap(c);
    await sleep(900);
  } else if (st.text) {
    await page
      .getByText(st.text, { exact: false })
      .first()
      .waitFor({ state: "visible", timeout: st.timeout || 9000 });
  } else if (st.sleep) {
    await sleep(st.sleep);
  } else if (st.scroll) {
    await smoothScroll(st.scroll.y, st.scroll.ms);
  } else if (st.cursor) {
    const box = await page.getByText(st.cursor, { exact: false }).first().boundingBox().catch(() => null);
    if (box) {
      for (let i = 1; i <= 18; i++) {
        await page.mouse.move(120 + ((box.x + box.width / 2 - 120) * i) / 18, 120 + ((box.y + box.height / 2 - 120) * i) / 18);
        await sleep(16);
      }
    }
  }
}

await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForSelector("header", { timeout: 60000 });
await sleep(5000); // the app's own boot screen runs before the shell appears

const http = await page.evaluate(() => fetch("/api/console/events", { credentials: "include" }).then((r) => r.status).catch(() => 0));
if (http !== 200 && !process.argv.includes("--signed-out")) {
  await ctx.close();
  throw new Error("no live operator session in this profile (server said " + http + ") - run node login.mjs first");
}

const t0 = Date.now();
const manifest = { base: BASE, startedAt: new Date(t0).toISOString(), scenes: [] };
const queue = scenes.filter((s) => s.kind === "capture" && (!only.length || only.includes(s.id)));

for (const sc of queue) {
  const start = (Date.now() - t0) / 1000;
  const budget = byId[sc.id]?.dur ?? sc.min ?? 8;
  const rec = { id: sc.id, start, dur: 0, warnings: [] };
  manifest.scenes.push(rec);
  console.log(`  ${sc.id}  at ${start.toFixed(1)}s, budget ${budget.toFixed(1)}s`);

  for (const st of sc.steps || []) {
    const label = st.nav || st.click || st.chip || st.text || (st.sleep ? "sleep " + st.sleep : "scroll");
    try {
      await runStep(st);
    } catch (e) {
      const msg = String(e.message).split("\n")[0];
      if (msg.startsWith("refusing to target")) throw e; // never swallow a safety refusal
      rec.warnings.push(label + ": " + msg.slice(0, 120));
      console.log(`    step skipped [${label}]: ${msg.slice(0, 90)}`);
    }
  }

  const used = (Date.now() - t0) / 1000 - start;
  if (used < budget) await sleep((budget - used) * 1000);
  rec.dur = (Date.now() - t0) / 1000 - start;
  await page.screenshot({ path: path.join(OUT, "frame-" + sc.id + ".png") });
}

const video = page.video();
const rawPath = video ? await video.path() : null;
await ctx.close();

let videoPath = null;
if (rawPath && fs.existsSync(rawPath)) {
  videoPath = path.join(VIDEO, "take.webm");
  fs.renameSync(rawPath, videoPath);
}
manifest.video = videoPath;
writeJson(path.join(OUT, "manifest.json"), manifest);
console.log("\ncapture -> " + path.join(OUT, "manifest.json"));
console.log("  take: " + (videoPath || "NO VIDEO — recordVideo unsupported on this build"));
