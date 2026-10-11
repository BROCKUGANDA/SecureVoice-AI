"use client";

import { useCurrentUserImage } from "@/hooks/use-current-user-image";
import { useCurrentUserName } from "@/hooks/use-current-user-name";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useSession } from "@/lib/auth-client";
import { t, useApp } from "@/lib/store";

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
  const { isPending } = useSession();
  const profileImage = useCurrentUserImage();
  const name = useCurrentUserName();

  // Still resolving the session — render nothing rather than a wrong answer.
  if (isPending) return null;

  const signedIn = Boolean(name);
  const initials = initialsFrom(name);

  return (
    <Avatar
      aria-label={
        signedIn
          ? t("Profile photo of the signed-in user", "صورة المستخدم المسجّل", lang)
          : undefined
      }
    >
      {profileImage && <AvatarImage src={profileImage} alt="" />}
      <AvatarFallback className="bg-paper font-mono text-[10.5px] font-semibold text-ink-2">
        {initials}
      </AvatarFallback>
    </Avatar>
  );
};

/**
 * Initials from a display name, falling back to the local part of an email and
 * then to `?` for a signed-out visitor.
 *
 * Splits on whitespace and takes the first character of each word, so
 * "Fatima Al Zaabi" → "FAZ" and "fatima@bank.ae" → "F". Empty segments (a
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
