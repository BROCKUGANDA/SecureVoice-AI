/**
 * THE CARRIER SEAM — three real adapters, one interface, and a refusal shaped
 * exactly like a success.
 *
 * `src/lib/adapters/telecom-adapter.ts` is the seam a second carrier plugs into
 * (checklist #401-#450: adapters, and #118: multi-carrier). Two properties make it
 * worth testing rather than eyeballing:
 *
 *   1. NOTHING HERE THROWS AT A CALLER. A missing credential, a carrier 500, a
 *      dead network and an unsupported channel all come back as the same typed
 *      union `placeCall` returns on success. A provider that throws mid-fraud-call
 *      is a different failure in every call site; a provider that returns a
 *      refusal is one `if`. `status: 0` for "the network was down" is kept
 *      distinct from "the carrier said 400" because the runbook differs.
 *   2. AN ADAPTER ADVERTISES ONLY WHAT IT CARRIES. SIP returns 501 for SMS rather
 *      than dialling something and calling it a message. A fake success is the
 *      failure mode a caller cannot detect from the outside, and it is the one
 *      this file is built to avoid.
 *
 * Every request is driven through an injected `fetchImpl`, so no test here can
 * reach a carrier. Config overrides are passed explicitly rather than through
 * env, so the assertions do not depend on whose `.env` is loaded — except the
 * API-key-precedence test, which is about env by definition.
 */
import { describe, expect, test } from "bun:test";
import {
  createTelecomAdapter,
  DEFAULT_CALL_TWIML,
  isTelecomProvider,
  registerTelecomAdapter,
  TELECOM_ADAPTERS,
  TELECOM_PROVIDERS,
  type TelecomAdapterConfig,
} from "@/lib/adapters/telecom-adapter";

type Captured = { url: string; method: string; headers: Record<string, string>; body: string };

/** A transport that records the request and answers with a canned response. */
function transport(
  response: { status?: number; body?: unknown } = {
    status: 200,
    body: { sid: "SM_ok", status: "queued" },
  },
): { fetchImpl: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      body: String(init?.body ?? ""),
    });
    return new Response(
      typeof response.body === "string" ? response.body : JSON.stringify(response.body ?? {}),
      {
        status: response.status ?? 200,
      },
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const TWILIO_BASE = { accountSid: "AC_test", authToken: "token_test", from: "+15005550006" };

function form(body: string): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(body));
}

describe("the factory", () => {
  test("resolves every built-in, its alias, and any casing of it", () => {
    for (const name of TELECOM_PROVIDERS) {
      expect(createTelecomAdapter(name).provider).toBe(name);
    }
    expect(createTelecomAdapter("  Twilio ").provider).toBe("twilio");
    // `sip-trunk` is the WP-18 port vocabulary's name for the same adapter.
    expect(createTelecomAdapter("sip-trunk").adapterId).toBe("telecom.sip-trunk");
    expect(isTelecomProvider("sip-trunk")).toBe(true);
    expect(isTelecomProvider("vonage")).toBe(false);
  });

  test("an unknown carrier is refused at construction, naming what IS loadable", () => {
    expect(() => createTelecomAdapter("vonage")).toThrow(TypeError);
    const message = ((): string => {
      try {
        createTelecomAdapter("vonage");
      } catch (e) {
        return (e as Error).message;
      }
      return "";
    })();
    for (const known of Object.keys(TELECOM_ADAPTERS)) {
      expect(message).toContain(known);
    }
  });

  test("a carrier shipped outside this file becomes loadable through the same factory", () => {
    registerTelecomAdapter("  Vonage ", () => createTelecomAdapter("twilio", TWILIO_BASE));
    expect(createTelecomAdapter("vonage").provider).toBe("twilio");
    expect(() => registerTelecomAdapter("", () => createTelecomAdapter("twilio"))).toThrow(
      TypeError,
    );
    expect(() => registerTelecomAdapter("x", undefined as never)).toThrow(TypeError);
    delete TELECOM_ADAPTERS["vonage"];
    expect(() => createTelecomAdapter("vonage")).toThrow(TypeError);
  });
});

