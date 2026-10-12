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
 * Magic-link sign-in email. The PRIMARY operator sign-in path
 * (src/lib/auth/magic-link.ts).
 *
 * ── Why this template is hand-written and not a Resend stock template ────────
 * A bank fraud console produces mail that nobody expects to receive. A generic
 * "reset your password" layout is visually indistinguishable from a phishing
 * attempt, which is the one confusion this email must never cause. Three rules
 * follow from that, and each is enforced by structure rather than by hope:
 *
 *   1. LEAD WITH THE DOMAIN. The origin is in the preheader (the inbox preview
 *      line, shown before the user clicks anything) AND in the footer, so the
 *      recipient can check the sender's origin without expanding the message.
 *   2. ONE ACTION, NEVER BURIED. Exactly one <a>. No "manage preferences", no
 *      secondary CTA, no link in the header. An operator in a hurry must have
 *      exactly one thing to click.
 *   3. EXPLICIT EXPIRY AND EXPLICIT DISARM. The TTL is stated in the body, and
 *      the "if you did not request this" line is a full paragraph rather than a
 *      small-print footer, because for THIS email most recipients are indeed
 *      not the person who initiated it.
 *
 * The link URL is passed in fully-formed. It is built by the caller from the
 * deployment's own base URL; this template never constructs it, so there is one
 * place where the origin is decided and one place to audit it.
 */

/** Mirrors MAGIC_LINK_TTL_MS (src/lib/auth/constants.ts). */
const TTL_MINUTES = 10;

export type MagicLinkEmailProps = {
  /** Fully-formed absolute sign-in URL, including the token. */
  signInUrl: string;
  /** Deployment origin, printed in the preheader and footer for verification. */
  baseUrl: string;
  /** Absolute expiry, so the "expires at" line matches the stored record. */
  expiresAt: number;
  /** Optional recipient name; falls back to a neutral greeting. */
  name?: string | null;
};

export function MagicLinkEmail({
  signInUrl,
  baseUrl,
  expiresAt,
  name,
}: MagicLinkEmailProps): React.ReactElement {
  const origin = displayOrigin(baseUrl);
  const expiryText = new Date(expiresAt).toUTCString();

  // "SecureVoice AI — sign-in link at securevoice.ai" is the entire preheader.
  // It repeats the origin because the preheader is the ONLY text an operator
  // reads before deciding whether to open a message they did not expect.
  const pretext = `SecureVoice AI sign-in link for ${origin}. Valid for ${TTL_MINUTES} minutes.`;

  return (
    <Html lang="en">
      <Head />
      <Preview>{pretext}</Preview>
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
              Your SecureVoice sign-in link
            </Heading>

            <Text style={para}>Hello{name ? ` ${name}` : ""},</Text>

            <Text style={para}>
              Use the button below to sign in to the {BRAND.name} Command Center. This link works
              once, for this browser, and expires in {TTL_MINUTES} minutes.
            </Text>

            <Section style={ctaRow}>
              <a href={signInUrl} style={button} target="_blank" rel="noreferrer">
                Sign in to SecureVoice
              </a>
            </Section>

            <Text style={expiry}>
              Expires at <strong>{expiryText}</strong> (UTC). After that the link stops working and
              you can request a new one from the sign-in page.
            </Text>

            <Hr style={rule} />

            {/* The disarm paragraph. Deliberately prominent. */}
            <Text style={disarm}>
              <strong>If you did not request this email, ignore it.</strong> No account was changed
              and no action is needed. This link was created by someone entering your address on the{" "}
              {origin} sign-in page. If that was not you, you can ignore this message — the link
              expires on its own and cannot be used twice.
            </Text>

            <Hr style={rule} />

            {/* Full link in plain text: some corporate mail gateways strip or
                mangle styled <a> tags, and this operator must still be able to
                sign in if the button does not render. */}
            <Text style={fallbackLabel}>
              If the button does not work, paste this into your browser:
            </Text>
            <Text style={fallback}>{signInUrl}</Text>

            <Text style={verify}>
              Confirm the address above begins with <strong>{origin}</strong> before you use it. A
              sign-in link from SecureVoice will always come from that exact origin.
            </Text>
          </Section>

          <Section style={footer}>
            <Text style={footerText}>
              {BRAND.name} · {origin}
            </Text>
            <Text style={footerText}>
              You are receiving this because a sign-in was requested for your address. This is an
              automated security message.
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

const body: React.CSSProperties = {
  backgroundColor: BRAND.canvas,
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
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

// Inline styles only. Email clients strip <style> blocks inconsistently and
// Outlook ignores padding on <a>; the borderRadius fallback keeps the button
// from rendering as a hard rectangle in the clients that support it.
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

// monospace + wrap so a long token does not overflow the 560px container.
const fallback: React.CSSProperties = {
  color: BRAND.muted,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
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
