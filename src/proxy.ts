import { NextResponse, type NextRequest } from "next/server";
import { consume } from "@/lib/ratelimit";

/**
 * Edge layer â€” runs before every route resolves (Next.js 16 renamed this file
 * from `middleware.ts` to `proxy.ts`).
 *
 * RUNTIME NOTE â€” read before assuming anything about "the edge": in Next 16 the
 * Edge Runtime is DEPRECATED. `export const runtime = "edge"` is deprecated and
 * setting `runtime` inside a proxy file throws. This file therefore runs on the
 * Node runtime, inside the same process, before the route handler. It is a
 * pre-route layer, not a separate isolate, and it must not import anything that
 * needs native Node modules.
 *
 * What belongs here is anything that can reject or enrich a request for CHEAPER
 * than the route would:
 *
 *   1. Request identity â€” mint or forward `x-request-id` so one id ties the
 *      reverse proxy, this layer, and every log line for a request together.
 *   2. Client-IP trust â€” resolve the real client IP only from headers the reverse
 *      proxy sets, and only when Caddy identifies itself on the connection.
 *   3. Geo + language resolution â€” turn proxy-supplied facts into headers the app
 *      can read, without pulling in a geo library or requiring a CDN.
 *   4. Pre-auth rate limiting - runs before any session lookup and before any body is parsed,
 *      so a scraper never reaches an expensive handler.
 *   5. Oversize-body reject â€” 413 with the real limit, instead of letting a huge
 *      body get buffered and then fail JSON parsing with a confusing 400.
 *
 * What does NOT belong here: authorization. Route handlers already guard
 * themselves (requireSignedIn / requireOperator), and a matcher change or a
 * Server Function move can silently drop proxy coverage â€” so this layer is never
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
 * Paths exempt from the rate limiter â€” infrastructure probes and static assets,
 * which would otherwise consume a shared bucket.
 */
