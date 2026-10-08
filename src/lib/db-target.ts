/**
 * Which database is this process actually talking to?
 *
 * The deployment intent is: PRODUCTION AND THE PUBLIC DEMO RUN ON THE POSTGRES
 * THAT LIVES ON THE VPS (the `db` service in docker-compose.yml), isolated from
 * each other by tenant (the demo is an organization, not a second database).
 * That intent is easy to violate silently: `DATABASE_URL` is one string in a
 * `.env` file, a developer's Supabase URL pasted there during setup keeps
 * working perfectly, and nothing anywhere says "production is not where you
 * think it is". This module makes the answer observable and, if the operator
 * asks for it, enforceable.
 *
 * Pure: no I/O, no server imports, and it never returns or logs the credentials
 * or the host name - only a coarse CLASS, which is all a health endpoint or a
 * boot log needs and which reveals nothing about the infrastructure layout.
 */

export type DatabaseKind =
  /** The compose `db` / `postgres` service: the VPS's own container. */
  | "vps-container"
  /** localhost / 127.0.0.1 / ::1 - a developer machine, or Postgres on the same host. */
  | "loopback"
  /** RFC1918 / .internal / .local: a Postgres on a private network the operator controls. */
  | "private-network"
  /** A managed service the operator does not run. */
  | "managed-supabase"
  | "managed-neon"
  | "managed-rds"
  /** A public hostname or address that is not a recognised managed service. */
  | "external"
  | "unset";

const SELF_HOSTED: ReadonlySet<DatabaseKind> = new Set([
  "vps-container",
  "loopback",
  "private-network",
]);

/** True for a database the operator runs themselves (the VPS intent). */
export function isSelfHosted(kind: DatabaseKind): boolean {
  return SELF_HOSTED.has(kind);
}

/**
 * The host of a Postgres URL.
 *
 * `new URL()` is NOT used, and that is deliberate: operators paste passwords with
 * unescaped `@`, `/` and `#`, and the WHATWG parser then reads the wrong host
 * (`u:p@ss/w#rd@db.x.supabase.co` parses as host `ss`), which would classify a
 * Supabase URL as something else. A hostname can never contain `@`, so the real
 * host starts after the LAST `@` whose remainder looks like `host[:port][/?#...]`.
 * IPv6 literals come back without their brackets.
 */
function hostOf(url: string): string {
  const rest = url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  const shape = /^(\[[0-9a-f:.]+\]|[a-z0-9._-]+)(:\d+)?(?=[/?#]|$)/i;

  // `lastIndexOf(x, -1)` clamps to 0 and would return index 0 again forever for a
  // string that starts with "@", so the step must stop explicitly at 0.
  for (
    let at = rest.lastIndexOf("@");
    at >= 0;
    at = at === 0 ? -1 : rest.lastIndexOf("@", at - 1)
  ) {
    const m = shape.exec(rest.slice(at + 1));
    if (m) return m[1]!.replace(/^\[|\]$/g, "").toLowerCase();
  }
  // No credentials in the URL at all: the authority starts the string.
  const m = shape.exec(rest);
  return m ? m[1]!.replace(/^\[|\]$/g, "").toLowerCase() : "";
}

function isPrivateIPv4(h: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** Classify a `DATABASE_URL`. Never throws. */
export function classifyDatabaseUrl(url: string | undefined | null): DatabaseKind {
  if (!url || !url.trim()) return "unset";
  const host = hostOf(url.trim());
  if (!host) return "external";

  if (host === "db" || host === "postgres" || host === "securevoice-db") return "vps-container";
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "0.0.0.0") {
    return "loopback";
  }
  if (isPrivateIPv4(host) || /\.(internal|local|lan|svc|cluster\.local)$/.test(host)) {
    return "private-network";
  }
  if (host.endsWith(".supabase.co") || host.endsWith(".supabase.com")) return "managed-supabase";
  if (host.endsWith(".neon.tech")) return "managed-neon";
  if (host.endsWith(".rds.amazonaws.com")) return "managed-rds";
  return "external";
}

/**
 * Enforce the deployment intent, but ONLY when the operator opts in with
 * REQUIRE_VPS_DATABASE=true. It is opt-in on purpose: flipping it on by default
 * would take down any deployment that is (knowingly) on a managed database the
 * next time it restarts. The operator flips it when they have moved the data.
 *
 * Throws with an actionable message instead of booting against the wrong database.
 */
export function assertDatabaseTarget(
  url: string | undefined | null,
  env: Record<string, string | undefined> = process.env,
): void {
  if (env.REQUIRE_VPS_DATABASE !== "true") return;
  if (env.NODE_ENV !== "production") return; // a laptop may use anything
  const kind = classifyDatabaseUrl(url);
  if (isSelfHosted(kind)) return;
  throw new Error(
    `REQUIRE_VPS_DATABASE=true but DATABASE_URL points at a ${kind} database. ` +
      "Production and the demo are meant to run on the Postgres on the VPS (the compose `db` " +
      "service). Move the data (see docs/DEPLOY.md, 'Moving the database onto the VPS') and " +
      "unset DATABASE_URL so compose uses the bundled one, or unset REQUIRE_VPS_DATABASE to " +
      "acknowledge the managed database deliberately.",
  );
}
