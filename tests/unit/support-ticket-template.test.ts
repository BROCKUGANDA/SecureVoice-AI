/**
 * Unit tests for the support-ticket notification template.
 *
 * ## Why this file exists
 *
 * This template is the one place an operator's problem report becomes an email
 * to the platform's own support inbox. Its failure modes are quiet:
 *
 *   1. a notification that arrives without the org id or the intervention ref
 *      it claims to attach is un-actionable — support cannot join it to
 *      anything, which is the entire point of the ticket;
 *   2. a message body that is NOT escaped is one paste away from injecting
 *      markup into an email rendered in a support engineer's client.
 *
 * The redaction of sensitive identifiers is NOT this template's job — the route
 * runs `redactPII` before the row is written, so the text this template renders
 * was already scrubbed (and the route test asserts that). What this file pins
 * is that the template faithfully carries what it is given.
 *
 *   bun test tests/unit/support-ticket-template.test.ts
 */
import { test, expect, describe } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  SupportTicketEmail,
  type SupportTicketEmailProps,
} from "@/lib/email/templates/support-ticket";

const FULL: SupportTicketEmailProps = {
  ref: "SV-S-AB2C3",
  orgId: "0a0a0a0a-0000-4000-8000-000000000001",
  operatorName: "Ada Lovelace",
  operatorEmail: "operator@example.test",
  interventionRef: "CASE-20261012-AB12",
  message: "The freeze button reported an error after I fired the signal.",
  baseUrl: "https://securevoiceai.me",
};

function render(props: Partial<SupportTicketEmailProps> = {}) {
  return renderToStaticMarkup(SupportTicketEmail({ ...FULL, ...props }));
}

describe("the notification carries what support needs", () => {
  test("the reference is present, so the email joins to the queued row", () => {
    expect(render()).toContain("SV-S-AB2C3");
  });

  test("the org id is present — the tenant the operator was acting in", () => {
    expect(render()).toContain("0a0a0a0a-0000-4000-8000-000000000001");
  });

  test("the reporter's name and address are present, so support can answer", () => {
    const html = render();
    expect(html).toContain("Ada Lovelace");
    expect(html).toContain("operator@example.test");
  });

  test("the intervention ref is present when one was attached", () => {
    expect(render()).toContain("CASE-20261012-AB12");
  });

  test("the message body is present", () => {
    expect(render()).toContain("The freeze button reported an error after I fired the signal.");
  });
});

describe("absent fields degrade rather than break", () => {
  test("no intervention ref omits the row entirely", () => {
    // undefined, not null: only an explicit undefined overrides FULL's value in
    // the spread above, and the template's `?.trim()` treats both as absent.
    const html = render({ interventionRef: undefined });
    expect(html).not.toContain("Intervention");
    expect(html).toContain("SV-S-AB2C3");
  });

  test("an empty-string intervention ref is treated as absent", () => {
    // The route stores `d.interventionRef || null`, so "" never reaches the
    // template from there — but a future caller may not be so careful, and a
    // blank labelled row is exactly the placeholder this file exists to prevent.
    expect(render({ interventionRef: "" })).not.toContain("Intervention");
  });

  test("no organisation still renders, and says so rather than showing a blank", () => {
    const html = render({ orgId: null });
    expect(html).toContain("none");
    expect(html).toContain("SV-S-AB2C3");
  });
});

describe("the message cannot inject markup", () => {
  test("angle brackets in the message are escaped, not rendered", () => {
    const html = render({ message: 'Ouch <script>alert("x")</script> & "more"' });
    // The literal tag must not survive; the escaped form must.
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
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
    // The one URL it puts in the body is the platform origin in the footer — a
    // bare origin, never a /console or /api path.
    const html = render();
    expect(html).toContain("https://securevoiceai.me");
    expect(html).not.toContain("/console");
    expect(html).not.toContain("/api/");
  });
});
