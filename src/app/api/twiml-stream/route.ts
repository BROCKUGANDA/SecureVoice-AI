import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const interventionId = searchParams.get("intervention_id") ?? "";

  const streamUrl = new URL("/api/voice-websocket", req.url);
  streamUrl.searchParams.set("intervention_id", interventionId);

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${streamUrl.toString()}" />
  </Connect>
</Response>`;

  return new NextResponse(twiml, {
    status: 200,
    headers: {
      "Content-Type": "text/xml",
    },
  });
}
