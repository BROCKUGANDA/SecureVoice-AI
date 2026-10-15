"use client";

import { HelpCircle, Mail } from "lucide-react";
import { useApp, t } from "@/lib/store";
import { FAQ } from "@/lib/commercial";
import { SUPPORT_EMAIL } from "@/lib/public-config";

/**
 * The published FAQ.
 *
 * This content has existed in `@/lib/commercial` since before it was rendered
 * anywhere: it was emitted as `FAQPage` structured data and never shown to a
 * human. That is the worst of both worlds — an answer engine can quote a page a
 * visitor cannot read, and a visitor who wants to read the same answers has
 * nowhere to go. It is now a real page at `/faq`.
 *
 * ## Why the answers are always visible rather than behind a disclosure
 *
 * The obvious build is an accordion. This is not one, for three reasons:
 *
 *   - The answer text in `commercial.ts` is written to be quotable out of
 *     context by something that has never seen the site. Collapsing it is the
 *     exact opposite of that intent.
 *   - Structured data must describe content that is on the page. An answer
 *     hidden behind `<details>` is still in the DOM, but a crawler that does not
 *     expand it and a visitor who does not click are being told something
 *     different from what `FAQPage` claims.
 *   - It is the same text, so a disclosure widget would ship JS to reveal
 *     content that costs nothing to render. On a page whose whole job is being
 *     read and cited, that is a bad trade.
 *
 * ## Why the data is not re-typed here
 *
 * `FAQ` is the single source, read by this view, by the `/faq` JSON-LD, and by
 * `llms.txt`. A hand-copied answer is how a support article starts contradicting
 * the pricing page, and the pricing answer below is the one most likely to.
 */
export function Faq() {
  const { lang } = useApp();

  return (
    <div className="mx-auto max-w-4xl px-4 py-10 sm:px-6 lg:px-8 lg:py-14">
      {/* header */}
      <div className="flex items-center gap-3">
        <span className="micro text-primary">{t("FAQ", "الأسئلة الشائعة", lang)}</span>
        <span className="h-px w-10 bg-line" />
      </div>

      <h1 className="font-display mt-3 flex items-center gap-3 text-3xl font-semibold tracking-tight sm:text-4xl">
        <HelpCircle className="h-7 w-7 text-primary" strokeWidth={1.6} />
        {t("Questions we are actually asked", "الأسئلة التي تُطرح علينا فعلاً", lang)}
      </h1>

      <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-ink-2">
        {t(
          "Eight answers, written to be read on their own. If something here is still unclear, the address below reaches a person.",
          "ثمانية أجوبة، كُتبت لتُقرأ وحدها. وإن بقي شيء غير واضح هنا، فإن العنوان أدناه يصل إلى شخص حقيقي.",
          lang,
        )}
      </p>

      {/* Questions and answers — a description list, because that is what this
          is: terms and their definitions. Not a tab set, not a card grid, and
          not a disclosure. The header text and the answers are both always
          present, so there is no `aria-expanded` to lie about — see the note
          above on why this is not an accordion. */}
      <dl className="mt-10 divide-y divide-line border-y border-line">
        {FAQ.map((f) => (
          <div key={f.q} className="py-6">
            <dt className="font-display text-[17px] font-semibold leading-snug tracking-tight text-ink">
              {lang === "ar" ? f.qAr : f.q}
            </dt>
            <dd
              className="mt-3 text-[14.5px] leading-relaxed text-ink-2"
              dir={lang === "ar" ? "rtl" : undefined}
            >
              {lang === "ar" ? f.aAr : f.a}
            </dd>
          </div>
        ))}
      </dl>

      {/* The question this page cannot answer. */}
      <div className="mt-12 rounded-2xl border border-line bg-white px-6 py-7">
        <h2 className="font-display text-[19px] font-semibold tracking-tight">
          {t("Still not answered?", "لم تجد إجابتك؟", lang)}
        </h2>
        <p className="mt-2 text-[14px] leading-relaxed text-ink-2">
          {t(
            "Procurement, security review, or a specific integration question — this reaches the team directly.",
            "للشراء، أو مراجعة أمنية، أو سؤال عن تكامل معيّن — يتصل هذا الأمر بالفريق مباشرة.",
            lang,
          )}
        </p>
        <a
          href={`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent("Question about SecureVoice AI")}`}
          className="mt-5 inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-[13px] font-semibold text-white transition hover:bg-primary-dark"
        >
          <Mail className="h-4 w-4" strokeWidth={1.8} />
          {SUPPORT_EMAIL}
        </a>
      </div>
    </div>
  );
}
