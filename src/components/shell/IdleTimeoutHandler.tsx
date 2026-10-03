"use client";

import { useEffect, useRef } from "react";
import { signOut, useSession } from "@/lib/auth-client";

/**
 * Idle-timeout guard — enterprise fintech session policy on the free tier.
 * Signs the user out after 15 minutes without interaction; the auth page then
 * explains why (store.timedOut). Mouse/key/scroll/touch all reset the timer.
 *
 * ── This is a COURTESY, not the control ───────────────────────────────────────
 * The 15-minute number here is duplicated from IDLE_TIMEOUT_SECONDS in
 * src/lib/auth/session-policy.ts on purpose: importing that module would pull a
 * `server-only` file into the client bundle, which is the leak Part K exists to
 * prevent. `tests/auth/session-policy.test.ts` asserts these two agree, so the
 * copy cannot drift silently.
 *
 * Where the limit is ACTUALLY enforced server-side:
 *  - the first-party `sv_session` store compares lastSeenAt against
 *    IDLE_TIMEOUT_MS on every request (src/lib/auth/session.ts), and
 *  - Better Auth expires the session row at ABSOLUTE_LIFETIME_SECONDS.
 *
 * Honest caveat: Better Auth has no native idle timeout, so a session created
 * through it is bounded by the absolute limit rather than by 15 minutes of
 * silence. This client timer is the ONLY idle control on that path. It is a
 * real control for a cooperative browser, and NOT a control at all against a
 * stolen cookie. Closing that gap properly needs a lastSeenAt column checked in
 * getSession — tracked as remaining work, not claimed as done here.
 */

const IDLE_TIMEOUT = 15 * 60 * 1000;
const EVENTS = ["mousemove", "keydown", "click", "scroll", "touchstart"] as const;

export function IdleTimeoutHandler({ onTimeout }: { onTimeout: () => void }) {
  const { data: session } = useSession();
  const isSignedIn = Boolean(session?.user);
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
