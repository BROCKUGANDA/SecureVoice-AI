"use client";
import { useEffect, useRef, useState } from "react";
import {
  createSession,
  type ConnectionType,
  type SecureVoiceConfig,
  type Session,
} from "./securevoice";

/**
 * A minimal React/React Native hook: mint a session, refresh before it expires.
 * Keeps no provider SDK dependency — a navigation app pairs the WebSocket /
 * WebRTC credential with its own media transport.
 */
export function useSecureVoiceSession(cfg: SecureVoiceConfig, type: ConnectionType = "websocket") {
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef<boolean>(true);

  useEffect(() => {
    alive.current = true;
    const run = async () => {
      const r = await createSession(cfg, type);
      if (!alive.current) return;
      if (r.ok && r.data) {
        setSession(r.data);
        setError(null);
        // Re-mint 60s before the 15-min credential expires.
        const refresh = Math.max(5, r.data.expiresInSecs - 60) * 1000;
        timer.current = setTimeout(() => void run(), refresh);
      } else {
        setError(r.error ?? "mint_failed");
      }
      setLoading(false);
    };
    void run();
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [cfg.baseUrl, cfg.agentId, cfg.toolSecret, type]);

  return { session, error, loading };
}
