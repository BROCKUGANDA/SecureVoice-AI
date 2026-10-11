import "server-only";

/**
 * Formal telecom adapter layer.
 *
 * One interface — `TelecomAdapter` — and one factory — `createTelecomAdapter(name)` —
 * standing in front of three carriers that agree on almost nothing:
 *
 *   - **Twilio** — form-encoded REST (`Calls.json`, `Messages.json`), HTTP Basic
 *     auth, a `sid` back.
 *   - **Infobip** — JSON REST (`/calls/1/calls`, `/sms/2/text/advanced`), an
 *     `Authorization: App <key>` header, an `id` back, and E.164 numbers with no
 *     leading `+`.
 *   - **SIP** — a voice protocol, not an HTTP API. This adapter speaks to a SIP
 *     trunk gateway's HTTP origination endpoint; there is no SIP stack here, and
 *     the adapter says so by refusing when no origination endpoint is bound.
 *
 * A caller never learns which of the three is underneath. It hands over a number
 * and gets a typed `TelecomResult`, or a typed refusal that names the reason —
 * never a thrown exception for an expected carrier failure, and never a
 * fabricated success. That is the point of the adapter: the carrier is a
 * configuration value, not a code path a caller branches on.
 *
 * ## Why a registry and not a `switch`
 *
 * `createTelecomAdapter` resolves a carrier through `TELECOM_ADAPTERS`, a
 * name-to-factory table, and `registerTelecomAdapter` can add one at runtime.
 * The factory imports no carrier module per branch, so adding a fourth provider
 * is a registry entry rather than an edit to a conditional — and a caller can
 * enumerate what is loadable (`Object.keys(TELECOM_ADAPTERS)`) without
 * constructing one.
 *
 * ## Honesty rules this file keeps
 *
 *   1. **A destination is validated before any credential is read and before
 *      any egress.** The E.164 check and its refusal string are copied VERBATIM
 *      from `@/lib/twilio` and `@/lib/ports/fakes` so a parity test can compare
 *      the three implementations byte for byte — see `validateE164`.
 *   2. **A missing credential is a typed refusal, not a thrown error and not a
 *      guessed default.** The refusal names the exact variable to set.
 *   3. **A channel a carrier does not have is refused, not faked.** SIP carries
 *      voice; `sendSms` on the SIP adapter returns a typed "not a SIP channel"
 *      refusal rather than dialling something plausible.
 *
 * ## Configuration
 *
 * Each factory reads its own environment by default and accepts an explicit
 * `TelecomAdapterConfig` override for everything, including the `fetch`
 * implementation — so an adapter is testable against a stub transport with no
 * credential and no carrier. The environment variable names mirror
 * `@/lib/twilio` and `@/lib/config.ts` (`TWILIO_ACCOUNT_SID`, …) so a deployment
 * that already configures Twilio configures this layer with the same variables.
 */

import type { AdapterMode } from "@/lib/ports/types";

// ── provider vocabulary ──────────────────────────────────────────────────────

/** The carriers this layer ships an adapter for. */
export const TELECOM_PROVIDERS = ["twilio", "infobip", "sip"] as const;

export type TelecomProvider = (typeof TELECOM_PROVIDERS)[number];

/** Which bearer a carrier can carry. One adapter advertises only what it has. */
export type TelecomChannel = "voice" | "sms";

/**
 * Aliases a caller may use that resolve to a canonical provider.
 *
 * `sip-trunk` is the name the WP-18 port vocabulary uses for this adapter
 * (`@/lib/ports/registry`), so accepting it here keeps one word for one thing
 * across the codebase.
 */
export const TELECOM_ALIASES: Readonly<Record<string, TelecomProvider>> = Object.freeze({
  "sip-trunk": "sip",
});

/** Narrow an arbitrary string to a known provider, resolving aliases. */
export function isTelecomProvider(value: string): value is TelecomProvider {
  return (TELECOM_PROVIDERS as readonly string[]).includes(resolveProviderName(value));
}

// ── configuration ────────────────────────────────────────────────────────────

/**
 * Everything a factory may be told, all optional.
 *
 * Every field falls back to an environment variable and then to a default, so
 * `createTelecomAdapter("twilio")` is complete the moment the Twilio variables
 * are set. Supplying a field here overrides both — which is how a test drives an
 * adapter against a stub `fetch` with no credential at all.
 */
