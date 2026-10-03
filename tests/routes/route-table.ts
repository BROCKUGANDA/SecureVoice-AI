/**
 * The route table, derived from the FILESYSTEM.
 *
 * AA-1.2 of the Stage 2 spec asks for a "router-enumerated route sweep" whose
 * whole value is that it cannot go stale: a route added in a hurry joins the
 * sweep automatically, with no list to remember to update. That property is only
 * real if the enumeration is genuinely derived — so this module walks
 * `src/app/**\/route.ts` on disk and reads the exported handlers out of each
 * file's source.
 *
 * Two deliberate consequences:
 *
 *   1. It reads SOURCE TEXT, not a compiled router. Next's own route manifest is
 *      not a public, stable interface, and depending on it would make this gate
 *      break on an unrelated upgrade. Reading `export async function GET` is the
 *      actual contract the App Router honours, so testing it tests reality.
 *
 *   2. Next route groups — `(marketing)`, `(app)` — are URL INVISIBLE. The
 *      parentheses are stripped, because `/api/(internal)/x` is served at
 *      `/api/x` and a sweep that believed otherwise would probe a path that does
 *      not exist and pass vacuously.
 *
 * Dynamic segments (`[id]`) are recorded as-is and flagged, because a sweep
 * cannot meaningfully call them without a real id; the caller decides whether to
 * substitute one.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";

/** One discovered route: its URL, its methods, and where it came from. */
export type DiscoveredRoute = {
  /** Public URL path, e.g. `/api/v1/interventions`. Never has a trailing slash. */
  readonly path: string;
  /** HTTP methods the module actually exports. */
  readonly methods: readonly HttpMethod[];
  /** Repository-relative source file, e.g. `src/app/api/health/route.ts`. */
  readonly file: string;
  /** True when the path contains a `[param]` segment and cannot be probed as-is. */
  readonly dynamic: boolean;
};

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";

const EXPORT_TO_METHOD: Record<string, HttpMethod> = {
  GET: "GET",
  POST: "POST",
  PUT: "PUT",
  PATCH: "PATCH",
  DELETE: "DELETE",
  HEAD: "HEAD",
  OPTIONS: "OPTIONS",
};

/**
 * Two legal ways a route module exports a handler, and the gate must read both:
 *
 *   export async function GET(req) {}                       — the common form
 *   export const { GET, POST } = toNextJsHandler(auth)      — Better Auth's form
 *
 * The destructured form is not hypothetical: `src/app/api/auth/[...all]/route.ts`
 * uses it. A detector that misses it reports a real, fully working auth surface
 * as exporting no handlers at all — which is a gate that cries wolf and
 * therefore gets ignored.
 */
function exportsHandler(source: string, name: string): boolean {
  // Direct form. Anchored on `export` so a bare mention in a comment or a string
  // never counts.
  const direct = new RegExp(
    `export\\s+(?:async\\s+)?(?:function|const|let|var)\\s+${name}\\b`,
  ).test(source);
  if (direct) return true;
  // Destructured form, including renames and defaults:
  //   export const { GET, POST: PUT_POST, OPTIONS = fallback } = handler
  const destructured = /export\s+(?:const|let|var)\s*\{([^}]*)\}\s*=/s.exec(source);
  if (!destructured?.[1]) return false;
  return destructured[1]
    .split(",")
    .map((part) => part.split(":")[0]?.split("=")[0]?.trim())
    .filter((part): part is string => Boolean(part))
    .includes(name);
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (entry === "route.ts" || entry === "route.tsx") acc.push(full);
  }
  return acc;
}

/**
 * Strip route-group parentheses: `(marketing)` and `(app)` organise files on
 * disk without appearing in the URL. Leaving them in produces `/api/(app)/x`,
 * which 404s — and a sweep that probed a 404 for its "unauthenticated" check
 * would record a false pass.
 */
function toUrlPath(appDir: string, file: string): string {
  const rel = file.slice(appDir.length).replace(/[\\/]route\.tsx?$/, "");
  const segments = rel
    .split(sep)
    .filter((s) => s.length > 0)
    .filter((s) => !(s.startsWith("(") && s.endsWith(")")));
  return `/${segments.join("/")}`.replace(/\/+$/, "") || "/";
}

