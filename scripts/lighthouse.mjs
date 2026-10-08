#!/usr/bin/env node
/**
 * Lighthouse harness — performance and accessibility, with budgets that fail.
 *
 *   node scripts/lighthouse.mjs                       # http://localhost:3000
 *   node scripts/lighthouse.mjs --url=http://…        # any deployed origin
 *   node scripts/lighthouse.mjs --chrome="<path>"     # explicit browser binary
 *   node scripts/lighthouse.mjs --html                # also write the HTML report
 *   node scripts/lighthouse.mjs --allow-dev           # don't refuse a dev server
 *
 * WHY THE DEV-SERVER REFUSAL EXISTS
 * --------------------------------
 * Lighthouse scores are only comparable to a budget if the page measured is the
 * page users get. `next dev` serves unminified modules, the HMR client and React
 * development builds through Turbopack, which inflates FCP/TBT/CLS by an amount
 * that is not a property of the product. Running a budget against it produces a
 * number that is real but about the wrong artefact, so the default is to stop and
 * say so rather than report it. `bun run build && bun run start` first, or pass
 * --allow-dev when you want the measurement anyway and know what it means.
 *
 * BROWSER AVAILABILITY ON THIS MACHINE (checked, not assumed)
 * ----------------------------------------------------------
 * There is no Google Chrome installed. Microsoft Edge 154 is, at
 * `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`. Lighthouse
 * drives any Chromium-family browser through chrome-launcher, so the resolver
 * below takes LH_CHROME_PATH / --chrome, then CHROME_PATH, then the usual
 * Chrome locations, then Edge — and if nothing is found it exits with the list of
 * places it looked instead of a stack trace.
 *
 * BUDGETS
 * -------
 * Declared here, in the file, so a change is a diff and not a config archaeology
 * exercise. `scores` are the Lighthouse category scores; `metrics` are
 * milliseconds (or unitless for CLS), taken from the same audits the report uses.
 * The a11y budget is not a score: a 0.98 accessibility score still hides
 * critical violations when the audit surface is large, so the count of
 * critical/serious violations is budgeted separately, at zero. A regulated bank
 * front door has no tolerance for a broken accessible name.
 *
 * Anything missed exits non-zero. A budget that is printed and ignored is a
 * comment, not a gate.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const OUT = resolve(ROOT, "coverage", "lighthouse");

const BUDGETS = {
  scores: {
    performance: 0.75,
    // Accessibility is held far above the others on purpose: this is the front
    // door of a banking product, and WCAG 2.1 AA is a legal expectation for it
    // in the markets it sells into, not a quality preference.
    accessibility: 0.95,
  },
  metrics: {
    "first-contentful-paint": 3000,
    "largest-contentful-paint": 4000,
    "total-blocking-time": 500,
    "cumulative-layout-shift": 0.15,
    "speed-index": 4500,
    interactive: 6000,
  },
  a11y: {
    maxFailingA11yItems: 0,
  },
};

const CHROME_CANDIDATES = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files/Google/Chrome/Application/chrome_canary.exe",
  `${process.env.LOCALAPPDATA ?? ""}/Google/Chrome/Application/chrome.exe`,
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

function arg(name) {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}
const flag = (name) => process.argv.slice(2).includes(`--${name}`);

const URL_TO_TEST = arg("url") ?? process.env.LH_URL ?? "http://localhost:3000";

function resolveChrome() {
  const explicit = arg("chrome") ?? process.env.LH_CHROME_PATH ?? process.env.CHROME_PATH;
  if (explicit) {
    return existsSync(explicit)
      ? { path: explicit, how: "explicit" }
      : { error: `the path you gave does not exist: ${explicit}` };
  }
  for (const c of CHROME_CANDIDATES) {
    if (c && existsSync(c)) return { path: c, how: "probed" };
  }
  // WSL / macOS/Linux where `which` is the cheapest correct answer.
  for (const bin of ["google-chrome", "chromium", "chromium-browser", "chrome", "microsoft-edge"]) {
    const probe = spawnSync("which", [bin], { encoding: "utf8" });
    if (probe.status === 0 && probe.stdout.trim()) {
      return { path: probe.stdout.trim(), how: "which" };
    }
  }
  return {
    error:
      "no Chromium-family browser found. Looked for: " +
      CHROME_CANDIDATES.join(", ") +
      " and PATH entries google-chrome/chromium/chromium-browser/chrome/microsoft-edge. " +
      "Pass --chrome=<path> or set LH_CHROME_PATH.",
  };
}

/**
 * Is this a dev server? Turbopack/webpack HMR leaves fingerprints in the HTML
 * that a production build does not have.
 */
async function looksLikeDev(url) {
  try {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) return false;
    const html = await res.text();
    return /webpack-hmr|turbopack|__next_react_dev|development/i.test(html);
  } catch {
    return false;
  }
}

async function reachable(url) {
  try {
    const res = await fetch(url, { redirect: "follow" });
    return res.status > 0;
  } catch {
    return false;
  }
}

/**
 * Failing entries behind the accessibility category.
 *
 * The enforced number is the count of failing items across every non-passing
 * audit in the category. Where Lighthouse does attach an `impact` to an item it
 * is bucketed and printed as well — but it is NOT what the gate enforces,
 * because the field is not present on every audit in this version and a budget
 * cannot rest on a field that may be missing. Say what is measured; enforce what
 * is certain.
 */
