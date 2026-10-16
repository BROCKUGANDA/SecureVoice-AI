import type { Metadata } from "next";
import { PublicPageLayout } from "@/components/shell/PublicPageLayout";
import { Team } from "@/views/Team";

/**
 * The real, shareable, indexable team URL.
 *
 * A team page is the one page a founder is asked for by name — in a due-diligence
 * checklist, a procurement thread, or a LinkedIn DM — so it has to have a URL to
 * paste. As a panel inside the app it did not.
 *
 * `alternates.canonical` and the `robots` decision both matter here: this is
 * public and indexable, unlike the console, because "who built this" is
 * something a bank or an insurer legitimately wants to look up before a pilot.
 */
export const metadata: Metadata = {
  title: "Team — SecureVoice AI",
  description:
    "Who builds SecureVoice AI. Founder and CEO with the engineering and the product, shipping voice systems for regulated banks and insurers across the GCC and MENA.",
  alternates: { canonical: "/team" },
  openGraph: {
    title: "Team — SecureVoice AI",
    description: "Founder and CEO. Engineering, product and voice, in one team.",
    url: "/team",
  },
};

export default function TeamPage() {
  return (
    <PublicPageLayout current="/team">
      <Team />
    </PublicPageLayout>
  );
}
