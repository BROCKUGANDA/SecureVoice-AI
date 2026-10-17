/**
 * Client error copy: what a person reads, and what they never read.
 *
 * Three properties, each failing in a different way in the wild:
 *
 *   1. NO RAW VENDOR TEXT ON SCREEN. `describeAuthError` used to claim that in a
 *      comment and do the opposite in its fallback (`return message`), which is how
 *      the public sign-in panel came to display `Invalid origin` — a deployment
 *      misconfiguration diagnosis, in English, in front of a judge.
 *   2. NO UNMAPPED CODE LEAKING AS PROSE. An unmapped code must fall to the generic
 *      sentence, not to the snake_case token, or the UI becomes a dump of server
 *      identifiers the moment the server renames one.
 *   3. ARABIC IS NOT AN AFTERTHOUGHT. Every string has both, and a copy that only
 *      exists in English would silently degrade an Arabic-first console.
 *
 * The reporting half is checked too: `reportClientError` must never throw, because
 * it runs inside error paths, and an error handler that throws replaces a handled
 * failure with an unhandled one.
 */
import { describe, expect, test } from "bun:test";
import {
  authErrorCode,
  authErrorDetail,
  describeAuthError,
  reportAuthError,
  type AuthLang,
} from "@/lib/auth/errors";
import {
  describeAnalyticsError,
  describeRecordingError,
  describeWorkspaceSwitchError,
} from "@/lib/console-errors";
import { reportClientError } from "@/lib/client-diagnostics";

/** A string is "for a person" if it has a space and is not a bare identifier. */
function readsLikeProse(s: string): boolean {
  return s.includes(" ") && s.length > 12;
}

const ARABIC = /[؀-ۿ]/;

