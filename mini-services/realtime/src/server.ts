/**
 * SecureVoice realtime service — low-latency case fan-out.
 *
 * Why this exists: the Command Center's live feed polls the audit table every 2s
 * (src/app/api/console/events). That is fine on a laptop and wrong for the thing
 * this platform actually is — an SLA-bound intervention console where a phase
 * transition has to reach the analyst's screen in well under the 60-second
 * response window, ideally immediately. This service is the push path: the app
 * appends to the audit chain and then broadcasts, and every operator watching
 * that case sees the transition on the same tick.
 *
 * It deliberately holds NO database client. Reading the audit chain stays in the
 * app (one writer, one source of truth); this process only moves already-
 * redacted events to already-authorised sockets. That keeps it stateless enough
 * to scale horizontally and impossible to use as a second, divergent audit log.
 *
 * Transport note: the socket.io path is `/realtime`, NOT `/`.
 *
 * engine.io's request matcher is `path === req.url.slice(0, path.length)`, so a
 * path of "/" matches EVERY url on the port — the socket layer would answer
 * /healthz with "Transport unknown" and swallow the ingest endpoint with it.
 * That only works when socket.io owns a port outright, which it cannot here
 * because this process also serves health checks and /ingest. A real subpath
 * keeps the two surfaces disjoint.
 *
 * The reverse proxy therefore routes on the `XTransformPort` query parameter and
 * preserves this path (see Caddyfile); the browser client must be told the same
 * value. Changing it breaks the WebSocket upgrade silently rather than loudly.
 *
 * Endpoints:
 *   GET  /healthz   liveness — no dependencies, safe for a healthcheck
 *   GET  /readyz    readiness — checks that a signing secret is configured
 *   POST /ingest    HMAC-signed fan-out from the app (see ingest.ts)
 *   GET  /realtime  socket.io endpoint
 */

import { createServer } from "node:http";
import { Server } from "socket.io";
import { PresenceRegistry, caseChannel, orgChannel, safeSegment } from "./channels.ts";
import { DEFAULT_PORT, MAX_INGEST_BYTES, SOCKET_PATH } from "./constants.ts";
import { parseIngest, verifySignature } from "./ingest.ts";
import { verify, type VerifiedGrant } from "./auth.ts";

const PORT = Number(process.env.PORT ?? DEFAULT_PORT);
const HOST = process.env.HOST ?? "0.0.0.0";
// Dedicated realtime secret — no AGENT_TOOL_SECRET fallback (that secret
// crosses the wire on ElevenLabs tool calls; a leak there must not mint
// console grants or forge live broadcasts).
const INGEST_SECRET = process.env.REALTIME_INGEST_SECRET ?? "";
const ALLOWED_ORIGIN = process.env.REALTIME_ALLOWED_ORIGIN ?? "";
const BODY_LIMIT = MAX_INGEST_BYTES;

const presence = new PresenceRegistry();

function corsOrigin(): string | string[] | boolean {
  if (!ALLOWED_ORIGIN) return true; // no origin configured → dev; log loudly below
  const list = ALLOWED_ORIGIN.split(",").map((o) => o.trim()).filter(Boolean);
  return list.length === 1 ? list[0]! : list;
}

const io = new Server(createServer(), {
  path: SOCKET_PATH,
  serveClient: false,
  // The proxy terminates TLS, so the browser talks https/wss to Caddy and this
  // process only ever sees plaintext hop-by-hop.
  transports: ["websocket", "polling"],
  pingInterval: 25_000,
  pingTimeout: 60_000,
  maxHttpBufferSize: 1e6,
  cors: { origin: corsOrigin(), methods: ["GET", "POST"] },
});

// ── Socket auth + channel membership ────────────────────────────────────────

io.use((socket, next) => {
  const raw = socket.handshake.auth?.token;
  const token = typeof raw === "string" ? raw : undefined;
  const grant = verify(token, INGEST_SECRET);
  if (!grant.ok) {
    // One indistinguishable failure: a client learns nothing about which half of
    // the check failed, matching the agent-tool policy in src/lib/.
    next(new Error("unauthorized"));
    return;
  }
  socket.data.grant = grant;
  next();
});

function grantOf(socket: { data: Record<string, unknown> }): VerifiedGrant {
  return socket.data.grant as VerifiedGrant;
}

