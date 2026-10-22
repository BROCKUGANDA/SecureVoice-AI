import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { postPinned } from "@/lib/outbox";

/**
 * A delivery must connect to the address the SSRF validator approved, not to a
 * second DNS answer. The server below is reachable only as 127.0.0.1 while the
 * URL names an unregistrable host; if the client resolves the host again the
 * test fails.
 */
describe("pinned webhook delivery", () => {
  let server: Server;
  let port = 0;
  let hostHeader = "";

  beforeAll(async () => {
    server = createServer((req, res) => {
      hostHeader = req.headers.host ?? "";
      res.statusCode = 200;
      res.end("ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("connects to the validated IP and keeps the hostname for Host", async () => {
    const res = await postPinned(
      `http://bank.example.test:${port}/hook`,
      ["127.0.0.1"],
      { "content-type": "application/json" },
      '{"event":"test"}',
      2_000,
    );
    expect(res.status).toBe(200);
    expect(hostHeader).toBe(`bank.example.test:${port}`);
  });
});
