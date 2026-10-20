#!/usr/bin/env bun
/**
 * bun run integrations:check — can this deployment actually reach everything it
 * claims to integrate with, with credentials that authenticate?
 *
 * WHY. The platform talks to roughly a dozen external vendors and a handful of
 * internal services, and until now the only way to find out whether one of them was
 * reachable was for a customer-facing path to hit it. A wrong host, a rotated key, a
 * variable left as an empty string in `.env`, or a tenant credential that 401s all
 * looked identical from the outside: a feature that quietly does not work. The
 * health endpoint cannot tell you any of it, because `/api/health` only asserts this
 * process is up.
 *
 * CONTRACT.
 *   · Read-only. Every probe is a GET or a PING, plus one `describe_index_stats`
 *     POST that reads a vector count and writes nothing. Nothing is created,
 *     sent, dialed, billed or mutated — no outbound call, no email, no webhooks,
 *     no Pinecone upsert. A run of this script is safe at any time, including
 *     during a live call.
 *   · No credential is ever printed. A system reports `configured` with the
 *     length of its secret, never the secret.
 *   · `required` is decided per system, not assumed: an optional vendor that is
 *     absent reports SKIP, so the exit code stays meaningful.
 *   · Every probe has its own timeout. One vendor hanging must not turn a
 *     diagnostic into an outage, and a 30s default would make the whole check
 *     unverifiable interactively.
 *
 * EXIT. 0 = every required system answered. 1 = at least one required system
 * failed or is missing. 2 = the script itself could not run.
 */

const TIMEOUT_MS = Number(process.env.INTEGRATIONS_CHECK_TIMEOUT_MS || 12_000);

/** Systems whose absence breaks a customer-facing promise, vs nice to have. */
const SYSTEMS = [
  { name: "elevenlabs.tts", group: "vendor", required: true, probe: "elevenlabsSubscription" },
  {
    name: "elevenlabs.agent",
    group: "vendor",
    required: true,
    probe: "elevenlabsAgent",
    needs: ["ELEVENLABS_AGENT_ID"],
  },
  { name: "elevenlabs.voices", group: "vendor", required: true, probe: "elevenlabsVoices" },
  { name: "elevenlabs.stt", group: "vendor", required: false, probe: "elevenlabsSttModels" },
  { name: "twilio.account", group: "vendor", required: true, probe: "twilioAccount" },
  { name: "pinecone.index", group: "vendor", required: true, probe: "pineconeIndexes" },
  { name: "deepgram", group: "vendor", required: false, probe: "deepgramProjects" },
  { name: "paddle", group: "vendor", required: false, probe: "paddleCatalog" },
  { name: "resend", group: "vendor", required: false, probe: "resendDomains" },
  { name: "llm.groq", group: "vendor", required: false, probe: "groqModels" },
  { name: "llm.gemini", group: "vendor", required: false, probe: "geminiModels" },
  { name: "langfuse", group: "observability", required: false, probe: "langfuseHealth" },
  { name: "axiom", group: "observability", required: false, probe: "axiomDatasets" },
  { name: "sentry.dsn", group: "observability", required: false, probe: "sentryDsnShape" },
  { name: "db.postgres", group: "internal", required: true, probe: "postgres" },
  { name: "db.supabase", group: "internal", required: false, probe: "supabaseRest" },
  { name: "cache.redis", group: "internal", required: false, probe: "redis" },
  { name: "auth.better-auth", group: "internal", required: true, probe: "betterAuth" },
  { name: "app.origin", group: "internal", required: true, probe: "ownHealth" },
  { name: "bank.webhook", group: "operator", required: false, probe: "bankWebhookDns" },
  { name: "agent.tools", group: "operator", required: true, probe: "agentToolConfig" },
];

/* ── probes ─────────────────────────────────────────────────────────────────── */

const EL = () => ({ "xi-api-key": process.env.ELEVENLABS_API_KEY ?? "" });

