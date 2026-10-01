import { describe, expect, test } from "bun:test";
import { PresenceRegistry, caseChannel, orgChannel, safeSegment } from "../src/channels.ts";

describe("channel naming", () => {
  test("derives names from the org", () => {
    expect(caseChannel("org_a", "SV-1")).toBe("case:org_a:SV-1");
    expect(orgChannel("org_a")).toBe("org:org_a");
  });

  test("safeSegment strips colons so a segment cannot fake a channel boundary", () => {
    // A colon in orgId would otherwise produce case:a:case:org_b:SV-1 — five
    // segments that the three-part join parser cannot reconstruct.
    expect(safeSegment("a:case:org_b", 64)).toBe("acaseorg_b");
    expect(safeSegment("SV-1", 64)).toBe("SV-1");
    expect(safeSegment("org_2AbC", 64)).toBe("org_2AbC");
    expect(safeSegment("x".repeat(200), 8)).toHaveLength(8);
  });
});

describe("presence registry", () => {
  test("tracks and releases a member", () => {
    const reg = new PresenceRegistry();
    reg.add("case:o:SV-1", { sub: "op", socketId: "s1", joinedAt: 1 });
    expect(reg.watchers("case:o:SV-1")).toEqual(["op"]);
    reg.remove("case:o:SV-1", "s1");
    expect(reg.watchers("case:o:SV-1")).toEqual([]);
  });

  test("collapses multiple tabs into one watcher", () => {
    const reg = new PresenceRegistry();
    reg.add("case:o:SV-1", { sub: "op", socketId: "s1", joinedAt: 1 });
    reg.add("case:o:SV-1", { sub: "op", socketId: "s2", joinedAt: 2 });
    expect(reg.watchers("case:o:SV-1")).toEqual(["op"]);
    expect(reg.stats().sockets).toBe(2);
  });

  test("keeps a watcher present until its last socket leaves", () => {
    const reg = new PresenceRegistry();
    reg.add("case:o:SV-1", { sub: "op", socketId: "s1", joinedAt: 1 });
    reg.add("case:o:SV-1", { sub: "op", socketId: "s2", joinedAt: 2 });
    reg.remove("case:o:SV-1", "s1");
    expect(reg.watchers("case:o:SV-1")).toEqual(["op"]);
    reg.remove("case:o:SV-1", "s2");
    expect(reg.watchers("case:o:SV-1")).toEqual([]);
  });

  test("reports every channel a socket belongs to, for disconnect cleanup", () => {
    const reg = new PresenceRegistry();
    reg.add("case:o:SV-1", { sub: "op", socketId: "s1", joinedAt: 1 });
    reg.add("org:o", { sub: "op", socketId: "s1", joinedAt: 1 });
    reg.add("case:o:SV-2", { sub: "other", socketId: "s2", joinedAt: 1 });
    expect(reg.channelsOf("s1").sort()).toEqual(["case:o:SV-1", "org:o"]);
  });

  test("stays bounded under channel churn", () => {
    const reg = new PresenceRegistry();
    for (let i = 0; i < 2_500; i++) {
      reg.add(`case:o:SV-${i}`, { sub: "op", socketId: `s${i}`, joinedAt: i });
      reg.remove(`case:o:SV-${i}`, `s${i}`);
    }
    expect(reg.stats().channels).toBeLessThanOrEqual(2_000);
  });

  test("caps sockets per channel rather than refusing the join", () => {
    const reg = new PresenceRegistry();
    for (let i = 0; i < 70; i++) {
      reg.add("case:o:SV-1", { sub: `op${i}`, socketId: `s${i}`, joinedAt: i });
    }
    expect(reg.members("case:o:SV-1").length).toBeLessThanOrEqual(64);
    // The newest socket always survives — a reconnect must not silently go deaf.
    expect(reg.members("case:o:SV-1").some((m) => m.socketId === "s69")).toBe(true);
  });
});
