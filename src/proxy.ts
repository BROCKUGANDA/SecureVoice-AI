import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse, type NextRequest } from "next/server";
import { consume } from "@/lib/ratelimit";

/**
 * Edge layer — runs before every route resolves (Next.js 16 renamed this file
 * from `middleware.ts` to `proxy.ts`).
 *
 * RUNTIME NOTE — read before assuming anything about "the edge": in Next 16 the
 * Edge Runtime is DEPRECATED. `export const runtime = "edge"` is deprecated and
 * setting `runtime` inside a proxy file throws. This file therefore runs on the
 * Node runtime, inside the same process, before the route handler. It is a
 * pre-route layer, not a separate isolate, and it must not import anything that
 * needs native Node modules.
 *
 * What belongs here is anything that can reject or enrich a request for CHEAPER
 * than the route would:
 *
 *   1. Request identity — mint or forward `x-request-id` so one id ties the
 *      reverse proxy, this layer, and every log line for a request together.
 *   2. Client-IP trust — resolve the real client IP only from headers the reverse
 *      proxy sets, and only when Caddy identifies itself on the connection.
 *   3. Geo + language resolution — turn proxy-supplied facts into headers the app
 *      can read, without pulling in a geo library or requiring a CDN.
 *   4. Pre-auth rate limiting — runs before Clerk and before any body is parsed,
 *      so a scraper never reaches an expensive handler.
 *   5. Oversize-body reject — 413 with the real limit, instead of letting a huge
 *      body get buffered and then fail JSON parsing with a confusing 400.
 *
 * What does NOT belong here: authorization. Route handlers already guard
 * themselves (requireSignedIn / requireOperator), and a matcher change or a
 * Server Function move can silently drop proxy coverage — so this layer is never
 * the only thing standing between a caller and data.
 */

/** Header the reverse proxy sets to identify itself. Not a secret; see trust notes. */
const PROXY_MARKER = "x-securevoice-proxy";
/** Request-id header, also echoed by Caddy so proxy-side and app-side logs join. */
const REQUEST_ID = "x-request-id";

/**
 * Edge budget, per client IP per hour. Deliberately its own number, NOT
 * RATE_LIMIT_PER_HOUR: that one sizes expensive metered calls (TTS/ASR), and
 * applying it to every page request would lock a judge out of the demo after a
 * few dozen clicks. 600/h is loose enough for real navigation while still
 * stopping a scraper that hammers an unauthenticated endpoint.
 */
const EDGE_RATE_PER_HOUR = Number(process.env.EDGE_RATE_LIMIT_PER_HOUR) || 600;

/**
 * Paths exempt from the rate limiter — infrastructure probes and static assets,
 * which would otherwise consume a shared bucket.
 */
