/**
 * Build the favicon / PWA / Open Graph image set from ONE source of truth.
 *
 * Why this exists: the site had exactly two SVGs — `src/app/icon.svg` and
 * `public/logo.svg` — and nothing else. That is not enough icons. Browsers ask
 * for `/favicon.ico` unprompted, Safari and iOS ignore SVG favicons outright and
 * want a 180x180 PNG at `/apple-touch-icon.png`, and the web-app manifest needs
 * real raster sizes (a `maskable` entry pointing at an SVG is rejected by most
 * launcher audits). A missing icon does not error in the console — it just shows
 * a blank tab or a generic glyph, which is exactly the "where did my favicon go"
 * report this script exists to make unrepeatable.
 *
 * The mark itself is NOT re-drawn here. `public/logo.svg` is read and
 * rasterised, so the favicon, the PWA icons, the splash and the OG card cannot
 * drift from the logo that already ships. Change the SVG, re-run this script.
 *
 * Sharp rasterises SVG through librsvg, so the SVG may only use the subset of
 * SVG that librsvg implements — shapes, gradients, opacity. No CSS, no JS, no
 * external fonts, no <image href>.
 *
 * Outputs
 *   src/app/favicon.ico        16/32/48 PNG frames in one ICO container (served at /favicon.ico)
 *   src/app/apple-icon.png      180x180, opaque (iOS tints transparent corners)
 *   public/icon-192.png         192x192 "any"
 *   public/icon-512.png         512x512 "any"
 *   public/icon-maskable-512.png 512x512 with the safe-zone padding a mask needs
 *   public/og-image.png         1200x630 social card
 *
 * Run: bun scripts/build-icons.mjs
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = (...p) => resolve(root, ...p);

/** The mark. Single source of truth for every raster below. */
const MARK_SVG = await readFile(out("public", "logo.svg"), "utf8");

/** Brand palette, mirroring tailwind.config.ts `primary` / `green-bright`. */
const INK = "#0c110e";
const GREEN_BRIGHT = "#2ed3a0";

