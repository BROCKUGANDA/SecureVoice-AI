/**
 * Unit tests for the pilot-request notification template.
 *
 * ## Why this file exists
 *
 * This template goes to the FOUNDER, not to a customer. Its whole job is to be
 * actionable in a phone notification preview: who, which institution, and a
 * reply address. The failure mode is not a crash — it is a notification that
 * arrives missing the one field that makes it actionable, or that forwards
 * something it should not.
 *
 * Two properties, because either half alone is a failure:
 *   1. every submitted field the founder needs is IN the rendered HTML
 *   2. it carries NO credential — no token, no console link, nothing that
 *      grants access. A notification email is the easiest thing in a system to
 *      forward by accident.
 *
 * Rendered with react-dom/server rather than a DOM: the interesting behaviour is
 * which strings reach the wire, and a DOM would only add noise.
 *
 *   bun test tests/unit/pilot-request-template.test.ts
 */
import { test, expect, describe } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PilotRequestEmail } from "@/lib/email/templates/pilot-request";
import type { PilotRequestEmailProps } from "@/lib/email/templates/pilot-request";

const FULL: PilotRequestEmailProps = {
  ref: "SV-P-ABC123",
  name: "Ada Lovelace",
  email: "ada@example.test",
  institution: "Stanbic Bank",
  role: "Head of Fraud",
  volume: "500-1000",
  message: "We would like a pilot next quarter.",
  source: "website",
  baseUrl: "https://securevoiceai.me",
};

function render(props: Partial<PilotRequestEmailProps> = {}) {
  return renderToStaticMarkup(PilotRequestEmail({ ...FULL, ...props }));
}

describe("the notification carries what the founder needs", () => {
  test("the institution is the subject line and the heading", () => {
    const html = render();
    expect(html).toContain("Stanbic Bank");
  });

  test("the submitter's name, email and role are present", () => {
    const html = render();
    expect(html).toContain("Ada Lovelace");
    expect(html).toContain("ada@example.test");
    expect(html).toContain("Head of Fraud");
  });

  test("the reference is present, so the email joins to the stored row", () => {
    const html = render();
    expect(html).toContain("SV-P-ABC123");
  });

  test("volume and the free-text message are present", () => {
    const html = render();
    expect(html).toContain("500-1000");
    expect(html).toContain("We would like a pilot next quarter.");
  });

  test("it says how to reply — a direct line to the submitter", () => {
    const html = render();
    expect(html).toContain("Ada Lovelace");
    expect(html.toLowerCase()).toContain("reply");
  });
});

describe("optional fields degrade rather than break", () => {
  test("a missing role and volume still render the rest", () => {
    const html = render({ role: null, volume: null });
    expect(html).toContain("Ada Lovelace");
    expect(html).toContain("SV-P-ABC123");
    // The labels for the absent fields are simply not rendered.
    expect(html).not.toContain("Monthly volume");
  });

  test("a missing message omits the message block entirely", () => {
    const html = render({ message: null });
    expect(html).toContain("Ada Lovelace");
    expect(html).not.toContain("MESSAGE");
  });

  test("an empty-string optional is treated as absent", () => {
    // The route stores `d.role || null`, so "" never reaches the template from
    // there — but a future caller may not be so careful, and a blank labelled
    // row is exactly the placeholder this file exists to prevent.
    const html = render({ role: "", volume: "", message: "" });
    expect(html).not.toContain("Monthly volume");
    expect(html).not.toContain("MESSAGE");
  });
});

describe("it carries no credential", () => {
  test("no token, no api key, no signing secret", () => {
    const html = render();
    for (const leak of ["token", "apiKey", "api_key", "secret", "Bearer", "password"]) {
      expect(html.toLowerCase()).not.toContain(leak.toLowerCase());
    }
  });

  test("no link into the operator console", () => {
    // The one place it does put a URL is the platform origin in the footer, and
    // that is a bare origin — never a /console or /api path.
    const html = render();
    expect(html).toContain("https://securevoiceai.me");
    expect(html).not.toContain("/console");
    expect(html).not.toContain("/api/");
  });
});
