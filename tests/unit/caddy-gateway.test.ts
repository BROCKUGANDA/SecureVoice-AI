/**
 * The API gateway lives in Caddy, so its guarantees are only as real as the
 * config file. Nothing in the app's test suite can catch a matcher that was
 * widened, or a rewrite that dropped, because both are outside the app.
 *
 * The properties worth protecting, and why each one matters:
 *
 *   1. `/v1/*` is ANCHORED. Caddy path matchers match from the start of the
 *      path, so this block cannot capture `/api/v1/*`. If someone "simplifies"
 *      it to `handle {` or `handle /v1*`, the public contract starts shadowing
 *      the internal one and a bank request can silently change meaning.
 *   2. The rewrite maps `/v1/x` to `/api/v1/x` — one implementation, reachable
 *      under the short path the integration docs publish.
 *   3. The block sits BEFORE the catch-all, or it never fires at all.
 *   4. No auth at the edge. The producer key is verified per route, where
 *      tenancy is resolved; a second implementation at the proxy would drift
 *      from the one that enforces isolation.
 *   5. The platform file (Northflank, TLS already terminated upstream) has the
 *      same rule — it is a separate file and would otherwise rot independently.
 *
 * This parses the files as text on purpose: `caddy validate` proves the syntax,
 * not the intent.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (f: string): string => readFileSync(new URL(`../../${f}`, import.meta.url), "utf8");

const FILES = ["Caddyfile", "Caddyfile.platform"] as const;

for (const file of FILES) {
  test(`${file}: /v1 is rewritten to the app's /api/v1, anchored`, () => {
    const src = read(file);

    const block = src.match(/handle \/v1\/[^{]*\{/);
    expect(block, `${file} has no handle /v1/* block`).not.toBeNull();

    // Anchored, no wildcard prefix. `/v1*` and `/v1/` alone are both wrong:
    // the first also matches `/v1anything`, the second drops the sub-path.
    expect(src).toMatch(/handle \/v1\/\* \{/);
    expect(src).not.toMatch(/handle \/v1\*/);

    // The rewrite must preserve the rest of the path: a literal prefix swap
    // that dropped `{uri}` would send every bank to the same URL.
    expect(src).toMatch(/rewrite \* \/api\{uri\}/);

    // Ordered before the catch-all, or the block is dead config.
    expect(src.indexOf("handle /v1/*")).toBeLessThan(src.indexOf("handle {"));
  });

  test(`${file}: the edge does not authenticate the bank API`, () => {
    const src = read(file);
    const start = src.indexOf("handle /v1/*");
    expect(start).toBeGreaterThan(-1);
    // Slice just this block (it has no nested braces) and read it.
    const body = src.slice(start, src.indexOf("\n\t}", start));
    for (const banned of [
      "basic_auth",
      "forward_auth",
      "basic_authentication",
      "basicauth",
      "jwt",
      "token",
    ]) {
      expect(body.toLowerCase(), `${file} does auth at the edge (${banned})`).not.toContain(banned);
    }
    // And it forwards to the app, which is where the key is checked.
    expect(body).toMatch(/reverse_proxy/);
  });

  test(`${file}: the gateway block never swallows the app's own namespace`, () => {
    const src = read(file);
    // No matcher that would also capture /api/... : a leading `*`, a bare
    // prefix of `/`, or an explicit /api path in the same block.
    expect(src).not.toMatch(/handle \* \{/);
    expect(src).not.toMatch(/handle \/api/);
  });
}
