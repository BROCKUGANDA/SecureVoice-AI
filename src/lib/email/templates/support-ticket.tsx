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
 * Internal notification: an operator filed a support ticket from the console.
 *
 * ── Why this is not a customer-facing template ───────────────────────────────
 * It goes to the platform's own support mailbox. Its job is to carry the three
 * things support needs to act: WHICH tenant (orgId), WHICH intervention (the
 * optional case reference), and the operator's own words — with a reply
 * address that reaches a human.
 *
 * ── Why the message is already scrubbed ──────────────────────────────────────
 * The caller (src/app/api/support/ticket/route.ts) runs `redactPII` BEFORE the
 * queue row is written, so the text this template renders — and the text a
 * drain retry re-renders from — never contained a PAN, an SSN or a phone
 * number. This template does not re-scrub: a second redaction pass here would
 * make the route's guarantee untestable by hiding its absence.
 *
 * ── What it deliberately does NOT contain ────────────────────────────────────
 * No token, no console link, nothing that grants access. A notification email
 * is the easiest thing in a system to forward by accident.
 */

export type SupportTicketEmailProps = {
  ref: string;
  orgId: string | null;
  operatorName: string;
  operatorEmail: string;
  interventionRef: string | null;
  message: string;
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

export function SupportTicketEmail({
  ref,
  orgId,
  operatorName,
  operatorEmail,
  interventionRef,
  message,
  baseUrl,
}: SupportTicketEmailProps) {
  return (
    <Html>
      <Head />
      <Preview>{`Support ticket ${ref} from ${operatorEmail}`}</Preview>
      <Body style={bodyStyle}>
        <Container style={containerStyle}>
          <Text style={kickerStyle}>SUPPORT TICKET</Text>
          <Heading style={headingStyle}>{ref}</Heading>

          <Section style={cardStyle}>
            <Row label="Reference" value={ref} />
            {/* "none" is stated rather than left blank: a ticket filed from a
                signed-in session with no active organization is a fact support
                should see, not a gap they have to guess at. */}
            <Row
              label="Organisation"
              value={orgId ?? "none (signed-in session without an organization)"}
            />
            <Row label="Reported by" value={`${operatorName} · ${operatorEmail}`} />
            {/* The route stores `|| null` and the test pins that a blank is
                treated as absent — a labelled row with nothing in it is exactly
                the placeholder this page must never show. */}
            {interventionRef?.trim() ? <Row label="Intervention" value={interventionRef} /> : null}
          </Section>

          <Hr style={hrStyle} />
          <Text style={labelStyle}>MESSAGE (PII auto-redacted before delivery)</Text>
          <Text style={valueStyle}>{message}</Text>

          <Hr style={hrStyle} />
          <Text style={footerStyle}>
            Reply to {operatorEmail} to answer directly. The queued record for this ticket carries
            reference {ref}.
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
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
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
  color: "#b45309",
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
