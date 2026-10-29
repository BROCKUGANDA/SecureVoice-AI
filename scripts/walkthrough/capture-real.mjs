/**
 * Capture REAL product screens from production for the showcase film.
 *
 * Everything that claims to be the product IS the product — a launch film built
 * from invented UI loses everyone who uses it. So every frame in the film comes
 * from the live origin at securevoiceai.me, not from a mockup.
 *
 * Usage: node scripts/walkthrough/capture-real.mjs [--base-url https://host]
 *
 * The origin is a CLI ARGUMENT, not an env var. This is a one-shot developer
 * script, not a deployed service, and an env var it reads would have to be
 * documented in .env.example — where it would tell every operator about a knob
 * only the film capture ever uses. An argument says the same thing without
 * pretending to be deployment configuration.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const { chromium } = await import("playwright");

const baseArg = process.argv.find((a) => a.startsWith("--base-url="));
const baseFlag = process.argv.indexOf("--base-url");
const BASE = (
  baseArg?.slice("--base-url=".length) ||
  (baseFlag >= 0 ? process.argv[baseFlag + 1] : undefined) ||
  "https://securevoiceai.me"
).replace(/\/+$/, "");
const OUT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")),
  "..",
  "..",
  "demo-film",
  "assets",
);
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

/**
 * Capture ONE element rather than the whole viewport.
 *
 * The full-page frames are right for a screen recording, but a film wants a
 * tight crop: the live panel with the real conversation in it, with the hero
 * copy cropped away. The crop is of the REAL panel — same pixels, less page
 * around them.
 */
