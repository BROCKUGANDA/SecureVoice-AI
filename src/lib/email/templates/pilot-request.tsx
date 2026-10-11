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
import { BRAND } from "../brand";

/**
 * Internal notification: a new pilot request landed.
 *
 * ── Why this is not a customer-facing template ───────────────────────────────
 * The other three templates go to a user who must act on a credential. This one
 * goes to US, and its whole job is to be actionable in a phone's notification
 * preview: who, which institution, how to reply. It therefore carries the
 * submitter's own submitted fields and no credential of any kind.
 *
 * ── Why it goes through the durable queue ────────────────────────────────────
 * It is sent with `enqueueAndSendEmail`, the same path as a magic link, so a
 * provider outage retries it instead of dropping it. A pilot request is revenue;
 * losing the notification silently is the failure this avoids. The ROW is
 * written before the send, so the lead survives even if every send attempt fails.
 *
 * ── What it deliberately does NOT contain ────────────────────────────────────
 * No token, no internal case data, no links into the operator console. A
 * notification email is the easiest thing in a system to forward by accident, so
 * it carries the enquiry and nothing that grants access.
 */

export type PilotRequestEmailProps = {
  ref: string;
  name: string;
  email: string;
  institution: string;
  role: string | null;
  volume: string | null;
  message: string | null;
  source: string;
  baseUrl: string;
};

function Row({ label, value }: { label: string; value: string }) {
  return (
    <Text style={rowStyle}>
      <span style={labelStyle}>{label}</span>
      <br />
      <span style={valueStyle}>{value}</span>
    </Text>
  );
}

export function PilotRequestEmail({
  ref,
  name,
  email,
  institution,
  role,
  volume,
  message,
  source,
  baseUrl,
}: PilotRequestEmailProps) {
  return (
    <Html>
      <Head />
      <Preview>{`Pilot request: ${institution} — ${name}`}</Preview>
      <Body style={bodyStyle}>
        <Container style={containerStyle}>
          <Text style={kickerStyle}>NEW PILOT REQUEST</Text>
          <Heading style={headingStyle}>{institution}</Heading>

          <Section style={cardStyle}>
            <Row label="Reference" value={ref} />
            <Row label="Name" value={name} />
            <Row label="Email" value={email} />
            {role ? <Row label="Role" value={role} /> : null}
            {volume ? <Row label="Monthly volume" value={volume} /> : null}
            <Row label="Source" value={source} />
          </Section>

          {message ? (
            <>
              <Hr style={hrStyle} />
              <Text style={labelStyle}>MESSAGE</Text>
              <Text style={valueStyle}>{message}</Text>
            </>
          ) : null}

          <Hr style={hrStyle} />
          <Text style={footerStyle}>
            Reply directly to this email to answer {name}. The request is also
            stored against reference {ref} in the platform.
          </Text>
          <Text style={footerStyle}>
            {BRAND.name} · {baseUrl}
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

const bodyStyle: React.CSSProperties = {
  backgroundColor: "#f6f7f6",
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  padding: "24px 0",
};
const containerStyle: React.CSSProperties = {
  backgroundColor: "#ffffff",
  borderRadius: "14px",
  margin: "0 auto",
  maxWidth: "560px",
  padding: "28px 26px",
};
const kickerStyle: React.CSSProperties = {
  color: "#0b7a55",
  fontSize: "11px",
  fontWeight: 700,
  letterSpacing: "0.08em",
  margin: "0 0 6px",
};
const headingStyle: React.CSSProperties = {
  color: "#0c110e",
  fontSize: "20px",
  fontWeight: 700,
  margin: "0 0 18px",
};
const cardStyle: React.CSSProperties = {
  backgroundColor: "#fafbfa",
  border: "1px solid #e6e9e7",
  borderRadius: "10px",
  padding: "14px 16px",
};
const rowStyle: React.CSSProperties = { margin: "0 0 12px" };
const labelStyle: React.CSSProperties = {
  color: "#6b7280",
  fontSize: "10.5px",
  fontWeight: 700,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
};
const valueStyle: React.CSSProperties = {
  color: "#0c110e",
  fontSize: "14px",
  lineHeight: "1.5",
  whiteSpace: "pre-wrap",
};
const hrStyle: React.CSSProperties = {
  borderColor: "#e6e9e7",
  margin: "18px 0 14px",
};
const footerStyle: React.CSSProperties = {
  color: "#6b7280",
  fontSize: "12px",
  lineHeight: "1.5",
  margin: "0 0 8px",
};
