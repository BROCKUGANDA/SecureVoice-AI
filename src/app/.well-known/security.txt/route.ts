import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const dynamic = "force-dynamic";

/**
 * GET /.well-known/security.txt — the RFC 9116 canonical path.
 *
 * ## Why this route exists rather than only `public/security.txt`
 *
 * `public/security.txt` is served by Next at `/security.txt`, which works. But
 * RFC 9116 §3 specifies `/.well-known/security.txt`, and that is the path every
 * scanner, researcher and vulnerability-reporting link points at. The file's own
 * header comment claimed "Served from /security.txt as well as from
 * /.well-known/security.txt by the Caddy reverse proxy; see Caddyfile" — and no
 * Caddyfile (Caddyfile, Caddyfile.dev, Caddyfile.platform) actually contained
 * that route. So the canonical path 404'd while the file read as if it did not.
 *
 * That is the worst failure mode for this file: it is present, correct, and
 * documented, so nobody checks it — and the disclosure channel it advertises is
 * unreachable from the URL a reporter would actually try.
 *
 * ## Why a route handler rather than a Caddyfile rule
 *
 * Caddy is not the only deployment target (Docker, `bun run start`, a platform
 * host), and a proxy-level rewrite is invisible to anyone auditing the app. A
 * route in `src/app/.well-known/` is served identically everywhere Next runs, and
 * sits beside the existing `apple-developer-merchantid-domain-association`
 * route so both well-known files are discoverable in one directory.
 *
 * ## The file on disk is the single source of truth
 *
 * This handler reads `public/security.txt` rather than duplicating its contents
 * here. Two copies of a security contact address drift, and the copy nobody
 * edits is the one that ends up in production.
 *
 * RFC 9116 wants `text/plain`. `charset=utf-8` is declared because the file is
 * UTF-8; the content is ASCII in practice, and declaring it correctly costs
 * nothing.
 */
export async function GET() {
  try {
    const body = await readFile(join(process.cwd(), "public", "security.txt"), "utf8");
    return new NextResponse(body, {
      status: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        // Pinned rather than "public, max-age=…": a researcher or a scanner that
        // cached a 404 from before this route existed would keep getting it until
        // the cache expired on its own. `no-cache` means revalidate every time,
        // which is the right posture for a file whose whole purpose is being
        // findable by someone in a hurry.
        "Cache-Control": "no-cache",
      },
    });
  } catch {
    // A missing security.txt is itself a finding, so this is explicit rather
    // than a silent empty 200 — an empty body would parse as "no contact
    // published" and satisfy nobody.
    return new NextResponse("security.txt is not available\n", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
}
