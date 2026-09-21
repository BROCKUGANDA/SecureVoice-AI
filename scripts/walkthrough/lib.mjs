/**
 * Shared helpers for the walkthrough pipeline.
 *
 * The pipeline is: scenes.mjs (storyboard) -> narrate.mjs (audio) ->
 * cards.py (Pillow overlays) -> capture.mjs (Playwright video) ->
 * assemble.mjs (ffmpeg). Every stage reads scenes.mjs, so re-cutting the
 * video means editing story text, not code.
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, "..", "..");
export const OUT = path.join(HERE, "out");
export const FINAL = path.join(REPO, "docs", "walkthrough");

export const AUDIO = path.join(OUT, "audio");
export const VIDEO = path.join(OUT, "video");
export const CLIP = path.join(OUT, "clip");
export const CARD = path.join(OUT, "card");
export const PROFILE = path.join(OUT, ".profile");

/** Base URL of the dev server the capture runs against. */
export const BASE = process.env.CAPTURE_BASE_URL || "http://localhost:3001";

/** Frame geometry. The browser viewport is captured at this size and the
 *  cards match it, so assembly is a straight scale to 1920x1080. */
export const VIEWPORT = { width: 1600, height: 1000 };
export const CANVAS = { width: 1920, height: 1080 };
export const FPS = 30;

export function ensureDirs() {
  for (const d of [OUT, AUDIO, VIDEO, CLIP, CARD, PROFILE, FINAL]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

/** Read KEY=VALUE pairs from the repo .env without importing it. */
export function readEnv(file = path.join(REPO, ".env")) {
  const txt = fs.readFileSync(file, "utf8");
  const out = {};
  for (const line of txt.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2].replace(/^"|"$/g, "");
  }
  return out;
}

export function sha(s) {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

export function ffprobeDuration(file) {
  const out = execFileSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file],
    { encoding: "utf8" },
  );
  const d = parseFloat(out.trim());
  if (!Number.isFinite(d)) throw new Error(`ffprobe gave no duration for ${file}`);
  return d;
}

export function ffprobeStream(file, kind = "v") {
  const out = execFileSync(
    "ffprobe",
    ["-v", "error", "-select_streams", kind, "-show_entries", "stream=width,height,r_frame_rate,duration", "-of", "csv=p=0", file],
    { encoding: "utf8" },
  );
  return out.trim();
}

/** Run a command from the tooling folder, streaming its output, and fail loudly. */
export function run(cmd, args, opts = {}) {
  process.stdout.write(`  $ ${cmd} ${args.join(" ")}\n`);
  const r = spawn(cmd, args, { stdio: "inherit", shell: false, cwd: HERE, ...opts });
  return new Promise((resolve, reject) => {
    r.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited with ${code}`)),
    );
    r.on("error", reject);
  });
}

export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Launch Chromium for capture.
 *
 * Deliberately headful: the demo plays audio and framer-motion animates on
 * requestAnimationFrame, which headless shells throttle. The window is placed
 * off the visible desktop so a take is not disturbed by the user's cursor.
 */
export async function launchBrowser({ audio = true } = {}) {
  const { chromium } = await import("playwright");
  const args = [
    "--autoplay-policy=no-user-gesture-required",
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    "--mute-audio=" + (audio ? "false" : "true"),
    "--force-device-scale-factor=1",
    "--hide-scrollbars=false",
    "--window-position=0,0",
    "--disable-blink-features=AutomationControlled",
  ];
  const browser = await chromium.launch({ headless: false, args, slowMo: 0 });
  return browser;
}

/** Locator by visible text, matching the app's actual rendering. */
export function byText(page, text, { exact = false } = {}) {
  return page.getByText(text, { exact }).first();
}

export function byButton(page, text) {
  return page
    .locator(
      `button:has-text(${JSON.stringify(text)}), [role="button"]:has-text(${JSON.stringify(text)})`,
    )
    .first();
}
