import { logError, logWarn, registerLogSink } from "@/lib/validation/safe-log";
import { registerExporterFlush } from "@/lib/telemetry/exporter-flush";

/**
 * Next.js instrumentation hook — runs once at server boot (Node runtime).
 * Surfaces missing critical configuration immediately in the logs instead of
 * as a confusing 500 on the first request that needed it.
 *
 * Deliberately NON-fatal: the reference deployment boots with no .env at all
 * (audit-only dry-run demo), and crashing there would break the zero-config
 * judge path. The failures that are actually unsafe (e.g. BYOK encryption
 * without AUTH_SECRET) fail closed at the point of use.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { assertCriticalConfig, env, voiceProviderLabel } = await import("@/lib/config");
  const missing = assertCriticalConfig();
  if (missing.length > 0) {
    logWarn("[config] missing critical env vars", {
      missing,
      detail:
        "the platform boots in degraded/audit-only mode; set them before enabling live voice or BYOK.",
    });
  }

  // A vendor credential and the vendor's permission are different claims. With a key
  // set but the commercial-use attestation absent, every agent utterance is answered
  // by the emergency cue and the browser demo silently substitutes the visitor's own
  // device voice — which until now surfaced only in a log line after a key had already
  // been parked, i.e. after someone had heard the beep.
  if (env.elevenLabsApiKey && !env.elevenLabsDryRun && !env.commercialUseAttested) {
    logWarn("[voice] live ElevenLabs calls are refused by the commercial-use guard", {
      serving: voiceProviderLabel(),
      detail:
        "callers hear the emergency cue; the demo falls back to the device voice. Set ELEVENLABS_COMMERCIAL_USE=true only on an account whose terms permit commercial use (ToS §1(c)(i), PUP §9(a)).",
    });
  }

  // Rate-limit backend. Chosen here, once, because this is the only place that
  // runs on the Node runtime before any route handler — and a limiter whose
  // store were chosen per-request would just be the in-process one again.
  //
  // REDIS_URL present => a shared, cluster-wide bucket. Absent => per-process
  // memory, which is only equivalent on a single instance. The distinction is
  // logged rather than assumed: "rate limiting is on" is not the same claim as
  // "the limit being enforced is the one we configured", and on a multi-instance
  // box only one of those two is true.
  try {
    const { installRateLimitStoreFromEnv } = await import("@/lib/ratelimit");
    const store = await installRateLimitStoreFromEnv();
    logWarn("[ratelimit] store installed", {
      store,
      detail:
        store === "memory"
          ? "REDIS_URL unset — limits are per-process and reset on restart. Set REDIS_URL for a cluster-wide limit."
          : "REDIS_URL set — limits are shared across instances.",
    });
  } catch (err) {
    logError("[ratelimit] store install failed — continuing with the in-process default", {
      error: err instanceof Error ? err.message : err,
    });
  }

  // Velocity-breaker alerts → the operator inbox.
  //
  // `setAlertSink()` documented "configure a sink at boot" and no production
  // code did, so an `auto_pause` — the sticky breaker that silences a tenant's
  // fraud calling until a human resumes it — reached stderr and nothing else.
  // The inbox, dedupe and escalation ladder all existed; only the wiring was
  // missing.
  try {
    const { installAbuseAlertSink } = await import("@/lib/abuse/alert-sink");
    installAbuseAlertSink();
    logWarn("[abuse] breaker alerts route to the operator inbox", {
      detail: "auto_pause pages at 5-minute SLA; velocity warnings arrive as info.",
    });
  } catch (err) {
    logError("[abuse] alert sink install failed — auto-pauses will log only", {
      error: err instanceof Error ? err.message : err,
    });
  }

  // Axiom log shipping. Registered HERE, not imported by `safe-log` itself,
  // because `safe-log` is bundled into the edge proxy and the browser bundle
  // (`src/proxy.ts`, `src/lib/languages.ts`) where `server-only` and
  // `@axiomhq/js` must never appear. With AXIOM_TOKEN unset the sink is a no-op
  // and every log record still reaches stdout.
  if (process.env.AXIOM_TOKEN) {
    try {
      const { axiomLogSink, axiomDataset, axiomDiagnostics } =
        await import("@/lib/telemetry/axiom");
      registerLogSink(axiomLogSink);
      logWarn("[axiom] structured log shipping enabled", {
        dataset: axiomDataset(),
        diagnostics: axiomDiagnostics(),
      });
    } catch (err) {
      logError("[axiom] init failed — continuing without remote log shipping", {
        error: err instanceof Error ? err.message : err,
      });
    }
  } else {
    logWarn("[config] AXIOM_TOKEN unset", {
      detail: "structured logs stay on stdout; nothing is shipped to Axiom.",
    });
  }

  // Sentry is surfaced the moment the DSN env var exists, and ONLY then —
  // importing the Sentry SDK unconditionally at boot adds its transport
  // overhead to every request path even when a deployment has not opted in.
  if (process.env.SENTRY_DSN) {
    const { init } = await import("@sentry/nextjs");
    try {
      init({
        dsn: process.env.SENTRY_DSN,
        tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? "0.1"),
        environment: process.env.SENTRY_ENVIRONMENT ?? (process.env.NODE_ENV || "development"),
        serverName: process.env.RENDER_INSTANCE_ID ?? undefined,
        // Never send payloads: our bank-facing rows frequently contain an
        // SMS body or a partial transcript, and Sentry's own request-body
        // capture would transmit it off-platform.
        beforeSend(event) {
          // Scrub authorization headers from the request
          if (event.request?.headers) {
            const headers = event.request.headers as Record<string, unknown>;
            for (const k of Object.keys(headers)) {
              if (/authorization|auth|token|api.?key|secret|cookie/i.test(k)) {
                delete headers[k];
              }
            }
          }
          if (event.request?.data) delete event.request.data;
          if (event.extra) {
            for (const k of Object.keys(event.extra)) {
              if (/phone|email|merchant|amount|transcript|case_?ref|sms/i.test(k))
                delete (event.extra as any)[k];
            }
          }
          return event;
        },
      });
      logWarn("[sentry] initialised", {
        traces: process.env.SENTRY_TRACES_SAMPLE_RATE ?? "0.1",
        environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
      });
    } catch (err) {
      logError("[sentry] init failed — continuing without remote error capture", {
        error: err instanceof Error ? err.message : err,
      });
    }
  }

  // OpenTelemetry → Grafana Cloud, over the standard OTLP/HTTP variables.
  //
  // Three signals (traces, metrics, logs) ship when an endpoint and an
  // Authorization header are both configured; without them the SDK is a no-op and
  // the app runs without remote telemetry — the same "degrade loudly, never
  // silently" contract as every other optional subsystem here.
  //
  // Nothing is read from `process.env` in this block on purpose. `initOtel()`
  // logs its own verdict and the per-signal endpoints, and the day this file
  // kept a second copy of the endpoint name is the day the published status could
  // disagree with what the runtime actually did.
  try {
    const { initOtel } = await import("@/lib/telemetry/otel");
    initOtel();
  } catch (err) {
    logError("[otel] init failed — continuing without remote telemetry", {
      error: err instanceof Error ? err.message : err,
    });
  }

  // Both subsystems above batch, so both need a flush on the way out. The OTLP
  // SDK holds each signal until its scheduled delay, and Axiom buffers log
  // records. `shutdownOtel` and `flushAxiom` each documented "call this from a
  // SIGTERM handler" and were called by nothing — so a deploy dropped whatever
  // had not shipped yet, which is precisely the window covering the release that
  // is being deployed.
  //
  // Handed to the preload instead of registered as a signal handler here. This
  // process's SIGTERM is owned by scripts/server-preload.ts; a second listener
  // would either race its drain or keep the process alive past it. The preload
  // calls this after its drain window elapses and immediately before it exits,
  // which is the last moment anything can still be shipped.
  //
  // A shared global is not a convenience, it is the only seam that reaches the
  // live SDK. Two reasons, and the first is the hard one: the runner image ships
  // `.next/standalone` plus this one preload script (`scripts/copy-standalone.mjs`,
  // Dockerfile `FROM … AS runner`), so there is no `src/` there to import at all.
  // And even importing the compiled server's own file would not help — a fresh
  // `import()` makes a *second* module instance, whose `initialized` singleton is
  // null, so its shutdown would report a clean flush of nothing.
  registerExporterFlush(async () => {
    const [{ shutdownOtel }, { flushAxiom }] = await Promise.all([
      import("@/lib/telemetry/otel"),
      import("@/lib/telemetry/axiom"),
    ]);
    await Promise.all([shutdownOtel(), flushAxiom()]);
  });

  // The "did we forget to flip it?" class of failure — loud at every boot,
  // plus `bun run preflight` before any demo or go-live.
  if (process.env.ELEVENLABS_DRY_RUN === "true") {
    logWarn("[config] ELEVENLABS_DRY_RUN=true — NO real voice", {
      detail: "Flip to false before judges or real users.",
    });
  }
  if (!process.env.BETTER_AUTH_SECRET || process.env.BETTER_AUTH_SECRET.length < 32) {
    logWarn("[config] BETTER_AUTH_SECRET missing or under 32 chars", {
      detail: "auth will throw at import. Generate with: openssl rand -base64 32",
    });
  }

  if (!process.env.QSTASH_TOKEN) {
    logWarn("[config] QSTASH_TOKEN unset", {
      detail:
        "bank signals enqueue via the Postgres queue directly. Set QSTASH_TOKEN and QSTASH_CURRENT/NEXT_SIGNING_KEY to dispatch through Upstash.",
    });
  }
  if (!process.env.SENTRY_DSN) {
    logWarn("[config] SENTRY_DSN unset", {
      detail: "remote error capture is off for this deployment.",
    });
  }

  // Live-send preflight: the four gates that determine whether this deployment
  // can actually place a carrier call. These are warnings, not crashes, because
  // the reference deployment boots in audit-only mode without them.
  try {
    const { abuseConfig } = await import("@/lib/abuse/config");
    const { isE164 } = await import("@/lib/twilio");

    const geo = abuseConfig().geo;
    const upperAllowlist = geo.allowlist.map((c) => c.trim().toUpperCase()).filter(Boolean);
    if (upperAllowlist.length === 0) {
      logWarn("[config] ABUSE_ALLOWED_COUNTRIES is empty — no destination is diallable", {});
    } else if (!upperAllowlist.includes("US")) {
      logWarn("[config] ABUSE_ALLOWED_COUNTRIES does not include US", {
        allowlist: upperAllowlist.join(","),
      });
    }

    if (process.env.TWILIO_LIVE_SEND !== "true") {
      logWarn("[config] TWILIO_LIVE_SEND is not true — live calls are refused", {});
    }

    const fromNumber = process.env.TWILIO_FROM_NUMBER;
    if (!fromNumber || !isE164(fromNumber)) {
      logWarn("[config] TWILIO_FROM_NUMBER is missing or not E.164", {});
    }

    const defaultTier = abuseConfig().tier.defaultTier;
    const testNumbers = abuseConfig().tier.testNumbers;
    if (defaultTier === "demo" && testNumbers.length === 0) {
      logWarn(
        "[config] demo tier with no ABUSE_TEST_NUMBERS — only verified test numbers can be dialled",
        {},
      );
    }
  } catch (err) {
    logError("[config] live-send preflight failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
