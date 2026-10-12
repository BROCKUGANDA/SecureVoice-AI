import "server-only";

/**
 * The CSRF origin allowlist, built once at boot.
 *
 * Better Auth rejects a sign-in whose `Origin` header is not in `trustedOrigins`,
 * and the browser-facing text for that rejection is the two-word sentence this
 * file exists to make impossible: `Invalid origin`. A deployment that serves
 * `https://securevoiceai.me` while `BETTER_AUTH_URL` still says
 * `http://localhost:3000` — which is the value `docker-compose.yml` and the
 * `Dockerfile` both default to — fails every login on the public host while
 * working perfectly on a laptop. Nothing in the build notices. The judge notices.
 *
 * So the allowlist is derived here, from explicit configuration, and a
 * production boot refuses to come up with a loopback base URL rather than
 * serving a page whose buttons do nothing.
 *
 * ## What is NOT allowed
 *
 *   · `*` or any wildcard. Better Auth accepts one; a CSRF allowlist that matches
 *     everything is not an allowlist. Every page that ever embeds a form could
 *     drive credential requests against this deployment.
 *   · A path. Origins are `scheme://host[:port]`. `https://example.com/app` would
 *     never match the `Origin: https://example.com` a browser actually sends, so
 *     accepting it would just hide a typo.
 *   · Reflection of the request's own `Host`. That is the DNS-rebinding hole: the
 *     attacker's name resolves to this server, the victim's browser sends
 *     `Host: attacker.example`, and a server that trusts what it is asked to trust
 *     has just authorised the origin it was defending against.
 */

/** Loopback and `.local` hosts — fine in dev, wrong in production. */
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|.*\.local)$/i;

export type ParsedOrigin = {
  /** Lower-cased scheme, always `http` or `https`. */
  scheme: "http" | "https";
  /** Lower-cased hostname, no port. */
  host: string;
  /** `:port` when the URL carried one explicitly, otherwise "". */
  port: string;
};

/**
 * Parse one origin, or return null when it is not one.
 *
 * Deliberately strict and deliberately quiet: the caller decides whether a bad
 * entry is a warning or a boot failure, because a stray comma in an env list is a
 * warning while a base URL that is not an origin at all is not.
 */
export function parseOrigin(raw: string): ParsedOrigin | null {
  const value = raw.trim();
  // A `?` or `#` is checked on the STRING, not the parsed URL: `new URL` normalises
  // a bare "https://host?" into an origin with an empty query, so the parser alone
  // cannot tell a pasted browser URL from a real origin. A config value with a
  // query in it is a typo, and a typo in a CSRF allowlist deserves a refusal.
  if (
    value === "" ||
    /\s/.test(value) ||
    value.includes("*") ||
    value.includes("?") ||
    value.includes("#")
  ) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  // An origin has no path, query, fragment, or credentials. `new URL("https://a.b")`
  // gives pathname "/", so compare against that rather than "empty".
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") return null;
  if (url.username !== "" || url.password !== "") return null;
  if (url.hostname === "") return null;
  return {
    scheme: url.protocol === "https:" ? "https" : "http",
    host: url.hostname.toLowerCase(),
    port: url.port ? `:${url.port}` : "",
  };
}

/** Canonical `scheme://host[:port]` for a parsed origin. */
export function formatOrigin(o: ParsedOrigin): string {
  return `${o.scheme}://${o.host}${o.port}`;
}

/**
 * The apex/www sibling of an origin, or null when there is not one.
 *
 * A marketing site is usually reachable as both `example.com` and
 * `www.example.com`, and a browser sends whichever it landed on. Forcing an
 * operator to configure both — and then failing in the middle of a demo when they
 * configured one — is a self-inflicted version of the bug this module exists to
 * prevent. Same scheme, same port: this is a hostname alias, not a widening.
 */
export function siblingOrigin(raw: string): string | null {
  const o = parseOrigin(raw);
  if (!o) return null;
  const siblingHost = o.host.startsWith("www.")
    ? o.host.slice(4)
    : o.host.includes(".")
      ? `www.${o.host}`
      : null;
  if (!siblingHost) return null;
  return formatOrigin({ ...o, host: siblingHost });
}