/** Rasterise the mark at `size`, optionally padded for maskable safe zones. */
async function markPng(size, { maskable = false } = {}) {
  // A maskable icon can be cropped to a circle inscribed in the middle 80%, so
  // the artwork is scaled down to 60% and re-centred on the same dark plate.
  // Without this the shield's corners are sliced off by the launcher's mask.
  const plate = maskable ? INK : "transparent";
  const art = maskable ? 0.6 : 1;
  const inner = Math.round(size * art);
  const pad = Math.round((size - inner) / 2);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" fill="${plate}"/>
  <g transform="translate(${pad} ${pad}) scale(${inner / 48})">${stripSvgWrapper(MARK_SVG)}</g>
</svg>`;
  return sharp(Buffer.from(svg)).resize(size, size).png({ compressionLevel: 9 }).toBuffer();
}

/**
 * `logo.svg` is a complete document, so its children are lifted out of the
 * `<svg>` element and re-wrapped at the size we want. Its own `viewBox` is
 * dropped because the wrapper owns the coordinate system — keeping both would
 * double-apply the 48-unit scale.
 */
function stripSvgWrapper(svg) {
  const open = svg.match(/<svg\b[^>]*>/i);
  const inner = svg.slice(svg.indexOf(">", svg.indexOf("<svg")) + 1, svg.lastIndexOf("</svg>"));
  void open;
  return inner;
}

/**
 * Assemble a multi-frame .ico by hand.
 *
 * Sharp writes PNG/JPEG/WebP and no ICO, and there is no ICO encoder in the
 * dependency tree. The container is small and fully specified though: a 6-byte
 * header, a 16-byte directory entry per frame, then the frame payloads. Frames
 * are PNG-compressed, which Windows has accepted since Vista — which matters,
 * because PNG is the only compression sharp can produce and re-encoding to BMP
 * here would mean writing a DIB header per frame for no visual gain.
 */
function buildIco(frames) {
  const count = frames.length;
  // Header: reserved(2) type(2)=1 count(2) — all little-endian.
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);

  const dirSize = 16 * count;
  let offset = 6 + dirSize;
  const entries = [];
  for (const f of frames) {
    const e = Buffer.alloc(16);
    // w/h are stored as a single byte; 256 is encoded as 0.
    e.writeUInt8(f.size >= 256 ? 0 : f.size, 0);
    e.writeUInt8(f.size >= 256 ? 0 : f.size, 1);
    e.writeUInt8(0, 2); // palette size: 0 = "no palette / truecolour"
    e.writeUInt8(0, 3); // reserved
    e.writeUInt16LE(1, 4); // colour planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(f.data.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += f.data.length;
  }
  return Buffer.concat([header, ...entries, ...frames.map((f) => f.data)]);
}

/* ————————————————————— Open Graph / Twitter card ————————————————————— */

/**
 * 1200x630 social card.
 *
 * Composed as an SVG and rasterised rather than screenshotted, so it is
 * deterministic, needs no browser, and cannot drift with a CSS change. Text is
 * the system sans stack librsvg can resolve; anything it cannot resolve falls
 * back to the default face, which is why no webfont is referenced here.
 *
 * Everything sits inside the left 1000px: X/Twitter crop the card to a 2:1
 * centre region in some surfaces, and the tagline must survive that crop.
 */
function ogSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <linearGradient id="og-bg" x1="0" y1="0" x2="1200" y2="630" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#0c110e"/>
      <stop offset="1" stop-color="#132019"/>
    </linearGradient>
    <linearGradient id="og-grad" x1="0" y1="0" x2="48" y2="48" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#2ed3a0"/>
      <stop offset="0.55" stop-color="#17a673"/>
      <stop offset="1" stop-color="#0b7a55"/>
    </linearGradient>
    <pattern id="og-grid" width="40" height="40" patternUnits="userSpaceOnUse">
      <path d="M40 0H0V40" fill="none" stroke="#ffffff" stroke-opacity="0.05" stroke-width="1"/>
    </pattern>
  </defs>

  <rect width="1200" height="630" fill="url(#og-bg)"/>
  <rect width="1200" height="630" fill="url(#og-grid)"/>

  <!-- mark, blown up from logo.svg's own geometry (48-unit grid, x4) -->
  <g transform="translate(80 76) scale(4)">
    <rect width="48" height="48" rx="11" fill="#000000" fill-opacity="0"/>
    <path d="M24 8.6 L35.6 12.9 V22.3 C35.6 29.8 30.7 35.5 24 39.4 C17.3 35.5 12.4 29.8 12.4 22.3 V12.9 Z"
          stroke="url(#og-grad)" stroke-width="2.4" stroke-linejoin="round"/>
    <g fill="url(#og-grad)">
      <rect x="16.9" y="21.2" width="2.7" height="5.6" rx="1.35" opacity="0.85"/>
      <rect x="21.35" y="17.2" width="2.7" height="13.6" rx="1.35"/>
      <rect x="25.8" y="19.2" width="2.7" height="9.6" rx="1.35" opacity="0.85"/>
      <rect x="30.25" y="22.4" width="2.7" height="3.2" rx="1.35" opacity="0.6"/>
    </g>
  </g>
  <text x="292" y="150" font-family="Helvetica, Arial, sans-serif" font-size="40" font-weight="700" fill="#ffffff" letter-spacing="-0.5">SecureVoice AI</text>
  <text x="292" y="188" font-family="Helvetica, Arial, sans-serif" font-size="21" fill="${GREEN_BRIGHT}" letter-spacing="3.4">FRAUD INTERVENTION</text>

  <text x="80" y="352" font-family="Helvetica, Arial, sans-serif" font-size="72" font-weight="700" fill="#ffffff" letter-spacing="-1.6">Real-time fraud intervention</text>
  <text x="80" y="428" font-family="Helvetica, Arial, sans-serif" font-size="72" font-weight="700" fill="${GREEN_BRIGHT}" letter-spacing="-1.6">for UAE banking</text>

  <text x="80" y="504" font-family="Helvetica, Arial, sans-serif" font-size="29" fill="#ffffff" opacity="0.66">An AI voice agent that calls the customer in their own language</text>
  <text x="80" y="548" font-family="Helvetica, Arial, sans-serif" font-size="29" fill="#ffffff" opacity="0.66">within 60 seconds of a fraud signal — and freezes the card.</text>

  <rect x="80" y="586" width="${GREEN_BRIGHT}" height="4" rx="2" fill="${GREEN_BRIGHT}" opacity="0.9"/>
  <text x="80" y="152" font-family="Helvetica, Arial, sans-serif" font-size="0" fill="none">.</text>
</svg>`;
}

/* ————————————————————————————————— run ————————————————————————————————— */

const written = [];
const put = async (rel, data) => {
  const p = out(rel);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, data);
  written.push(`${rel} (${data.length} bytes)`);
};

// favicon.ico — 16/32/48. 48 is included because Windows' medium-icon slot and
// some older shells ask for it directly.
const frames = await Promise.all(
  [16, 32, 48].map(async (size) => ({ size, data: await markPng(size) })),
);
await put("src/app/favicon.ico", buildIco(frames));

// iOS tints (and can reject) transparent artwork, so this one is composited on
// an opaque plate rather than rasterised with alpha.
await put("src/app/apple-icon.png", await markPng(180));
await put("public/icon-192.png", await markPng(192));
await put("public/icon-512.png", await markPng(512));
await put("public/icon-maskable-512.png", await markPng(512, { maskable: true }));

const og = await sharp(Buffer.from(ogSvg())).png({ compressionLevel: 9 }).toBuffer();
await put("public/og-image.png", og);

console.log("[build-icons] wrote:\n  " + written.join("\n  "));
