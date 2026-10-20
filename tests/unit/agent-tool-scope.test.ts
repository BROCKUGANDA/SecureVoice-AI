import { beforeEach, describe, expect, test, mock } from "bun:test";

/**
 * A tenant credential scoped to `card_freeze` must not invoke
 * `human_handoff`. The deployment allow-list remains a second, independent
 * condition; this test pins the narrowing.
 */
let row: {
  id: string;
  orgId: string;
  revoked: boolean;
  toolScope?: string | null;
} | null = null;

mock.module("@/lib/db", () => ({
  db: {
    agentToolSecret: {
      findUnique: async () => row,
      update: async () => ({}),
    },
  },
}));

const previousAllowed = process.env.AGENT_TOOL_ALLOWED;
const previousSecret = process.env.AGENT_TOOL_SECRET;

beforeEach(() => {
  process.env.AGENT_TOOL_ALLOWED = "card_freeze,human_handoff";
  process.env.AGENT_TOOL_SECRET = "platform-secret";
  row = { id: "ts1", orgId: "org-1", revoked: false, toolScope: "card_freeze" };
});

describe("tenant agent-tool scoping", () => {
  test("a tenant secret cannot invoke a tool outside its scope", async () => {
    const { authorizeToolCall } = await import("@/lib/agent-tool-auth");
    const result = await authorizeToolCall("tenant-secret", "human_handoff");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("tool_not_in_scope");
  });

  test("the scoped tool is allowed, and the tenant is resolved", async () => {
    const { authorizeToolCall } = await import("@/lib/agent-tool-auth");
    const result = await authorizeToolCall("tenant-secret", "card_freeze");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.orgId).toBe("org-1");
  });

  test("the legacy null scope still obeys the deployment allow-list", async () => {
    row = { id: "ts2", orgId: "org-2", revoked: false, toolScope: null };
    const { authorizeToolCall } = await import("@/lib/agent-tool-auth");
    const result = await authorizeToolCall("legacy-secret", "human_handoff");
    expect(result.ok).toBe(true);
  });

  test("a malformed empty scope fails closed rather than widening", async () => {
    row = { id: "ts3", orgId: "org-3", revoked: false, toolScope: "" };
    const { authorizeToolCall } = await import("@/lib/agent-tool-auth");
    const result = await authorizeToolCall("bad-secret", "card_freeze");
    expect(result.ok).toBe(false);
  });

  test("a revoked credential is refused", async () => {
    row = { id: "ts4", orgId: "org-4", revoked: true, toolScope: "card_freeze" };
    const { authorizeToolCall } = await import("@/lib/agent-tool-auth");
    const result = await authorizeToolCall("tenant-secret", "card_freeze");
    expect(result.ok).toBe(false);
  });
});

// Restore env so this file cannot leak configuration into a later suite.
process.on("beforeExit", () => {
  if (previousAllowed === undefined) delete process.env.AGENT_TOOL_ALLOWED;
  else process.env.AGENT_TOOL_ALLOWED = previousAllowed;
  if (previousSecret === undefined) delete process.env.AGENT_TOOL_SECRET;
  else process.env.AGENT_TOOL_SECRET = previousSecret;
});
