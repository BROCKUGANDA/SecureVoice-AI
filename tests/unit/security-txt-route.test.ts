/**
 * `/.well-known/security.txt` — the disclosure channel a researcher actually
 * tries, asserted as BYTES rather than as a route that exists.
 *
 * The file's own header promised it was served from `/.well-known/security.txt` by
 * the reverse proxy, and no Caddyfile in the repository contained that rule: the
 * canonical RFC 9116 path 404'd while the file read as if it did not. That is the
 * failure mode specific to this document — it is present, correct and referenced, so
 * nobody re-checks it, and the contact a vulnerable finder would use in a hurry is
 * unreachable from the URL they would use in a hurry.
 *
 * The point of asserting the body is that a handler which returns 200 and an empty
 * string would pass a status-only check while telling a reporter there is no way to
 * reach anyone.
 */
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { NextRequest } from "next/server";

test("the canonical well-known path serves the published security contact", async () => {
  const { GET } = await import("@/app/.well-known/security.txt/route");
  const res = await GET(new NextRequest("https://app.test/.well-known/security.txt"));

  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  // Revalidated every time, so a scanner that cached the old 404 stops seeing it.
  expect(res.headers.get("cache-control")).toContain("no-cache");

  const body = await res.text();
  expect(body.length, "a 200 with no contact would satisfy nobody").toBeGreaterThan(0);
  // RFC 9116 requires an expiry and at least one contact.
  expect(body).toMatch(/^Expires:/im);
  expect(body).toMatch(/^Contact:/im);

  // One source of truth: the route reads the file on disk rather than duplicating
  // a contact address that would drift.
  const disk = await readFile(new URL("../../public/security.txt", import.meta.url), "utf8");
  expect(body).toBe(disk);
});
