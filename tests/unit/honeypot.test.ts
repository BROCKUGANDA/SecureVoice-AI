import { beforeEach, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import {
  _resetHoneypotForTest,
  hashIdentifier,
  hasScammerHash,
} from "@/lib/abuse/honeypot-blocklist";
import { isHoneypotBlocked, recordHoneypotHit, recordScammerNumber } from "@/lib/abuse/honeypot";
import { GET } from "@/app/api/internal/get-api-keys/route";

function randomIp(): string {
  return `203.0.113.${Math.floor(Math.random() * 250) + 2}`;
}

beforeEach(() => {
  _resetHoneypotForTest();
});

describe("API honeypot", () => {
  test("a decoy hit blocks the source for the local process", async () => {
    const ip = randomIp();
    expect(await isHoneypotBlocked(ip)).toBe(false);

    await recordHoneypotHit(ip, "unit test");
    expect(await isHoneypotBlocked(ip)).toBe(true);
  });

  test("the decoy route returns a fake 500 and records the hit", async () => {
    const ip = randomIp();
    const res = await GET(
      new NextRequest("http://localhost/api/internal/get-api-keys", {
        headers: { "x-securevoice-client-ip": ip, "user-agent": "scanner-test" },
      }),
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Database connection failed" });
    expect(await isHoneypotBlocked(ip)).toBe(true);
  });

  test("the proxy's untrusted sentinel is never turned into a global block", async () => {
    await recordHoneypotHit("untrusted", "unit test");
    expect(await isHoneypotBlocked("untrusted")).toBe(false);
  });

  test("the voice decoy stores a hash, never the number", async () => {
    const phone = "+971501234567";
    await recordScammerNumber(phone);
    expect(hasScammerHash(hashIdentifier(phone))).toBe(true);
    expect(hasScammerHash(phone)).toBe(false);
  });
});
