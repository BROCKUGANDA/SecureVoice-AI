/**
 * UNIT — transit encryption gates (WP: encryption in transit).
 *
 * Two production transports carry platform data over the network beyond the
 * TLS edge: the Postgres connection (case rows, transcripts, phone numbers)
 * and the Redis connection (the shared budget counter). Both must refuse a
 * plaintext configuration in production unless the operator explicitly
 * acknowledges a private network — the same rule, enforced in the one place
 * each connection is built, so a misconfigured .env fails loudly instead of
 * silently shipping a plaintext hop beneath a TLS-terminated edge.
 *
 * The predicates are pure (env injectable), so every branch is driven here
 * without mutating process.env — except the wiring test at the bottom, which
 * proves the refusal is actually reached through the meter's own connect()
 * path, with the env saved and restored.
 */
import { afterEach, describe, expect, test } from "bun:test";

import { assertTransportIsEncrypted } from "@/lib/db-transport";
import { assertRedisTransportIsEncrypted, sharedMeter } from "@/lib/redis";

const PROD = { NODE_ENV: "production" } as Record<string, string | undefined>;
const PROD_PLAINTEXT_OK = {
  NODE_ENV: "production",
  DB_ALLOW_PLAINTEXT_PRIVATE_NETWORK: "true",
  REDIS_ALLOW_PLAINTEXT_PRIVATE_NETWORK: "true",
} as Record<string, string | undefined>;

describe("assertTransportIsEncrypted (DATABASE_URL)", () => {
  test("production without sslmode is refused", () => {
    expect(() =>
      assertTransportIsEncrypted("postgresql://u:p@db.zox.supabase.co:5432/postgres", PROD),
    ).toThrow(/sslmode=require/);
  });

  test("production with sslmode=disable is refused", () => {
    expect(() =>
      assertTransportIsEncrypted("postgresql://u:p@db:5432/securevoice?sslmode=disable", PROD),
    ).toThrow(/sslmode=require/);
  });

  test("production with sslmode=require passes", () => {
    expect(() =>
      assertTransportIsEncrypted(
        "postgresql://u:p@db.zox.supabase.co:5432/postgres?sslmode=require",
        PROD,
      ),
    ).not.toThrow();
  });

  test("production with verify-full and a pinned CA passes", () => {
    expect(() =>
      assertTransportIsEncrypted(
        "postgresql://u:p@db.zox.supabase.co:5432/postgres?sslmode=verify-full&sslrootcert=supabase-ca.crt",
        PROD,
      ),
    ).not.toThrow();
  });

  test("the explicit private-network opt-in acknowledges plaintext", () => {
    expect(() =>
      assertTransportIsEncrypted(
        "postgresql://u:p@db:5432/securevoice?sslmode=disable",
        PROD_PLAINTEXT_OK,
      ),
    ).not.toThrow();
  });

  test("outside production the gate is silent (a laptop may use anything)", () => {
    expect(() =>
      assertTransportIsEncrypted("postgresql://u:p@localhost:5432/x?sslmode=disable", {
        NODE_ENV: "test",
      }),
    ).not.toThrow();
  });

  test("an empty URL is not this gate's problem", () => {
    expect(() => assertTransportIsEncrypted("", PROD)).not.toThrow();
  });

  test("an unknown sslmode is not an encrypted mode", () => {
    expect(() =>
      assertTransportIsEncrypted("postgresql://u:p@db:5432/x?sslmode=prefer", PROD),
    ).toThrow(/sslmode=require/);
  });
});

describe("assertRedisTransportIsEncrypted (REDIS_URL)", () => {
  test("production with redis:// is refused", () => {
    expect(() => assertRedisTransportIsEncrypted("redis://cache:6379", PROD)).toThrow(
      /rediss:\/\//,
    );
  });

  test("production with rediss:// passes", () => {
    expect(() =>
      assertRedisTransportIsEncrypted("rediss://default:p@cache.example.com:6379", PROD),
    ).not.toThrow();
  });

  test("the scheme check is case-insensitive and tolerates padding", () => {
    expect(() =>
      assertRedisTransportIsEncrypted("  REDISS://default:p@cache.example.com:6379", PROD),
    ).not.toThrow();
  });

  test("the explicit private-network opt-in acknowledges plaintext", () => {
    expect(() =>
      assertRedisTransportIsEncrypted("redis://redis:6379", PROD_PLAINTEXT_OK),
    ).not.toThrow();
  });

  test("outside production the gate is silent", () => {
    expect(() =>
      assertRedisTransportIsEncrypted("redis://redis:6379", { NODE_ENV: "test" }),
    ).not.toThrow();
  });

  test("an unset REDIS_URL is not this gate's problem", () => {
    expect(() => assertRedisTransportIsEncrypted(undefined, PROD)).not.toThrow();
  });
});

describe("wiring — the refusal is reached through the meter", () => {
  const saved = {
    NODE_ENV: process.env.NODE_ENV,
    REDIS_URL: process.env.REDIS_URL,
    REDIS_ALLOW_PLAINTEXT_PRIVATE_NETWORK: process.env.REDIS_ALLOW_PLAINTEXT_PRIVATE_NETWORK,
  };

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    sharedMeter._reset();
  });

  test("sharedMeter.incrBy refuses a plaintext production Redis", async () => {
    // Bun types NODE_ENV as read-only on process.env; the assignment is the
    // point of the test, so go through the mutable view.
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    process.env.REDIS_URL = "redis://redis:6379";
    delete process.env.REDIS_ALLOW_PLAINTEXT_PRIVATE_NETWORK;
    sharedMeter._reset(); // drop any cached client so connect() runs

    expect(sharedMeter.incrBy("transit-test", 1)).rejects.toThrow(/rediss:\/\//);
  });
});
