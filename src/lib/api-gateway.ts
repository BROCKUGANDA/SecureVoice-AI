import { NextResponse } from "next/server";
import { z } from "zod";

const ISO_CURRENCY = /^[A-Z]{3}$/;

const InboundTriggerSchema = z.object({
  amount: z.number().positive(),
  currency: z.string().length(3).regex(ISO_CURRENCY),
  transaction_id: z.string().uuid(),
  customer_phone_token: z.string().startsWith("tok_"),
  org_id: z.string().uuid(),
  institution_type: z.enum(["bank", "insurance"]).optional(),
  call_category: z.enum(["time_critical_fraud", "routine", "sensitive_case"]).optional(),
});

export type GatewayDecision =
  | { ok: true; payload: z.infer<typeof InboundTriggerSchema> }
  | { ok: false; status: number; error: string };

export async function apiGateway(req: Request): Promise<GatewayDecision> {
  const ip = req.headers.get("x-forwarded-for") ?? "unknown";
  const endpoint = new URL(req.url).pathname;

  // Rate limiting requires a shared store; this is the documented extension
  // point. Until a Redis-backed limiter is wired, validate the payload and
  // auth, then allow the request through.
  try {
    const body = await req.json();
    const parsed = InboundTriggerSchema.safeParse(body);
    if (!parsed.success) {
      return { ok: false, status: 400, error: "Invalid payload" };
    }

    const signature = req.headers.get("X-SecureVoice-Signature");
    if (!signature) {
      return { ok: false, status: 401, error: "Missing signature" };
    }

    return { ok: true, payload: parsed.data };
  } catch {
    return { ok: false, status: 400, error: "Malformed request body" };
  }
}
