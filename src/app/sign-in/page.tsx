import type { Metadata } from "next";
import AppRoot from "@/app/page";

export const dynamic = "force-dynamic";

/**
 * GET /sign-in — the sign-in view at a shareable address.
 *
 * It exists for the two places a login page is linked from rather than clicked
 * to: an expired session that has to send someone somewhere, and a runbook or
 * support reply that needs to name a URL. `/` cannot serve that, because `/` is
 * the marketing page and the login is a view inside the shell.
 *
 * `noindex` because a login page in a search result is a phishing target and a
 * crawl-budget waste, not an asset.
 */
export const metadata: Metadata = {
  title: "Sign in — SecureVoice AI",
  description: "Operator and demo sign-in for SecureVoice AI.",
  robots: { index: false, follow: false },
};

export default function SignInRoute() {
  return <AppRoot />;
}
