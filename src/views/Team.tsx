"use client";

/**
 * The team page — public, indexable, and honest about its size.
 *
 * ## Why this exists as a route rather than a panel
 *
 * "Who built this" is the first question a bank's fraud team asks and the third
 * question an insurer's procurement team asks, and both of them ask it in a
 * channel where they need a LINK. A team page nested inside the app is not
 * pasteable into a procurement thread.
 *
 * ## Why the roster is short and says so
 *
 * One person. This is a founder-built product and the page states that plainly
 * rather than implying a bench that does not exist. A due-diligence reader who
 * discovers the team size by counting avatars has learned the same thing, but has
 * learned it later and has less reason to trust the rest of the page.
 *
 * The empty slots below are deliberate and labelled as such: a reader can see
 * where the team is going, which is a stronger signal than a page that quietly
 * gains a row one day.
 */

import { Instagram, Linkedin, Music2, ArrowUpRight } from "lucide-react";
import { useApp, t } from "@/lib/store";
import { Reveal } from "@/components/fx/core";
import { PanelHeader } from "@/components/ui/PanelHeader";

type Social = {
  /** lucide icon — the platforms all ship one, so no image requests and no SVG blob. */
  icon: typeof Instagram;
  /** Used for both the aria-label and the accessible name of the link. */
  label: string;
  href: string;
  /** The handle as written on the platform, so a reader can verify it. */
  handle: string;
};

type Member = {
  name: string;
  role: { en: string; ar: string };
  bio: { en: string; ar: string };
  /** Null until there is a real headshot. A broken image is worse than none. */
  image: string | null;
  socials: Social[];
  /**
   * The roles this person owns end to end. A one-person company listing "Founder
   * & CEO" reads as a title; listing what is actually on their plate is due
   * diligence a reader can act on.
   */
  owns: { en: string[]; ar: string[] };
};

/**
 * First and last initial — not one letter per word.
 *
 * The old inline derivation took every word's first character, which was fine for
 * a two-word name and is "OAAAO" for a five-word one. Five glyphs at 20px do not
 * fit the 64px badge, and the fallback is the thing a reader sees when there is no
 * headshot yet. Bounded for any name length, and `?` for an empty one.
 */
function initialsOf(name: string): string {
  const words = name.split(/\s+/).filter(Boolean);
  const first = words[0]?.charAt(0) ?? "";
  const last = words.length > 1 ? (words.at(-1)?.charAt(0) ?? "") : "";
  return (first + last).toUpperCase() || "?";
}

const TEAM: Member[] = [
  {
    name: "Okot Araa Andrew Aaron Otema",
    role: { en: "Founder & CEO — engineering", ar: "المؤسس والرئيس التنفيذي — الهندسة" },
    bio: {
      en: "Builds the product end to end: the voice pipeline, the guardrail layer, the billing and the console. Prior work across real-time audio, payments infrastructure and regulated production systems.",
      ar: "يبني المنتج من طرفه إلى طرفه: خط أنابيب الصوت، وطبقة الضوابط، والفوترة، ولوحة التشغيل. خبرة سابقة في الصوت الفوري، وبنية المدفوعات، والأنظمة الإنتاجية المنظَّمة.",
    },
    image: null,
    socials: [
      {
        icon: Instagram,
        label: "Instagram",
        handle: "@yngdon_ad",
        href: "https://www.instagram.com/yngdon_ad/",
      },
      {
        icon: Linkedin,
        label: "LinkedIn",
        handle: "aaokot",
        href: "https://www.linkedin.com/in/aaokot/",
      },
      {
        // lucide has no TikTok glyph — Music2 is the closest neutral mark, and a
        // brand-accurate TikTok logo is a trademark question, not a design one.
        icon: Music2,
        label: "TikTok",
        handle: "@256ix",
        href: "https://www.tiktok.com/@256ix",
      },
    ],
    owns: {
      en: [
        "Voice pipeline — streaming TTS, ASR, barge-in, call duration",
        "Agent intent routing and the compliance guardrail layer",
        "Ledger, metering, plan allowances and overage",
        "Audit chain, tenancy isolation and the consent gates",
      ],
      ar: [
        "خط أنابيب الصوت — تحكّم الكلام، والتعرّف على الكلام، والمقاطعة، ومدة المكالمة",
        "توجيه نوايا الوكيل وطبقة الضوابط المطابقة",
        "السجل، والقياس، وبدائل الخطط، والفائض",
        "سلسلة التدقيق، وعزل المستأجرين، وبوابات الموافقة",
      ],
    },
  },
];

/**
 * Open seats, rendered rather than omitted.
 *
 * A page that grows a new face one day is a page nobody can verify. Showing the
 * shape of the team you intend to hire tells a reader the same thing and lets
 * them ask about it.
 */
const OPEN_ROLES: { en: string; ar: string }[] = [
  { en: "Voice / audio engineer", ar: "مهندس صوت" },
  { en: "Applied compliance lead", ar: "مسؤول الامتثال التطبيقي" },
  { en: "Enterprise partnerships", ar: "شراكات المؤسسات" },
];

