"use client";

/**
 * How the signed-in identity is presented — including the demo seat, which is
 * the one case that must NOT look like a person.
 *
 * The demo account's stored `name` is the literal "demo user". Rendering it put
 * the string "demo user" next to a "DU" initials badge in the header of every
 * page a judge visits, which reads as an unfinished placeholder rather than as a
 * deliberate product surface — and on a fraud platform's own header it reads as
 * though the account is somebody's personal login.
 *
 * So a demo session is presented as a LABEL, not as a name: a single "D", the
 * words "Demo session", and a tint. Nothing here is a claim about who is using
 * the product, because there is no person to name — the credential is published
 * in the client bundle and shared by every judge who takes the queue position.
 *
 * For everyone else the name is the account's own, unchanged.
 */

import { useCurrentUserImage } from "@/hooks/use-current-user-image";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useSession } from "@/lib/auth-client";
import { isDemoAccount } from "@/lib/demo-account";
import { t, useApp } from "@/lib/store";
import type { Lang } from "@/lib/store";

/** What to render for this session, in one place — so the avatar and the label agree. */
export type IdentityPresentation = {
  /** True when this session is the published demo seat. */
  isDemo: boolean;
  /** The words to show beside the avatar. */
  label: string;
  /** The letters inside the avatar. */
  initials: string;
};

export function presentIdentity(
  email: string | null | undefined,
  name: string | null | undefined,
  lang: Lang,
): IdentityPresentation {
  if (isDemoAccount(email)) {
    return {
      isDemo: true,
      // ONE letter, not "DU". Two initials advertise that this is a username, and
      // the initials badge exists to identify a person; there is no person.
      initials: "D",
      label: t("Demo session", "جلسة تجريبية", lang),
    };
  }
  const resolved = name ?? email ?? null;
  return {
    isDemo: false,
    label: resolved ?? "",
    initials: initialsFrom(resolved),
  };
}

/**
 * The current operator's avatar — their profile image when the account has one,
 * their initials when it does not, and a neutral `?` when there is no account
 * at all.
 *
 * ADAPTED FROM THE SUPABASE "Current User Avatar" BLOCK. The shape and the
 * fallback chain are the block's; the identity is not. This project
 * authenticates with Better Auth, not Supabase Auth (see
 * src/hooks/use-current-user-*.ts for why the upstream hooks could never have
 * worked here), so the image and the name come from the app's own session.
 *
 * Three details the block does not handle, and why each matters:
 *
 *  1. **A pending session renders nothing, not a `?`.** Better Auth resolves the
 *     session asynchronously on mount. Rendering the signed-out fallback during
 *     that window would flash a `?` at a signed-in operator on every page load
 *     — the "data flash" this codebase's checklist calls out, where the UI
 *     states something that is about to be contradicted.
 *
 *  2. **Initials fall back through the email.** An account redeemed from an
 *     invitation may have no `name` yet, but it always has an email. Showing `?`
 *     there would hide a user who is, in fact, signed in.
 *
 *  3. **`alt=""` on the photo, not the initials.** The block sets
 *     `alt={initials}`, which makes a screen reader announce the decorative
 *     fallback as if it were the image's name. The initials are already visible
 *     text in the fallback, so they need no announcement, and an empty `alt`
 *     marks the photo as decorative relative to the name beside it — which is
 *     how the navbar already labels the same session.
 *
 * No props by design, same as the block: the subject is whoever is signed in.
 */
export const CurrentUserAvatar = () => {
  const { lang } = useApp();
  const { data, isPending } = useSession();
  const profileImage = useCurrentUserImage();

  // Still resolving the session — render nothing rather than a wrong answer.
  if (isPending) return null;

  const presented = presentIdentity(data?.user?.email, data?.user?.name, lang);
  const signedIn = Boolean(presented.label);

  return (
    <Avatar
      aria-label={
        signedIn
          ? t("Profile photo of the signed-in user", "صورة المستخدم المسجّل الدخول", lang)
          : undefined
      }
    >
      {profileImage && !presented.isDemo && <AvatarImage src={profileImage} alt="" />}
      <AvatarFallback
        className={
          presented.isDemo
            ? "bg-ink font-mono text-[10.5px] font-semibold text-white"
            : "bg-paper font-mono text-[10.5px] font-semibold text-ink-2"
        }
      >
        {presented.initials}
      </AvatarFallback>
    </Avatar>
  );
};

/**
 * Initials from a display name, falling back to the local part of an email and
 * then to `?` for a signed-out visitor.
 *
 * Splits on whitespace and takes the first character of each word, so
 * "Fatima Al Zaabi" -> "FAZ" and "fatima@bank.ae" -> "F". Empty segments (a
 * doubled space) contribute nothing rather than an `undefined` character.
 */
function initialsFrom(name: string | null): string {
  if (!name) return "?";
  const source = name.includes("@") ? name.slice(0, name.indexOf("@")) : name;
  const letters = source
    .split(/[\s._-]+/)
    .map((word) => word.charAt(0))
    .filter((char) => char.length > 0)
    .join("")
    .toUpperCase();
  return letters || "?";
}