describe("sign-in error copy", () => {
  test("the origin refusal is recognised from a code AND from the vendor's message alone", () => {
    // Better Auth's origin guard has thrown this with a message and no stable code,
    // so the message path is the one that actually fires in production.
    const byCode = describeAuthError({ code: "INVALID_ORIGIN" }, "en");
    const byMessage = describeAuthError({ message: "Invalid origin" }, "en");
    expect(byCode).toBe(byMessage);
    expect(byCode).toContain("operator");
    // And it never repeats the phrase back at the user.
    expect(byCode.toLowerCase()).not.toContain("invalid origin");
  });

  test("a credential failure does not distinguish a missing account from a wrong password", () => {
    const noSuchUser = describeAuthError({ code: "USER_NOT_FOUND" }, "en");
    const wrongPassword = describeAuthError({ code: "INVALID_EMAIL_OR_PASSWORD" }, "en");
    const alsoWrong = describeAuthError({ code: "INVALID_PASSWORD" }, "en");
    expect(noSuchUser).toBe(wrongPassword);
    expect(noSuchUser).toBe(alsoWrong);
  });

  test("an unmapped vendor message is never rendered", () => {
    const leaky = {
      message:
        "Failed operation: db error: column UserProfile.elevenKeyEnc does not exist (internal hint: set AUTH_SECRET)",
      code: "INTERNAL_SERVER_ERROR",
    };
    const shown = describeAuthError(leaky, "en");
    for (const fragment of ["UserProfile", "elevenKeyEnc", "AUTH_SECRET", "db error"]) {
      expect(shown, fragment).not.toContain(fragment);
    }
    expect(readsLikeProse(shown)).toBe(true);
  });

  test("every mapped code returns prose, in both languages", () => {
    const codes = [
      "INVALID_EMAIL_OR_PASSWORD",
      "USER_NOT_FOUND",
      "TOO_MANY_REQUESTS",
      "too_many_failed_signins",
      "bot_check_failed",
      "INVALID_ORIGIN",
      "CSRF_ERROR",
      "SESSION_EXPIRED",
      "FAIL_TO_GET_SESSION",
      "EMAIL_NOT_VERIFIED",
      "WEAK_PASSWORD",
      "BANNED",
      "INVALID_TWO_FACTOR_CODE",
      "TWO_FACTOR_PENDING",
    ];
    for (const code of codes) {
      const en = describeAuthError({ code }, "en");
      const ar = describeAuthError({ code }, "ar");
      expect(en.length, code).toBeGreaterThan(12);
      expect(en, code).not.toBe(code);
      expect(ar, code).not.toBe(en);
      expect(ar, code).toMatch(ARABIC);
    }
  });

  test("an empty or junk error still produces a sentence", () => {
    for (const junk of [undefined, null, "", 0, {}, { message: "" }, { code: "" }]) {
      const shown = describeAuthError(junk, "en");
      expect(readsLikeProse(shown), JSON.stringify(junk)).toBe(true);
      expect(shown).not.toBe("");
    }
  });

  test("codes are read from the nested body too", () => {
    // Better Auth's client throws `{ error: { message, code } }` on some paths and
    // resolves `{ error: { body: { code } } }` on others.
    expect(authErrorCode({ error: { message: "x" }, body: { code: "SESSION_EXPIRED" } })).toBe(
      "SESSION_EXPIRED",
    );
    expect(authErrorDetail({ message: "Invalid origin" })).toBe("Invalid origin");
    expect(authErrorDetail({ error: { message: "vendor text" } })).toBe("vendor text");
  });

  test("reportAuthError keeps the raw text out of the rendered path", () => {
    // The vendor string is still captured — for the console and Sentry — it is just
    // no longer what the user reads.
    const seen: unknown[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => seen.push(args);
    try {
      reportAuthError({ code: "INVALID_ORIGIN", message: "Invalid origin" });
    } finally {
      console.warn = original;
    }
    expect(seen.length).toBe(1);
    const [, payload] = seen[0] as [string, Record<string, unknown>];
    expect(payload.auth_code).toBe("INVALID_ORIGIN");
    expect(payload.vendor_message).toBe("Invalid origin");
  });
});

describe("console panel copy", () => {
  test("each endpoint's own codes map to their own sentences", () => {
    expect(describeRecordingError("storage_not_configured", "en")).toContain("storage");
    expect(describeRecordingError("recording_not_found", "en")).toContain("30 days");
    expect(describeAnalyticsError("analytics_unavailable", "en")).toContain("Live calls");
    expect(describeWorkspaceSwitchError("MEMBERSHIP_NOT_FOUND", "en")).toContain("administrator");
  });

  test("an HTTP status folded into a code still means the same thing", () => {
    // The fetch layer reports `download_refused_401`; the route reports
    // `authentication_required`. A person should not see two different sentences.
    expect(describeRecordingError("download_refused_401", "en")).toBe(
      describeRecordingError("authentication_required", "en"),
    );
    expect(describeRecordingError("download_refused_404", "en")).toBe(
      describeRecordingError("recording_not_found", "en"),
    );
  });

  test("no panel ever renders the token it was given", () => {
    for (const [label, fn] of [
      ["analytics", describeAnalyticsError],
      ["recording", describeRecordingError],
      ["workspace", describeWorkspaceSwitchError],
    ] as const) {
      for (const code of ["fetch_failed", "some_new_code", "Failed to fetch", "500"]) {
        const shown = fn(code, "en");
        expect(shown, `${label}:${code}`).not.toBe(code);
        expect(readsLikeProse(shown), `${label}:${code}`).toBe(true);
        expect(fn(code, "ar"), `${label}:${code}`).toMatch(ARABIC);
      }
    }
  });

  test("a missing code is handled like an unknown one", () => {
    for (const fn of [
      describeAnalyticsError,
      describeRecordingError,
      describeWorkspaceSwitchError,
    ]) {
      for (const value of [undefined, null, ""]) {
        expect(readsLikeProse(fn(value, "en"))).toBe(true);
      }
    }
  });
});

describe("client reporting", () => {
  test("a console that throws cannot break the error path", () => {
    const original = console.warn;
    console.warn = () => {
      throw new Error("console is gone");
    };
    try {
      expect(() => reportClientError("test-scope", new Error("boom"))).not.toThrow();
      expect(() => reportAuthError({ message: "boom" })).not.toThrow();
    } finally {
      console.warn = original;
    }
  });

  test("a non-Error thrown value is still reported", () => {
    const seen: unknown[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => seen.push(args);
    try {
      reportClientError("test-scope", "a bare string");
      reportClientError("test-scope", null);
    } finally {
      console.warn = original;
    }
    expect(seen).toHaveLength(2);
    expect((seen[0] as [string, { detail: string }])[1].detail).toBe("a bare string");
  });

  test("every sign-in language gets a sentence, not a hole", () => {
    // Auth copy is authored in `en` + `ar`, while `AuthLang` is the product's full
    // six. `Copy` used to be a closed `{ en; ar }`, so the lookup for a Hindi,
    // Urdu, French or Swahili sign-in failure returned `undefined` — an empty error
    // message served to someone who has just been locked out. The type error was
    // the evidence that nobody had ever asked for those languages; this is the
    // assertion that makes asking for them legal.
    //
    // Per language rather than per code: the failure was the missing row, not the
    // wording.
    const langs: AuthLang[] = ["en", "ar", "hi", "ur", "fr", "sw"];
    for (const code of ["INVALID_EMAIL_OR_PASSWORD", "TOO_MANY_REQUESTS", "USER_NOT_FOUND"]) {
      for (const lang of langs) {
        const shown = describeAuthError({ code }, lang);
        expect({ code, lang, shown }).toEqual({ code, lang, shown: expect.any(String) });
        expect(shown.length).toBeGreaterThan(12);
        expect(readsLikeProse(shown)).toBe(true);
      }
    }
    // Arabic must keep its own wording: a fallback so broad it also swallowed the
    // one translated non-English language would be the same bug in disguise.
    expect(ARABIC.test(describeAuthError({ code: "USER_NOT_FOUND" }, "ar"))).toBe(true);
    // And the four untranslated languages take the English line — stated, not
    // accidental, so a later translation that forgets one of them shows up here.
    for (const lang of ["hi", "ur", "fr", "sw"] as const) {
      expect(describeAuthError({ code: "USER_NOT_FOUND" }, lang)).toBe(
        describeAuthError({ code: "USER_NOT_FOUND" }, "en"),
      );
    }
  });
});