export function Team() {
  const { lang } = useApp();

  return (
    <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6 lg:px-8 lg:py-20">
      <Reveal>
        <p className="micro text-ink-3">{t("THE PEOPLE", "الفريق", lang)}</p>
        <h1 className="mt-3 font-display text-[clamp(2rem,4.4vw,3.25rem)] font-semibold leading-[1.04] tracking-tight">
          {t("Built by the people who answer the phone.", "من يبنيه هو من يرد على الهاتف.", lang)}
        </h1>
        <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-ink-2">
          {t(
            "SecureVoice AI is founder-built. One team owns the whole path — the call, the guardrail, the audit trail and the invoice — which is why the same engine is what runs the demo, the pilot and production. No handoff between a sales demo and the thing that ships.",
            "SecureVoice AI من إنتاج المؤسس. فريق واحد يملك المسار كاملاً — المكالمة، والضابط، وسجل التدقيق، والفاتورة — ولذلك يكون المحرك نفسه هو الذي يشغّل العرض التجريبي والتجريبي التشغيلي والإنتاج. لا تسليم بين عرض المبيعات وما يُشحن.",
            lang,
          )}
        </p>
      </Reveal>

      <div className="mt-12 grid gap-6 lg:grid-cols-[1.15fr_1fr]">
        {TEAM.map((m) => (
          <Reveal key={m.name}>
            <article className="h-full rounded-3xl border border-line bg-white p-6 sm:p-7">
              <PanelHeader
                icon={<span className="text-green-bright">◆</span>}
                title={
                  <span>
                    {t("FOUNDER", "مؤسس", lang)}
                    <span className="ml-2 font-normal text-white/60">{m.name}</span>
                  </span>
                }
              />

              <div className="mt-6 flex items-start gap-4">
                {/*
                  The empty avatar.
                  `image` is null until there is a real headshot, and that is
                  deliberate rather than a placeholder waiting to be filled in with
                  a stock photo: a generated face for a named real person is a
                  misrepresentation, and a broken <img> is worse than a clean
                  monogram. The dashed ring says "a photo goes here" so the gap
                  reads as intentional.
                */}
                <span className="relative grid h-16 w-16 shrink-0 place-items-center overflow-hidden rounded-2xl bg-paper ring-1 ring-dashed ring-line">
                  {m.image ? (
                    <img src={m.image} alt={m.name} className="h-full w-full object-cover" />
                  ) : (
                    <span className="font-display text-[20px] font-semibold text-ink-3">
                      {initialsOf(m.name)}
                    </span>
                  )}
                </span>

                <div className="min-w-0">
                  <h2 className="font-display text-[19px] font-semibold tracking-tight">
                    {m.name}
                  </h2>
                  <p className="text-[12.5px] font-medium text-primary">{m.role.en}</p>
                  <p className="mt-1 text-[12px] text-ink-3">{m.role.ar}</p>
                </div>
              </div>

              <p className="mt-5 text-[13.5px] leading-relaxed text-ink-2">{m.bio.en}</p>
              <p className="mt-2 text-[13px] leading-relaxed text-ink-3" dir="rtl">
                {m.bio.ar}
              </p>

              <div className="mt-6">
                <p className="micro text-ink-3">{t("OWNS", "المسؤوليات", lang)}</p>
                <ul className="mt-3 space-y-2">
                  {m.owns.en.map((line) => (
                    <li key={line} className="flex gap-2.5 text-[13px] leading-relaxed text-ink-2">
                      <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-primary/70" />
                      {line}
                    </li>
                  ))}
                </ul>
              </div>

              <div className="mt-6 flex flex-wrap gap-2 border-t border-line pt-5">
                {m.socials.map((s) => {
                  const Icon = s.icon;
                  return (
                    <a
                      key={s.label}
                      href={s.href}
                      // `noreferrer` because the target is a third party and we
                      // do not want to leak the referring URL or hand them a
                      // window.opener reference.
                      target="_blank"
                      rel="me noopener noreferrer"
                      className="group flex items-center gap-2 rounded-full border border-line bg-paper px-3 py-1.5 text-[12.5px] font-medium text-ink-2 transition hover:border-primary/50 hover:text-primary"
                    >
                      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                      <span className="font-mono text-[11px] tracking-wide">{s.handle}</span>
                      <span className="sr-only">{s.label} (opens in a new tab)</span>
                      <ArrowUpRight
                        className="h-3 w-3 opacity-50 transition group-hover:opacity-100"
                        aria-hidden="true"
                      />
                    </a>
                  );
                })}
              </div>
            </article>
          </Reveal>
        ))}

        <Reveal>
          <section className="h-full rounded-3xl border border-dashed border-line bg-paper/50 p-6 sm:p-7">
            <p className="micro text-ink-3">{t("HIRING", "التوظيف", lang)}</p>
            <h2 className="mt-2 font-display text-[17px] font-semibold tracking-tight">
              {t("Open roles", "الوظائف الشاغرة", lang)}
            </h2>
            <ul className="mt-5 space-y-3">
              {OPEN_ROLES.map((r) => (
                <li
                  key={r.en}
                  className="flex items-center justify-between gap-3 border-b border-line pb-3 last:border-0 last:pb-0"
                >
                  <span className="text-[13.5px] font-medium text-ink-2">{r.en}</span>
                  <span className="text-[12.5px] text-ink-3" dir="rtl">
                    {r.ar}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-5 text-[12.5px] leading-relaxed text-ink-3">
              {t(
                "Nothing is hidden behind a “we're a stealth company” line. If you are hiring for a bank or an insurer and want to talk to whoever will actually answer the phone, the fastest route is the demo.",
                "لا شيء مخفي خلف عبارة «نحن شركة ناشئة». إن كنت توظّف عن بنك أو شركة تأمين وتريد التحدث إلى من سيردّ فعلاً على الهاتف، فأسرع طريق هو العرض التجريبي.",
                lang,
              )}
            </p>
          </section>
        </Reveal>
      </div>
    </div>
  );
}
