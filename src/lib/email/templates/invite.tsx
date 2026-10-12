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
 * Workspace invitation email.
 *
 * ── Copy is deliberately identical to the API response ───────────────────────
 * src/app/api/auth/invites/route.ts returns, on 201:
 *
 *   "Single use. Bound to this email. Expires in 72 hours."
 *
 * That string is the operator's support answer and the invitee's expectation.
 * If this template paraphrased it — "your invite is valid for three days" —
 * then a recipient who read the email and a support agent reading the API
 * response would be describing different products. INVITE_TTL_MS and the
 * wording below are one fact stated twice; change them together.
 */

/** Mirrors INVITE_TTL_MS (src/lib/auth/constants.ts). */
const TTL_HOURS = 72;

export type InviteEmailProps = {
  /** Fully-formed absolute invite URL, including the token. */
  inviteUrl: string;
  baseUrl: string;
  /** Absolute expiry, matching the record written by issueInvite(). */
  expiresAt: number;
  /** Role granted on acceptance, e.g. "analyst". */
  role?: string | null;
  name?: string | null;
};

export function InviteEmail({
  inviteUrl,
  baseUrl,
  expiresAt,
  role,
  name,
}: InviteEmailProps): React.ReactElement {
  const origin = displayOrigin(baseUrl);
  const expiryText = new Date(expiresAt).toUTCString();

  return (
    <Html lang="en">
      <Head />
      <Preview>{`You have been invited to a SecureVoice AI workspace at ${origin}.`}</Preview>
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
              You have been invited to SecureVoice
            </Heading>

            <Text style={para}>Hello{name ? ` ${name}` : ""},</Text>

            <Text style={para}>
              You have been invited to join a {BRAND.name} workspace. Accept the invitation below to
              create your operator account and reach the fraud Command Center.
            </Text>

            {role ? (
              <Text style={roleNote}>
                Access level: <strong>{role}</strong>
              </Text>
            ) : null}

            <Section style={ctaRow}>
              <a href={inviteUrl} style={button} target="_blank" rel="noreferrer">
                Accept invitation
              </a>
            </Section>

            <Text style={expiry}>
              Expires at <strong>{expiryText}</strong> (UTC). Single use. Bound to this email.
            </Text>

            <Hr style={rule} />

            {/* Verbatim copy from the API response — see the file header. */}
            <Text style={note}>Single use. Bound to this email. Expires in {TTL_HOURS} hours.</Text>

            <Hr style={rule} />

            <Text style={fallbackLabel}>
              If the button does not work, paste this into your browser:
            </Text>
            <Text style={fallback}>{inviteUrl}</Text>

            <Text style={verify}>
              Confirm the address above begins with <strong>{origin}</strong>. If you were not
              expecting this invitation, you can safely ignore it — nobody is added to the workspace
              unless the link above is opened.
            </Text>
          </Section>

          <Section style={footer}>
            <Text style={footerText}>
              {BRAND.name} · {origin}
            </Text>
            <Text style={footerText}>
              Automated invitation message. You are receiving it because this address was submitted
              for workspace access.
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

const roleNote: React.CSSProperties = {
  backgroundColor: BRAND.warnSurface,
  borderLeft: `3px solid ${BRAND.primary}`,
  color: BRAND.ink,
  fontSize: "14px",
  lineHeight: "22px",
  margin: "0 0 4px",
  padding: "12px 16px",
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

const note: React.CSSProperties = {
  color: BRAND.muted,
  fontSize: "13px",
  lineHeight: "20px",
  margin: "0",
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