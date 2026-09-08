import { clerkMiddleware } from "@clerk/nextjs/server";

/**
 * Clerk auth middleware (Next.js 16 proxy convention — replaces middleware.ts).
 * The matcher excludes static assets; every route passes through so `auth()`
 * works in route handlers. Route protection itself lives in the handlers
 * (console/*) — this middleware only attaches the auth context.
 */
export default clerkMiddleware();

export const config = {
  matcher: [
    // Clerk's auto-proxy path must come after the API matcher
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest|mp3|wav)).*)",
    "/(api|trpc)(.*)",
    "/__clerk/:path*",
  ],
};
