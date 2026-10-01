/**
 * Constants shared by the server, the browser client and the tests.
 *
 * This module must stay free of side effects: the test suite imports
 * SOCKET_PATH to build its client, and importing `server.ts` for a constant
 * would bind a second listener during the test run.
 */

/**
 * socket.io mount path.
 *
 * NOT "/" on purpose. engine.io's request matcher is
 * `path === req.url.slice(0, path.length)`, so a path of "/" matches every URL
 * on the port — the socket layer would answer /healthz with "Transport unknown"
 * and swallow /ingest along with it. A real subpath keeps the HTTP surface
 * (health, ingest) and the socket surface disjoint.
 *
 * Three places must agree on this value: the server, the browser client
 * (src/lib/realtime.ts), and the reverse-proxy route (Caddyfile).
 */
export const SOCKET_PATH = "/realtime";

/** Port the compose service listens on. Not published to the host — Caddy fronts it. */
export const DEFAULT_PORT = 4000;

/** Max ingest body, matching parseIngest()'s own cap on the decoded payload. */
export const MAX_INGEST_BYTES = 64 * 1024;
