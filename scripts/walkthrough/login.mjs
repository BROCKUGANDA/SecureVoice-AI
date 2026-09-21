/**
 * One-time seeded sign-in for the capture profile.
 *
 * Sign-in works now: the app's one-click login completes Clerk's device-trust
 * step itself, so this run only has to happen once per machine — it lands the
 * session in out/.profile, and every recorded take then runs unattended.
 *
 * Usage: node login.mjs   (then sign in in the window that opens)
 */
import { BASE, PROFILE, VIEWPORT, ensureDirs, sleep } from "./lib.mjs";
const { chromium } = await import("playwright");
ensureDirs();
const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: false, viewport: VIEWPORT,
  args: ["--autoplay-policy=no-user-gesture-required"],
});
const page = ctx.pages()[0] || (await ctx.newPage());
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForSelector("header");

const live = async () =>
  page.evaluate(async () => {
    const r = await fetch("/api/console/events", { credentials: "include", signal: AbortSignal.timeout(4000) });
    return r.status;
  }).catch(() => 0);

console.log("\n  Sign in as the operator in the browser window.");
console.log("  Waiting for the server to accept the session (up to 5 minutes)...");
for (let i = 0; i < 300; i++) {
  const s = await live();
  if (s === 200) {
    console.log("  session is live (server 200). Profile saved for the take.");
    await sleep(1500);
    await ctx.close();
    process.exit(0);
  }
  await sleep(2000);
}
console.error("  no live session after 5 minutes - run again, or fix the pending-session bug first.");
await ctx.close();
process.exit(1);