io.on("connection", (socket) => {
  const grant = grantOf(socket);
  if (!grant.ok) {
    socket.disconnect(true);
    return;
  }
  socket.data.sub = grant.sub;
  socket.data.orgId = grant.orgId;
  // A socket is a member of exactly the channels its grant named. Nothing the
  // client sends can widen this — the join handler only accepts a match.
  socket.data.channels = new Set(grant.chans);

  const announce = (channel: string) => {
    io.to(channel).emit("presence", {
      channel,
      watchers: presence.watchers(channel),
    });
  };

  socket.on("join", (payload: unknown, ack?: (res: unknown) => void) => {
    const requested = typeof payload === "string" ? payload : "";
    const [kind, orgPart, callRef] = requested.split(":");
    const orgId = safeSegment(orgPart ?? "", 64);
    const ref = safeSegment(callRef ?? "", 64);
    const expected = kind === "case" && ref ? caseChannel(orgId, ref) : kind === "org" ? orgChannel(orgId) : "";

    if (!expected || !socket.data.channels.has(expected)) {
      ack?.({ ok: false, error: "not_in_scope" });
      return;
    }
    void socket.join(expected);
    presence.add(expected, { sub: grant.sub, socketId: socket.id, joinedAt: Date.now() });
    ack?.({ ok: true, channel: expected, watchers: presence.watchers(expected) });
    announce(expected);
  });

  socket.on("leave", (payload: unknown) => {
    const requested = typeof payload === "string" ? payload : "";
    if (!socket.data.channels.has(requested)) return;
    void socket.leave(requested);
    presence.remove(requested, socket.id);
    announce(requested);
  });

  socket.on("disconnect", () => {
    for (const channel of socket.data.channels as Set<string>) {
      presence.remove(channel, socket.id);
      announce(channel);
    }
  });
});

// ── HTTP surface: health + ingest ────────────────────────────────────────────

const httpServer = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const send = (status: number, body: unknown) => {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "content-length": Buffer.byteLength(text),
    });
    res.end(text);
  };

  if (req.method === "GET" && url.pathname === "/healthz") {
    send(200, { ok: true, uptimeSec: Math.round(process.uptime()), ...presence.stats() });
    return;
  }
  if (req.method === "GET" && url.pathname === "/readyz") {
    // Ready means "a writer could actually authenticate to me". Without a
    // secret this process accepts no ingests and mints no valid grants, so
    // reporting ready would only produce silent no-ops in production.
    if (!INGEST_SECRET) {
      send(503, { ok: false, error: "ingest_secret_unconfigured" });
      return;
    }
    send(200, { ok: true });
    return;
  }
  if (req.method === "POST" && url.pathname === "/ingest") {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > BODY_LIMIT) {
        // Respond BEFORE destroying the request — writing after destroy raises
        // and the client never sees the 413.
        send(413, { error: "payload_too_large" });
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (res.writableEnded) return;
      const rawBody = Buffer.concat(chunks).toString("utf8");
      const sig = verifySignature(req.headers["sv-signature"] as string | undefined, rawBody, INGEST_SECRET);
      if (!sig.ok) {
        send(401, { error: "unauthorized" });
        return;
      }
      let decoded: unknown;
      try {
        decoded = JSON.parse(rawBody);
      } catch {
        send(400, { error: "invalid_json" });
        return;
      }
      const parsed = parseIngest(decoded);
      if (!parsed.ok) {
        send(parsed.status, { error: parsed.error });
        return;
      }
      io.to(parsed.channel).emit("activity", {
        channel: parsed.channel,
        event: parsed.event,
        ts: Date.now(),
      });
      send(202, { ok: true, channel: parsed.channel });
    });
    return;
  }
  send(404, { error: "not_found" });
});

io.attach(httpServer, { path: SOCKET_PATH });

httpServer.listen(PORT, HOST, () => {
  if (!INGEST_SECRET) {
    console.warn("[realtime] REALTIME_INGEST_SECRET unset — /ingest and /ws will reject everything");
  }
  if (!ALLOWED_ORIGIN) {
    console.warn("[realtime] REALTIME_ALLOWED_ORIGIN unset — accepting any Origin (dev only)");
  }
  console.log(`[realtime] listening on ${HOST}:${PORT} (socket.io path "${SOCKET_PATH}")`);
});

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    io.close(() => httpServer.close(() => process.exit(0)));
    // Don't let a stuck socket hold the container open past its grace period.
    setTimeout(() => process.exit(0), 5_000).unref();
  });
}