/**
 * Split an env-style list on commas, semicolons, or whitespace.
 *
 * `BETTER_AUTH_TRUSTED_ORIGINS` is read from a shell, a compose file, a Docker
 * secret, and a VPS `.env` — four places, four quoting habits. Accepting any of
 * the three separators costs nothing and removes a class of "it worked in my
 * shell" failure.
 */
export function splitOriginList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

/** Is `origin` (a raw `Origin` header value) in the allowlist? */
export function isTrustedOrigin(origin: string | null | undefined, allowlist: string[]): boolean {
  if (!origin) return false;
  const parsed = parseOrigin(origin);
  if (!parsed) return false;
  const needle = formatOrigin(parsed);
  return allowlist.some((entry) => {
    const e = parseOrigin(entry);
    return e !== null && formatOrigin(e) === needle;
  });
}

export type OriginConfig = {
  /** The canonical base URL Better Auth is configured with. */
  baseURL: string;
  /** The full allowlist, including the base URL and any www/apex siblings. */
  origins: string[];
  /** Entries that were present but unusable — the caller logs these. */
  rejected: string[];
};

/**
 * Build the allowlist, or refuse to boot.
 *
 * `production` is a parameter rather than a read of `process.env.NODE_ENV` so the
 * rule — and the message that tells an operator what to type — is testable without
 * mutating the environment of a shared process.
 */
export function buildTrustedOrigins(input: {
  baseURL: string | undefined;
  extra: string | undefined;
  production: boolean;
}): OriginConfig {
  const base = parseOrigin(input.baseURL ?? "");
  if (base === null) {
    throw new Error(
      `BETTER_AUTH_URL must be an origin like https://securevoiceai.me — got ${JSON.stringify(
        input.baseURL ?? "",
      )}. A path, a wildcard, or a missing scheme is rejected because it can never match the Origin header a browser sends.`,
    );
  }
  const baseOrigin = formatOrigin(base);

  if (input.production && LOCAL_HOST.test(base.host)) {
    throw new Error(
      `BETTER_AUTH_URL is ${baseOrigin}, which is a loopback host, and this process is running with NODE_ENV=production. Every sign-in from the public address would be answered "Invalid origin": Better Auth compares the browser's Origin against this value. Set BETTER_AUTH_URL to the public origin (e.g. https://securevoiceai.me) — or, for a deliberate local production run, set NODE_ENV=development.`,
    );
  }

  const accepted = new Set<string>([baseOrigin]);
  const apexSibling = siblingOrigin(baseOrigin);
  if (apexSibling) accepted.add(apexSibling);

  const rejected: string[] = [];
  for (const entry of splitOriginList(input.extra)) {
    const parsed = parseOrigin(entry);
    if (parsed === null) {
      rejected.push(entry);
      continue;
    }
    accepted.add(formatOrigin(parsed));
    const sibling = siblingOrigin(formatOrigin(parsed));
    if (sibling) accepted.add(sibling);
  }

  return { baseURL: baseOrigin, origins: [...accepted].sort(), rejected };
}

let cached: OriginConfig | null = null;

/**
 * The allowlist this process was configured with, read from the environment once.
 *
 * Both halves of the system take it from here — `src/lib/better-auth.ts` hands the
 * list to Better Auth, and the auth route compares an incoming `Origin` against it
 * to log a refusal. One derivation, so the diagnostic cannot disagree with the
 * enforcement it is describing.
 *
 * Memoised on purpose: these are boot-time values, and re-reading them per request
 * would let a mid-process `process.env` edit make the log claim a host is trusted
 * while Better Auth, configured at import, does not. A test that needs a different
 * configuration imports `buildTrustedOrigins` and passes its inputs explicitly.
 */
export function trustedOriginsFromEnv(): OriginConfig {
  cached ??= buildTrustedOrigins({
    baseURL: process.env.BETTER_AUTH_URL ?? process.env.APP_URL,
    extra: process.env.BETTER_AUTH_TRUSTED_ORIGINS,
    production: process.env.NODE_ENV === "production",
  });
  return cached;
}
