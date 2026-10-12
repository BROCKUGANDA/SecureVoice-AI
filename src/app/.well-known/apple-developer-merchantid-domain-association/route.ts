import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const dynamic = "force-dynamic";

/**
 * GET /.well-known/apple-developer-merchantid-domain-association
 *
 * Paddle's Apple Pay domain-verification file.
 *
 * ## What this is for
 *
 * Apple Pay only renders the sheet on a domain that has completed merchant ID
 * domain association. For a Paddle merchant that means serving Paddle's own
 * association file at exactly this path on exactly this origin. Without it,
 * Apple Pay silently does not appear for buyers — which on a checkout for a
 * bank's fraud console looks like "payment options are broken" rather than a
 * missing config file.
 *
 * The exact path and the file contents come from Paddle, not from us:
 *   Paddle > My account > Settings > Website approval
 * Then Confirm verification next to your domain.
 *
 * ## Why the contents are a file on disk, not an env var
 *
 * The association document is a signed blob issued by Apple to Paddle. It
 * changes only when Paddle reissues it, is not secret, and must be byte-exact.
 * Storing it on disk means the bytes served are the bytes Paddle gave us — no
 * escaping, no re-serialisation, no accidental trailing newline — and swapping
 * it is a redeploy rather than a config edit. An env var would put a
 * multi-hundred-character base64 blob in .env, where a well-meaning trim would
 * break verification with a 400 from Apple.
 *
 * ## When the file is absent
 *
 * 404 with a clear body rather than a Next.js error page. This route is probed
 * by Apple's crawler and by Paddle's verifier; a generic 500 tells neither of
 * them anything useful about what is actually wrong.
 */

const FILENAME = "apple-developer-merchantid-domain-association";

/**
 * Where the downloaded file is mounted in the deployed image.
 *
 * The Dockerfile's runner stage copies ONLY `.next/standalone` (Dockerfile:134) —
 * `public/` is never copied in. So a file placed in `public/.well-known/` would
 * be invisible in production, and `process.cwd()/.well-known/` is likewise
 * absent. The app keeps its own copy under `src/app/.well-known/`, which the
 * builder stage's `COPY . .` includes, and an operator mounts the real file
 * over this path at deploy time (see docs/PADDLE-APPLE-PAY.md).
 *
 * Two locations are tried so the route works in dev (source tree), in a
 * plain `bun run build && bun start`, and in the container.
 */
const CANDIDATES = [
  join(process.cwd(), "src", "app", ".well-known", FILENAME),
  join(process.cwd(), "public", ".well-known", FILENAME),
  join(process.cwd(), ".well-known", FILENAME),
];

export async function GET() {
  let body: string | null = null;
  for (const path of CANDIDATES) {
    try {
      body = await readFile(path, "utf8");
      break;
    } catch {
      continue;
    }
  }

  if (body === null) {
    return new NextResponse(
      "Apple Pay domain association file is not installed.\n" +
        "Download it from Paddle (My account > Settings > Website approval) and mount it at\n" +
        `src/app/.well-known/${FILENAME} in the deployed image. See docs/PADDLE-APPLE-PAY.md.\n`,
      { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } },
    );
  }

  // Apple's verifier requires this exact content type. `application/json` (the
  // common default) makes a correctly-served file still fail to verify.
  return new NextResponse(body, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // Apple's crawler and Paddle both re-fetch during approval; a long max-age
      // would serve a stale blob after Paddle reissues one.
      "Cache-Control": "public, max-age=300",
    },
  });
}