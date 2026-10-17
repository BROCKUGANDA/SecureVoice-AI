/**
 * Cross-node fan-out (WP-20 gate, the part that needs a shared bus).
 *
 * The hazard: two replicas behind a round-robin proxy with no shared pub/sub
 * means an event ingested into node A never reaches a client connected to node
 * B — and nothing errors. The console just goes quiet. So this test stands up
 * TWO real instances against one Redis, connects a client to node B only,
 * ingests into node A, and asserts the event arrives on B.
 *
 * Mirrors test/e2e.test.ts's proven handshake (grant token via the service's
 * own `sign`, ingest via the service's own `signIngest`) so the only new thing
 * under test is the cross-instance hop.
 *
 * Exits non-zero with a clear message when REDIS_URL is unreachable: this is
 * the one WP-20 assertion that cannot be satisfied with in-memory state.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { createClient } from "redis";
import { io as createClient2, type Socket } from "socket.io-client";
import { sign } from "../src/auth.ts";
import { signIngest } from "../src/ingest.ts";
import { SOCKET_PATH } from "../src/constants.ts";

const SECRET = "crossnode-ingest-secret";
const REDIS = process.env.REDIS_URL ?? "redis://127.0.0.1:6380";
// Ports are per-run, not constants. Two self-hosted runners on one host run this
// gate at the same time; with fixed ports the second instance fails to bind,
// never answers /readyz, and the gate fails with a connection error that has
// nothing to do with fan-out. CI passes CROSSNODE_PORT_BASE derived from the
// run id; the default keeps a local `bun test` working unchanged.
// `||`, NOT `??`, and the Number() is validated. An env var set to an EMPTY
// STRING is not nullish, so `?? 4321` would not fire — and `Number("")` is 0,
// which silently asks the OS for port 0 and then waits 25 seconds for a server
// that can never bind. That is exactly what this gate reported, so the guard
// exists to make the cause legible instead of leaving the next person to
// re-derive it from a timeout.
const rawPortBase = Number(process.env.CROSSNODE_PORT_BASE || "");
const PORT_BASE = Number.isFinite(rawPortBase) && rawPortBase >= 1024 ? rawPortBase : 4321;
const PORT_A = PORT_BASE;
const PORT_B = PORT_BASE + 1;
const ORG = "org_crossnode";
const CALL_REF = "SV-CROSSNODE";

let procA: ChildProcess | null = null;
let procB: ChildProcess | null = null;
let socketB: Socket | null = null;

/**
 * The last lines each instance printed.
 *
 * The pipes are READ, deliberately. `stdio: ["ignore","pipe","pipe"]` with no
 * listener hands the child a kernel pipe nobody drains, so once ~64 KB is
 * buffered the replica blocks on its next log write — and a fan-out test then
 * fails as a timeout inside a process that was actually stopped by a console.log.
 * It is also the only way a red here can be diagnosed at all: the CI log shows
 * the parent's assertion, and the child's reason never reaches it.
 */
const tails = new Map<string, string>();

function drain(label: string, child: ChildProcess): void {
  for (const [stream, tag] of [
    [child.stdout, "out"],
    [child.stderr, "err"],
  ] as const) {
    if (!stream) continue;
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      const key = `${label}:${tag}`;
      tails.set(key, ((tails.get(key) ?? "") + chunk).slice(-8_000));
    });
  }
}

/** Every captured tail, newest first by label — for the message that fails. */
function instanceLog(): string {
  const parts = [...tails.entries()]
    .filter(([, text]) => text.trim())
    .map(([key, text]) => `--- ${key} ---\n${text.trim().split("\n").slice(-12).join("\n")}`);
  return parts.length ? parts.join("\n") : "(no instance output captured)";
}

