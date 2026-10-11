import * as React from "react";
import {
  Body,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Preview,
  Section,
  Text,
} from "@react-email/components";
import { BRAND, displayOrigin, logoUrl } from "../brand";

/**
 * Password-reset email. Better Auth's `sendResetPassword`.
 *
 * ── The least justified of the three templates ───────────────────────────────
 * src/lib/auth/magic-link.ts:5-15 argues that this system is magic-link-FIRST
 * precisely because "nothing phishable" — there is no reusable operator secret
 * to plant in a proxy log or a support ticket. Passwords survive here only as a
 * fallback for "an operator on a locked-down network with no mail access" — and
 * note the irony: that fallback is for someone who by definition cannot read
 * this email.
 *
 * It is implemented because `emailAndPassword.enabled` is true
 * (src/lib/better-auth.ts:57) and a password-based account with no reset path is
 * a locked account. But treat it as a fallback surface, not a primary one.
 *
 * The copy is deliberately NOT copyed from the magic-link template. A "set your
 * password" mail reads as routine; the disarm paragraph here is the load-bearing
 * element, because a password reset is the single most phished email there is,
 * and the recipient of a bank fraud console's reset mail may not be the person
 * who triggered it.
 */

/** Mirrors the Better Auth reset window. Kept short; re-issue is cheap. */
const TTL_MINUTES = 60;

export type PasswordResetEmailProps = {
  /** Fully-formed absolute reset URL, including the token. */
  resetUrl: string;
  baseUrl: string;
  expiresAt: number;
  name?: string | null;
};

export function PasswordResetEmail({
  resetUrl,
  baseUrl,
  expiresAt,
  name,
}: PasswordResetEmailProps): React.ReactElement {
  const origin = displayOrigin(baseUrl);
  const expiryText = new Date(expiresAt).toUTCString();

  return (
    <Html lang="en">
      <Head />
      <Preview>{`Reset your SecureVoice AI password. Requested from ${origin}.`}</Preview>
      <Body style={body}>
        <Container style={container}>
          <Section style={header}>
            <Text style={wordmark}>
              <img
                src={logoUrl(baseUrl)}
                alt="SecureVoice AI"
                width="150"
                height="40"
                style={logo}
              />
            </Text>
          </Section>

          <Section style={content}>
            <Heading as="h1" style={heading}>
              Reset your password
            </Heading>

            <Text style={para}>Hello{name ? ` ${name}` : ""},</Text>

            <Text style={para}>
              A password reset was requested for your {BRAND.name} operator account. Choose a new
              password using the button below.
            </Text>

            <Section style={ctaRow}>
              <a href={resetUrl} style={button} target="_blank" rel="noreferrer">
                Set a new password
              </a>
            </Section>

            <Text style={expiry}>
              Expires at <strong>{expiryText}</strong> (UTC). Valid for {TTL_MINUTES} minutes.
            </Text>

            <Hr style={rule} />

            {/* The disarm paragraph. This email type is the most commonly
                impersonated in the world; the sender gets no benefit from
                making this line small. */}
            <Text style={disarm}>
              <strong>If you did not request a password reset, ignore this email.</strong> Your
              password will not change and no action is required. Ignoring this message is the
              correct response — nobody at {BRAND.name} will contact you to "confirm" a reset.
            </Text>

            <Hr style={rule} />

            <Text style={fallbackLabel}>
              If the button does not work, paste this into your browser:
            </Text>
            <Text style={fallback}>{resetUrl}</Text>

            <Text style={verify}>
              Confirm the address above begins with <strong>{origin}</strong> before you use it. A
              password reset from SecureVoice will always come from that exact origin.
            </Text>
          </Section>

          <Section style={footer}>
            <Text style={footerText}>
              {BRAND.name} · {origin}
            </Text>
            <Text style={footerText}>
              Automated security message. Never share this link — it grants access to your account.
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

const body: React.CSSProperties = {
  backgroundColor: BRAND.canvas,
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  margin: "0",
  padding: "32px 12px",
};

const container: React.CSSProperties = {
  backgroundColor: BRAND.surface,
  borderRadius: "12px",
  margin: "0 auto",
  maxWidth: "560px",
  overflow: "hidden",
};

const header: React.CSSProperties = {
  backgroundColor: BRAND.primaryDeep,
  padding: "28px 32px",
  textAlign: "center",
};

const wordmark: React.CSSProperties = { margin: "0" };

const logo: React.CSSProperties = {
  display: "inline-block",
  height: "40px",
  width: "150px",
};

const content: React.CSSProperties = { padding: "32px" };

const heading: React.CSSProperties = {
  color: BRAND.ink,
  fontSize: "22px",
  fontWeight: "700",
  letterSpacing: "-0.01em",
  lineHeight: "30px",
  margin: "0 0 20px",
};

const para: React.CSSProperties = {
  color: BRAND.ink,
  fontSize: "15px",
  lineHeight: "24px",
  margin: "0 0 16px",
};

const ctaRow: React.CSSProperties = { margin: "28px 0", textAlign: "center" };

const button: React.CSSProperties = {
  backgroundColor: BRAND.primary,
  borderRadius: "8px",
  color: BRAND.onPrimary,
  display: "inline-block",
  fontSize: "16px",
  fontWeight: "600",
  lineHeight: "20px",
  padding: "14px 32px",
  textDecoration: "none",
};

const expiry: React.CSSProperties = {
  color: BRAND.muted,
  fontSize: "13px",
  lineHeight: "20px",
  margin: "0 0 24px",
};

const rule: React.CSSProperties = {
  border: "none",
  borderTop: `1px solid ${BRAND.hairline}`,
  margin: "24px 0",
};

const disarm: React.CSSProperties = {
  backgroundColor: BRAND.warnSurface,
  borderLeft: `3px solid ${BRAND.primary}`,
  color: BRAND.ink,
  fontSize: "14px",
  lineHeight: "22px",
  margin: "0 0 4px",
  padding: "14px 16px",
};

const fallbackLabel: React.CSSProperties = {
  color: BRAND.muted,
  fontSize: "13px",
  lineHeight: "20px",
  margin: "0 0 6px",
};

const fallback: React.CSSProperties = {
  color: BRAND.muted,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  fontSize: "12px",
  lineHeight: "18px",
  margin: "0 0 20px",
  wordBreak: "break-all",
};

const verify: React.CSSProperties = {
  color: BRAND.muted,
  fontSize: "13px",
  lineHeight: "20px",
  margin: "0",
};

const footer: React.CSSProperties = {
  backgroundColor: BRAND.canvas,
  padding: "20px 32px",
  textAlign: "center",
};

const footerText: React.CSSProperties = {
  color: BRAND.muted,
  fontSize: "12px",
  lineHeight: "18px",
  margin: "0 0 4px",
};