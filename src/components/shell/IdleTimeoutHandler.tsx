"use client";

import { useEffect, useRef } from "react";
import { useClerk } from "@clerk/nextjs";

/**
 * Idle-timeout guard — enterprise fintech session policy on the free tier.
 * Signs the user out after 15 minutes without interaction; the auth page then
 * explains why (store.timedOut). Mouse/key/scroll/touch all reset the timer.
 */

const IDLE_TIMEOUT = 15 * 60 * 1000;
const EVENTS = ["mousemove", "keydown", "click", "scroll", "touchstart"] as const;

export function IdleTimeoutHandler({ onTimeout }: { onTimeout: () => void }) {
  const { signOut, isSignedIn } = useClerk();
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!isSignedIn) return;

    const onTimeout = () => {
      void signOut();
      onTimeout();
    };

    const reset = () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(onTimeout, IDLE_TIMEOUT);
    };

    reset();
    EVENTS.forEach((e) => window.addEventListener(e, reset, { passive: true }));
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      EVENTS.forEach((e) => window.removeEventListener(e, reset));
    };
  }, [isSignedIn, signOut, onTimeout]);

  return null;
}
