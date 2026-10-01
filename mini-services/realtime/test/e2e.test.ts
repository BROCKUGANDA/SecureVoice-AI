/**
 * End-to-end: a real socket client must be able to authenticate, join a channel
 * it was granted, receive a signed ingest broadcast, and be refused a channel it
 * was not granted.
 *
 * This exists because the auth/ingest unit tests can all pass while the server
 * still fails to wire auth into the handshake correctly. It drives the actual
 * HTTP surface and a real socket.io client against a live instance.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { io as createClient, type Socket } from "socket.io-client";
import { sign } from "../src/auth.ts";
import { SOCKET_PATH } from "../src/constants.ts";
import { signIngest } from "../src/ingest.ts";

const SECRET = "e2e-ingest-secret";
const PORT = 4117;
const BASE = `http://127.0.0.1:${PORT}`;

let proc: ReturnType<typeof Bun.spawn> | null = null;

type Activity = { channel: string; event: { kind: string; payload?: Record<string, unknown> } };

/** One socket plus everything it has actually observed on it. */
type Client = {
  socket: Socket;
  activity: Activity[];
  presence: { channel: string; watchers: string[] }[];
};

async function waitFor<T>(fn: () => T | null | undefined, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v !== undefined && v !== null) return v;
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 25));
  }
}

/**
 * Poll until the server answers. Deliberately NOT built on waitFor(): an async
 * callback would return a pending Promise that is never null, so the loop would
 * exit immediately and every later test would race the listener — and the
 * "rejects a socket" cases would then pass for the wrong reason (connection
 * refused instead of unauthorized).
 */