/** Every `route.ts` under `src/app`, as discovered methods. */
export function discoverRoutes(appDir: string): DiscoveredRoute[] {
  const out: DiscoveredRoute[] = [];
  for (const file of walk(appDir).sort()) {
    const source = readFileSync(file, "utf8");
    const methods: HttpMethod[] = [];
    for (const [name, method] of Object.entries(EXPORT_TO_METHOD)) {
      if (exportsHandler(source, name)) methods.push(method);
    }
    const path = toUrlPath(appDir, file);
    // A `GET`-exporting route also answers HEAD without declaring it.
    if (methods.includes("GET") && !methods.includes("HEAD")) methods.push("HEAD");
    out.push({
      path,
      methods: methods.sort(),
      file: file
        .split(sep)
        .join("/")
        .replace(/^.*?(?=src\/)/, ""),
      dynamic: /\[[^\]]+\]/.test(path),
    });
  }
  return out;
}

/**
 * Routes that are PUBLIC BY DESIGN and must therefore NOT be expected to reject
 * an unauthenticated caller.
 *
 * Every entry is a deliberate, reasoned exemption with the reason inline —
 * because the failure mode of this file is a silent scope creep that adds a
 * genuinely open route to the list and the sweep stops noticing it. A new public
 * route must be added here EXPLICITLY, which is the point: it becomes a reviewed
 * decision rather than an omission.
 *
 * Each reason names the credential that actually guards the route, so a reader
 * can check that claim rather than trust it.
 */
const PUBLIC_BY_DESIGN: Readonly<Record<string, string>> = {
  "/api/health":
    "liveness probe for the container runtime; exposes no data and takes no parameters",
  "/api/readyz": "readiness probe for the load balancer; reports dependency health only",
  "/api/meta": "static deployment metadata for the console; no tenant data",
  "/api/tts/stream":
    "TTS stream guarded by its own provider-credential path, not an operator session",
  "/api/twilio/audio":
    "Twilio media webhook authenticated by Twilio's own signature scheme (tests/webhooks)",
  "/api/twilio/turn":
    "Twilio turn credential fetch authenticated by Twilio's signature, not a session",
  "/api/webhooks/receiver":
    "our own REFERENCE receiver published for integrators; holds no tenant data",
  "/api/webhooks/elevenlabs": "inbound ElevenLabs webhook authenticated by the vendor signature",
  "/api/pilot":
    "public pilot intake form, deliberately unauthenticated so an institution can enquire before any contract exists",
  "/api/webhooks":
    "signing DEMO for integrators; mints a signature over a caller-supplied event name, holds no tenant data and arms nothing",
  "/api/elevenlabs/signed-url":
    "agent tool endpoint guarded by the x-agent-tool-secret via authorizeToolCall('signed_url'), not an operator session",
  "/api/elevenlabs/tools/card-freeze":
    "agent tool endpoint guarded by the x-agent-tool-secret via guardToolCall, not an operator session",
  "/api/elevenlabs/tools/human-handoff":
    "agent tool endpoint guarded by the x-agent-tool-secret via guardToolCall, not an operator session",
  "/api/elevenlabs/tools/switch-language":
    "agent tool endpoint guarded by the x-agent-tool-secret via authorizeToolCall, not an operator session",
  "/api/elevenlabs/tools/verify-transaction":
    "agent tool endpoint guarded by the x-agent-tool-secret via guardToolCall, not an operator session",
  "/openapi": "published contract document (WP-17); schema only, no tenant data",
  "/asyncapi": "published contract document (WP-17); schema only, no tenant data",
  "/v1/conformance/run":
    "self-serve bank conformance checker guarded by an org-scoped PRODUCER KEY, not an operator session (src/app/v1/conformance/run/route.ts)",
};

export function isPublicByDesign(path: string): boolean {
  return Object.prototype.hasOwnProperty.call(PUBLIC_BY_DESIGN, path);
}

export function publicRoutes(): Readonly<Record<string, string>> {
  return PUBLIC_BY_DESIGN;
}