const RL_EXEMPT = [/^\/api\/health$/, /^\/_next\//, /^\/favicon\.ico$/, /^\/robots\.txt$/];

/**
 * Hard ceiling on any request body. Set above experimental.proxyClientMaxBodySize
 * in next.config.ts is NOT possible (that one is a framework cap), so this is
 * kept in step with it â€” 40MB, above /api/asr's own 34MB limit.
 */
const MAX_BODY_BYTES = 40_000_000;

/**
 * Is this request known to have arrived through the reverse proxy?
 *
 * The marker header is trivially forgeable, so this is NOT authentication â€” it
 * only decides whether we believe the client-IP headers. The reasoning: on a
 * correctly deployed stack the origin listens only on the compose network and is
 * not reachable from the internet, so the only way in is through Caddy, which
 * always sets the marker. Anyone who reaches the origin directly could forge
 * both, and the real fix is at the network layer (do not publish the port) â€”
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
 * are a memory-exhaustion vector â€” hence the sanitise + length cap.
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
    // `split` always yields at least one element, so element 0 is the primary
    // subtag; `?? null` keeps the "not one of ours" case explicit instead of
    // asserting an index that can be missing.
    const base = tag.split("-")[0] ?? null;
    if (base && SUPPORTED.includes(base as (typeof SUPPORTED)[number])) return base;
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
  const res = NextResponse.json(
    { error },
    { status, headers: { "Cache-Control": "no-store", [REQUEST_ID]: requestId, ...extra } },
  );
  // A rejected request is still a served response, and an error body on an
  // operator route is exactly the sort of thing that must not be indexed.
  applySurfaceHeaders(res, req.nextUrl.pathname);
  return res;
}

/* â”€â”€ Public surface: indexing + Permissions-Policy (WP-24) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

/**
 * Which paths a crawler may index. An ALLOWLIST, not a denylist.
 *
 * The reason is structural, and it is the single most important thing to
 * understand about this app's public surface: there is no `/console` URL.
 * `src/app/page.tsx` renders EVERY view â€” marketing, docs, security, legal AND
 * the authenticated Command Center â€” from one client-side `view` state, with no
 * `usePathname`, no `router.push`, and no `history.pushState` anywhere in the
 * tree. So the console cannot be de-indexed by path: there is no path to
 * exclude. What protects it is (a) the session guard gating the data and (b) never handing
 * a crawler a URL that resolves to it.
 *
 * That leaves exactly two HTML routes in the tree â€” `/` and `/inspector` â€” and
 * `/inspector` is a signature-verification debug tool, so `/` is the only
 * indexable page.
 *
 * Allowlist rather than denylist because a denylist silently reopens the
 * surface every time someone adds a route: the new page ships indexable and
 * nobody notices for months. Here a new page is noindex by default and has to
 * be opted in, which fails towards the safe side.
 *
 * `/sitemap.xml` is listed because it is part of the public SEO surface and the
 * proxy matcher DOES run for it (unlike `/robots.txt` and `/site.webmanifest`,
 * whose extensions the matcher excludes). Leaving it noindexed was measured on
 * a running server, not assumed. `/robots.txt` is absent from this list on
 * purpose: the matcher skips it entirely, so no header is ever attached.
 *
 * Adding a real public page? Add it here AND to src/app/sitemap.ts. tests/
 * surface/surface.test.ts fails if the two disagree.
 */
export const INDEXABLE_PATHS: readonly string[] = ["/", "/sitemap.xml"];

/**
 * Where the microphone is permitted.
 *
 * READ THIS BEFORE "TIGHTENING" IT â€” this list looks longer than it should be,
 * and shortening it silently breaks the product.
 *
 * `navigator.mediaDevices.getUserMedia` is called in exactly two places:
 * `src/views/Demo.tsx` and `src/lib/voice-client.ts`. Both are reachable from
 * the `demo` VIEW, which `src/app/page.tsx` renders at path `/`. So in the
 * current single-page architecture the microphone consumer IS `/`, and denying
 * it there is denying it to the entire demo â€” the one thing this app exists to
 * show.
 *
 * The policy is still written as an allowlist rather than a blanket
 * `microphone=(self)` because that is the shape that survives the obvious next
 * refactor: when the demo is split out to its own `/widget` route, deleting
 * `"/"` from this array is the whole change, and until then `/api/*`, `/v1/*`
 * and every other path are provably denied. Everything not listed gets
 * `microphone=()`.
 */
export const MICROPHONE_ALLOWLIST: readonly string[] = ["/"];

/** Capabilities this product never uses. Denied on every path, no exceptions. */
const ALWAYS_DENIED = [
  "camera=()",
  "geolocation=()",
  "payment=()",
  "usb=()",
  "midi=()",
  "serial=()",
  "hid=()",
  "display-capture=()",
] as const;

function isIndexable(pathname: string): boolean {
  return INDEXABLE_PATHS.includes(pathname);
}

/**
 * `X-Robots-Tag` for a path, or `null` when the path is indexable and the
 * header should be absent entirely.
 *
 * `null` rather than `index, follow` for the indexable case: emitting an
 * affirmative robots header on the marketing site is noise, and if it ever
 * disagreed with src/app/sitemap.ts the disagreement would be invisible in a
 * diff. Absence is the unambiguous signal.
 *
 * `nofollow` is paired with `noindex` deliberately. These responses carry
 * operator dashboards, DB latency, heap size and the Command Center's audit
 * chain â€” following links out of them would let a crawler walk from a leaked
 * internal URL to the rest of the site.
 */
export function robotsTagFor(pathname: string): string | null {
  return isIndexable(pathname) ? null : "noindex, nofollow";
}

/**
 * `Permissions-Policy` for a path.
 *
 * This OVERLAPS with the blanket header in next.config.ts
 * (`camera=(), microphone=(self), geolocation=(), payment=()`). The overlap is
 * deliberate, and which header wins was MEASURED on a running dev server
 * rather than reasoned about:
 *
 *   GET /            -> Permissions-Policy: camera=(), geolocation=(), payment=(),
 *                       usb=(), midi=(), serial=(), hid=(), display-capture=(),
 *                       microphone=(self)          <- this function's value, ONCE
 *   GET /api/status  -> Permissions-Policy: ... microphone=()   <- this function's
 *
 * So the proxy's response header REPLACES the one from `headers()` â€” it does
 * not append and the two do not intersect. That makes this the authoritative
 * definition of the policy, which is why the per-path half lives here: the
 * config's global value is dead on every path this file matches. Empirically
 * the header is present once, not twice.
 *
 * next.config.ts is outside this work package's scope. Its `headers()` does
 * support per-`source` entries and is arguably the better home for a static
 * policy; see docs/SURFACE.md.
 */
export function permissionsPolicyFor(pathname: string): string {
  const mic = MICROPHONE_ALLOWLIST.includes(pathname) ? "microphone=(self)" : "microphone=()";
  return [...ALWAYS_DENIED, mic].join(", ");
}

/**
 * Apply the surface headers to a response.
 *
 * Split out from the middleware body so the early-return paths (413/429) get
 * the same treatment as the normal one â€” a rejection that skipped this would
 * leak a robots-invisible error page exactly when something has gone wrong.
 */
export function applySurfaceHeaders(res: NextResponse, pathname: string): NextResponse {
  const tag = robotsTagFor(pathname);
  if (tag) res.headers.set("X-Robots-Tag", tag);
  res.headers.set("Permissions-Policy", permissionsPolicyFor(pathname));
  return res;
}

/**
 * Edge middleware.
 *
 * Previously this was `clerkMiddleware(handler)`, which wrapped our
 * handler in Clerk's session machinery. It no longer is: Better Auth resolves the
 * session inside the route (src/app/api/auth/[...all]/route.ts) and in each
 * guard via `auth.api.getSession({ headers })`.
 *
 * That is not a downgrade in protection â€” it is the documented Better Auth pattern,
 * and it is stronger in one respect: an edge cookie-presence check is a routing
 * optimisation, not authorisation. Leaving Clerk in the middleware would also have
 * meant two identity systems live at once (hazard AU-7), which is how
 * privilege-escalation bugs happen.
 *
 * The handler below never used the auth argument, so unwrapping is behaviour-
 * preserving for every path except the `/__clerk/*` proxy, which no longer exists.
 *
 * Note for the reader who looks for Clerk here and does not find it: session
 * presence is NOT checked in this file, deliberately. Every page, route handler
 * and Server Action performs its own authoritative `getSession`.
 */
export default function proxy(req: NextRequest): NextResponse {
  const requestId = req.headers.get(REQUEST_ID)?.slice(0, 64) || crypto.randomUUID();
  const pathname = req.nextUrl.pathname;

  // 1. Oversize body â€” reject before anything buffers it. Announced via
  //    content-length, so this costs nothing for clients that send it (all of
  //    them in practice). Chunked uploads without the header still rely on the
  //    proxyClientMaxBodySize cap in next.config.ts.
  const declaredLength = Number(req.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return reject(req, 413, "payload_too_large", requestId);
  }

  // 2. Pre-auth rate limit, before any session lookup and before any body is
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
  // the route handler. Passing them as `headers` instead would expose them to
  // the client, which is why the distinction matters.
  const res = NextResponse.next({ request: { headers } });
  res.headers.set(REQUEST_ID, requestId);
  return applySurfaceHeaders(res, pathname);
}
export const config = {
  matcher: [
    // Static assets and Next internals are excluded; everything else gets the
    // request id, client ip, language, country and surface headers. The
    // `/__clerk/*` proxy matcher that used to sit here is gone with Clerk.
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest|mp3|wav)).*)",
    "/(api|trpc)(.*)",
  ],
};
