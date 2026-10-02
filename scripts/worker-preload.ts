/**
 * Bun preload for the dial worker.
 *
 * `server-only` is a Next.js bundler marker: inside a client bundle it throws,
 * which is exactly what we want there. Outside any bundle — a plain Bun process
 * such as this worker — there is no client/server boundary to enforce, so the
 * package only prevents the process from starting.
 *
 * Every module the worker imports is genuinely server-only (Prisma client,
 * audit chain, key material) and none of them is reachable from a client
 * bundle, so neutralising the marker changes nothing about the security
 * boundary. It only lets a non-Next runtime import them.
 *
 * The Next build is unaffected: this preload is loaded by the worker process
 * only, via bunfig's preload hook for that command.
 */
import { plugin } from "bun";

plugin({
  name: "server-only-noop",
  setup(build) {
    build.module("server-only", () => ({
      exports: {},
      loader: "object",
    }));
  },
});