async function waitForServer(timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "no attempt made";
  for (;;) {
    try {
      const res = await fetch(`${BASE}/readyz`);
      if (res.ok) return;
      lastError = `readyz returned ${res.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    if (Date.now() > deadline) {
      throw new Error(`realtime server never became ready: ${lastError}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

function open(token: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const activity: Activity[] = [];
    const presence: { channel: string; watchers: string[] }[] = [];
    const socket = createClient(BASE, {
      path: SOCKET_PATH,
      transports: ["websocket"],
      auth: { token },
      reconnection: false,
      timeout: 4000,
    });
    socket.on("activity", (e: Activity) => activity.push(e));
    socket.on("presence", (e: { channel: string; watchers: string[] }) => presence.push(e));
    socket.on("connect", () => resolve({ socket, activity, presence }));
    socket.on("connect_error", reject);
  });
}

function emit<T>(socket: Socket, event: string, payload: unknown): Promise<T> {
  return new Promise((resolve) => socket.emit(event, payload, resolve as (res: T) => void));
}

function grant(orgId: string, sub: string, chans: string[]) {
  return sign({ orgId, sub, chans, exp: Math.floor(Date.now() / 1000) + 60 }, SECRET);
}

async function postIngest(event: unknown): Promise<Response> {
  const { body, header } = signIngest(event, SECRET);
  return fetch(`${BASE}/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json", "sv-signature": header },
    body,
  });
}

beforeAll(async () => {
  proc = Bun.spawn(["bun", "run", "src/server.ts"], {
    env: {
      ...process.env,
      REALTIME_INGEST_SECRET: SECRET,
      REALTIME_ALLOWED_ORIGIN: BASE,
      PORT: String(PORT),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  await waitForServer();
});

afterAll(() => {
  proc?.kill();
});

describe("realtime service", () => {
  test("healthz reports liveness", async () => {
    const r = await fetch(`${BASE}/healthz`);
    expect(r.status).toBe(200);
    expect(((await r.json()) as { ok: boolean }).ok).toBe(true);
  });

  // Regression guard. With socket.io mounted at "/", engine.io's matcher
  // (`path === req.url.slice(0, path.length)`) matches every URL on the port and
  // answers /healthz with {"code":0,"message":"Transport unknown"} — the HTTP
  // surface disappears behind the socket layer. Assert the socket path is a real
  // subpath so that class of regression cannot come back.
  test("socket path is a real subpath, not /", () => {
    expect(SOCKET_PATH).not.toBe("/");
    expect(SOCKET_PATH.startsWith("/")).toBe(true);
  });

  test("healthz is not intercepted by the socket layer", async () => {
    const r = await fetch(`${BASE}/healthz`);
    const text = await r.text();
    expect(text).not.toContain("Transport unknown");
    expect(() => JSON.parse(text)).not.toThrow();
  });

  test("returns 404 JSON for an unknown path", async () => {
    const r = await fetch(`${BASE}/nope`);
    expect(r.status).toBe(404);
    expect(((await r.json()) as { error: string }).error).toBe("not_found");
  });

  test("rejects an unsigned ingest", async () => {
    const r = await fetch(`${BASE}/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "activity", orgId: "org_a", callRef: "SV-1" }),
    });
    expect(r.status).toBe(401);
  });

  test("rejects a socket with no token", async () => {
    // Assert the REASON, not merely that it rejected — a connection-refused
    // failure produces the same rejection and would mask a broken handshake.
    await expect(open("")).rejects.toThrow(/unauthorized/);
  });

  test("rejects a socket with a token signed by the wrong secret", async () => {
    const bad = sign(
      { orgId: "org_a", sub: "op", chans: ["case:org_a:SV-1"], exp: Math.floor(Date.now() / 1000) + 60 },
      "attacker-secret",
    );
    await expect(open(bad)).rejects.toThrow(/unauthorized/);
  });

  test("rejects an expired grant at the handshake", async () => {
    const stale = sign(
      { orgId: "org_a", sub: "op", chans: ["case:org_a:SV-1"], exp: Math.floor(Date.now() / 1000) - 600 },
      SECRET,
    );
    await expect(open(stale)).rejects.toThrow(/unauthorized/);
  });

  test("refuses a join for a channel outside the grant", async () => {
    const { socket } = await open(grant("org_a", "analyst-1", ["case:org_a:SV-77"]));
    try {
      const denied = await emit<{ ok: boolean; error?: string }>(socket, "join", "case:org_b:SV-77");
      expect(denied.ok).toBe(false);
      expect(denied.error).toBe("not_in_scope");

      const ok = await emit<{ ok: boolean; channel?: string }>(socket, "join", "case:org_a:SV-77");
      expect(ok.ok).toBe(true);
      expect(ok.channel).toBe("case:org_a:SV-77");
    } finally {
      socket.close();
    }
  }, 15_000);

  test("delivers a signed ingest to a joined channel", async () => {
    const client = await open(grant("org_a", "analyst-1", ["case:org_a:SV-77"]));
    try {
      await emit(client.socket, "join", "case:org_a:SV-77");

      const res = await postIngest({
        kind: "activity",
        orgId: "org_a",
        callRef: "SV-77",
        payload: { action: "identity.verified" },
      });
      expect(res.status).toBe(202);

      const seen = await waitFor(() => client.activity[0]);
      expect(seen.channel).toBe("case:org_a:SV-77");
      expect(seen.event.kind).toBe("activity");
      expect(seen.event.payload?.action).toBe("identity.verified");
    } finally {
      client.socket.close();
    }
  }, 15_000);

  test("a socket receives nothing for a channel it never joined", async () => {
    const client = await open(grant("org_a", "analyst-2", ["case:org_a:SV-78"]));
    try {
      // Granted one channel, but the ingest below targets a DIFFERENT case, so
      // nothing should ever arrive on this socket.
      const res = await postIngest({
        kind: "activity",
        orgId: "org_a",
        callRef: "SV-77",
        payload: { action: "account.frozen" },
      });
      expect(res.status).toBe(202);
      await new Promise((r) => setTimeout(r, 300));
      expect(client.activity.filter((e) => e.channel === "case:org_a:SV-77")).toHaveLength(0);
    } finally {
      client.socket.close();
    }
  }, 15_000);

  test("announces presence on join and on last disconnect", async () => {
    const watcher = await open(grant("org_a", "analyst-3", ["case:org_a:SV-79"]));
    const observer = await open(grant("org_a", "analyst-4", ["case:org_a:SV-79"]));
    try {
      await emit(watcher.socket, "join", "case:org_a:SV-79");
      await emit(observer.socket, "join", "case:org_a:SV-79");

      const joined = await waitFor(() => observer.presence.find((p) => p.watchers.includes("analyst-3")));
      expect(joined.channel).toBe("case:org_a:SV-79");

      watcher.socket.close();
      const left = await waitFor(
        () => observer.presence.find((p) => !p.watchers.includes("analyst-3") && p.watchers.includes("analyst-4")),
        6000,
      );
      expect(left.channel).toBe("case:org_a:SV-79");
    } finally {
      watcher.socket.close();
      observer.socket.close();
    }
  }, 20_000);
});
