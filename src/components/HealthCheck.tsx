"use client";
import { useEffect, useState } from "react";

export default function HealthCheck() {
  const [status, setStatus] = useState<"healthy" | "degraded">("healthy");

  useEffect(() => {
    const voiceHealthUrl =
      process.env.NEXT_PUBLIC_VOICE_HEALTH_URL ?? "https://voice.securevoice.ai/api/health";

    const interval = setInterval(async () => {
      try {
        const res = await fetch(voiceHealthUrl);
        if (!res.ok) throw new Error("degraded");
        setStatus("healthy");
      } catch {
        setStatus("degraded");
      }
    }, 30000);

    return () => clearInterval(interval);
  }, []);

  if (status === "degraded") {
    return (
      <div className="bg-red-600 text-white text-center py-2 text-sm">
        ⚠️ Voice Engine experiencing degraded performance. Active calls may be delayed. Our team has
        been alerted.
      </div>
    );
  }

  return null;
}