function spawnInstance(port: number, label: string, redisUrl = REDIS): ChildProcess {
  const child = spawn(process.execPath, ["run", "src/server.ts"], {
    env: {
      ...process.env,
      PORT: String(port),
      REALTIME_INGEST_SECRET: SECRET,
      REALTIME_ALLOWED_ORIGIN: "",
      REDIS_URL: redisUrl,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  drain(label, child);
  return child;
}

async function waitReady(port: number, timeoutMs = 25_000): Promise<{ pubsub: string }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/readyz`);
      if (res.ok) return (await res.json()) as { pubsub: string };
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`instance on :${port} never became ready`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

describe("WP-20 cross-node fan-out", () => {
  beforeAll(async () => {
    const probe = createClient({ url: REDIS, socket: { connectTimeout: 4000 } });
    try {
      await probe.connect();
      await probe.ping();
    } catch {
      console.error(
        `\n  CROSS-NODE GATE NOT RUN: REDIS_URL=${REDIS} is unreachable.\n` +
          `  This assertion cannot be satisfied without a shared bus. Start Redis and re-run.\n`,
      );
      process.exit(1);
    } finally {
      await probe.quit().catch(() => {});
    }

    procA = spawnInstance(PORT_A, "A");
    procB = spawnInstance(PORT_B, "B");
    const [a, b] = await Promise.all([waitReady(PORT_A), waitReady(PORT_B)]);
    // Both instances must actually be on the shared bus, or this test would
    // pass for the wrong reason.
    expect(a.pubsub).toBe("redis");
    expect(b.pubsub).toBe("redis");

    // Client connects to node B ONLY.
    const token = sign(
      {
        orgId: ORG,
        sub: "op",
        chans: [`case:${ORG}:${CALL_REF}`],
        exp: Math.floor(Date.now() / 1000) + 300,
      },
      SECRET,
    );
    socketB = createClient2(`http://127.0.0.1:${PORT_B}`, {
      path: SOCKET_PATH,
      transports: ["websocket"],
      auth: { token },
      reconnection: false,
      timeout: 5000,
    });
    await new Promise<void>((resolve, reject) => {
      socketB!.once("connect", () => resolve());
      socketB!.once("connect_error", (e: Error) => reject(e));
    });
    const joined = await new Promise<{ ok: boolean }>((resolve, reject) => {
      socketB!
        .timeout(5000)
        .emit("join", `case:${ORG}:${CALL_REF}`, (err: unknown, res: { ok: boolean }) =>
          err ? reject(err) : resolve(res),
        );
    });
    expect(joined.ok).toBe(true);
  }, 60_000);

  afterAll(() => {
    socketB?.close();
    procA?.kill();
    procB?.kill();
  });

  test("an event ingested on node A reaches a client connected to node B", async () => {
    const signed = signIngest(
      {
        kind: "activity",
        orgId: ORG,
        callRef: CALL_REF,
        payload: { type: "state", state: "FREEZE_STAGED", marker: "cross-node-proof" },
      },
      SECRET,
      Math.floor(Date.now() / 1000),
    );
    if (!("body" in signed)) throw new Error("signIngest returned no body");

    // Register the listener BEFORE the ingest is fired. The order here used to be
    // fetch -> assert 202 -> `new Promise(socket.once("activity"))`, and that is a
    // race the test loses when delivery is fast: node A publishes over Redis and
    // node B emits to a socket on the SAME host, so the event can arrive while the
    // fetch round-trip is still resolving. `once()` attached afterwards never sees
    // it, and the assertion then waits the whole 10s for an event that was already
    // delivered. That is exactly the red CI reported on a commit whose tree was
    // byte-identical to the green one before it — a window measured in
    // milliseconds, opened by the runner's load rather than by the product.
    const activity = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            // The tails are the difference between "fan-out timed out" and a
            // diagnosable failure: they say whether node B's replica thought it
            // was on the bus at all, and whether node A's ingest logged anything.
            new Error(`node B never received the activity event\n${instanceLog()}`),
          ),
        10_000,
      );
      socketB!.once("activity", (payload: unknown) => {
        clearTimeout(timer);
        resolve(payload);
      });

      fetch(`http://127.0.0.1:${PORT_A}/ingest`, {
        method: "POST",
        headers: { "content-type": "application/json", "sv-signature": signed.header },
        body: signed.body,
      })
        // 202 = accepted for fan-out (the service answers before the broadcast
        // resolves, deliberately — the writer must never block on a socket).
        .then((res) => {
          if (![200, 202].includes(res.status))
            reject(new Error(`node A refused the ingest: HTTP ${res.status}`));
        })
        .catch(reject);
    });
    expect(JSON.stringify(activity)).toContain("cross-node-proof");
    console.log("  cross-node delivery verified: ingest on node A -> client on node B");
  }, 30_000);

  /**
   * The same scenario with NO shared bus — i.e. what the deployment looked like
   * before the adapter. The client on B must NOT receive the event. This is the
   * test that gives the one above meaning: without it, "it passed" could just
   * mean "one process happened to handle both".
   */
  test("without the adapter, node B stays silent — the silent failure this prevents", async () => {
    const PORT_C = PORT_BASE + 2;
    const PORT_D = PORT_BASE + 3;
    // Per-run, like A and B. These two were hard-coded 4323/4324 after the port
    // base was introduced, so two jobs on this host would contend for them: the
    // second run's replica never binds, `waitReady` answers from the FIRST run's
    // process, and the "no bus" half of this test can pass or fail on which
    // neighbour happens to own the port. Same hazard the header describes,
    // left in the one place the header did not look.
    const procC = spawnInstance(PORT_C, "C", "");
    const procD = spawnInstance(PORT_D, "D", "");

    let client: Socket | null = null;
    try {
      const [c, d] = await Promise.all([waitReady(PORT_C), waitReady(PORT_D)]);
      expect(c.pubsub).toBe("single-node");
      expect(d.pubsub).toBe("single-node");

      const token = sign(
        {
          orgId: ORG,
          sub: "op",
          chans: [`case:${ORG}:${CALL_REF}`],
          exp: Math.floor(Date.now() / 1000) + 300,
        },
        SECRET,
      );
      client = createClient2(`http://127.0.0.1:${PORT_D}`, {
        path: SOCKET_PATH,
        transports: ["websocket"],
        auth: { token },
        reconnection: false,
        timeout: 5000,
      });
      await new Promise<void>((resolve, reject) => {
        client!.once("connect", () => resolve());
        client!.once("connect_error", (e: Error) => reject(e));
      });
      await new Promise<void>((resolve, reject) => {
        client!
          .timeout(5000)
          .emit("join", `case:${ORG}:${CALL_REF}`, (err: unknown, res: { ok: boolean }) =>
            err ? reject(err) : res.ok ? resolve() : reject(new Error("join refused")),
          );
      });

      let received = false;
      client.on("activity", () => {
        received = true;
      });

      const signed = signIngest(
        {
          kind: "activity",
          orgId: ORG,
          callRef: CALL_REF,
          payload: { type: "state", marker: "no-bus-proof" },
        },
        SECRET,
        Math.floor(Date.now() / 1000),
      );
      if (!("body" in signed)) throw new Error("signIngest returned no body");
      const res = await fetch(`http://127.0.0.1:${PORT_C}/ingest`, {
        method: "POST",
        headers: { "content-type": "application/json", "sv-signature": signed.header },
        body: signed.body,
      });
      expect([200, 202]).toContain(res.status);

      await new Promise((r) => setTimeout(r, 2500));
      expect(received).toBe(false);
      console.log(
        "  confirmed: without the Redis adapter the event never reaches the other node (silent, no error)",
      );
    } finally {
      client?.close();
      procC.kill();
      procD.kill();
    }
  }, 60_000);
});