describe("the one carrier-independent rule", () => {
  test("every adapter refuses a non-E.164 destination with the same bytes", () => {
    // The parity claim: a caller may compare the Twilio adapter, the Infobip
    // adapter and the recording fake on one input and get one answer.
    const reason = "Destination phone is not E.164";
    for (const name of [...TELECOM_PROVIDERS]) {
      const adapter = createTelecomAdapter(name, {
        ...TWILIO_BASE,
        fetchImpl: transport().fetchImpl,
      });
      for (const bad of ["", "5005550006", "+0123", "+1", "not-a-number", "+1 500 555 0006"]) {
        expect(adapter.validateDestination(bad), `${name} ${bad}`).toEqual({ ok: false, reason });
      }
      expect(adapter.validateDestination("+15005550006")).toEqual({ ok: true });
    }
  });

  test("a bad destination never reaches the transport", async () => {
    const t = transport();
    const twilio = createTelecomAdapter("twilio", { ...TWILIO_BASE, fetchImpl: t.fetchImpl });
    const res = await twilio.placeCall("5005550006");

    expect(res.ok).toBe(false);
    expect(!res.ok && res.status).toBe(422);
    expect(t.calls).toHaveLength(0);
  });
});

describe("twilio", () => {
  test("posts the v2010 form shape to the account's Calls endpoint with Basic auth", async () => {
    const t = transport({ status: 201, body: { sid: "CA_1", status: "queued" } });
    const twilio = createTelecomAdapter("twilio", { ...TWILIO_BASE, fetchImpl: t.fetchImpl });

    const res = await twilio.placeCall("+971501234567");

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.id).toBe("CA_1");
      expect(res.status).toBe("queued");
      expect(res.provider).toBe("twilio");
      expect(res.channel).toBe("voice");
    }
    expect(t.calls[0]!.url).toBe("https://api.twilio.com/2010-04-01/Accounts/AC_test/Calls.json");
    expect(t.calls[0]!.method).toBe("POST");
    expect(t.calls[0]!.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(t.calls[0]!.headers.authorization).toBe(
      `Basic ${Buffer.from("AC_test:token_test").toString("base64")}`,
    );
    const sent = form(t.calls[0]!.body);
    expect(sent.To).toBe("+971501234567");
    expect(sent.From).toBe("+15005550006");
    // A transport adapter has no opinion on what a bank says, so the default
    // script is brand-free — and it is still a script, not an empty call.
    expect(sent.Twiml).toBe(DEFAULT_CALL_TWIML);
    expect(sent.Twiml).toContain("This is an automated call");
  });

  test("inline TwiML beats a call URL, and both beat the default", async () => {
    const withTwiml = transport();
    await createTelecomAdapter("twilio", {
      ...TWILIO_BASE,
      twiml: "<Response><Say>custom</Say></Response>",
      callUrl: "https://example.test/twiml",
      fetchImpl: withTwiml.fetchImpl,
    }).placeCall("+15005550006");
    const sentTwiml = form(withTwiml.calls[0]!.body);
    expect(sentTwiml.Twiml).toContain("custom");
    expect(sentTwiml.Url).toBeUndefined();

    const urlOnly = transport();
    await createTelecomAdapter("twilio", {
      ...TWILIO_BASE,
      callUrl: "https://example.test/twiml",
      fetchImpl: urlOnly.fetchImpl,
    }).placeCall("+15005550006");
    expect(form(urlOnly.calls[0]!.body).Url).toBe("https://example.test/twiml");
  });

  test("an API key pair is preferred over the master auth token", async () => {
    const prior = {
      SID: process.env.TWILIO_API_KEY_SID,
      SECRET: process.env.TWILIO_API_KEY_SECRET,
    };
    process.env.TWILIO_API_KEY_SID = "SK_test";
    process.env.TWILIO_API_KEY_SECRET = "secret_test";
    try {
      const t = transport();
      await createTelecomAdapter("twilio", { ...TWILIO_BASE, fetchImpl: t.fetchImpl }).placeCall(
        "+15005550006",
      );
      expect(t.calls[0]!.headers.authorization).toBe(
        `Basic ${Buffer.from("SK_test:secret_test").toString("base64")}`,
      );
    } finally {
      if (prior.SID === undefined) delete process.env.TWILIO_API_KEY_SID;
      else process.env.TWILIO_API_KEY_SID = prior.SID;
      if (prior.SECRET === undefined) delete process.env.TWILIO_API_KEY_SECRET;
      else process.env.TWILIO_API_KEY_SECRET = prior.SECRET;
    }
  });

  test("a missing credential is a typed 401 refusal, not a throw and not a request", async () => {
    const t = transport();
    const bare = createTelecomAdapter("twilio", { fetchImpl: t.fetchImpl });

    const voice = await bare.placeCall("+15005550006");
    const sms = await bare.sendSms("+15005550006", "code 1234");

    expect(!voice.ok && voice.status).toBe(401);
    expect(!sms.ok && sms.status).toBe(401);
    expect(t.calls).toHaveLength(0);
  });

  test("a Messaging Service and an explicit From are never both sent", async () => {
    const t = transport();
    await createTelecomAdapter("twilio", {
      ...TWILIO_BASE,
      messagingServiceSid: "MG_test",
      fetchImpl: t.fetchImpl,
    }).sendSms("+971501234567", "Your card was restricted.");

    const sent = form(t.calls[0]!.body);
    expect(sent.MessagingServiceSid).toBe("MG_test");
    expect(sent.From).toBeUndefined();
    expect(sent.Body).toBe("Your card was restricted.");
  });

  test("an empty message is refused before egress", async () => {
    const t = transport();
    const twilio = createTelecomAdapter("twilio", { ...TWILIO_BASE, fetchImpl: t.fetchImpl });
    const res = await twilio.sendSms("+15005550006", "   ");
    expect(res.ok).toBe(false);
    expect(t.calls).toHaveLength(0);
  });
});