function a11yViolations(lhr) {
  const category = lhr.categories.accessibility;
  if (!category) return { total: 0, byImpact: {}, failingAudits: [] };
  const byImpact = {};
  const failingAudits = [];
  let total = 0;
  for (const ref of category.auditRefs ?? []) {
    const audit = lhr.audits[ref.id];
    if (!audit) continue;
    if (audit.score === null || audit.score === 1) continue; // n/a or passing
    const items = audit.details?.items ?? [];
    const failing = items.filter(
      (i) => i.importance === "FAILING" || (i.node ?? i.selector) !== undefined,
    );
    const count = failing.length || items.length;
    if (!count) continue;
    failingAudits.push({ id: audit.id, title: audit.title, count });
    total += count;
    for (const item of failing) {
      const impact = item.impact ?? "unspecified";
      byImpact[impact] = (byImpact[impact] ?? 0) + 1;
    }
  }
  return { total, byImpact, failingAudits };
}

function fmtMetric(key, value) {
  if (value === undefined || value === null) return "n/a";
  if (key === "cumulative-layout-shift") return value.toFixed(3);
  return `${Math.round(value)}ms`;
}

async function main() {
  const chrome = resolveChrome();
  if (chrome.error) {
    console.error(`lighthouse: ${chrome.error}`);
    process.exit(2);
  }

  console.log(`lighthouse: browser ${chrome.path} (${chrome.how})`);
  console.log(`lighthouse: url     ${URL_TO_TEST}`);

  if (!(await reachable(URL_TO_TEST))) {
    console.error(
      [
        `lighthouse: ${URL_TO_TEST} is not answering.`,
        "            Lighthouse measures a running server; it does not start one.",
        "            production (measured against the real artefact):",
        "                bun run build && bun run start        # then this script",
        "            development (numbers will not mean anything):",
        "                bun run dev",
      ].join("\n"),
    );
    process.exit(2);
  }

  if (!flag("allow-dev") && (await looksLikeDev(URL_TO_TEST))) {
    console.error(
      [
        "lighthouse: this looks like a DEV server (HMR/Turbopack markers in the HTML).",
        "            Perf budgets are not evaluated against dev output: unminified",
        "            modules and the React development build are not what a customer",
        "            loads. Build and start, then measure:",
        "                bun run build && bun run start",
        "            Or, if you really want the dev number, add --allow-dev.",
      ].join("\n"),
    );
    process.exit(3);
  }

  const lighthouse = (await import("lighthouse")).default;
  const chromeLauncher = await import("chrome-launcher");

  const launched = await chromeLauncher.launch({
    chromePath: chrome.path,
    port: 0,
    chromeFlags: [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--remote-debugging-port=0",
    ],
  });

  let lhr;
  try {
    const result = await lighthouse(
      URL_TO_TEST,
      {
        port: launched.port,
        output: flag("html") ? ["json", "html"] : "json",
        logLevel: "error",
        onlyCategories: ["performance", "accessibility"],
        formFactor: "desktop",
        throttlingMethod: "simulate",
        screenEmulation: {
          mobile: false,
          width: 1366,
          height: 900,
          deviceScaleFactor: 1,
          disabled: false,
        },
      },
      undefined,
    );
    lhr = result.lhr;
    mkdirSync(OUT, { recursive: true });
    writeFileSync(resolve(OUT, "report.json"), result.report, "utf8");
    if (flag("html")) writeFileSync(resolve(OUT, "report.html"), result.report[1], "utf8");
  } finally {
    await launched.kill().catch(() => {});
  }

  const problems = [];
  console.log("");
  console.log("── lighthouse ──");

  for (const [name, need] of Object.entries(BUDGETS.scores)) {
    const score = lhr.categories[name]?.score;
    const ok = typeof score === "number" && score >= need;
    const shown = typeof score === "number" ? (score * 100).toFixed(0).padStart(3) : " n/a";
    console.log(`  ${name.padEnd(14)} ${shown}   need ${need * 100}   ${ok ? "PASS" : "FAIL"}`);
    if (!ok) problems.push(`score ${name} ${shown} < ${need * 100}`);
  }

  console.log("");
  for (const [key, max] of Object.entries(BUDGETS.metrics)) {
    const value = lhr.audits[key]?.numericValue;
    const ok = value !== undefined && value <= max;
    console.log(
      `  ${key.padEnd(26)} ${fmtMetric(key, value).padStart(9)}   budget <= ${fmtMetric(key, max)}   ${ok ? "PASS" : "FAIL"}`,
    );
    if (!ok) problems.push(`${key} ${fmtMetric(key, value)} > ${fmtMetric(key, max)}`);
  }

  const a11y = a11yViolations(lhr);
  const a11yOk = a11y.total <= BUDGETS.a11y.maxCriticalOrSeriousViolations;
  console.log("");
  console.log(
    `  a11y failing audits      ${String(a11y.failingAudits.length).padStart(9)}   (${
      a11y.failingAudits.map((f) => `${f.id}=${f.count}`).join(", ") || "none"
    })`,
  );
  console.log(
    `  a11y critical/serious    ${String(a11y.total).padStart(9)}   budget <= ${BUDGETS.a11y.maxCriticalOrSeriousViolations}   ${a11yOk ? "PASS" : "FAIL"}`,
  );
  if (!a11yOk) {
    problems.push(
      `accessibility critical/serious violations ${a11y.total} > ${BUDGETS.a11y.maxCriticalOrSeriousViolations}`,
    );
  }

  if (lhr.runError) problems.push(`runError: ${lhr.runError.message}`);

  console.log(`  report: coverage/lighthouse/report.json`);
  if (problems.length) {
    console.log("");
    console.log("  budgets missed:");
    for (const p of problems) console.log(`    · ${p}`);
    process.exit(1);
  }
  console.log("");
  console.log("  all budgets met");
}

main().catch((err) => {
  console.error(`lighthouse: ${err?.stack ?? err}`);
  process.exit(2);
});
