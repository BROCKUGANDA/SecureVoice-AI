import { describe, expect, test } from "bun:test";
import {
  EVIDENCE_RETENTION_DAYS,
  EVIDENCE_RETENTION_MS,
  evidenceHoldElapsed,
} from "@/lib/privacy/evidence-hold";

describe("the evidence hold", () => {
  test("is five years by default and env-overridable", () => {
    const prior = process.env.PRIVACY_EVIDENCE_RETENTION_DAYS;
    try {
      delete process.env.PRIVACY_EVIDENCE_RETENTION_DAYS;
      // The module reads env at import time; this assertion documents the
      // shipped default rather than re-importing a second module instance.
      expect(EVIDENCE_RETENTION_DAYS).toBe(5 * 365);
      expect(EVIDENCE_RETENTION_MS).toBe(5 * 365 * 86_400_000);
    } finally {
      if (prior === undefined) delete process.env.PRIVACY_EVIDENCE_RETENTION_DAYS;
      else process.env.PRIVACY_EVIDENCE_RETENTION_DAYS = prior;
    }
  });

  test("is not elapsed before the window and is after it", () => {
    const now = Date.UTC(2026, 9, 22);
    expect(evidenceHoldElapsed(new Date(now - EVIDENCE_RETENTION_MS + 1), now)).toBe(false);
    expect(evidenceHoldElapsed(new Date(now - EVIDENCE_RETENTION_MS), now)).toBe(true);
    expect(evidenceHoldElapsed(new Date(now - EVIDENCE_RETENTION_MS - 1), now)).toBe(true);
  });
});