describe("infobip", () => {
  const cfg = (fetchImpl: typeof fetch): TelecomAdapterConfig => ({
    apiKey: "info_key",
    from: "+971800123456",
    fetchImpl,
  });

  test("authenticates with the App scheme and strips the leading plus it does not want", async () => {
    const t = transport({ status: 200, body: { id: "call_9", status: "RINGING" } });
    const res = await createTelecomAdapter("infobip", cfg(t.fetchImpl)).placeCall("+971501234567");

    expect(t.calls[0]!.url).toBe("https://api.infobip.com/calls/1/calls");
    expect(t.calls[0]!.headers.authorization).toBe("App info_key");
    expect(t.calls[0]!.headers["content-type"]).toBe("application/json");
    const body = JSON.parse(t.calls[0]!.body) as {
      endpoint: { phoneNumber: string };
      from: string;
    };
    expect(body.endpoint.phoneNumber).toBe("971501234567");
    expect(body.from).toBe("971800123456");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.status).toBe("RINGING");
  });

  test("reads the SMS id and status out of the first message of an advanced reply", async () => {
    const t = transport({
      body: { messages: [{ messageId: "mid_1", status: { groupName: "SENT", name: "OK" } }] },
    });
    const res = await createTelecomAdapter("infobip", cfg(t.fetchImpl)).sendSms(
      "+971501234567",
      "alert",
    );

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.id).toBe("mid_1");
      // `status.name` is the specific word and wins; `groupName` is the phase.
      expect(res.status).toBe("OK");
    }
    const body = JSON.parse(t.calls[0]!.body) as { messages: { destinations: { to: string }[] }[] };
    expect(body.messages[0]!.destinations[0]!.to).toBe("971501234567");
  });

  test("an SMS reply carrying only a group phase still reports a status", async () => {
    const t = transport({
      body: { messages: [{ messageId: "mid_2", status: { groupName: "PENDING" } }] },
    });
    const res = await createTelecomAdapter("infobip", cfg(t.fetchImpl)).sendSms(
      "+971501234567",
      "x",
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.status).toBe("PENDING");
  });
});