export type TelecomAdapterConfig = {
  /** Sender / caller id. Twilio: a number or messaging service; Infobip: sender. */
  from?: string;
  /** Twilio account SID. */
  accountSid?: string;
  /** Twilio auth token (used when no API key pair is configured). */
  authToken?: string;
  /** Provider credential. Infobip API key, or a SIP gateway token. */
  apiKey?: string;
  /** Twilio messaging service SID; mutually exclusive with `from` on Twilio. */
  messagingServiceSid?: string;
  /** Base URL. Twilio API origin, Infobip base, or a SIP origination endpoint. */
  baseUrl?: string;
  /** Basic-auth username (SIP gateway, or an explicit override). */
  username?: string;
  /** Basic-auth password (SIP gateway, or an explicit override). */
  password?: string;
  /** Twilio only: inline TwiML to run on connect. Takes precedence over `callUrl`. */
  twiml?: string;
  /** Twilio only: URL Twilio fetches TwiML from on connect. */
  callUrl?: string;
  /** Request timeout in milliseconds. */
  timeoutMs?: number;
  /** Injected transport, for tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
};

// ── results ──────────────────────────────────────────────────────────────────

/**
 * The outcome of one carrier request.
 *
 * A typed union, mirroring `TelephonyResult` in `@/lib/ports/types`, so a caller
 * handles success and failure with one `if` and never has to tell "the carrier
 * said 401" from "the process threw". `id` is the carrier's own handle (`sid` on
 * Twilio, `id` on Infobip); `status` is its own status word.
 */
export type TelecomResult =
  | { ok: true; provider: TelecomProvider; channel: TelecomChannel; id: string; status: string }
  | {
      ok: false;
      provider: TelecomProvider;
      channel: TelecomChannel;
      status: number;
      error: string;
    };

/** A destination check: carrier-independent, and the only part provable offline. */
export type TelecomVerdict = { ok: true } | { ok: false; reason: string };

// ── the interface ────────────────────────────────────────────────────────────

/**
 * A carrier, reduced to the operations a caller needs.
 *
 * `adapterId` and `mode` mirror the port vocabulary in `@/lib/ports/types`: an
 * adapter says what it is, so a report can print the binding rather than infer
 * it. These are real adapters, so `mode` is always `"real"`.
 */
export interface TelecomAdapter {
  /** Stable adapter id, e.g. `telecom.twilio`. Written to logs and evidence. */
  readonly adapterId: string;
  /** Which carrier this adapter speaks to. */
  readonly provider: TelecomProvider;
  /** Real or fake, per the port convention. Always `"real"` here. */
  readonly mode: AdapterMode;
  /** The bearers this carrier supports. A channel absent here is refused, not faked. */
  readonly channels: readonly TelecomChannel[];
  /**
   * Destination check, evaluated BEFORE any credential lookup and before any
   * egress. On the interface rather than buried in an adapter because it is the
   * one telephony behaviour every carrier agrees on.
   */
  validateDestination(number: string): TelecomVerdict;
  /** Place an outbound voice call to an E.164 number. */
  placeCall(number: string): Promise<TelecomResult>;
  /** Send a text message to an E.164 number. */
  sendSms(number: string, message: string): Promise<TelecomResult>;
}

// ── shared checks ────────────────────────────────────────────────────────────

/** E.164, copied verbatim from `@/lib/twilio` so the two cannot drift. */
const E164 = /^\+[1-9]\d{7,14}$/;
/** The refusal string `@/lib/twilio` and `@/lib/ports/fakes` both return. */
const NOT_E164 = "Destination phone is not E.164";

/**
 * The one carrier-independent rule. Kept as a free function, with the exact
 * reason string the rest of the codebase uses, so a parity check can compare
 * this adapter, the Twilio adapter and the recording fake on the same input and
 * get the same bytes back.
 */
function validateE164(number: string): TelecomVerdict {
  return typeof number === "string" && E164.test(number)
    ? { ok: true }
    : { ok: false, reason: NOT_E164 };
}

/** A refused send, shaped like every other one. */
function refuse(
  provider: TelecomProvider,
  channel: TelecomChannel,
  status: number,
  error: string,
): TelecomResult {
  return { ok: false, provider, channel, status, error };
}

// ── Twilio ───────────────────────────────────────────────────────────────────

/**
 * The TwiML a call carries when the caller configured no script.
 *
 * Deliberately brand-free: this is a generic transport adapter, and baking a
 * bank's wording into it would make every deployment say the wrong thing. A
 * caller that wants a real script sets `config.twiml` (inline) or
 * `config.callUrl` (fetched), and that takes precedence.
 */
export const DEFAULT_CALL_TWIML =
  '<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="Polly.Joanna">This is an automated call. Goodbye.</Say></Response>';

/**
 * Twilio — the live-telephony path.
 *
 * Plain REST via `fetch`, no SDK: the v2010 API is form-encoded with HTTP Basic
 * auth. Runtime auth prefers the dedicated API key (`TWILIO_API_KEY_SID` /
 * `TWILIO_API_KEY_SECRET`, rotatable independently) and falls back to the master
 * `TWILIO_AUTH_TOKEN` — the same precedence `@/lib/twilio` uses.
 */
function createTwilioAdapter(config: TelecomAdapterConfig = {}): TelecomAdapter {
  const accountSid = config.accountSid ?? process.env.TWILIO_ACCOUNT_SID;
  const authToken = config.authToken ?? process.env.TWILIO_AUTH_TOKEN;
  const apiKeySid = process.env.TWILIO_API_KEY_SID;
  const apiKeySecret = process.env.TWILIO_API_KEY_SECRET;
  const username = config.username ?? (apiKeySid && apiKeySecret ? apiKeySid : accountSid);
  const password = config.password ?? (apiKeySid && apiKeySecret ? apiKeySecret : authToken);
  const from = config.from ?? process.env.TWILIO_FROM_NUMBER;
  const messagingServiceSid =
    config.messagingServiceSid ?? process.env.TWILIO_MESSAGING_SERVICE_SID;
  const baseUrl = trimTrailingSlash(
    config.baseUrl ?? process.env.TWILIO_API_BASE_URL ?? "https://api.twilio.com",
  );
  const twiml = config.twiml;
  const callUrl = config.callUrl ?? process.env.TWILIO_CALL_URL;
  const timeoutMs = config.timeoutMs ?? readPositiveInt(process.env.TWILIO_TIMEOUT_MS, 10_000);
  const fetchImpl = config.fetchImpl ?? fetch;

  const credentialRefusal = (channel: TelecomChannel): TelecomResult =>
    refuse(
      "twilio",
      channel,
      401,
      "twilio: TWILIO_ACCOUNT_SID and a credential (TWILIO_AUTH_TOKEN or TWILIO_API_KEY_SID/SECRET) must be configured",
    );

  return {
    adapterId: "telecom.twilio",
    provider: "twilio",
    mode: "real",
    channels: ["voice", "sms"],
    validateDestination: validateE164,

    async placeCall(number: string): Promise<TelecomResult> {
      const verdict = validateE164(number);
      if (!verdict.ok) return refuse("twilio", "voice", 422, verdict.reason);
      if (!accountSid || !username || !password) return credentialRefusal("voice");
      if (!from)
        return refuse("twilio", "voice", 422, "twilio: TWILIO_FROM_NUMBER is not configured");

      const params: Record<string, string> = { To: number, From: from };
      if (twiml) params.Twiml = twiml;
      else if (callUrl) params.Url = callUrl;
      else params.Twiml = DEFAULT_CALL_TWIML;

      const outcome = await postForm(`${baseUrl}/2010-04-01/Accounts/${accountSid}/Calls.json`, {
        auth: basicAuth(username, password),
        params,
        timeoutMs,
        fetchImpl,
      });
      if (!outcome.ok) return refuse("twilio", "voice", outcome.status, `twilio: ${outcome.error}`);
      return {
        ok: true,
        provider: "twilio",
        channel: "voice",
        id: String(pick(outcome.body, "sid") ?? ""),
        status: String(pick(outcome.body, "status") ?? "queued"),
      };
    },

    async sendSms(number: string, message: string): Promise<TelecomResult> {
      const verdict = validateE164(number);
      if (!verdict.ok) return refuse("twilio", "sms", 422, verdict.reason);
      if (!accountSid || !username || !password) return credentialRefusal("sms");
      if (typeof message !== "string" || message.trim().length === 0) {
        return refuse("twilio", "sms", 422, "twilio: message must be a non-empty string");
      }
      if (!messagingServiceSid && !from) {
        return refuse(
          "twilio",
          "sms",
          422,
          "twilio: TWILIO_MESSAGING_SERVICE_SID or TWILIO_FROM_NUMBER must be configured",
        );
      }

      // A Messaging Service and an explicit `From` are mutually exclusive on
      // Twilio's side; a service chooses the sender itself.
      const params: Record<string, string> = { To: number, Body: message };
      if (messagingServiceSid) params.MessagingServiceSid = messagingServiceSid;
      else params.From = from!;

      const outcome = await postForm(`${baseUrl}/2010-04-01/Accounts/${accountSid}/Messages.json`, {
        auth: basicAuth(username, password),
        params,
        timeoutMs,
        fetchImpl,
      });
      if (!outcome.ok) return refuse("twilio", "sms", outcome.status, `twilio: ${outcome.error}`);
      return {
        ok: true,
        provider: "twilio",
        channel: "sms",
        id: String(pick(outcome.body, "sid") ?? ""),
        status: String(pick(outcome.body, "status") ?? "queued"),
      };
    },
  };
}

// ── Infobip ──────────────────────────────────────────────────────────────────

/**
 * Infobip — JSON REST for both voice and SMS.
 *
 * Auth is `Authorization: App <API_KEY>`. Numbers are sent WITHOUT the leading
 * `+` (Infobip's E.164 fields omit it), so `toInfobipNumber` strips it at the
 * boundary — the caller still speaks canonical E.164 in, and the adapter
 * translates.
 */
function createInfobipAdapter(config: TelecomAdapterConfig = {}): TelecomAdapter {
  const apiKey = config.apiKey ?? process.env.INFOBIP_API_KEY;
  const baseUrl = trimTrailingSlash(
    config.baseUrl ?? process.env.INFOBIP_BASE_URL ?? "https://api.infobip.com",
  );
  const from = config.from ?? process.env.INFOBIP_FROM;
  const timeoutMs = config.timeoutMs ?? readPositiveInt(process.env.INFOBIP_TIMEOUT_MS, 10_000);
  const fetchImpl = config.fetchImpl ?? fetch;

  const credentialRefusal = (channel: TelecomChannel): TelecomResult =>
    refuse("infobip", channel, 401, "infobip: INFOBIP_API_KEY is not configured");

  const headers = (): Record<string, string> => ({
    authorization: `App ${apiKey ?? ""}`,
    "content-type": "application/json",
    accept: "application/json",
  });

  return {
    adapterId: "telecom.infobip",
    provider: "infobip",
    mode: "real",
    channels: ["voice", "sms"],
    validateDestination: validateE164,

    async placeCall(number: string): Promise<TelecomResult> {
      const verdict = validateE164(number);
      if (!verdict.ok) return refuse("infobip", "voice", 422, verdict.reason);
      if (!apiKey) return credentialRefusal("voice");
      if (!from) return refuse("infobip", "voice", 422, "infobip: INFOBIP_FROM is not configured");

      const outcome = await postJson(`${baseUrl}/calls/1/calls`, {
        headers: headers(),
        body: {
          endpoint: { type: "PHONE", phoneNumber: toInfobipNumber(number) },
          from: toInfobipNumber(from),
          connectTimeout: 30,
        },
        timeoutMs,
        fetchImpl,
      });
      if (!outcome.ok)
        return refuse("infobip", "voice", outcome.status, `infobip: ${outcome.error}`);
      return {
        ok: true,
        provider: "infobip",
        channel: "voice",
        id: String(pick(outcome.body, "id") ?? ""),
        status: infobipStatus(outcome.body),
      };
    },

    async sendSms(number: string, message: string): Promise<TelecomResult> {
      const verdict = validateE164(number);
      if (!verdict.ok) return refuse("infobip", "sms", 422, verdict.reason);
      if (!apiKey) return credentialRefusal("sms");
      if (typeof message !== "string" || message.trim().length === 0) {
        return refuse("infobip", "sms", 422, "infobip: message must be a non-empty string");
      }
      if (!from) return refuse("infobip", "sms", 422, "infobip: INFOBIP_FROM is not configured");

      const outcome = await postJson(`${baseUrl}/sms/2/text/advanced`, {
        headers: headers(),
        body: {
          messages: [{ destinations: [{ to: toInfobipNumber(number) }], from, text: message }],
        },
        timeoutMs,
        fetchImpl,
      });
      if (!outcome.ok) return refuse("infobip", "sms", outcome.status, `infobip: ${outcome.error}`);
      const first = firstMessage(outcome.body);
      return {
        ok: true,
        provider: "infobip",
        channel: "sms",
        id: String(pick(first, "messageId") ?? ""),
        status: infobipStatus(first),
      };
    },
  };
}

// ── SIP ──────────────────────────────────────────────────────────────────────

/**
 * SIP — a voice protocol, not an HTTP API.
 *
 * There is no SIP stack in this repository, so this adapter is honest about what
 * it is: an HTTP bridge to a SIP trunk gateway's origination endpoint
 * (`SIP_TRUNK_ORIGINATION_URL`). With no endpoint bound, `placeCall` refuses with
 * a typed 503 rather than pretending a trunk exists.
 *
 * SIP carries VOICE. `sendSms` therefore returns a typed "not a SIP channel"
 * refusal — a SIP adapter that dialled something and called it an SMS would be a
 * lie a caller could not detect.
 */
function createSipAdapter(config: TelecomAdapterConfig = {}): TelecomAdapter {
  const originationUrl = config.baseUrl ?? process.env.SIP_TRUNK_ORIGINATION_URL;
  const username = config.username ?? process.env.SIP_TRUNK_USERNAME;
  const password = config.password ?? process.env.SIP_TRUNK_PASSWORD;
  const from = config.from ?? process.env.SIP_TRUNK_FROM;
  const timeoutMs = config.timeoutMs ?? readPositiveInt(process.env.SIP_TRUNK_TIMEOUT_MS, 10_000);
  const fetchImpl = config.fetchImpl ?? fetch;

  return {
    adapterId: "telecom.sip-trunk",
    provider: "sip",
    mode: "real",
    channels: ["voice"],
    validateDestination: validateE164,

    async placeCall(number: string): Promise<TelecomResult> {
      const verdict = validateE164(number);
      if (!verdict.ok) return refuse("sip", "voice", 422, verdict.reason);
      if (!originationUrl) {
        return refuse(
          "sip",
          "voice",
          503,
          "sip: SIP_TRUNK_ORIGINATION_URL is not configured — no SIP trunk origination endpoint is bound",
        );
      }

      const headers: Record<string, string> = {
        "content-type": "application/json",
        accept: "application/json",
      };
      if (username && password) headers.authorization = basicAuth(username, password);

      const outcome = await postJson(originationUrl, {
        headers,
        body: { to: number, from: from ?? null, channel: "voice" },
        timeoutMs,
        fetchImpl,
      });
      if (!outcome.ok) return refuse("sip", "voice", outcome.status, `sip: ${outcome.error}`);
      return {
        ok: true,
        provider: "sip",
        channel: "voice",
        id: String(pick(outcome.body, "id") ?? pick(outcome.body, "callId") ?? ""),
        status: String(pick(outcome.body, "status") ?? "queued"),
      };
    },

    async sendSms(number: string, _message: string): Promise<TelecomResult> {
      const verdict = validateE164(number);
      if (!verdict.ok) return refuse("sip", "sms", 422, verdict.reason);
      return refuse(
        "sip",
        "sms",
        501,
        "sip: SIP trunking carries voice only — SMS is not a SIP channel; use a messaging provider",
      );
    },
  };
}

// ── the registry and the factory ─────────────────────────────────────────────

/** A function that builds a configured adapter for one carrier. */
export type TelecomAdapterFactory = (config?: TelecomAdapterConfig) => TelecomAdapter;

/**
 * The open registry, keyed by lower-cased provider name.
 *
 * It is deliberately a mutable `Record` rather than a frozen one:
 * `registerTelecomAdapter` extends it, so a carrier shipped outside this file is
 * loadable through the same factory as the built-ins. `Object.keys(TELECOM_ADAPTERS)`
 * is the loadable set.
 */
export const TELECOM_ADAPTERS: Record<string, TelecomAdapterFactory> = {
  twilio: createTwilioAdapter,
  infobip: createInfobipAdapter,
  sip: createSipAdapter,
};

/**
 * Add or replace a carrier factory. The name is normalised (trimmed, lower
 * cased) so `"Twilio"` and `"twilio"` cannot become two entries.
 */
export function registerTelecomAdapter(provider: string, factory: TelecomAdapterFactory): void {
  const key = resolveProviderName(provider);
  if (key.length === 0) {
    throw new TypeError("registerTelecomAdapter: provider name must be a non-empty string");
  }
  if (typeof factory !== "function") {
    throw new TypeError("registerTelecomAdapter: factory must be a function");
  }
  TELECOM_ADAPTERS[key] = factory;
}

/**
 * Resolve an adapter by carrier name.
 *
 * An unknown name is a `TypeError` at construction, not a runtime failure mid
 * call: a caller that typo'd a carrier wants to hear about it before it sends a
 * request, and the message names every carrier that IS loadable. Aliases
 * (`sip-trunk` → `sip`) resolve here, so the port vocabulary and this factory
 * agree.
 */
export function createTelecomAdapter(
  provider: string,
  config: TelecomAdapterConfig = {},
): TelecomAdapter {
  const key = resolveProviderName(provider);
  const factory = TELECOM_ADAPTERS[key];
  if (typeof factory !== "function") {
    throw new TypeError(
      `createTelecomAdapter: unknown provider ${JSON.stringify(provider)}; ` +
        `known providers: ${Object.keys(TELECOM_ADAPTERS).sort().join(", ")}`,
    );
  }
  return factory(config);
}

// ── internals ────────────────────────────────────────────────────────────────

type HttpOutcome =
  { ok: true; status: number; body: unknown } | { ok: false; status: number; error: string };

/** POST a JSON body and normalise every outcome into one shape. */
function postJson(
  url: string,
  args: {
    headers: Record<string, string>;
    body: unknown;
    timeoutMs: number;
    fetchImpl: typeof fetch;
  },
): Promise<HttpOutcome> {
  return sendRequest(url, {
    headers: args.headers,
    body: JSON.stringify(args.body),
    timeoutMs: args.timeoutMs,
    fetchImpl: args.fetchImpl,
  });
}

/** POST a form-encoded body with HTTP Basic auth (Twilio's wire format). */
function postForm(
  url: string,
  args: {
    auth: string;
    params: Record<string, string>;
    timeoutMs: number;
    fetchImpl: typeof fetch;
  },
): Promise<HttpOutcome> {
  return sendRequest(url, {
    headers: {
      authorization: args.auth,
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: new URLSearchParams(args.params).toString(),
    timeoutMs: args.timeoutMs,
    fetchImpl: args.fetchImpl,
  });
}

/**
 * The single place an HTTP request leaves this module.
 *
 * A transport failure becomes `status: 0` rather than a thrown exception so the
 * caller has ONE failure shape to reason about, and so "the network was down" is
 * distinguishable from "the carrier said 400". The body is parsed defensively: a
 * non-JSON error page is still an error, not a parse crash.
 */
async function sendRequest(
  url: string,
  init: {
    headers: Record<string, string>;
    body: string;
    timeoutMs: number;
    fetchImpl: typeof fetch;
  },
): Promise<HttpOutcome> {
  let res: Response;
  try {
    res = await init.fetchImpl(url, {
      method: "POST",
      headers: init.headers,
      body: init.body,
      signal: AbortSignal.timeout(init.timeoutMs),
    });
  } catch (err) {
    return { ok: false, status: 0, error: `network error: ${errorMessage(err)}` };
  }

  const text = await res.text().catch(() => "");
  let body: unknown = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      error: carrierErrorMessage(body) ?? `HTTP ${res.status}`,
    };
  }
  return { ok: true, status: res.status, body };
}