const probes = {
  async elevenlabsSubscription() {
    const r = await get("https://api.elevenlabs.io/v1/user/subscription", EL());
    return r.status === 200
      ? pass(`tier=${r.json?.tier} chars=${r.json?.character_count}/${r.json?.character_limit}`)
      : fail(`HTTP ${r.status} — key rejected or revoked`);
  },
  async elevenlabsAgent() {
    const id = process.env.ELEVENLABS_AGENT_ID;
    const r = await get(
      `https://api.elevenlabs.io/v1/convai/agents/${encodeURIComponent(id)}`,
      EL(),
    );
    if (r.status !== 200) return fail(`HTTP ${r.status} for agent ${mask(id)}`);
    const cc = r.json?.conversation_config ?? {};
    const kb = (JSON.stringify(r.json).match(/knowledge_base/g) || []).length;
    return pass(
      `"${r.json?.name}" tts=${cc.tts?.model_id} kb_refs=${kb} presets=[${Object.keys(cc.language_presets || {}).join(",")}]`,
    );
  },
  async elevenlabsVoices() {
    const langs = ["en", "ar", "hi", "ur", "fr", "sw"];
    const missing = [];
    const names = [];
    for (const l of langs) {
      const id = process.env[`ELEVENLABS_VOICE_${l.toUpperCase()}`] || "";
      if (!id) {
        missing.push(`${l}(unset)`);
        continue;
      }
      const r = await get(`https://api.elevenlabs.io/v1/voices/${encodeURIComponent(id)}`, EL());
      if (r.status !== 200) missing.push(`${l}(HTTP ${r.status})`);
      else names.push(`${l}=${r.json?.labels?.language ?? "?"}`);
    }
    if (missing.length) return fail(`unusable voice ids: ${missing.join(" ")}`);
    // The voice's OWN label is reported rather than hidden: six voices labelled `en`
    // is the known quality gap, and a check that reported only "all resolve 200"
    // would call that healthy.
    return pass(`all resolve; native labels: ${names.join(" ")}`);
  },
  async elevenlabsSttModels() {
    const r = await get("https://api.elevenlabs.io/v1/speech-to-text");
    return r.status === 422 || r.status === 405 || r.status === 200
      ? pass("endpoint reachable")
      : fail(`HTTP ${r.status}`);
  },
  /**
   * Twilio — probed in BOTH auth shapes, because the app uses both for
   * different jobs and a single-shape probe produces a confident wrong answer.
   *
   * `src/lib/twilio.ts creds()` dials with the API key when
   * `TWILIO_API_KEY_SID/SECRET` are present and falls back to the master token;
   * `verifyTwilioSignature()` on the other hand keys every inbound webhook
   * (turn, status, SMS) with `TWILIO_AUTH_TOKEN` and nothing else. So a
   * deployment can place calls and still reject every response Twilio posts to
   * it — the dead-air case where a customer speaks and nothing happens. Probing
   * only the dialing shape would report that box as green.
   */
  async twilioAccount() {
    const sid = process.env.TWILIO_ACCOUNT_SID || "";
    const tok = process.env.TWILIO_AUTH_TOKEN || "";
    const ksid = process.env.TWILIO_API_KEY_SID || "";
    const ksec = process.env.TWILIO_API_KEY_SECRET || "";
    const from = process.env.TWILIO_FROM_NUMBER || "";
    if (!sid) return fail("TWILIO_ACCOUNT_SID unset");

    const account = async (user, pass) =>
      get(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}.json`, {
        Authorization: "Basic " + Buffer.from(`${user}:${pass}`).toString("base64"),
      });

    const keyRes = ksid && ksec ? await account(ksid, ksec) : null;
    const tokRes = tok ? await account(sid, tok) : null;

    const detail = [];
    const dialWith =
      keyRes?.status === 200 ? "api-key" : tokRes?.status === 200 ? "auth-token" : null;
    detail.push(dialWith ? `dials=${dialWith}` : "dials=NEITHER_SHAPE_AUTHENTICATES");
    // A token Twilio rejects is not a neutral absence: the verifier returns
    // `false` (reject) when a token is configured, and only `null` (caller's
    // policy) when it is blank. Wrong is therefore worse than unset.
    detail.push(
      !tok
        ? "webhooks=UNVERIFIABLE(no token)"
        : tokRes?.status === 200
          ? "webhooks=ok"
          : "webhooks=REJECTED(token invalid)",
    );
    detail.push(from ? "from=SET" : "from=MISSING(mode→unconfigured)");

    const acct = keyRes?.json ?? tokRes?.json ?? {};
    if (keyRes?.status === 200 || tokRes?.status === 200) {
      const live = /^(true|1)$/.test(String(process.env.TWILIO_LIVE_SEND || ""));
      detail.push(
        `account="${acct.friendly_name}" type=${acct.type} live_send=${live ? "ATTESTED" : "off(guarded)"}`,
      );
      // A trial account only dials numbers enrolled in its own verified list, so
      // "TWILIO_LIVE_SEND=true" on one silently refuses every real customer.
      if (acct.type === "trial") detail.push("TRIAL: refuses unverified numbers");
      // Every inbound route fails CLOSED on anything but `true`
      // (turn:529, status:86, sms/inbound:82), so an account that dials but
      // cannot verify is a call that speaks and then stops listening. Reporting
      // that as `ok` would describe this platform's most customer-facing path as
      // healthy while it is dead.
      if (tokRes?.status !== 200) {
        return fail(
          `${detail.join(" ")} — dials but refuses every Twilio webhook: TWILIO_AUTH_TOKEN ` +
            `must be the account's live auth token (an API key secret cannot verify signatures)`,
        );
      }
      return pass(detail.join(" "));
    }
    return fail(
      `${detail.join(" ")} — key=${keyRes ? `HTTP ${keyRes.status}` : "unset"} ` +
        `token=${tokRes ? `HTTP ${tokRes.status}` : "unset"}`,
    );
  },
  /**
   * Pinecone — the tenant knowledge base. Probed the way `documents.ts` reaches
   * it, which is the DATA plane whenever `PINECONE_HOST` is set:
   * `pc.index(INDEX, HOST)` never asks the control plane for the host, so a key
   * that is valid for vectors and invalid for `GET /indexes` is a working
   * deployment, and a probe that only tried the control plane would fail it.
   * `describe_index_stats` is the read-only call that proves key + host + index
   * together without writing a vector.
   */
  async pineconeIndexes() {
    const key = process.env.PINECONE_API_KEY || "";
    const host = (process.env.PINECONE_HOST || "").replace(/^https?:\/\//, "");
    const want = process.env.PINECONE_INDEX || "";
    if (!key) return fail("PINECONE_API_KEY unset — tenant document retrieval cannot run");
    // documents.ts/transcript-index.ts both gate on a NON-EMPTY index name
    // (`pineconeConfigured()`), so an empty PINECONE_INDEX switches retrieval
    // off even when the key and host are perfect.
    if (!want) return fail("PINECONE_INDEX empty — retrieval returns pinecone_not_configured");

    const parts = [];
    if (host) {
      const dp = await fetch(`https://${host}/describe_index_stats`, {
        method: "POST",
        headers: { "Api-Key": key, "Content-Type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const body = await dp.json().catch(() => ({}));
      if (dp.status === 200) {
        const total =
          body.total_vector_count ??
          body.namespaces?.reduce((a, n) => a + (n?.vector_count ?? 0), 0);
        return pass(
          `data-plane ok host=${host} vectors=${total} namespaces=${Object.keys(body.namespaces || {}).length}`,
        );
      }
      parts.push(
        `data-plane HTTP ${dp.status} (${String(body?.error?.message ?? "").slice(0, 40)})`,
      );
    } else parts.push("no PINECONE_HOST");

    const cp = await get("https://api.pinecone.io/indexes", { "Api-Key": key });
    if (cp.status === 200) {
      const names = (cp.json?.indexes ?? []).map((i) => i.name);
      return names.includes(want)
        ? pass(`control-plane ok, index "${want}" present (${names.length} total)`)
        : fail(`index "${want}" not present (have: ${names.join(",") || "none"})`);
    }
    parts.push(
      `control-plane HTTP ${cp.status} (${String(cp.json?.error?.message ?? "").slice(0, 40)})`,
    );
    // Both planes rejecting the same key is the one unambiguous verdict here.
    return fail(`key rejected on both planes: ${parts.join("; ")}`);
  },
  async deepgramProjects() {
    const r = await get("https://api.deepgram.com/v1/projects", {
      Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`,
    });
    return r.status === 200 ? pass("key accepted") : fail(`HTTP ${r.status}`);
  },
  async paddleCatalog() {
    const env = (process.env.NEXT_PUBLIC_PADDLE_ENVIRONMENT || "production").trim();
    const host = env === "sandbox" ? "https://sandbox-api.paddle.com" : "https://api.paddle.com";
    const r = await get(`${host}/products`, {
      Authorization: `Bearer ${process.env.PADDLE_API_KEY}`,
    });
    return r.status === 200
      ? pass(`${env} catalog reachable, ${(r.json?.results ?? []).length} products`)
      : fail(`HTTP ${r.status} against ${host}`);
  },
  async resendDomains() {
    const r = await get("https://api.resend.com/domains", {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
    });
    return r.status === 200
      ? pass(`key accepted, ${(r.json?.data ?? []).length} sending domains`)
      : fail(`HTTP ${r.status}`);
  },
  async groqModels() {
    const r = await get("https://api.groq.com/openai/v1/models", {
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
    });
    return r.status === 200
      ? pass(`${(r.json?.data ?? []).length} models`)
      : fail(`HTTP ${r.status}`);
  },
  async geminiModels() {
    const r = await get(
      `https://generativelanguage.googleapis.com/v1beta/models?page_size=5&key=${encodeURIComponent(process.env.GEMINI_API_KEY ?? "")}`,
    );
    return r.status === 200
      ? pass(`${(r.json?.models ?? []).length} models listed`)
      : fail(`HTTP ${r.status}`);
  },
  async langfuseHealth() {
    const base = process.env.LANGFUSE_BASE_URL;
    if (!base) return skip("LANGFUSE_BASE_URL unset");
    const auth = Buffer.from(
      `${process.env.LANGFUSE_PUBLIC_KEY}:${process.env.LANGFUSE_SECRET_KEY}`,
    ).toString("base64");
    const r = await get(`${base.replace(/\/$/, "")}/api/public/health`, {
      Authorization: `Basic ${auth}`,
    });
    return r.status === 200 ? pass(String(r.json?.status ?? "ok")) : fail(`HTTP ${r.status}`);
  },
  async axiomDatasets() {
    const r = await get("https://api.axiom.co/v1/datasets", {
      "X-API-Key": process.env.AXIOM_TOKEN ?? "",
    });
    return r.status === 200 ? pass(`${(r.json ?? []).length} datasets`) : fail(`HTTP ${r.status}`);
  },
  async sentryDsnShape() {
    const dsn = process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN || "";
    if (!dsn) return skip("no server DSN");
    return /^(https?:\/\/[^@]+@[^/]+\/\d+$)/.test(dsn)
      ? pass("DSN well-formed")
      : fail("DSN malformed");
  },
  async postgres() {
    const url = process.env.DATABASE_URL || "";
    if (!url) return fail("DATABASE_URL unset");
    let pg;
    try {
      ({ default: pg } = await import("pg"));
    } catch {
      // Not a database problem, so it must not be reported as one: the driver is a
      // dependency of the app, and this script can be run from a directory that has
      // no node_modules (a CI workspace before install, a scratch dir). Say which
      // fact is missing rather than claiming Postgres is down.
      return skip("pg driver unavailable here — run it from the app checkout or the container");
    }
    try {
      const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: TIMEOUT_MS });
      await c.connect();
      const v = await c.query("select version() as v, current_schema() as s");
      const tables = await c.query(
        "select count(*)::int as n from information_schema.tables where table_schema='public'",
      );
      const migrations = await c
        .query("select count(*)::int as n from public._prisma_migrations")
        .then((r) => String(r.rows[0]?.n ?? 0))
        .catch(() => "unreadable");
      const pending = await c
        .query(
          "select count(*)::int as n from public._prisma_migrations where finished_at is null and rolled_back_at is null",
        )
        .then((r) => r.rows[0]?.n ?? 0)
        .catch(() => 0);
      await c.end();
      if (pending > 0) return fail(`${pending} migration(s) not finished — schema is mid-flight`);
      return pass(
        `${v.rows[0].v.split(" ")[1] ?? "?"}, ${tables.rows[0].n} public tables, migrations=${migrations}`,
      );
    } catch (e) {
      return fail(`connect failed: ${short(e.message)}`);
    }
  },
  async supabaseRest() {
    // Not a probe of anything the platform does. `SUPABASE_URL` has exactly two
    // readers in the tree — the config getters at src/lib/config.ts:379 — and no
    // call site, so there is no code path whose health this could describe. The
    // live Supabase connection is DATABASE_URL, covered by `db.postgres`.
    // Reporting `ok` for a REST host that answers 401 would be a gate that
    // cannot fail, which is the failure mode this whole script exists to remove.
    return skip("no code path reads SUPABASE_URL; Supabase Postgres is covered by db.postgres");
  },
  async redis() {
    const url = process.env.REDIS_URL || "";
    if (!url) return skip("REDIS_URL unset — rate limiting falls back to per-process buckets");
    let Redis;
    try {
      ({ default: Redis } = await import("ioredis"));
    } catch {
      return skip("ioredis unavailable here — same fallback note as the pg driver above");
    }
    try {
      const c = new Redis(url, {
        maxRetriesPerRequest: 1,
        connectTimeout: TIMEOUT_MS,
        lazyConnect: true,
      });
      const pong = await c.ping();
      await c.quit().catch(() => c.disconnect());
      return pong === "PONG" ? pass("PING answered") : fail(`unexpected reply ${pong}`);
    } catch (e) {
      return fail(`unreachable: ${short(e.message)}`);
    }
  },
  async betterAuth() {
    const base = (process.env.BETTER_AUTH_URL || "").replace(/\/$/, "");
    if (!base) return fail("BETTER_AUTH_URL unset — sessions cannot be issued");
    const r = await get(`${base}/api/auth/get-session`);
    // 200 (signed out) or 401 both prove the endpoint is mounted and answering.
    return r.status === 200 || r.status === 401 || r.status === 204
      ? pass(`${base} answers ${r.status}`)
      : fail(`HTTP ${r.status} from ${base}`);
  },
  async ownHealth() {
    const base = (process.env.SITE_ADDRESS || process.env.NEXT_PUBLIC_SITE_URL || "").replace(
      /\/$/,
      "",
    );
    if (!base) return fail("SITE_ADDRESS unset — nothing to self-check");
    const origin = base.startsWith("http") ? base : `https://${base}`;
    const h = await get(`${origin}/api/health`);
    const r = await get(`${origin}/api/readyz`);
    if (h.status !== 200) return fail(`HTTP ${h.status} from ${origin}/api/health`);
    return pass(
      `${origin} health=200 readyz=${r.status} status=${r.json?.status ?? "?"} fatal_fails=${
        (r.json?.checks ?? []).filter((c) => c.fatal && !c.ok).length
      }`,
    );
  },
  async bankWebhookDns() {
    const url = process.env.BANK_WEBHOOK_URL || "";
    if (!url) return skip("BANK_WEBHOOK_URL unset — operator has no receiver configured");
    try {
      const host = new URL(url).hostname;
      await Bun.dns.resolve(host, "ANY").catch(() => Bun.dns.resolve(host));
      return pass(`${host} resolves`);
    } catch (e) {
      return fail(`cannot resolve ${url}: ${short(e.message)}`);
    }
  },
  async agentToolConfig() {
    // The operator-facing half: the agent's tool callbacks are only trustworthy if
    // the shared secret exists AND every advertised tool is explicitly allowed.
    const secret = process.env.AGENT_TOOL_SECRET || "";
    const allowed = (process.env.AGENT_TOOL_ALLOWED || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (secret.length < 32)
      return fail(`AGENT_TOOL_SECRET missing or ${secret.length} chars (needs 32+)`);
    if (!allowed.length) return fail("AGENT_TOOL_ALLOWED empty — every tool call would be refused");
    const declared = Object.entries(process.env)
      .filter(([k]) => k.startsWith("ELEVENLABS_TOOL_"))
      .map(([k, v]) => [k.replace("ELEVENLABS_TOOL_", "").toLowerCase(), v]);
    const unbound = declared.filter(([name, id]) => !id && allowed.includes(name));
    return pass(
      `${allowed.length} tools allowed (${allowed.join(",")}); ${declared.filter(([, v]) => v).length}/${declared.length} platform tool ids bound` +
        (unbound.length ? ` — allowed but unbound: ${unbound.map(([n]) => n).join(",")}` : ""),
    );
  },
};

/* ── plumbing ───────────────────────────────────────────────────────────────── */

const pass = (detail) => ({ ok: true, detail });
const fail = (detail) => ({ ok: false, detail });
const skip = (detail) => ({ ok: true, skipped: true, detail });

function mask(v) {
  if (!v) return "(empty)";
  return v.length <= 8 ? `len=${v.length}` : `${v.slice(0, 4)}…${v.slice(-4)}`;
}
function short(m) {
  return String(m || "")
    .replace(/\s+/g, " ")
    .slice(0, 120);
}

async function get(url, headers = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ac.signal, redirect: "follow", headers });
    let json = null;
    const text = await res.text().catch(() => "");
    try {
      json = JSON.parse(text);
    } catch {
      /* non-JSON responses are fine; status is the signal */
    }
    return { status: res.status, json, text };
  } catch (e) {
    return { status: 0, json: null, text: String(e.message || e) };
  } finally {
    clearTimeout(t);
  }
}

