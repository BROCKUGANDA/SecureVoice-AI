/**
 * Docker must wait as long as the code says it will.
 *
 * `SHUTDOWN_DRAIN_MS` and `stop_grace_period` are two numbers in two languages
 * that have to agree, and nothing in the runtime enforces it: set the window to
 * 65s and leave Docker at its 10s default and the process still drains — into a
 * SIGKILL, mid-request, with the log line saying "drain window elapsed" never
 * reaching anyone. The graceful shutdown then exists in the source and nowhere
 * else, which is the failure shape this file is written against.
 *
 * The services are discovered from what they actually RUN (a `command` that boots
 * a draining entrypoint), not from a hand-kept list of names that quietly stops
 * being true the day a service is renamed.
 *
 *   bun test tests/unit/shutdown-window.test.ts
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { setupGracefulShutdown, _resetShutdownForTests } from "@/lib/graceful-shutdown";

const COMPOSE = readFileSync(resolve(import.meta.dir, "../../docker-compose.yml"), "utf8");

/** `75s` / `2m` / `90s` → ms. Anything unparseable is 0, so a typo fails the check. */
function parseDuration(raw: string): number {
  const m = /^(\d+)\s*(s|m|h)?$/i.exec(raw.trim());
  if (!m) return 0;
  const n = Number(m[1]);
  const unit = (m[2] ?? "s").toLowerCase();
  return unit === "h" ? n * 3_600_000 : unit === "m" ? n * 60_000 : n * 1_000;
}

type ServiceBlock = { name: string; body: string; grace: number | null };

/**
 * Split the top-level `services:` map into per-service blocks.
 *
 * Deliberately a scoped text scan rather than a YAML dependency: the shape it
 * needs is two-space-indented keys, and importing a YAML parser into a gate to
 * read one integer is not worth the surface. It is exact about indentation, so a
 * reformat that breaks the assumption shows up as "no services found" — a loud
 * failure, not a silent pass.
 */
function services(): ServiceBlock[] {
  const lines = COMPOSE.split(/\r?\n/);
  const out: ServiceBlock[] = [];
  let current: { name: string; body: string[] } | null = null;
  let inServices = false;

  for (const line of lines) {
    if (/^services:\s*$/.test(line)) {
      inServices = true;
      continue;
    }
    if (inServices && /^[a-zA-Z]/.test(line)) inServices = false;
    if (!inServices) continue;

    const nameMatch = /^  ([A-Za-z0-9_.-]+):\s*(#.*)?$/.exec(line);
    if (nameMatch) {
      if (current) out.push({ name: current.name, body: current.body.join("\n"), grace: null });
      current = { name: nameMatch[1]!, body: [] };
      continue;
    }
    if (current) current.body.push(line);
  }
  if (current) out.push({ name: current.name, body: current.body.join("\n"), grace: null });

  return out.map((s) => {
    const g = /stop_grace_period:\s*(\S+)/.exec(s.body);
    return { ...s, grace: g ? parseDuration(g[1]!) : null };
  });
}

/** The drain the application code actually asks for. */
_resetShutdownForTests();
const drainMs = setupGracefulShutdown({ exit: () => {} }).drainMs();
_resetShutdownForTests();

/** Entrypoints that wait for in-flight work before exiting. */
const DRAINING = [
  { needle: "src/worker/voice-stream.ts", why: "live media-stream calls (beginCall per call)" },
  { needle: "server-preload.ts", why: "the Next server's accept-then-drain handler" },
] as const;

describe("the orchestrator waits for the drain", () => {
  test("compose declares services to check", () => {
    expect(services().length).toBeGreaterThan(5);
  });

  test("the resolved window is the documented one, not an accident of the environment", () => {
    // If someone shortens the default, every grace period below silently stops
    // meaning anything; if they lengthen it, the check below catches the compose
    // side. Either way this assertion is what makes the number visible.
    expect(drainMs).toBeGreaterThanOrEqual(30_000);
  });

  for (const probe of DRAINING) {
    test(`${probe.needle} runs inside a service given enough grace`, () => {
      const runner = services().find((s) => s.body.includes(probe.needle));
      expect(runner, `no service runs ${probe.needle} — update this gate`).toBeDefined();
      const grace = runner!.grace;
      expect(grace, `${runner!.name} has no stop_grace_period`).not.toBeNull();
      // Equality is not enough: killed exactly at the boundary is killed.
      expect(grace!).toBeGreaterThan(drainMs);
    });
  }

  test("no declared grace period is shorter than the window it is meant to cover", () => {
    const offenders = services()
      .filter((s) => s.grace !== null && s.grace <= drainMs)
      .map((s) => `${s.name}=${s.grace}ms`);
    expect(offenders).toEqual([]);
  });
});
