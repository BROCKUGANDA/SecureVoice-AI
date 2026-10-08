import { NextResponse } from "next/server";
import { consume as consumeRateLimit, rateLimitId } from "@/lib/ratelimit";
import { logWarn } from "@/lib/validation/safe-log";

export const dynamic = "force-dynamic";

/**
 * GET /api/operator/webhooks — machine-readable catalogue of every endpoint an
 * integrator has to wire up.
 *
 * ## Why this exists
 *
 * The operator dashboard shows this list to a human who pastes URLs into the
 * Twilio console. An integrator's provisioning script needs the same list, and
 * until this route existed the only copy was a `const` inside a React view —
 * unreachable from a terminal, and guaranteed to drift the first time a path
 * changed. One catalogue, two consumers.
 *
 * ## What is and is not in here
 *
 *   IN: paths, HTTP methods, and the authentication scheme each endpoint
 *       enforces. This is integration configuration, not a secret.
 *   OUT: every signing secret and token. `BANK_WEBHOOK_SECRET` is how a
 *       receiver verifies OUR deliveries and `WEBHOOK_SECRET` is how we verify
 *       THEIRS — publishing either in a catalogue endpoint turns "operator
 *       reads the dashboard" into a full compromise of both directions of the
 *       contract. The operator reads secrets from the environment, once.
 *
 * ## Why it is unauthenticated
 *
 * Every path in the catalogue is already discoverable from the public
 * integration contract (`GET /asyncapi`, `/openapi`) and from the published
 * docs, so gating this route protects nothing while making it unusable by the
 * CI job that most needs it. Rate-limited rather than open, because it is still
 * a scrape target and the cost of serving it should stay bounded.
 */
const CATALOGUE = [
  {
    id: "inbound-intervention",
    label: "Inbound intervention webhook",
    description:
      "Bank or insurer fraud-engine alerts. Point your producer webhook here.",
    path: "/api/v1/interventions",
    method: "POST",
    auth: "SV-Signature HMAC",
    secret: "WEBHOOK_SECRET (yours, sent in the header)",
    direction: "inbound",
  },
  {
    id: "outbound-delivery",
    label: "Outbound delivery callback",
    description:
      "SecureVoice posts case outcomes and audit events back to your systems.",
    path: "/api/webhooks/receiver",
    method: "POST",
    auth: "SV-Signature HMAC",
    secret: "BANK_WEBHOOK_SECRET (verify with this)",
    direction: "outbound",
  },
  {
    id: "elevenlabs-postcall",
    label: "ElevenLabs post-call ingest",
    description:
      "Post-call transcript, summary, and outcome from the conversation plane.",
    path: "/api/webhooks/elevenlabs",
    method: "POST",
    auth: "ElevenLabs-Signature HMAC",
    secret: "ELEVENLABS_WEBHOOK_SECRET (verify with this)",
    direction: "inbound",
  },
  {
    id: "twilio-voice",
    label: "Twilio voice webhook",
    description:
      "Twilio calls this for TwiML instructions when a customer answers.",
    path: "/api/twiml-stream",
    method: "GET/POST",
    auth: "Twilio webhook, no inbound signature",
    secret: null,
    direction: "inbound",
  },
  {
    id: "twilio-media",
    label: "Twilio Media Streams WebSocket",
    description:
      "Live mulaw audio bridge for Twilio Media Streams when enabled.",
    path: "/api/voice-websocket",
    method: "WS",
    auth: "Feature-gated path (FEATURE_TWILIO_MEDIA_STREAMS)",
    secret: null,
    direction: "inbound",
  },
  {
    id: "twilio-sms",
    label: "Twilio SMS webhook",
    description: "Customer YES/NO replies to the blind-ping or intervention SMS.",
    path: "/api/sms/inbound",
    method: "POST",
    auth: "X-Twilio-Signature",
    secret: "TWILIO_AUTH_TOKEN (verify with this)",
    direction: "inbound",
  },
  {
    id: "twilio-status",
    label: "Twilio status callback",
    description: "Carrier delivery reports for outbound calls and SMS.",
    path: "/api/twilio/status",
    method: "POST",
    auth: "X-Twilio-Signature",
    secret: "TWILIO_AUTH_TOKEN (verify with this)",
    direction: "inbound",
  },
  {
    id: "operator-internal",
    label: "Operator internal event stream",
    description:
      "Internal operator/backend topic for case state transitions and alerts.",
    path: "/api/console/events",
    method: "SSE",
    auth: "Session required",
    secret: null,
    direction: "outbound",
  },
] as const;

/**
 * The origin a caller should paste into a vendor console.
 *
 * Prefers an explicit configured public origin, because the server's own idea
 * of its origin is wrong exactly when it matters (behind Caddy, behind a load
 * balancer, on a preview domain). Only then does it fall back to the request's
 * Host header, which is what a self-hosted single-origin deployment wants.
 */
function publicOrigin(req: Request): string {
  const configured =
    process.env.NEXT_PUBLIC_APP_URL ??
    process.env.APP_BASE_URL ??
    process.env.TWILIO_WEBHOOK_BASE_URL;
  if (configured) return configured.replace(/\/+$/, "");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (host) {
    const proto = req.headers.get("x-forwarded-proto") ?? "https";
    return `${proto}://${host}`;
  }
  return "https://your-app.com";
}

export async function GET(req: Request) {
  const rl = consumeRateLimit("operator-webhooks", rateLimitId(req as never, "operator-webhooks"), 1, 60);
  if (!rl.ok) {
    return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429 });
  }

  const origin = publicOrigin(req);

  // `placeholders` is surfaced, not silently swallowed: an operator who reads
  // `"url": "https://your-app.com/api/..."` should be told why, rather than
  // discovering it by pasting a URL that 404s.
  if (origin === "https://your-app.com") {
    logWarn("[operator-webhooks] no public origin configured; emitting placeholder URLs", {
      hint: "set NEXT_PUBLIC_APP_URL / APP_BASE_URL / TWILIO_WEBHOOK_BASE_URL",
    });
  }

  const webhooks = CATALOGUE.map((entry) => ({
    id: entry.id,
    label: entry.label,
    description: entry.description,
    path: entry.path,
    method: entry.method,
    auth: entry.auth,
    // The NAME of the env var, never its value.
    secret_env: entry.secret,
    direction: entry.direction,
    url: `${origin}${entry.path}`,
  }));

  return NextResponse.json(
    {
      ok: true,
      count: webhooks.length,
      origin,
      origin_configured: origin !== "https://your-app.com",
      schema_version: "2026-10-01",
      webhooks,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