/** Does the system have what it needs to be probed at all? */
function prerequisites(s) {
  const needed =
    s.needs ??
    {
      "elevenlabs.tts": ["ELEVENLABS_API_KEY"],
      "elevenlabs.agent": ["ELEVENLABS_API_KEY", "ELEVENLABS_AGENT_ID"],
      "elevenlabs.voices": ["ELEVENLABS_API_KEY"],
      "elevenlabs.stt": ["ELEVENLABS_API_KEY"],
      "twilio.account": ["TWILIO_ACCOUNT_SID"],
      "pinecone.index": ["PINECONE_API_KEY"],
      deepgram: ["DEEPGRAM_API_KEY"],
      paddle: ["PADDLE_API_KEY"],
      resend: ["RESEND_API_KEY"],
      "llm.groq": ["GROQ_API_KEY"],
      "llm.gemini": ["GEMINI_API_KEY"],
      langfuse: ["LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY"],
      axiom: ["AXIOM_TOKEN"],
    }[s.name] ??
    [];
  return needed.filter((k) => !(process.env[k] || "").trim());
}

const results = [];
for (const s of SYSTEMS) {
  const absent = prerequisites(s);
  if (absent.length) {
    results.push({
      ...s,
      ok: !s.required,
      skipped: s.required ? false : true,
      detail: `env unset: ${absent.join(", ")}`,
    });
    continue;
  }
  const out = await probes[s.probe]();
  results.push({ ...s, ...out });
}

const width = Math.max(...results.map((r) => r.name.length));
console.log(
  `\nintegration connectivity — ${results.length} systems, ${TIMEOUT_MS / 1000}s per probe, GET/PING only\n`,
);
for (const r of results) {
  const tag = r.skipped ? (r.ok ? "SKIP" : "MISS") : r.ok ? "  ok" : "FAIL";
  console.log(`${tag}  ${r.name.padEnd(width)}  ${r.group.padEnd(11)}  ${r.detail ?? ""}`);
}
const failed = results.filter((r) => !r.ok);
const requiredFailed = failed.filter((r) => r.required);
console.log(
  `\n${results.length - failed.length}/${results.length} systems answered. ` +
    `${requiredFailed.length} required failure(s)` +
    (failed.length && !requiredFailed.length
      ? ` (${failed
          .filter((f) => !f.required)
          .map((f) => f.name)
          .join(", ")} optional)`
      : "") +
    ".",
);
console.log(
  "Read-only by construction: this dialed no number, sent no email, wrote no row and\n" +
    "upserted no vector. It authenticates against each system and reports the answer.",
);
process.exit(requiredFailed.length ? 1 : 0);
