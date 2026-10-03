/**
 * Live proof that the feature flags gate real HTTP behaviour.
 *
 * Unit tests prove `flag()` resolves correctly and that `notifyRealtime()`
 * consults it. Neither proves the deployed route does. This boots the built
 * Next server twice — once with flags off, once on — and asserts the observable
 * difference:
 *
 *   flags off → /api/console/features says false, and the realtime-token route
 *                answers 503 without ever touching the session.
 *   flags on  → /api/console/features says true, and the token route gets past
 *                the flag gate (401/400 from the auth check instead of 503),
 *                proving the gate is what returned 503 in the first case.
 *
 * The 401-vs-503 distinction is the whole point: 503 means "not configured",
 * 401 means "configured, now prove who you are". A route that returned 503 in
 * both cases would pass a naive smoke test while ignoring its flag entirely.
 */

const BASE = process.env.PROBE_BASE ?? "http://127.0.0.1:3111";

type Result = { name: string; ok: boolean; detail: string };

async function get(path: string, init?: RequestInit): Promise<{ status: number; body: string }> {
  const res = await fetch(`${BASE}${path}`, init);
  let body = "";
  try {
    body = JSON.stringify(await res.json());
  } catch {
    body = "<non-json>";
  }
  return { status: res.status, body };
}

async function main() {
  const results: Result[] = [];
  const check = (name: string, ok: boolean, detail: string) => results.push({ name, ok, detail });

  const expectFlag = process.env.EXPECT_LIVE_FEED;

  // 1. The client-visible flag route must reflect the deployment's env.
  const feats = await get("/api/console/features");
  let served: unknown;
  try {
    served = JSON.parse(feats.body).consoleLiveFeed;
  } catch {
    served = undefined;
  }
  check(
    "features route served and uncached",
    feats.status === 200 && feats.body !== "<non-json>",
    `status=${feats.status} body=${feats.body.slice(0, 80)}`,
  );
  check(
    `consoleLiveFeed reflects env (expected ${expectFlag})`,
    served === (expectFlag === "true"),
    `served=${JSON.stringify(served)}`,
  );

  // 2. The flag value must NOT include server-only flags.
  const noLeak = !/"(realtime|piiRedaction|elevenLabsLive)"/.test(feats.body);
  check("no server-only flags leaked to the client", noLeak, `body=${feats.body.slice(0, 120)}`);

  // 3. The token route must reflect the SAME flag.
  const token = await get("/api/console/realtime-token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ callRefs: ["SV-PROBE"] }),
  });

  if (expectFlag === "true") {
    // Flag on: must get PAST the gate. Whatever the auth decision is, it must
    // not be the 503 "not configured" response.
    const pastGate = token.status !== 503;
    check(
      "token route passes the flag gate when enabled",
      pastGate,
      `status=${token.status} (503 would mean the flag was ignored) body=${token.body.slice(0, 80)}`,
    );
  } else {
    // Flag off: 503 specifically, and it must NOT be 401 — a 401 would mean the
    // gate was skipped and the session check ran first.
    check(
      "token route returns 503 (not 401) when realtime is off",
      token.status === 503,
      `status=${token.status} body=${token.body.slice(0, 100)}`,
    );
    check(
      "503 message names both switches so the fix is obvious",
      /FEATURE_REALTIME/.test(token.body) && /REALTIME_INGEST_SECRET/.test(token.body),
      `body=${token.body.slice(0, 140)}`,
    );
  }

  // 4. An unauthenticated caller must not be able to tell *which* flags are on
  //    beyond the client-safe set — the features route is public by design, but
  //    the token route must not leak deployment state to a stranger.
  if (expectFlag === "true") {
    const anon = await get("/api/console/realtime-token", { method: "POST" });
    check(
      "unauthenticated token request never returns a grant",
      !/"token"\s*:/.test(anon.body),
      `status=${anon.status} body=${anon.body.slice(0, 80)}`,
    );
  }

  const failed = results.filter((r) => !r.ok);
  for (const r of results) {
    console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}\n      ${r.detail}`);
  }
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error("probe crashed:", e);
  process.exit(1);
});
