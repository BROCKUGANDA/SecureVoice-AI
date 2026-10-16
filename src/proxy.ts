import { NextResponse, type NextRequest } from "next/server";
import { consume } from "@/lib/ratelimit";
import { IP_UNKNOWN, IP_UNTRUSTED, isRealIp, normalizeIp } from "@/lib/ip-normalize";
import { SUPPORTED_LANGS } from "@/lib/languages";
import { logWarn } from "@/lib/validation/safe-log";

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
 *   4. Pre-auth rate limiting - runs before any session lookup and before any body is parsed,
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
 * Paths exempt from the rate limiter entirely — static assets and framework
 * internals, which are not decisions about callers at all.
 */
const STATIC_EXEMPT = [/^\/_next\//, /^\/favicon\.ico$/, /^\/robots\.txt$/];

/**
 * The paths the INFRASTRUCTURE probes, and the budget it gets.
 *
 * These are not user traffic. Caddy active-checks `health_uri /api/readyz` every
 * 10s, once per reverse_proxy block (the `/v1/*` handler and the main handler), and
 * only `health_status 2xx` counts as healthy. The probes arrive without a proxy
 * marker, so `clientIp()` keys every one of them as the same caller — and two 10s
 * handlers is 720 requests an hour against a 600/hour page budget. The load balancer
 * was therefore always going to be throttled by the thing it probes; production logs
 * show the resulting stream of `429 rate_limited` on `/api/readyz`.
 *
 * A 429 there is not noise: Caddy may pull a healthy origin out of rotation for it,
 * and ADR-008's graceful drain signals "leaving rotation" with a 503 from this same
 * path, so a second meaning on the probe breaks a deployment mechanism.
 *
 * Probes are NOT exempt, though. `/api/readyz` reads the database, and an
 * unthrottled DB-backed endpoint is a cheap way to buy load. They get their own
 * bucket instead: a ceiling no legitimate probe schedule approaches (720/h here,
 * 6000/h there) and still far below what hammering looks like.
 *
 * Exported because tests/surface/probe-budget.test.ts reads the Caddyfile's
 * `health_uri` list and fails if it ever points at a path this list would throttle.
 */
export const PROBE_PATHS = [/^\/api\/health$/, /^\/api\/readyz$/];

const PROBE_RATE_PER_HOUR = Number(process.env.PROBE_RATE_LIMIT_PER_HOUR) || 6000;

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
 *
 * When the request arrives through Cloudflare's proxy (the orange-cloud
 * hostname), the left-most XFF entry is Cloudflare's edge — Caddy overwrites the
 * chain with the immediate peer — so the real client is in CF-Connecting-IP,
 * which Cloudflare sets and Caddy forwards untouched. It wins over XFF; on the
 * direct (unproxied) hostname the header is absent and the chain is used as
 * before.
 *
 * `normalizeIp` is imported from the SHARED `src/lib/ip-normalize.ts` rather than
 * re-implemented. The server-side resolver in `src/lib/client-ip.ts` re-derives this
 * same value whenever the header it injects did not survive, and if the two spelled
 * an address differently the injected value and the re-derived one would be two
 * identities for one person — which is the exact defect that module was written to
 * remove. This is why `ip-normalize.ts` carries no `server-only` marker and no
 * `node:` imports: it has to be valid on the edge AND in Node.
 *
 * NOTE: the edge runtime cannot import `next/headers`, so the trust marker is read
 * straight off the request. That is the same value, from the same place.
 */
function clientIp(req: NextRequest): string {
  if (!cameThroughProxy(req)) return IP_UNTRUSTED;
  const cf = normalizeIp(req.headers.get("cf-connecting-ip"));
  if (isRealIp(cf)) return cf;
  const first = normalizeIp(req.headers.get("x-forwarded-for")?.split(",")[0]);
  if (isRealIp(first)) return first;
  const real = normalizeIp(req.headers.get("x-real-ip"));
  if (isRealIp(real)) return real;
  return IP_UNKNOWN;
}

