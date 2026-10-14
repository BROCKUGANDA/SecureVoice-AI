type Env = {
  BANK_SECRET: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
  QSTASH_TOKEN: string;
};

async function verifyHMAC(message: string, signature: string | null, secret: string): Promise<boolean> {
  if (!signature || !secret) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  const expected = [...new Uint8Array(mac)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return diff === 0;
}

const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return new Response("Bad Request", { status: 400 });
    }

    const signature = request.headers.get("X-SecureVoice-Signature");
    if (!(await verifyHMAC(JSON.stringify(payload), signature, env.BANK_SECRET))) {
      return new Response("Unauthorized", { status: 401 });
    }

    const body = (payload ?? {}) as { transaction_id?: string; org_id?: string };

    const supabaseRes = await fetch(`${env.SUPABASE_URL}/rest/v1/interventions`, {
      method: "POST",
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        transaction_id: body.transaction_id,
        org_id: body.org_id,
        status: "pending",
      }),
    });

    if (!supabaseRes.ok) {
      return new Response("Upstream error", { status: 502 });
    }

    await fetch("https://qstash.upstash.io/v2/publish", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.QSTASH_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url: "https://voice.securevoice.ai/api/worker-trigger-call",
        body: JSON.stringify(payload),
      }),
    });

    return new Response(JSON.stringify({ status: "queued" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  },
};

export default worker;
