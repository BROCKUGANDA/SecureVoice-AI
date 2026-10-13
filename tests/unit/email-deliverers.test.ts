import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { EnqueueAndSendResult } from "@/lib/email/queue";

const enqueue = mock(async (_input: unknown): Promise<EnqueueAndSendResult> => ({
  ok: true,
  id: "synthetic-message",
}));
mock.module("@/lib/email/queue", () => ({ enqueueAndSendEmail: enqueue }));
// `buildLink` stayed in `@/lib/email/resend`; the three deliverers moved to
// `@/lib/email/deliverers` so the queue↔resend import cycle could be broken.
// Importing them from resend yields undefined — which is why they are now
// imported from the module that actually owns them.
const { buildLink } = await import("@/lib/email/resend");
const { deliverMagicLink, deliverInvite, sendResetPassword } =
  await import("@/lib/email/deliverers");

const envKeys = ["APP_BASE_URL", "NEXT_PUBLIC_APP_URL", "APP_URL"] as const;
const saved = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
const token = "synthetic+token/with&reserved=?";
const email = "operator@example.test";
const expiresAt = Date.UTC(2026, 9, 12, 10, 30);

beforeEach(() => {
  for (const key of envKeys) delete process.env[key];
  process.env.APP_BASE_URL = "https://staging.example.test///";
  enqueue.mockClear();
});
afterAll(() => {
  for (const key of envKeys) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

test("links encode every query value and retain the deployment origin", () => {
  const url = new URL(buildLink("/auth/magic-link/verify", { token, next: "/console?a=1" }));
  expect(url.origin).toBe("https://staging.example.test");
  expect(url.pathname).toBe("/auth/magic-link/verify");
  expect(url.searchParams.get("token")).toBe(token);
  expect(url.searchParams.get("next")).toBe("/console?a=1");
  expect([...url.searchParams.keys()]).toEqual(["token", "next"]);
});

test("origin fallback follows deployment configuration and refuses a missing origin", () => {
  process.env.NEXT_PUBLIC_APP_URL = "https://public.example.test";
  process.env.APP_URL = "https://app.example.test";
  expect(buildLink("/auth", {})).toBe("https://staging.example.test/auth");
  delete process.env.APP_BASE_URL;
  expect(buildLink("/auth", {})).toBe("https://public.example.test/auth");
  delete process.env.NEXT_PUBLIC_APP_URL;
  expect(buildLink("/auth", {})).toBe("https://app.example.test/auth");
  delete process.env.APP_URL;
  expect(() => buildLink("/auth", {})).toThrow("must be set");
});

const deliverers = [
  {
    kind: "magic_link",
    subject: "Your SecureVoice sign-in link",
    send: () => deliverMagicLink({ email, token, expiresAt }),
    extra: {},
  },
  {
    kind: "invite",
    subject: "You have been invited to SecureVoice",
    send: () => deliverInvite({ email, token, expiresAt, role: "analyst" }),
    extra: { role: "analyst" },
  },
];
for (const deliverer of deliverers) {
  describe(deliverer.kind, () => {
    test("queues the correct message with the credential outside persisted props", async () => {
      await deliverer.send();
      expect(enqueue).toHaveBeenCalledTimes(1);
      expect(enqueue).toHaveBeenCalledWith({
        kind: deliverer.kind,
        subject: deliverer.subject,
        toEmail: email,
        token,
        props: {
          expiresAt,
          baseUrl: "https://staging.example.test",
          name: null,
          ...deliverer.extra,
        },
      });
    });
    test.each(["queue_failed", "send_failed"] as const)(
      "propagates %s to the route",
      async (reason) => {
        enqueue.mockResolvedValueOnce({ ok: false, reason, detail: "unavailable" });
        await expect(deliverer.send()).rejects.toThrow(`(${reason}): unavailable`);
      },
    );
  });
}

test("invites without a role queue a null role", async () => {
  await deliverInvite({ email, token, expiresAt });
  expect(enqueue).toHaveBeenCalledWith(
    expect.objectContaining({ props: expect.objectContaining({ role: null }) }),
  );
});

test("password reset extracts the token and queues the advertised one-hour expiry", async () => {
  const before = Date.now();
  await sendResetPassword({ user: { email, name: "Aisha" }, url: buildLink("/reset", { token }) });
  expect(enqueue).toHaveBeenCalledTimes(1);
  expect(enqueue).toHaveBeenCalledWith({
    kind: "password_reset",
    toEmail: email,
    subject: "Reset your SecureVoice password",
    token,
    props: {
      name: "Aisha",
      baseUrl: "https://staging.example.test",
      expiresAt: expect.any(Number),
    },
  });
  const call = enqueue.mock.calls[0];
  if (!call) throw new Error("Expected a queued password reset");
  const input = call[0] as { props: { expiresAt: number } };
  expect(input.props.expiresAt).toBeGreaterThanOrEqual(before + 3_600_000);
  expect(input.props.expiresAt).toBeLessThanOrEqual(Date.now() + 3_600_000);
});

test.each([
  "not a URL",
  "https://staging.example.test/reset",
  "https://staging.example.test/reset?token=",
])("refuses reset URL %s before queueing", async (url) => {
  await expect(sendResetPassword({ user: { email }, url })).rejects.toThrow(
    "did not carry a token",
  );
  expect(enqueue).not.toHaveBeenCalled();
});

test("password reset failure propagates and an unnamed recipient stays neutral", async () => {
  enqueue.mockResolvedValueOnce({ ok: false, reason: "send_failed", detail: "unavailable" });
  await expect(
    sendResetPassword({ user: { email }, url: buildLink("/reset", { token }) }),
  ).rejects.toThrow("password-reset delivery failed (send_failed): unavailable");
  expect(enqueue).toHaveBeenCalledWith(
    expect.objectContaining({ props: expect.objectContaining({ name: null }) }),
  );
});