async function shootElement(page, selector, name, { settle = 900 } = {}) {
  await page.waitForTimeout(settle);
  const file = path.join(OUT, name + ".png");
  await page.locator(selector).first().screenshot({ path: file });
  console.log("  captured " + name + " (crop)");
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

/**
 * Open the live demo panel.
 *
 * `networkidle` NEVER fires on this page: the console holds a realtime
 * (SSE/WebSocket) feed open, so the document is never idle by that measure.
 * The original live-demo goto waited out its full 90s timeout and took the
 * whole capture down with it — which is why the film only ever had the three
 * marketing frames and no conversation at all. `domcontentloaded` plus an
 * explicit settle is the honest wait here.
 */
async function openLiveDemo(page) {
  await page.goto(BASE + "/#live-demo", { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.waitForTimeout(2500);
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
  await openLiveDemo(page);
  await shoot(page, "demo-idle", { settle: 300 });

  // Run the simulation if a control is present.
  const runBtn = page.getByRole("button", { name: /simulate fraud alert/i }).first();
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

// ── the live conversation: the product ACTUALLY performing ─────────────────────
// A real turn through the public surface. The panel posts the caller's words to
// /api/agent (the guardrailed intent router) and the answer comes back as neural
// audio from /api/tts/stream, so every frame here is the product performing —
// nothing staged, nothing mocked. That is the difference between a film that
// proves the claim and one that illustrates it.
const CONVERSATIONS = [
  { lang: "en", label: "English", line: "That transaction is not mine", prefix: "conversation-en" },
  { lang: "ar", label: "العربية", line: "هذه العملية ليست مني", prefix: "conversation-ar" },
  { lang: "hi", label: "हिन्दी", line: "यह लेनदेन मेरा नहीं है", prefix: "conversation-hi" },
  { lang: "ur", label: "اردو", line: "یہ لین دین میرا نہیں ہے", prefix: "conversation-ur" },
  {
    lang: "fr",
    label: "Français",
    line: "Cette transaction n'est pas la mienne",
    prefix: "conversation-fr",
  },
  { lang: "sw", label: "Kiswahili", line: "Hili si jambo langu", prefix: "conversation-sw" },
];

/**
 * Wait until the panel's send control is enabled.
 *
 * Switching the language starts a turn in the panel, and while that turn is in
 * flight the send button is disabled — so a capture that clicks straight after
 * a language switch races it and dies on "element is not enabled". The button
 * being enabled is the honest signal that the panel is ready for the next turn.
 */
async function waitForSendEnabled(page, timeout = 30_000) {
  await page.waitForFunction(
    () => {
      const b = document.querySelector('#live-demo button[type="submit"]');
      return !!b && !b.disabled;
    },
    null,
    { timeout },
  );
}

for (const c of CONVERSATIONS) {
  const ctx = await browser.newContext({
    viewport: { width: W, height: H },
    deviceScaleFactor: 1,
  });
  const page = await ctx.newPage();
  try {
    await openLiveDemo(page);
    if (c.lang !== "en") {
      await page.locator("#live-demo button", { hasText: c.label }).first().click();
      await page.waitForTimeout(600);
    }
    await page.locator("#live-demo input[aria-label]").first().fill(c.line);
    // The send control is disabled while the input is empty OR while a turn is in
    // flight, so the wait has to come AFTER the fill: waiting for "enabled"
    // before typing can never succeed.
    await waitForSendEnabled(page);
    await page.locator('#live-demo button[type="submit"]').first().click();
    await page.waitForTimeout(1500);
    await shoot(page, c.prefix + "-routing", { settle: 300 });
    await page.waitForTimeout(4500);
    await shoot(page, c.prefix + "-replied", { settle: 800 });
    await shootElement(page, "#live-demo", c.prefix + "-panel", { settle: 400 });
    const said = await page
      .locator('#live-demo [role="log"]')
      .first()
      .innerText()
      .catch(() => "");
    console.log("  " + c.prefix + " transcript: " + said.replace(/\s+/g, " ").slice(0, 110));
  } catch (e) {
    // One language failing must not cost the other five their frames.
    console.log("  (" + c.prefix + " skipped: " + String(e && e.message).slice(0, 90) + ")");
  }
  await ctx.close();
}

// ── the SPOKEN turn: a real microphone ─────────────────────────────────────────
// Chromium can be handed a WAV file as its microphone, so the panel's
// push-to-talk captures genuine speech, /api/asr transcribes it, and the agent
// answers in voice. The customer's line is synthesised by the PRODUCT'S OWN
// voice (the public /api/tts/stream endpoint), so the film never claims a call
// that did not happen — and ffmpeg turns that audio into the PCM WAV Chromium's
// fake microphone expects.
{
  const wav = path.join(OUT, "_fake-mic.wav");
  const mp3 = path.join(OUT, "_fake-mic.mp3");
  try {
    const tts = await fetch(BASE + "/api/tts/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: "That transaction is not mine",
        lang: "en",
        role: "customer",
      }),
    });
    if (tts.ok) {
      fs.writeFileSync(mp3, Buffer.from(await tts.arrayBuffer()));
      execFileSync(
        "ffmpeg",
        ["-y", "-i", mp3, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav],
        { stdio: "ignore" },
      );
      fs.unlinkSync(mp3);
      console.log("  fake microphone armed with the product's own voice");
    }
  } catch (e) {
    console.log("  (could not build the fake microphone: " + String(e && e.message) + ")");
  }

  if (fs.existsSync(wav)) {
    const micBrowser = await chromium.launch({
      headless: true,
      args: [
        "--hide-scrollbars",
        "--force-device-scale-factor=1",
        "--disable-gpu",
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
        `--use-file-for-fake-audio-capture=${wav}%noloop`,
      ],
    });
    const ctx = await micBrowser.newContext({
      viewport: { width: W, height: H },
      // Record the panel as VIDEO: the film's centrepiece has to show the product
      // ACTING (the level meter moving, the transcript filling, the reply
      // arriving), and a camera move over a frozen screenshot is not that.
      recordVideo: { dir: OUT, size: { width: W, height: H } },
    });
    const page = await ctx.newPage();
    await openLiveDemo(page);
    // Push to talk: the same control starts and stops the recording.
    const rec = page.locator('#live-demo button[aria-label*="ecording"]').first();
    if (await rec.count()) {
      await rec.click();
      await page.waitForTimeout(6000);
      await shoot(page, "conversation-spoken-listening", { settle: 300 });
      await rec.click();
      await page.waitForTimeout(9000);
      await shoot(page, "conversation-spoken", { settle: 700 });
      await shootElement(page, "#live-demo", "conversation-spoken-panel", { settle: 400 });
      const said = await page
        .locator('#live-demo [role="log"]')
        .first()
        .innerText()
        .catch(() => "");
      console.log("  spoken transcript: " + said.replace(/\s+/g, " ").slice(0, 110));
    }
    await micBrowser.close();
    // Playwright finalises the recording when the context closes. Convert it to
    // the mp4 the composition can time, and drop the webm.
    const recFile = fs
      .readdirSync(OUT)
      .filter((f) => f.endsWith(".webm"))
      .map((f) => path.join(OUT, f))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
    if (recFile) {
      const mp4 = path.join(OUT, "conversation-video.mp4");
      execFileSync(
        "ffmpeg",
        [
          "-y",
          "-i",
          recFile,
          "-c:v",
          "libx264",
          "-pix_fmt",
          "yuv420p",
          "-movflags",
          "+faststart",
          mp4,
        ],
        { stdio: "ignore" },
      );
      fs.unlinkSync(recFile);
      console.log("  recorded the live turn as video: conversation-video.mp4");
    }
    fs.unlinkSync(wav);
  }
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
