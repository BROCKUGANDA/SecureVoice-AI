import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MagicLinkEmail } from "@/lib/email/templates/magic-link";
import { PasswordResetEmail } from "@/lib/email/templates/password-reset";
import { InviteEmail } from "@/lib/email/templates/invite";

const baseUrl = "https://staging.example.test/";
const expiresAt = Date.UTC(2026, 9, 12, 10, 30);
const name = '<script>alert("name")</script>';
const tokenUrl = "https://staging.example.test/auth/verify?token=synthetic&next=%2F";
const templates = [
  {
    label: "magic link",
    render: (recipient?: string | null) =>
      MagicLinkEmail({ baseUrl, expiresAt, name: recipient, signInUrl: tokenUrl }),
    action: "Sign in to SecureVoice",
    safety: "If you did not request this email, ignore it.",
    ttl: "10 minutes",
  },
  {
    label: "password reset",
    render: (recipient?: string | null) =>
      PasswordResetEmail({ baseUrl, expiresAt, name: recipient, resetUrl: tokenUrl }),
    action: "Set a new password",
    safety: "If you did not request a password reset, ignore this email.",
    ttl: "60 minutes",
  },
  {
    label: "invitation",
    render: (recipient?: string | null) =>
      InviteEmail({ baseUrl, expiresAt, name: recipient, inviteUrl: tokenUrl }),
    action: "Accept invitation",
    safety: "If you were not",
    ttl: "72 hours",
  },
];

for (const template of templates) {
  describe(`${template.label} email`, () => {
    test("preserves the credential link in one action and a readable fallback", () => {
      const html = renderToStaticMarkup(template.render("Aisha"));
      expect(html.match(/<a\s/g)).toHaveLength(1);
      const escapedUrl = tokenUrl.replaceAll("&", "&amp;");
      expect(html).toContain(`href="${escapedUrl}"`);
      expect(html).toContain(`>${escapedUrl}</p>`);
      expect(html).toContain(template.action);
      expect(html).toContain("Hello Aisha,");
      expect(html).toContain("https://staging.example.test/logo.svg");
      expect(html).not.toContain("https://staging.example.test//");
      expect(html).toContain("Mon, 12 Oct 2026 10:30:00 GMT");
      expect(html).toContain(template.ttl);
      expect(html).toContain(template.safety);
    });

    test("escapes recipient markup instead of embedding executable HTML", () => {
      const html = renderToStaticMarkup(template.render(name));
      expect(html).not.toContain("<script>");
      expect(html).toContain("&lt;script&gt;");
    });

    test.each([undefined, null, ""])("uses a neutral greeting for %p", (recipient) => {
      const html = renderToStaticMarkup(template.render(recipient));
      expect(html).toContain(">Hello,</p>");
      expect(html).not.toContain("Hello undefined");
      expect(html).not.toContain("Hello null");
    });
  });
}

test("invitation access level is escaped and omitted when absent", () => {
  const props = { baseUrl, expiresAt, inviteUrl: tokenUrl };
  const html = renderToStaticMarkup(InviteEmail({ ...props, role: "<b>admin</b>" }));
  expect(html).toContain("Access level:");
  expect(html).toContain("&lt;b&gt;admin&lt;/b&gt;");
  expect(html).not.toContain("<b>admin</b>");
  for (const role of [undefined, null, ""]) {
    expect(renderToStaticMarkup(InviteEmail({ ...props, role }))).not.toContain("Access level:");
  }
});