/** Read one field off a parsed body, or `undefined`. */
function pick(body: unknown, key: string): unknown {
  if (!body || typeof body !== "object") return undefined;
  return (body as Record<string, unknown>)[key];
}

/** The first message object of an Infobip advanced-SMS reply. */
function firstMessage(body: unknown): unknown {
  const messages = pick(body, "messages");
  return Array.isArray(messages) ? messages[0] : undefined;
}

/** Infobip's status word, from either the SMS or the Calls shape. */
function infobipStatus(body: unknown): string {
  const status = pick(body, "status");
  if (typeof status === "string") return status;
  const name = pick(status, "name") ?? pick(status, "groupName");
  return typeof name === "string" ? name : "PENDING";
}

/** Infobip E.164 fields omit the leading `+`; the caller still speaks canonical E.164. */
function toInfobipNumber(number: string): string {
  return number.replace(/^\+/, "");
}

/** A non-2xx body's human message, bounded, or `null` when it carries none. */
function carrierErrorMessage(body: unknown): string | null {
  if (typeof body === "string") return body.slice(0, 300) || null;
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  const err = record.error;
  if (typeof err === "string") return err.slice(0, 300);
  if (err && typeof err === "object") {
    const message = (err as Record<string, unknown>).message;
    if (typeof message === "string") return message.slice(0, 300);
  }
  if (typeof record.message === "string") return record.message.slice(0, 300);
  return null;
}

function basicAuth(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function resolveProviderName(provider: string): string {
  const key = typeof provider === "string" ? provider.trim().toLowerCase() : "";
  return TELECOM_ALIASES[key] ?? key;
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A positive integer from an env string, or the fallback. */
function readPositiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}
