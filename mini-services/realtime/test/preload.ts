/**
 * Test preload: `server-only` is a Next.js bundler marker that throws when
 * imported outside the RSC bundle. The crosscheck test imports the app's
 * src/lib modules (which are marked server-only) — in Bun tests there is no
 * client/server boundary to enforce, so it is a deliberate no-op here.
 */
import { mock } from "bun:test";

mock.module("server-only", () => ({}));
