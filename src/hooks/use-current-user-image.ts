"use client";

import { useSession } from "@/lib/auth-client";

/**
 * The signed-in operator's profile image URL.
 *
 * ADAPTED FROM THE SUPABASE BLOCK, and the reason matters: the upstream
 * `useCurrentUserImage` reads `supabase.auth.getSession()` and then
 * `user_metadata.avatar_url`. That is a Supabase Auth shape, and this project
 * does not use Supabase Auth — authentication is Better Auth
 * (src/lib/better-auth.ts), with Supabase acting only as the managed Postgres
 * database behind the bank-side mirror. No route anywhere calls
 * `supabase.auth.signInWith`, `setSession` or `onAuthStateChange`, so there is
 * never a Supabase session cookie to read: `getSession()` would return
 * `{ session: null }` for every user, and this hook would hand back `null`
 * forever — an avatar that renders its fallback for the whole operator
 * population while looking wired up.
 *
 * The image lives on the account this app actually authenticates: Better Auth's
 * `user.image` column (prisma/schema.prisma), a plain URL set by the identity
 * provider or by the operator's own profile edit.
 *
 * `useSession()` is the app's ONE session signal (see src/lib/auth-client.ts),
 * so this cannot disagree with the navbar, the console, or the role gate.
 * Better Auth exposes the session synchronously after hydration and re-fetches
 * on auth atoms, so there is no `useEffect` + local state dance here: reading
 * the hook directly keeps the two consistent and removes a render pass.
 *
 * Returns null while the session is loading, so a caller must not treat null as
 * "this user has no picture" until the session has resolved.
 */
export const useCurrentUserImage = (): string | null => {
  const { data: session, isPending } = useSession();
  if (isPending || !session) return null;
  return session.user.image ?? null;
};
