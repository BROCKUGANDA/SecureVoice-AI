"use client";

import { ScrollText, FileText, ArrowRight } from "lucide-react";
import { useApp, t } from "@/lib/store";
import { Reveal } from "@/components/fx/core";

/* ————————————————— shared legal shell ————————————————— */

function LegalShell({
  kind,
  icon: Icon,
  titleEn,
  titleAr,
  subtitleEn,
  subtitleAr,
  meta,
  sections,
}: {
  kind: "privacy" | "terms";
  icon: typeof ScrollText;
  titleEn: string;
  titleAr: string;
  subtitleEn: string;
  subtitleAr: string;
  meta: { version: string; effective: string; entity: string };
  sections: { h: string; body: string[] }[];
}) {
  const { lang, setView } = useApp();

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8 lg:py-12">
      <div className="mx-auto max-w-3xl">
        {/* header */}
        <div className="flex items-center gap-3">
          <span className="micro text-primary">{kind === "privacy" ? "Privacy" : "Legal"}</span>
          <span className="h-px w-10 bg-line" />
          <span dir="rtl" className="font-arabic text-[13px] text-ink-3">
            {kind === "privacy" ? "الخصوصية" : "الشروط والأحكام"}
          </span>
        </div>
        <h1 className="font-display mt-3 flex items-center gap-3 text-3xl font-semibold tracking-tight sm:text-4xl">
          <Icon className="h-7 w-7 text-primary" strokeWidth={1.6} />
          {lang === "ar" ? titleAr : titleEn}
        </h1>
        <p className="mt-3 text-[15px] leading-relaxed text-ink-2">
          {lang === "ar" ? subtitleAr : subtitleEn}
        </p>

        <div className="mt-5 flex flex-wrap gap-x-6 gap-y-1.5 rounded-2xl border border-line bg-white px-5 py-3.5 font-mono text-[11px] text-ink-3">
          <span>VERSION {meta.version}</span>
          <span>EFFECTIVE {meta.effective}</span>
          <span>{meta.entity}</span>
        </div>

        {/* body */}
        <div className="mt-10 space-y-9">
          {sections.map((s, i) => (
            <Reveal key={s.h} delay={Math.min(i * 0.03, 0.15)}>
              <section>
                <h2 className="font-display text-[17px] font-semibold tracking-tight">
                  <span className="mr-2.5 font-mono text-[12px] font-bold text-primary">{String(i + 1).padStart(2, "0")}</span>
                  {s.h}
                </h2>
                <div className="mt-3 space-y-3 border-l-2 border-line pl-5">
                  {s.body.map((p, j) => (
                    <p key={j} className="text-[13.5px] leading-relaxed text-ink-2">
                      {p}
                    </p>
                  ))}
                </div>
              </section>
            </Reveal>
          ))}
        </div>

        {/* cross-link */}
        <div className="mt-12 rounded-2xl border border-line bg-white p-5">
          {kind === "privacy" ? (
            <button
              onClick={() => setView("terms")}
              className="group flex w-full items-center justify-between text-left"
            >
              <span className="text-[13.5px] font-semibold tracking-tight">
                {t("Looking for the Terms of Service?", "تبحث عن الشروط والأحكام؟", lang)}
              </span>
              <ArrowRight className="h-4 w-4 text-ink-3 transition group-hover:translate-x-0.5 group-hover:text-primary" />
            </button>
          ) : (
            <button
              onClick={() => setView("privacy")}
              className="group flex w-full items-center justify-between text-left"
            >
              <span className="text-[13.5px] font-semibold tracking-tight">
                {t("Looking for the Privacy Policy?", "تبحث عن سياسة الخصوصية؟", lang)}
              </span>
              <ArrowRight className="h-4 w-4 text-ink-3 transition group-hover:translate-x-0.5 group-hover:text-primary" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ————————————————— privacy policy ————————————————— */

const PRIVACY_SECTIONS = [
  {
    h: "Who we are",
    body: [
      "SecureVoice Technologies FZ-LLC (\"SecureVoice\", \"we\") provides a real-time voice fraud-intervention platform for banks and insurers operating in the United Arab Emirates. This policy explains what personal data we process through this website and the platform, why, and the rights you have over it.",
      "We act as the data controller for data submitted through this website (for example, a pilot request) and as a data processor acting on your bank's documented instructions for any data processed inside a bank deployment of the platform.",
    ],
  },
  {
    h: "What we collect — and how little it is",
    body: [
      "Through this website we collect only what you type into the pilot-request form: your name, work email, institution, and any optional scoping details (role, portfolio volume, message). We do not run advertising trackers, we do not buy or sell personal data, and we do not use cookies for cross-site profiling.",
      "Inside bank deployments, the platform processes call audio, transcripts, and case metadata strictly to detect and interrupt fraud. Account identifiers reach the platform as tokens — never as full card numbers — and knowledge-check answers are verified without being stored.",
    ],
  },
  {
    h: "Lawful basis",
    body: [
      "For website data we rely on your consent, given when you submit a form, and on our legitimate interest in operating and securing the service. For fraud-intervention calls processed for a bank, the lawful basis is established by that bank — typically the vital-interest and legal-obligation bases recognised under Federal Decree-Law No. 45 of 2021 (the \"PDPL\") — and we operate strictly on the bank's documented instructions.",
    ],
  },
  {
    h: "Where your data lives",
    body: [
      "Website submissions are stored in our UAE region (me-central-1). Platform deployments store speech, transcripts and case data inside the bank's own tenancy, in-country. Data never leaves the UAE; inference endpoints that process audio are similarly pinned to the region, including the prompts sent to them.",
    ],
  },
  {
    h: "How long we keep it",
    body: [
      "Pilot requests are retained for up to 24 months from last contact, then deleted or anonymised. In platform deployments, transcripts are pseudonymised after case closure and raw audio retention is configurable by the bank — down to zero once the tamper-evident audit hash has been written.",
    ],
  },
  {
    h: "Who can see it",
    body: [
      "Access is role-based and least-privilege. Website data is visible only to the pilot team. Deployment data is visible only to the bank itself; SecureVoice staff have no standing access to customer call data, and any time-boxed support access is logged and announced.",
    ],
  },
  {
    h: "Your rights",
    body: [
      "Under the PDPL you may request access, correction, deletion, portability, or object to processing. Email privacy@securevoice.ae and we will verify and respond within 30 days. If you are unsatisfied, you may lodge a complaint with the UAE Data Office.",
      "If your data is processed inside your bank's deployment of SecureVoice, direct your request to the bank; we support the bank in fulfilling it.",
    ],
  },
  {
    h: "Security",
    body: [
      "TLS 1.3 in transit, AES-256 at rest, signed webhooks, least-privilege access, and an immutable audit trail are described in detail on our Security page. We do not ask for — and the platform structurally cannot request — PINs, passwords, OTPs or full card numbers.",
    ],
  },
  {
    h: "Contact",
    body: [
      "Data protection questions: privacy@securevoice.ae. Postal: SecureVoice Technologies FZ-LLC, Dubai, United Arab Emirates. We answer every privacy email personally — no ticket bots.",
    ],
  },
];

export function Privacy() {
  return (
    <LegalShell
      kind="privacy"
      icon={ScrollText}
      titleEn="Privacy Policy"
      titleAr="سياسة الخصوصية"
      subtitleEn="We collect the minimum needed to answer you, we store it in the UAE, and we never sell it. This page is the plain-English version; the legal text of our DPA is available to pilot customers on request."
      subtitleAr="نجمع الحد الأدنى اللازم للرد عليك، ونخزّنه في الإمارات، ولا نبيعه أبداً. هذه النسخة المبسطة؛ والنص القانوني متاح لعملاء البرنامج التجريبي عند الطلب."
      meta={{ version: "1.2", effective: "2026-02-01", entity: "SECUREVOICE TECHNOLOGIES FZ-LLC" }}
      sections={PRIVACY_SECTIONS}
    />
  );
}

/* ————————————————— terms of service ————————————————— */

const TERMS_SECTIONS = [
  {
    h: "Agreement",
    body: [
      "These Terms govern your use of this website and any evaluation access to the SecureVoice platform (the \"Service\") operated by SecureVoice Technologies FZ-LLC (\"SecureVoice\", \"we\"). By using the Service you accept these Terms. Production use by a financial institution is governed by a separate signed agreement (MSA + DPA) that takes precedence over anything on this page.",
    ],
  },
  {
    h: "What the Service is",
    body: [
      "SecureVoice is a real-time voice fraud-intervention platform: when a transaction crosses a bank's risk threshold, the platform places an outbound call, verifies identity within guardrails, and executes protective actions such as freezing a card or holding a transfer. The public demonstration on this website replays representative scenarios with synthetic data; the conversation-turn endpoint is the same auditable decision surface used in production deployments.",
    ],
  },
  {
    h: "Demo data and no warranty",
    body: [
      "Names, card digits, case references and amounts shown in the demo are synthetic. The demo is provided \"as is\" for evaluation. While we work hard to keep it available, we do not warrant uninterrupted or error-free operation of the public demonstration, and availability figures shown on the status endpoint apply to the reference deployment only.",
    ],
  },
  {
    h: "Acceptable use",
    body: [
      "Do not attempt to identify real individuals from demo data, probe or disrupt the Service, submit another person's personal information through our forms, or use automated tooling to spam the pilot intake (we rate-limit and honeypot; abuse is logged). Security research is welcome within our Responsible Disclosure policy on the Security page.",
    ],
  },
  {
    h: "Protective actions are not financial advice",
    body: [
      "Fraud decisions produced by the platform are operational actions taken on behalf of the contracting bank under its own policies. Nothing on this website constitutes financial, legal, or regulatory advice, and no customer relationship is created by using the demonstration.",
    ],
  },
  {
    h: "Intellectual property",
    body: [
      "The Service, including its guardrail policy format, agent architecture, voice personas and this website, is the property of SecureVoice Technologies FZ-LLC and its licensors. You may reference and link to this site; you may not copy its design, content or code for competing purposes without written permission.",
    ],
  },
  {
    h: "Limitation of liability",
    body: [
      "To the maximum extent permitted by law, SecureVoice is not liable for indirect, incidental or consequential damages arising from use of the public website or demonstration. Nothing in these Terms limits liability that cannot be limited by law.",
    ],
  },
  {
    h: "Governing law",
    body: [
      "These Terms are governed by the laws of the United Arab Emirates, and the courts of Dubai have exclusive jurisdiction. We may update these Terms; material changes will be announced on this page with a new version and effective date.",
    ],
  },
];

export function Terms() {
  return (
    <LegalShell
      kind="terms"
      icon={FileText}
      titleEn="Terms of Service"
      titleAr="الشروط والأحكام"
      subtitleEn="The short version: use this site lawfully, treat the demo as evaluation-only, and rely on a signed agreement for production. The long version follows."
      subtitleAr="باختصار: استخدم الموقع بشكل قانوني، وتعامل مع العرض التجريبي كتقييم فقط، واعتمد على اتفاقية موقّعة للإنتاج. التفاصيل الكاملة أدناه."
      meta={{ version: "1.1", effective: "2026-02-01", entity: "SECUREVOICE TECHNOLOGIES FZ-LLC" }}
      sections={TERMS_SECTIONS}
    />
  );
}