/** Best-effort language from Accept-Language, narrowed to the languages we speak. */
const SUPPORTED = [...SUPPORTED_LANGS];

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
  logWarn("[edge] request rejected", {
    status,
    error,
    method: req.method,
    path: req.nextUrl.pathname,
    rid: requestId,
  });
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
 * `src/app/page.tsx` renders EVERY view — marketing, docs, security, legal AND
 * the authenticated Command Center — from one client-side `view` state, with no
 * `usePathname`, no `router.push`, and no `history.pushState` anywhere in the
 * tree. So the console cannot be de-indexed by path: there is no path to
 * exclude. What protects it is (a) the session guard gating the data and (b) never handing
 * a crawler a URL that resolves to it.
 *
 * The allowlist is therefore short, and every entry is a real HTTP route:
 *
 *   `/`             the single-page app (marketing + docs + legal panels)
 *   `/sitemap.xml`  the SEO surface; measured as matched by this proxy
 *   `/pricing`      real route — the commercial page
 *   `/terms`        real route — required to be publicly addressable
 *   `/privacy`      real route — required to be publicly addressable
 *   `/refund`       real route — required to be publicly addressable
 *   `/docs`         real route — the integration surface a bank has to read
 *   `/security`     real route — what a procurement review asks for by name
 *   `/usecases`     real route — the "does this fit us" page
 *
 * Every one of these is a `public` view in VIEW_ACCESS. The authenticated views
 * (`console`, `dashboard`, `demo`, `product`, `settings`, `deck`, `setup`) are
 * deliberately ABSENT and must stay absent: there is no URL for them to exclude,
 * which is the second of the two layers protecting the Command Center. Giving
 * `/console` a route would delete that layer, and a future route or Server
 * Action move that slipped past a guard would become publicly reachable rather
 * than merely reachable-by-session.
 *
 * `/inspector` is the only other HTML route and stays off the list: it is a
 * signature-verification debug tool, i.e. operator material.
 *
 * Allowlist rather than denylist because a denylist silently reopens the
 * surface every time someone adds a route: the new page ships indexable and
 * nobody notices for months. Here a new page is noindex by default and has to
 * be opted in, which fails towards the safe side.
 *
 * Adding a real public page? Add it here AND to src/app/sitemap.ts. tests/
 * surface/surface.test.ts fails if the two disagree, and if the route file does
 * not exist.
 */
export const INDEXABLE_PATHS: readonly string[] = [
  "/",
  "/sitemap.xml",
  // Machine-readable text for an answer engine. Listed here for the same reason as
  // `/sitemap.xml`: it is not a page, and the route declares its own robots intent
  // (`noindex, follow`) because the file's entire purpose is to be followed to the
  // pages it links. A blanket `nofollow` from this middleware would cancel that.
  "/llms.txt",
  "/pricing",
  "/terms",
  "/privacy",
  "/refund",
  "/docs",
  "/security",
  "/usecases",
  "/faq",
];

/**
 * Where the microphone is permitted.
 *
 * READ THIS BEFORE "TIGHTENING" IT — this list looks longer than it should be,
 * and shortening it silently breaks the product.
 *
 * `navigator.mediaDevices.getUserMedia` is called in exactly two places:
 * `src/components/demo/LiveVoicePanel.tsx` (the mic button itself) and
 * `src/lib/voice-client.ts` (the barge-in monitor that runs while the agent is
 * speaking). Both are rendered from the `home` VIEW, which `src/app/page.tsx`
 * serves at path `/` — so in the current single-page architecture the microphone
 * consumer IS `/`, and denying it there is denying it to the landing demo and to
 * the live browser-mic widget, which are the two things this app exists to show.
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
 * chain — following links out of them would let a crawler walk from a leaked
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
 * So the proxy's response header REPLACES the one from `headers()` — it does
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
 * the same treatment as the normal one — a rejection that skipped this would
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
 * That is not a downgrade in protection — it is the documented Better Auth pattern,
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
export default async function proxy(req: NextRequest): Promise<NextResponse> {
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

  // 2. Pre-auth rate limit, before any session lookup and before any body is
  //    handler runs. Keyed by resolved client IP so one noisy caller cannot
  //    exhaust a shared bucket — with one deliberate exception: infrastructure
  //    probes get their own scope, because a load balancer that is throttled by
  //    the origin it is checking turns a healthy deployment into an outage.
  if (!STATIC_EXEMPT.some((re) => re.test(pathname))) {
    const probe = PROBE_PATHS.some((re) => re.test(pathname));
    const rl = await consume(
      probe ? "probe" : "edge",
      clientIp(req),
      1,
      probe ? PROBE_RATE_PER_HOUR : EDGE_RATE_PER_HOUR,
    );
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
