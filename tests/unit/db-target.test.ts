/**
 * UNIT - which database is production actually on?
 *
 * The intent is that production and the demo run on the Postgres on the VPS.
 * The failure this guards is silent: one `DATABASE_URL` line, a developer's
 * Supabase URL left in `.env`, and everything keeps working while production is
 * not where anyone thinks it is. Classification must therefore be (a) right for
 * the URL shapes people really paste, and (b) leak nothing about the host.
 */
import { describe, expect, test } from "bun:test";

import { assertDatabaseTarget, classifyDatabaseUrl, isSelfHosted } from "@/lib/db-target";

describe("classifyDatabaseUrl", () => {
  const cases: Array<[string, string, ReturnType<typeof classifyDatabaseUrl>]> = [
    ["compose db service", "postgresql://securevoice:securevoice@db:5432/securevoice", "vps-container"],
    ["compose postgres alias", "postgresql://u:p@postgres:5432/x", "vps-container"],
    ["localhost", "postgresql://u:p@localhost:5432/x", "loopback"],
    ["127.0.0.1", "postgresql://u:p@127.0.0.1:5432/x?sslmode=disable", "loopback"],
    ["IPv6 loopback", "postgresql://u:p@[::1]:5432/x", "loopback"],
    ["RFC1918 10/8", "postgresql://u:p@10.1.2.3:5432/x", "private-network"],
    ["RFC1918 172.16/12", "postgresql://u:p@172.20.0.5:5432/x", "private-network"],
    ["RFC1918 192.168/16", "postgresql://u:p@192.168.1.9:5432/x", "private-network"],
    [".internal", "postgresql://u:p@pg.vps.internal:5432/x", "private-network"],
    ["supabase direct", "postgresql://postgres:pw@db.abcdefgh.supabase.co:5432/postgres", "managed-supabase"],
    ["supabase pooler", "postgresql://postgres.ref:pw@aws-0-eu.pooler.supabase.com:6543/postgres", "managed-supabase"],
    ["neon", "postgresql://u:p@ep-cool-123.eu-central-1.aws.neon.tech/x", "managed-neon"],
    ["rds", "postgresql://u:p@mydb.abc.eu-west-1.rds.amazonaws.com:5432/x", "managed-rds"],
    ["public hostname", "postgresql://u:p@pg.example.com:5432/x", "external"],
    ["public IP", "postgresql://u:p@203.0.113.9:5432/x", "external"],
  ];
  for (const [label, url, kind] of cases) {
    test(label, () => expect(classifyDatabaseUrl(url)).toBe(kind));
  }

  test("not-quite-private addresses are NOT private", () => {
    // 172.15 and 172.32 sit just outside 172.16/12; 192.169 is outside 192.168/16.
    for (const h of ["172.15.0.1", "172.32.0.1", "192.169.0.1", "11.0.0.1"]) {
      expect(classifyDatabaseUrl(`postgresql://u:p@${h}:5432/x`), h).toBe("external");
    }
  });

  test("a hostile suffix cannot pass as a managed or self-hosted host", () => {
    expect(classifyDatabaseUrl("postgresql://u:p@evil-supabase.co.attacker.com:5432/x")).toBe("external");
    expect(classifyDatabaseUrl("postgresql://u:p@db.attacker.com:5432/x")).toBe("external");
    expect(classifyDatabaseUrl("postgresql://u:p@dbx:5432/x")).toBe("external");
  });

  test("passwords with @ / # (which operators really paste) still classify by the REAL host", () => {
    expect(classifyDatabaseUrl("postgresql://u:p@ss/w#rd@db.zzz.supabase.co:5432/postgres")).toBe(
      "managed-supabase",
    );
    expect(classifyDatabaseUrl("postgresql://u:p@ss@db:5432/securevoice")).toBe("vps-container");
  });

  test("unset and blank are 'unset', never a crash", () => {
    for (const v of [undefined, null, "", "   "]) {
      expect(classifyDatabaseUrl(v as string)).toBe("unset");
    }
  });

  test("garbage never throws", () => {
    for (const v of ["not a url", "://", "postgres://", "@@@", "postgresql://:@:/"]) {
      expect(() => classifyDatabaseUrl(v)).not.toThrow();
    }
  });

  test("the class reveals no host or credential", () => {
    const kind = classifyDatabaseUrl("postgresql://u:secretpw@db.zoxpov.supabase.co:5432/postgres");
    expect(kind).not.toContain("zoxpov");
    expect(kind).not.toContain("secretpw");
  });
});

describe("isSelfHosted", () => {
  test("the VPS intent: container, loopback and private network are ours; managed is not", () => {
    for (const k of ["vps-container", "loopback", "private-network"] as const) {
      expect(isSelfHosted(k), k).toBe(true);
    }
    for (const k of ["managed-supabase", "managed-neon", "managed-rds", "external", "unset"] as const) {
      expect(isSelfHosted(k), k).toBe(false);
    }
  });
});

describe("assertDatabaseTarget (opt-in)", () => {
  const SUPA = "postgresql://postgres:pw@db.abc.supabase.co:5432/postgres";
  const VPS = "postgresql://securevoice:securevoice@db:5432/securevoice";

  test("does nothing unless the operator opted in - a managed DB must not take a deploy down by surprise", () => {
    expect(() => assertDatabaseTarget(SUPA, { NODE_ENV: "production" })).not.toThrow();
    expect(() =>
      assertDatabaseTarget(SUPA, { NODE_ENV: "production", REQUIRE_VPS_DATABASE: "false" }),
    ).not.toThrow();
    expect(() =>
      assertDatabaseTarget(SUPA, { NODE_ENV: "production", REQUIRE_VPS_DATABASE: "1" }),
    ).not.toThrow(); // only the exact string "true" opts in
  });

  test("when opted in, production refuses a managed database with an actionable message", () => {
    const env = { NODE_ENV: "production", REQUIRE_VPS_DATABASE: "true" };
    expect(() => assertDatabaseTarget(SUPA, env)).toThrow(/managed-supabase/);
    expect(() => assertDatabaseTarget(SUPA, env)).toThrow(/Moving the database onto the VPS/);
    expect(() => assertDatabaseTarget(undefined, env)).toThrow(/unset/);
    expect(() => assertDatabaseTarget("postgresql://u:p@pg.example.com/x", env)).toThrow(/external/);
  });

  test("when opted in, the VPS database passes", () => {
    const env = { NODE_ENV: "production", REQUIRE_VPS_DATABASE: "true" };
    expect(() => assertDatabaseTarget(VPS, env)).not.toThrow();
    expect(() => assertDatabaseTarget("postgresql://u:p@10.0.0.4:5432/x", env)).not.toThrow();
  });

  test("a developer machine is never blocked, even when opted in", () => {
    expect(() =>
      assertDatabaseTarget(SUPA, { NODE_ENV: "development", REQUIRE_VPS_DATABASE: "true" }),
    ).not.toThrow();
    expect(() => assertDatabaseTarget(SUPA, { REQUIRE_VPS_DATABASE: "true" })).not.toThrow();
  });

  test("the error never contains the connection string", () => {
    try {
      assertDatabaseTarget(SUPA, { NODE_ENV: "production", REQUIRE_VPS_DATABASE: "true" });
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).not.toContain("postgres:pw");
      expect(msg).not.toContain("abc.supabase.co");
    }
  });
});