describe("sip", () => {
  test("advertises voice only and refuses SMS as a channel it does not carry", async () => {
    const t = transport();
    const sip = createTelecomAdapter("sip", { fetchImpl: t.fetchImpl });

    expect(sip.channels).toEqual(["voice"]);
    const res = await sip.sendSms("+971501234567", "hello");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(501);
      expect(res.error).toContain("SIP trunking carries voice only");
    }
    // Refusing is not dialling something and calling it a message.
    expect(t.calls).toHaveLength(0);
  });

  test("an unbound trunk is a typed 503, never a silent success", async () => {
    const t = transport();
    const res = await createTelecomAdapter("sip", { fetchImpl: t.fetchImpl }).placeCall(
      "+971501234567",
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(503);
      expect(res.error).toContain("SIP_TRUNK_ORIGINATION_URL");
    }
  });

  test("a bound trunk posts the canonical number and takes the carrier's id", async () => {
    const t = transport({ body: { callId: "sip_42", status: "RINGING" } });
    const res = await createTelecomAdapter("sip", {
      baseUrl: "https://trunk.example.com/originate",
      username: "u",
      password: "p",
      from: "+971800123456",
      fetchImpl: t.fetchImpl,
    }).placeCall("+971501234567");

    // The bound endpoint is used verbatim: it is a full origination URL, and a
    // path appended to it would point at a route nobody configured.
    expect(t.calls[0]!.url).toBe("https://trunk.example.com/originate");
    expect(JSON.parse(t.calls[0]!.body)).toEqual({
      to: "+971501234567",
      from: "+971800123456",
      channel: "voice",
    });
    expect(t.calls[0]!.headers.authorization).toBe(
      `Basic ${Buffer.from("u:p").toString("base64")}`,
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.id).toBe("sip_42");
  });
});

describe("failure shapes a caller can reason about", () => {
  test("a carrier 500 keeps its status and names its provider", async () => {
    const t = transport({ status: 500, body: { error: { message: "upstream unavailable" } } });
    const res = await createTelecomAdapter("twilio", {
      ...TWILIO_BASE,
      fetchImpl: t.fetchImpl,
    }).placeCall("+15005550006");

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(500);
      expect(res.error).toBe("twilio: upstream unavailable");
      expect(res.provider).toBe("twilio");
    }
  });

  test("a transport failure is status 0, distinguishable from a carrier 400", async () => {
    const dead = (async () => {
      throw new Error("connect ECONNREFUSED");
    }) as unknown as typeof fetch;
    const res = await createTelecomAdapter("twilio", {
      ...TWILIO_BASE,
      fetchImpl: dead,
    }).placeCall("+15005550006");

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(0);
      expect(res.error).toContain("network error");
      expect(res.error).toContain("ECONNREFUSED");
    }
  });

  test("an HTML error page is an error, not a parse crash", async () => {
    const t = transport({ status: 502, body: "<html><body>Bad Gateway</body></html>" });
    const res = await createTelecomAdapter("infobip", {
      apiKey: "k",
      from: "+15005550006",
      fetchImpl: t.fetchImpl,
    }).placeCall("+15005550006");

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(502);
  });

  test("a body that is not JSON still yields the carrier's own status", async () => {
    const t = transport({ status: 200, body: "not json at all" });
    const res = await createTelecomAdapter("twilio", {
      ...TWILIO_BASE,
      fetchImpl: t.fetchImpl,
    }).placeCall("+15005550006");
    // Success with an unreadable body is an empty id, and that is honest: the
    // call was accepted, we just cannot name it.
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.id).toBe("");
  });

  test("a request that never answers is bounded by the timeout, not left hanging", async () => {
    const never = ((...args: unknown[]) => {
      const init = args[1] as { signal?: AbortSignal };
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("The operation aborted.")));
      });
    }) as unknown as typeof fetch;

    const res = await Promise.race([
      createTelecomAdapter("twilio", {
        ...TWILIO_BASE,
        timeoutMs: 40,
        fetchImpl: never,
      }).placeCall("+15005550006"),
      // Annotated so the race resolves to `TelecomResult | string` instead of
      // `unknown`; the sentinel is what the `typeof` check below narrows away.
      new Promise<string>((resolve) => setTimeout(() => resolve("HUNG"), 1_500)),
    ]);

    expect(res).not.toBe("HUNG");
    if (typeof res !== "string") expect(res.ok).toBe(false);
  });
});