const RL_EXEMPT = [/^\/api\/health$/, /^\/api\/status$/, /^\/_next\//, /^\/favicon\.ico$/, /^\/robots\.txt$/];

/**
 * Hard ceiling on any request body. Set above experimental.proxyClientMaxBodySize
 * in next.config.ts is NOT possible (that one is a framework cap), so this is
 * kept in step with it — 40MB, above /api/asr's own 34MB limit.
 */
const MAX_BODY_BYTES = 40_000_000;

/**
 * Is this request known to have arrived through the reverse proxy?
 *
 * The marker header is trivially forgeable, so this is NOT authentication — it
 * only decides whether we believe the client-IP headers. The reasoning: on a
 * correctly deployed stack the origin listens only on the compose network and is
 * not reachable from the internet, so the only way in is through Caddy, which
 * always sets the marker. Anyone who reaches the origin directly could forge
 * both, and the real fix is at the network layer (do not publish the port) —
 * but we still fail towards "no trusted IP", so a forged header cannot buy extra
 * rate-limit budget.
 */
function cameThroughProxy(req: NextRequest): boolean {
  return req.headers.get(PROXY_MARKER) === "1";
}

/**
 * Resolve the client IP.
 *
 * X-Forwarded-For is a list whose left-most entry is the original client. We
 * take one entry, cap its length, and only when the request came through the
 * proxy. This value becomes a rate-limit key, and unbounded attacker-chosen keys
 * are a memory-exhaustion vector — hence the sanitise + length cap.
 */
function clientIp(req: NextRequest): string {
  if (!cameThroughProxy(req)) return "direct";
  const xff = req.headers.get("x-forwarded-for");
  const first = xff?.split(",")[0]?.trim();
  const candidate = first || req.headers.get("x-real-ip");
  if (!candidate) return "unknown";
  return candidate.replace(/[^\w.:]/g, "").slice(0, 64) || "unknown";
}

/** Best-effort language from Accept-Language, narrowed to the languages we speak. */
const SUPPORTED = ["en", "ar", "hi", "ur", "fr", "sw"] as const;

function resolveLanguage(req: NextRequest): string | null {
  const header = req.headers.get("accept-language");
  if (!header) return null;
  for (const part of header.split(",")) {
    const tag = part.split(";")[0]?.trim().toLowerCase();
    if (!tag) continue;
    const base = tag.split("-")[0];
    if (SUPPORTED.includes(base as (typeof SUPPORTED)[number])) return base;
  }
  return null;
}

/** Sanitise the proxy-supplied country code (ISO-3166-1 alpha-2). */
function resolveCountry(req: NextRequest): string | null {
  const raw = req.headers.get("x-securevoice-country");
  if (!raw) return null;
  const code = raw.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : null;
}

/** Uniform rejection shape, so clients never have to parse prose to handle an error. */
function reject(
  req: NextRequest,
  status: number,
  error: string,
  requestId: string,
  extra: Record<string, string> = {},
): NextResponse {
  // Log the path for correlation, but never echo it back to the caller.
  console.warn(`[edge] ${status} ${error} ${req.method} ${req.nextUrl.pathname} rid=${requestId}`);
  return NextResponse.json(
    { error },
    { status, headers: { "Cache-Control": "no-store", [REQUEST_ID]: requestId, ...extra } },
  );
}

export default clerkMiddleware((_auth, req) => {
  const requestId = req.headers.get(REQUEST_ID)?.slice(0, 64) || crypto.randomUUID();
  const pathname = req.nextUrl.pathname;

  // 1. Oversize body — reject before anything buffers it. Announced via
  //    content-length, so this costs nothing for clients that send it (all of
  //    them in practice). Chunked uploads without the header still rely on the
  //    proxyClientMaxBodySize cap in next.config.ts.
  const declaredLength = Number(req.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return reject(req, 413, "payload_too_large", requestId);
  }

  // 2. Pre-auth rate limit, before Clerk touches the session and before any
  //    handler runs. Keyed by resolved client IP so one noisy caller cannot
  //    exhaust a shared bucket.
  if (!RL_EXEMPT.some((re) => re.test(pathname))) {
    const rl = consume("edge", clientIp(req), 1, EDGE_RATE_PER_HOUR);
    if (!rl.ok) {
      return reject(req, 429, "rate_limited", requestId, {
        "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)),
        "X-RateLimit-Remaining": "0",
      });
    }
  }

  // 3. Enrich: hand the route a consistent set of request-scoped facts.
  const headers = new Headers(req.headers);
  headers.set(REQUEST_ID, requestId);
  headers.set("x-securevoice-client-ip", clientIp(req));
  const lang = resolveLanguage(req);
  if (lang) headers.set("x-securevoice-lang", lang);
  const country = resolveCountry(req);
  if (country) headers.set("x-securevoice-country", country);

  // NextResponse.next({ request: { headers } }) makes these visible UPSTREAM to
  // the route handler. Passing them as `headers` instead would expose them to the
  // client, which is why the distinction matters.
  const res = NextResponse.next({ request: { headers } });
  res.headers.set(REQUEST_ID, requestId);
  return res;
});

export const config = {
  matcher: [
    // Clerk's auto-proxy path must come after the API matcher
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest|mp3|wav)).*)",
    "/(api|trpc)(.*)",
    "/__clerk/:path*",
  ],
};
