/**
 * Stage 4 — assembly.
 *
 * Cuts the single Playwright recording at the manifest's scene boundaries,
 * scales every frame to 1920x1080, overlays the Pillow caption, mixes the
 * narrator with the agent lines measured in narrate.mjs, then concat-muxes the
 * clips into one MP4. Every clip is encoded with identical parameters so the
 * final concat is a lossless stream copy.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { AUDIO, CARD, CLIP, CANVAS, FINAL, OUT, REPO, ffprobeDuration, readJson } from "./lib.mjs";
import { scenes } from "./scenes.mjs";

const timings = readJson(path.join(AUDIO, "timings.json"));
const manifest = readJson(path.join(OUT, "manifest.json"));
if (!timings || !manifest) throw new Error("run narrate.mjs and capture.mjs first");
const rec = readJson(path.join(OUT, "manifest.json")).video;
if (!rec || !fs.existsSync(rec)) throw new Error("no recording at " + rec);
const byId = Object.fromEntries(timings.scenes.map((t) => [t.id, t]));
const cut = Object.fromEntries(manifest.scenes.map((s) => [s.id, s]));

fs.mkdirSync(CLIP, { recursive: true });
fs.mkdirSync(FINAL, { recursive: true });
const fwd = (p) => p.split(path.sep).join("/");

function ffmpeg(args, label) {
  try {
    execFileSync("ffmpeg", args, { cwd: REPO, maxBuffer: 1 << 26, stdio: ["ignore", "ignore", "pipe"] });
  } catch (e) {
    const tail = String(e.stderr || e.message).split("\n").slice(-14).join("\n");
    throw new Error(label + " failed:\n" + tail);
  }
}

const list = [];
for (const [i, sc] of scenes.entries()) {
  const t = byId[sc.id];
  if (!t) throw new Error("no timings for scene " + sc.id);
  const out = path.join(CLIP, sc.id + ".mp4");
  const narr = path.join(AUDIO, t.narr);

  if (sc.kind === "card") {
    const dur = t.dur;
    ffmpeg([
      "-y", "-loop", "1", "-framerate", "30", "-i", fwd(path.join(CARD, sc.id + ".png")),
      "-i", fwd(narr), "-t", dur.toFixed(2),
      "-vf", "scale=" + CANVAS.width + ":" + CANVAS.height + ",format=yuv420p",
      "-af", "aresample=48000,afade=t=in:st=0:d=0.4,afade=t=out:st=" + (dur - 0.7).toFixed(2) + ":d=0.7",
      "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
      "-video_track_timescale", "30000", fwd(out),
    ], sc.id + " (card)");
  } else {
    const c = cut[sc.id];
    if (!c) throw new Error("scene " + sc.id + " was never captured");
    const dur = Math.max(c.dur, t.dur);
    const args = [
      "-y",
      "-ss", c.start.toFixed(2), "-t", dur.toFixed(2), "-i", fwd(rec),
      "-loop", "1", "-i", fwd(path.join(CARD, "cap-" + sc.id + ".png")),
      "-i", fwd(narr),
    ];
    for (const a of t.agent) args.push("-i", fwd(path.join(AUDIO, a.file)));

    const filters = [
      "[0:v]scale=" + CANVAS.width + ":" + CANVAS.height + ":force_original_aspect_ratio=decrease," +
        "pad=" + CANVAS.width + ":" + CANVAS.height + ":(ow-iw)/2:(oh-ih)/2:color=0x0a0f0c," +
        "setsar=1,fps=30,format=yuv420p[b]",
      "[b][1:v]overlay=0:0:enable='between(t,0.3," + (dur - 0.2).toFixed(2) + ")'[v]",
      "[2:a]aresample=48000,adelay=300|300[m0]",
    ];
    t.agent.forEach((a, k) => {
      filters.push(
        "[" + (3 + k) + ":a]aresample=48000,adelay=" + Math.round(a.at * 1000) + "|0000,volume=0.82[m" + (k + 1) + "]",
      );
    });
    const mix = Array.from({ length: t.agent.length + 1 }, (_, k) => "[m" + k + "]").join("");
    filters.push(mix + "amix=inputs=" + (t.agent.length + 1) + ":duration=longest:normalize=0,apad,atrim=0:" + dur.toFixed(2) + "[a]");

    args.push(
      "-filter_complex", filters.join(";"),
      "-map", "[v]", "-map", "[a]", "-t", dur.toFixed(2),
      "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
      "-video_track_timescale", "30000", fwd(out),
    );
    ffmpeg(args, sc.id + " (capture)");
  }
  console.log("  clip " + sc.id + "  " + ffprobeDuration(out).toFixed(1) + "s");
  list.push("file '" + fwd(out) + "'");
}

const listFile = path.join(CLIP, "list.txt");
fs.writeFileSync(listFile, list.join("\n") + "\n");
const mp4 = path.join(FINAL, "securevoice-walkthrough.mp4");
ffmpeg(["-y", "-f", "concat", "-safe", "0", "-i", fwd(listFile), "-c", "copy", "-movflags", "+faststart", fwd(mp4)], "concat");

/** Sidecar captions: the same text the narrator speaks, as a real .srt. */
function stamp(s) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = (s % 60).toFixed(3).padStart(6, "0");
  const ms = String(Math.round((s % 1) * 1000)).padStart(3, "0");
  return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0") + ":" + sec.split(".")[0] + "." + ms;
}
let at = 0, srt = "", n = 0;
for (const sc of scenes) {
  const dur = ffprobeDuration(path.join(CLIP, sc.id + ".mp4"));
  const half = dur / Math.max(1, sc.captions?.length || 1);
  (sc.captions || []).forEach((line, k) => {
    const s = at + k * half, e = at + (k + 1) * half - 0.1;
    srt += ++n + "\n" + stamp(s) + " --> " + stamp(e) + "\n" + line + "\n\n";
  });
  at += dur;
}
fs.writeFileSync(path.join(FINAL, "securevoice-walkthrough.srt"), srt);
ffmpeg(["-y", "-ss", (at * 0.42).toFixed(2), "-i", fwd(mp4), "-frames:v", "1", fwd(path.join(FINAL, "poster.png"))], "poster");

const total = ffprobeDuration(mp4);
console.log("\nwalkthrough -> " + mp4);
console.log("  " + total.toFixed(1) + "s  (" + Math.floor(total / 60) + "m" + String(Math.round(total % 60)).padStart(2, "0") + "s)");
console.log("  " + (fs.statSync(mp4).size / 1e6).toFixed(1) + " MB  ·  captions: securevoice-walkthrough.srt");
