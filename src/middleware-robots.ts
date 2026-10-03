import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

/**
 * X-Robots-Tag middleware for WP-24 public surface.
 *
 * Every authenticated route returns `noindex, nofollow` so the operator
 * console is never indexed by a search engine. A `robots.txt` alone is
 * advisory — a response header is the control.
 *
 * Also blocks AI crawlers (GPTBot, ClaudeBot, PerplexityBot, Google-Extended)
 * from the authenticated console. Marketing and docs hosts allow them.
 */

export function middleware(req: NextRequest) {
  const res = NextResponse.next();

  // All authenticated routes get noindex
  const path = req.nextUrl.pathname;
  if (
    path.startsWith("/api/") ||
    path.startsWith("/dashboard") ||
    path.startsWith("/console") ||
    path.startsWith("/settings") ||
    path.startsWith("/audit")
  ) {
    res.headers.set("X-Robots-Tag", "noindex, nofollow");
  }

  // Block AI crawlers on authenticated routes
  const ua = req.headers.get("user-agent") ?? "";
  const aiCrawlers = ["gptbot", "claudebot", "perplexitybot", "google-extended"];
  const isAICrawler = aiCrawlers.some((c) => ua.toLowerCase().includes(c));

  if (isAICrawler && (path.startsWith("/api/") || path.startsWith("/dashboard"))) {
    return new NextResponse(null, { status: 403 });
  }

  return res;
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - api (handled above)
     * - _next/static (static files)
     * - _next/image (image optimization)
     * - favicon.ico (favicon)
     */
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
