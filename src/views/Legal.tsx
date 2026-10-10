"use client";

import { ScrollText, FileText, ArrowRight, Undo2 } from "lucide-react";
import { useApp, t } from "@/lib/store";
import { SUPPORT_EMAIL } from "@/lib/public-config";
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
  sectionsAr,
}: {
  kind: "privacy" | "terms" | "refund";
  icon: typeof ScrollText;
  titleEn: string;
  titleAr: string;
  subtitleEn: string;
  subtitleAr: string;
  meta: { version: string; effective: string; entity: string };
  sections: { h: string; body: string[] }[];
  /* Modern Standard Arabic counterpart of `sections`, index-aligned. The
     English legal text is authoritative, so the two live side by side rather
     than interleaved — the translation can never silently rewrite it. */
  sectionsAr: { h: string; body: string[] }[];
}) {
  const { lang } = useApp();

  /** Short eyebrow above the title, and its Arabic mirror. */
  const eyebrow: [string, string] =
    kind === "privacy"
      ? ["Privacy", "الخصوصية"]
      : kind === "refund"
        ? ["Refunds", "الاسترداد"]
        : ["Legal", "الشروط والأحكام"];
  const eyebrowAr =
    kind === "privacy" ? "الخصوصية" : kind === "refund" ? "الاسترداد" : "الشروط والأحكام";

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8 lg:py-12">
      <div className="mx-auto max-w-3xl">
        {/* header */}
        <div className="flex items-center gap-3">
          <span className="micro text-primary">{t(eyebrow[0], eyebrow[1], lang)}</span>
          <span className="h-px w-10 bg-line" />
          {lang === "en" && (
            <span dir="rtl" className="font-arabic text-[13px] text-ink-3">
              {eyebrowAr}
            </span>
          )}
        </div>
        <h1 className="font-display mt-3 flex items-center gap-3 text-3xl font-semibold tracking-tight sm:text-4xl">
          <Icon className="h-7 w-7 text-primary" strokeWidth={1.6} />
          {lang === "ar" ? titleAr : titleEn}
        </h1>
        <p className="mt-3 text-[15px] leading-relaxed text-ink-2">
          {lang === "ar" ? subtitleAr : subtitleEn}
        </p>

        <div className="mt-5 flex flex-wrap gap-x-6 gap-y-1.5 rounded-2xl border border-line bg-white px-5 py-3.5 font-mono text-[11px] text-ink-3">
          <span>
            {t("VERSION", "إصدار", lang)} {meta.version}
          </span>
          <span>
            {t("EFFECTIVE", "ساري من", lang)} {meta.effective}
          </span>
          <span>{meta.entity}</span>
        </div>

        {/* body */}
        <div className="mt-10 space-y-9">
          {sections.map((s, i) => (
            <Reveal key={s.h} delay={Math.min(i * 0.03, 0.15)}>
              <section>
                <h2 className="font-display text-[17px] font-semibold tracking-tight">
                  <span className="mr-2.5 font-mono text-[12px] font-bold text-primary">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  {t(s.h, sectionsAr[i].h, lang)}
                </h2>
                <div className="mt-3 space-y-3 border-l-2 border-line pl-5">
                  {s.body.map((p, j) => (
                    <p key={j} className="text-[13.5px] leading-relaxed text-ink-2">
                      {t(p, sectionsAr[i].body[j], lang)}
                    </p>
                  ))}
                </div>
              </section>
            </Reveal>
          ))}
        </div>

        {/* cross-link
            Real anchors, not `setView` buttons. The same component renders in two
            places: as a panel inside the SPA at `/`, and as a standalone route at
            `/terms` etc. A `setView` call is inert on the standalone route (there
            is no SPA mounted to receive it), so the link would look live and do
            nothing. An `<a href>` is correct in both, and it is also what makes the
            documents mutually reachable by a crawler rather than only by a click. */}
        <nav
          aria-label="Related legal documents"
          className="mt-12 grid gap-px overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-2"
        >
          {LEGAL_DOCS.map((doc) => (
            <a
              key={doc.id}
              href={doc.href}
              className="group flex items-center justify-between bg-white px-5 py-4 text-left transition hover:bg-green-tint"
            >
              <span>
                <span className="block text-[13.5px] font-semibold tracking-tight">
                  {doc.titleEn}
                </span>
                <span className="mt-0.5 block text-[11.5px] text-ink-3">
                  {t(doc.blurbEn, doc.blurbAr, lang)}
                </span>
              </span>
              <ArrowRight className="h-4 w-4 shrink-0 text-ink-3 transition group-hover:translate-x-0.5 group-hover:text-primary" />
            </a>
          ))}
        </nav>
      </div>
    </div>
  );
}

/**
 * The three legal documents, so the cross-link bar renders all of them instead
 * of the two-way Privacy↔Terms pairing it replaced. `href` is the real route;
 * `id` is the in-app `View`, kept for the SPA navigation the footer uses.
 */
const LEGAL_DOCS = [
  {
    id: "terms",
    href: "/terms",
    titleEn: "Terms of Service",
    blurbEn: "The agreement this website and any evaluation access operate under.",
    blurbAr: "الاتفاقية التي يعمل بمقتضاها هذا الموقع وأي وصول تقييمي.",
  },
  {
    id: "privacy",
    href: "/privacy",
    titleEn: "Privacy Policy",
    blurbEn: "What we process, where it lives, and your rights over it.",
    blurbAr: "ما نعالجه وأين يُحفظ وحقوقكم بشأنه.",
  },
  {
    id: "refund",
    href: "/refund",
    titleEn: "Refund Policy",
    blurbEn: "How cancellation and refunds work, including prepaid credits.",
    blurbAr: "كيف يعمل الإلغاء والاسترداد، بما في ذلك الأرصدة المسبقة.",
  },
] as const;

/* ————————————————— privacy policy ————————————————— */

const PRIVACY_SECTIONS = [
  {
    h: "Who we are",
    body: [
      'SecureVoice Technologies FZ-LLC ("SecureVoice", "we") provides a real-time voice fraud-intervention platform for banks and insurers operating in the United Arab Emirates. This policy explains what personal data we process through this website and the platform, why, and the rights you have over it.',
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
      'For website data we rely on your consent, given when you submit a form, and on our legitimate interest in operating and securing the service. For fraud-intervention calls processed for a bank, the lawful basis is established by that bank — typically the vital-interest and legal-obligation bases recognised under Federal Decree-Law No. 45 of 2021 (the "PDPL") — and we operate strictly on the bank\'s documented instructions.',
      "Because this deployment runs in the European Economic Area, we also comply with the EU General Data Protection Regulation (Regulation (EU) 2016/679) for personal data processed in connection with it: we rely on your consent for website submissions and on legitimate interests for security logging, we have concluded a Data Processing Agreement with each processor, and transfers outside the EEA are covered by Standard Contractual Clauses or an adequacy decision.",
    ],
  },
  {
    h: "Where your data lives",
    body: [
      "This website and the reference deployment run in European infrastructure: the application server and its database are hosted in Germany (Frankfurt, eu-central-1) with TLS 1.3 in transit and AES-256 at rest.",
      "Live voice inference — text to speech and speech to text — is performed by our processors (listed below) in the United States and the United Kingdom, so the words spoken during an intervention call cross the border to be synthesised. We do not send call audio to any model for reasoning or decision-making; intent classification and every protective action are deterministic server-side code.",
      "In a bank deployment the position changes: case data, transcripts and audio are written to the bank's own tenancy, and our role is that of a processor acting on the bank's documented instructions. A bank requiring in-country (UAE) processing deploys the platform inside its own VPC — the container topology is unchanged — so speech, transcripts and case data never leave its perimeter.",
      "We do not sell personal data, and we do not use it for advertising or profiling of any kind.",
    ],
  },
  {
    h: "Sub-processors",
    body: [
      "We use a small number of processors, each under contract and each limited to the purpose stated: identity and session management, which we host ourselves on our own infrastructure (the Clerk processor was retired at the Clerk -> Better Auth cutover, and no account data is sent to a third-party identity provider); telephony for outbound intervention calls and SMS (Twilio); speech synthesis and transcription (ElevenLabs, with Deepgram as fallback); optional reply drafting (Groq or Google Gemini); infrastructure and database hosting (the cloud provider and database provider named in our sub-processor register); and transactional email for support replies. Where a deployment enables Better Auth's optional hosted telemetry (BETTER_AUTH_API_KEY), Better Auth receives request metadata only — never case content, credentials, or personal data — and that processor must be added to the register below before such a deployment is offered.",
      "Where a bank requires additional residency, silence, or a written commitment for any of these, we will either pin the processor to an in-region endpoint or remove it from that deployment. The current register, with processing locations and the standard contractual clauses where applicable, is available on request.",
    ],
  },
  {
    h: "Automated voice and your rights when you are called",
    body: [
      "The intervention call is delivered by an AI voice agent. Every call opens with a spoken disclosure that it is an automated system calling on the bank's behalf and that the call is recorded, and the agent never asks for a PIN, password, one-time passcode or full card number.",
      "You can ask to stop at any time and the opt-out is honoured immediately for all future contact about that account.",
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
      `Under the PDPL you may request access, correction, deletion, portability, or object to processing. Under the GDPR you may also request restriction and erasure, and you may complain to your national supervisory authority — in the EEA, the Irish Data Protection Commission is our lead authority. Email ${SUPPORT_EMAIL} and we will verify and respond within 30 days.`,
      "If your data is processed inside your bank's deployment of SecureVoice, direct your request to the bank; we support the bank in fulfilling it. If you ask us to delete a case record, we destroy the encryption key that makes the transcript readable while retaining the hash chain, so the record of the action remains provable without the content.",
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
      `Data protection questions: ${SUPPORT_EMAIL}. Postal: SecureVoice Technologies FZ-LLC, Dubai, United Arab Emirates. We answer every privacy email personally — no ticket bots.`,
    ],
  },
];

/* ————————————————— privacy policy (Modern Standard Arabic) ————————————————— */

const PRIVACY_SECTIONS_AR = [
  {
    h: "من نحن",
    body: [
      "تُقدّم شركة SecureVoice Technologies FZ-LLC («SecureVoice»، «نحن») منصة صوتية للتدخل الفوري في الاحتيال، للبنوك وشركات التأمين العاملة في دولة الإمارات العربية المتحدة. وتوضح هذه السياسة بيانات الشخصية التي نعالجها عبر هذا الموقع والمنصة، وسبب معالجتها، والحقوق التي تتمتّعون بها بشأنها.",
      "نعمل كمراقب للبيانات المقدّمة عبر هذا الموقع (مثل طلب تجربة ميدانية)، وكمعالج للبيانات يتصرّف وفق تعليمات بنككم الموثّقة بالنسبة إلى أي بيانات تُعالج داخل نشر بنكي للمنصة.",
    ],
  },
  {
    h: "ما نجمعه — ومدى قِلّته",
    body: [
      "عبر هذا الموقع نجمع فقط ما يُدخَل في نموذج طلب التجربة: الاسم، والبريد المهني، والمؤسسة، وأي تفاصيل اختيارية لتحديد النطاق (الدور، وحجم المحفظة، والرسالة). ولا نشغّل أدوات تتبّع إعلانية، ولا نشتري أو نبيع بيانات شخصية، ولا نستخدم ملفات تعريف الارتباط للتتبع بين المواقع.",
      "داخل عمليات النشر البنكية، تعالج المنصة صوت المكالمات والنصوص المحوّلة وبيانات الحالة الوصفية، لكشف الاحتيال وإيقافه حصراً. وتصل معرّفات الحساب إلى المنصة كرموز مميّزة — لا كأرقام بطاقات كاملة — وتُتحقّق من إجابات أسئلة التحقق دون تخزينها.",
    ],
  },
  {
    h: "الأساس القانوني",
    body: [
      "بالنسبة إلى بيانات الموقع، نعتمد على موافقتكم المقدّمة عند إرسال النموذج، وعلى مصلحتنا المشروعة في تشغيل الخدمة وتأمينها. وبالنسبة إلى مكالمات التدخل الاحتيالي التي تُعالج لحساب بنك، فالأساس القانوني يحدّده ذلك البنك — وعادةً ما يكون أساس المصلحة الحيوية والالتزام القانوني المعترف بهما بموجب المرسوم بقانون اتحادي رقم 45 لسنة 2021 (قانون حماية البيانات الشخصية) — ونحن نعمل حصراً وفق تعليمات البنك الموثّقة.",
      "لأن هذا النشر يعمل داخل المنطقة الاقتصادية الأوروبية، فإننا نلتزم أيضاً باللائحة العامة لحماية البيانات في الاتحاد الأوروبي (اللائحة (EU) 2016/679) بالنسبة إلى البيانات الشخصية المعالجة بالارتباط به: نعتمد على موافقتكم لإرسالات الموقع وعلى المصالح المشروعة لتسجيل أحداث الأمان، وقد أبرمنا اتفاقية معالجة بيانات مع كل معالج، وتغطّي البنود التعاقدية النموذجية أو قرار الملاءمة عمليات النقل خارج المنطقة الاقتصادية الأوروبية.",
    ],
  },
  {
    h: "أين تُحتفظ ببياناتكم",
    body: [
      "يعمل هذا الموقع والنشر المرجعي على بنية تحتية أوروبية: خادم التطبيق وقاعدة بياناته مستضافان في ألمانيا (فرانكفورت، eu-central-1)، بتشفير TLS 1.3 أثناء النقل وAES-256 أثناء التخزين.",
      "يُجرى الاستدلال الصوتي الحيّ — تحويل النص إلى كلام والكلام إلى نص — عبر معالجينا (المذكورين أدناه) في الولايات المتحدة والمملكة المتحدة، لذا تعبر الكلمات المنطوقة في مكالمة التدخل الحدود لتُولَّد صوتياً. ولا نرسل صوت المكالمات إلى أي نموذج للاستدلال أو اتخاذ القرار؛ فتصنيف النية وكل إجراء وقائي هما شيفرة خادمية حتمية.",
      "أما في النشر البنكي فالوضع يتغيّر: تُكتب بيانات الحالة والنصوص والصوت في مستأجر البنك الخاص، ودورنا دور معالج يتصرّف وفق تعليمات البنك الموثّقة. والبنك الذي يشترط المعالجة داخل الدولة (الإمارات) ينشر المنصة داخل شبكته الافتراضية الخاصة — دون تغيير في طوبولوجيا الحاويات — فلا يغادر الكلام ولا النصوص ولا بيانات الحالة نطاقه.",
      "لا نبيع البيانات الشخصية، ولا نستخدمها في الإعلانات أو بناء الملامح الشخصية بأي شكل.",
    ],
  },
  {
    h: "المعالجون الفرعيون",
    body: [
      "نستخدم عدداً قليلاً من المعالجين، كل منهم بموجب عقد وكل منهم مقيّد بالغرض المذكور: إدارة الهوية والجلسات، التي نستضيفها بأنفسنا على بنيتنا التحتية (وقد أُوقف معالج Clerk عند الانتقال من Clerk إلى Better Auth، ولا تُرسل أي بيانات حساب إلى مزوّد هوية خارجي)؛ والاتصالات الهاتفية للمكالمات الصادرة والرسائل النصية (Twilio)؛ وتوليف الكلام وتحويله إلى نص (ElevenLabs، مع Deepgram كبديل)؛ وصياغة الردود الاختيارية (Groq أو Google Gemini)؛ واستضافة البنية التحتية وقاعدة البيانات (مزوّد الخدمات السحابية ومزوّد قاعدة البيانات المذكورين في سجل المعالجين الفرعيين)؛ والبريد الإلكتروني للردود على الاستفسارات. وحيثما يُفعّل النشر القياسات الاختيارية المستضافة لدى Better Auth (BETTER_AUTH_API_KEY)، فإن Better Auth يستقبل بيانات وصفية عن الطلبات فقط — لا محتوى الحالات ولا بيانات الاعتماد ولا البيانات الشخصية — ويجب إضافة ذلك المعالج إلى السجل أدناه قبل طرح مثل هذا النشر.",
      "وحيثما يشترط أحد البنوك موقعاً إضافياً للبيانات، أو التزاماً بالسرّية، أو تعهّداً كتابياً بأي من هذه الجهات، فسنقوم إما بتثبيت المعالج على نقطة نهاية داخل المنطقة أو بإزالته من ذلك النشر. والسجل الحالي، بمواقع المعالجة والبنود التعاقدية النموذجية حيث تنطبق، متاح عند الطلب.",
    ],
  },
  {
    h: "الصوت الآلي وحقوقكم عندما يتم الاتصال بكم",
    body: [
      "تُسلَّم مكالمة التدخل عبر وكيل صوتي ذكاء اصطناعي. وتبدأ كل مكالمة بإفصاح منطوق بأنها نظام آلي يتصل نيابة عن البنك وأن المكالمة مُسجَّلة، ولا يطلب الوكيل في أي وقت رمزاً سرياً أو كلمة مرور أو رمز تحقق لمرة واحدة أو رقم بطاقة كاملاً.",
      "يمكنكم طلب التوقف في أي وقت، ويُحترم طلب إلغاء الاشتراك فوراً في كل تواصل مستقبلي بشأن ذلك الحساب.",
    ],
  },
  {
    h: "مدة الاحتفاظ بها",
    body: [
      "تُحتفظ بطلبات التجربة لمدة تصل إلى ٢٤ شهراً من آخر تواصل، ثم تُحذف أو تُصبح مجهولة الهوية. وفي عمليات نشر المنصة، تُجعل النصوص المحوّلة مجهولة الهوية بعد إغلاق الحالة، ومدة الاحتفاظ بالصوت الخام قابلة للتحديد من البنك — وصولاً إلى الصفر بعد كتابة بصمة التدقيق المقاومة للعبث.",
    ],
  },
  {
    h: "من يمكنه الاطلاع عليها",
    body: [
      "الوصول قائم على الأدوار ومحدود بأقل صلاحيات ممكنة. بيانات الموقع مرئية لفريق التجربة فقط. وبيانات النشر مرئية للبنك وحده؛ ولا يملك موظفو SecureVoice حق وصول دائم إلى بيانات مكالمات العملاء، وأي وصول للدعم محدود المدة يُسجَّل ويُعلَن.",
    ],
  },
  {
    h: "حقوقكم",
    body: [
      `بموجب قانون حماية البيانات الشخصية، يمكنكم طلب الوصول أو التصحيح أو الحذف أو النقل، أو الاعتراض على المعالجة. وبموجب اللائحة العامة لحماية البيانات، يمكنكم أيضاً طلب تقييد المعالجة والمحو، وتقديم شكوى إلى سلطة الرقابة الوطنية — وفي المنطقة الاقتصادية الأوروبية تكون لجنة حماية البيانات الأيرلندية هي سلطتنا الرئيسية. راسلوا ${SUPPORT_EMAIL} وسنتحقق ونردّ خلال ٣٠ يوماً.`,
      "إذا كانت بياناتكم تُعالج داخل نشر SecureVoice في بنككم، فوجّهوا طلبكم إلى البنك؛ ونحن ندعم البنك في تنفيذه. وإذا طلبتم منا حذف سجل حالة، فإننا نتلف مفتاح التشفير الذي يجعل النص المحوّل قابلاً للقراءة، مع الاحتفاظ بسلسلة البصمات، فيبقى إثبات وقوع الإجراء ممكناً دون الاحتفاظ بالمحتوى.",
    ],
  },
  {
    h: "الأمن",
    body: [
      "يُوصف بالتفصيل في صفحة الأمان لدينا تشفير TLS 1.3 أثناء النقل وAES-256 أثناء التخزين، وخطافات الأحداث الموقّعة، والوصول بأقل صلاحيات ممكنة، وأثر التدقيق غير القابل للتغيير. ولا نطلب — ولا تستطيع المنصة بنيوياً أن تطلب — رموزاً سرية أو كلمات مرور أو رموز تحقق لمرة واحدة أو أرقام بطاقات كاملة.",
    ],
  },
  {
    h: "التواصل",
    body: [
      `أسئلة حماية البيانات: ${SUPPORT_EMAIL}. البريد البريدي: SecureVoice Technologies FZ-LLC، دبي، الإمارات العربية المتحدة. نردّ على كل رسالة خصوصية شخصياً — بلا روبوتات تذاكر.`,
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
      subtitleEn="We collect the minimum needed to answer you, we store it in Europe, and we never sell it. This page is the plain-English version; the legal text of our DPA is available to pilot customers on request."
      subtitleAr="نجمع الحد الأدنى اللازم للرد عليك، ونخزّنه في أوروبا، ولا نبيعه أبداً. هذه النسخة المبسطة؛ والنص القانوني متاح لعملاء البرنامج التجريبي عند الطلب."
      meta={{ version: "1.3", effective: "2026-10-02", entity: "SECUREVOICE TECHNOLOGIES FZ-LLC" }}
      sections={PRIVACY_SECTIONS}
      sectionsAr={PRIVACY_SECTIONS_AR}
    />
  );
}

/* ————————————————— terms of service ————————————————— */

const TERMS_SECTIONS = [
  {
    h: "Agreement",
    body: [
      'These Terms govern your use of this website and any evaluation access to the SecureVoice platform (the "Service") operated by SecureVoice Technologies FZ-LLC ("SecureVoice", "we"). By using the Service you accept these Terms. Production use by a financial institution is governed by a separate signed agreement (MSA + DPA) that takes precedence over anything on this page.',
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
      'Names, card digits, case references and amounts shown in the demo are synthetic. The demo is provided "as is" for evaluation. While we work hard to keep it available, we do not warrant uninterrupted or error-free operation of the public demonstration, and availability figures shown on the status endpoint apply to the reference deployment only.',
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
    h: "Artificial intelligence and automated decisions",
    body: [
      "The Service uses an AI voice agent for customer contact and, where configured, a language model to phrase replies. No model ever decides a financial outcome. Intent classification, identity verification and every protective action are deterministic server-side code governed by the bank's policy; a language model may only rephrase a line that policy has already approved, and its output is scanned before it is spoken.",
      "A freeze or hold requested by the agent is staged and reversible, and a second actor — the bank's system or a human specialist — commits it. You can ask at any point during a call whether you are speaking to an automated system, and the agent will tell you plainly.",
      "Because our website demonstration runs on synthetic data and is for evaluation only, no automated decision made by it affects any real person. Production terms on this point are governed by the signed agreement with the contracting bank.",
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

/* ————————————————— terms of service (Modern Standard Arabic) ————————————————— */

const TERMS_SECTIONS_AR = [
  {
    h: "الاتفاقية",
    body: [
      "تحكم هذه الشروط استخدامكم لهذا الموقع وأي وصول تقييمي إلى منصة SecureVoice («الخدمة») التي تديرها شركة SecureVoice Technologies FZ-LLC («SecureVoice»، «نحن»). وباستخدامكم الخدمة فإنكم تقبلون هذه الشروط. أما الاستخدام الإنتاجي من قِبل مؤسسة مالية فيخضع لاتفاقية موقّعة منفصلة (اتفاقية مستوى الخدمة + اتفاقية معالجة البيانات) تتقدّم على أي مما ورد في هذه الصفحة.",
    ],
  },
  {
    h: "ما هي الخدمة",
    body: [
      "SecureVoice منصة صوتية للتدخل الفوري في الاحتيال: عندما تتجاوز عملية ما عتبة الخطر المعتمدة في البنك، تبدأ المنصة مكالمة صادرة، وتتحقق من الهوية في إطار الضمانات، وتنفّذ إجراءات وقائية مثل تجميد البطاقة أو إيقاف التحويل. أما العرض التوضيحي على هذا الموقع فيعيد سيناريوهات نموذجية ببيانات اصطناعية؛ ونقطة نهاية محادثة الوكيل هي نفس سطح القرار القابل للتدقيق المستخدم في عمليات النشر الإنتاجية.",
    ],
  },
  {
    h: "بيانات العرض وعدم الضمان",
    body: [
      "الأسماء وأرقام البطاقات ومراجع الحالات والمبالغ الظاهرة في العرض اصطناعية. ويُقدَّم العرض «كما هو» لأغراض التقييم. وبينما نبذل قصارى جهدنا للحفاظ على توفره، فإننا لا نضمن تشغيل العرض التوضيحي العام دون انقطاع أو أخطاء، وأرقام التوافر المعروضة على نقطة نهاية الحالة تنطبق على النشر المرجعي فقط.",
    ],
  },
  {
    h: "الاستخدام المقبول",
    body: [
      "لا تحاولوا التعرّف على أشخاص حقيقيين من بيانات العرض، ولا تختبروا أو تعطّلوا الخدمة، ولا ترسلوا معلومات شخصية لشخص آخر عبر نماذجنا، ولا تستخدموا أدوات آلية لإغراق استمارة التجربة (فنحن نحدّ المعدّل ونستخدم مصائد المحتالين؛ ويُسجَّل أي إساءة). ونرحّب بأبحاث الأمن في إطار سياسة الإبلاغ المسؤول المنشورة في صفحة الأمان.",
    ],
  },
  {
    h: "الإجراءات الوقائية ليست استشارة مالية",
    body: [
      "قرارات الاحتيال التي تصدرها المنصة إجراءات تشغيلية تُتخذ نيابة عن البنك المتعاقد وفق سياساته. ولا شيء في هذا الموقع يُشكّل استشارة مالية أو قانونية أو تنظيمية، ولا ينشأ عن استخدام العرض أي علاقة عميل.",
    ],
  },
  {
    h: "الذكاء الاصطناعي والقرارات الآلية",
    body: [
      "تستخدم الخدمة وكيلاً صوتياً بالذكاء الاصطناعي للتواصل مع العملاء، ونموذجاً لغوياً — حيث يكون مكوّناً — لصياغة الردود. ولا يقرّر أي نموذج نتيجة مالية. فتصنيف النية والتحقق من الهوية وكل إجراء وقائي هي شيفرة خادمية حتمية يحكمها سياسة البنك؛ ولا يجوز للنموذج اللغوي سوى إعادة صياغة عبارة وافقت عليها السياسة مسبقاً، ويُفحص مخرجه قبل النطق به.",
      "أي تجميد أو إيقاف يطلبه الوكيل يكون مُعدّاً وقابلاً للتراجع، ويكمّله طرف ثانٍ — نظام البنك أو أخصائي بشري. ويمكنكم السؤال في أي لحظة من المكالمة عما إذا كنتم تتحدثون إلى نظام آلي، وسيجيبكم الوكيل بصراحة.",
      "لأن العرض التوضيحي على موقعنا يعمل ببيانات اصطناعية وهو لأغراض التقييم فقط، فإن أي قرار آلي صادر عنه لا يؤثر في أي شخص حقيقي. وتخضع شروط الإنتاج في هذه النقطة للاتفاقية الموقّعة مع البنك المتعاقد.",
    ],
  },
  {
    h: "الملكية الفكرية",
    body: [
      "الخدمة، بما في ذلك صيغة سياسة الضمانات وبنية الوكيل وشخصياته الصوتية وهذا الموقع، ملك لشركة SecureVoice Technologies FZ-LLC ومرخّصيها. ويجوز لكم الإشارة إلى هذا الموقع والربط به؛ ولا يجوز نسخ تصميمه أو محتواه أو شيفرته لأغراض تنافسية دون إذن كتابي.",
    ],
  },
  {
    h: "حدود المسؤولية",
    body: [
      "إلى أقصى حد يسمح به القانون، لا تتحمل SecureVoice مسؤولية الأضرار غير المباشرة أو العرضية أو التبعية الناشئة عن استخدام الموقع أو العرض العام. ولا شيء في هذه الشروط يحدّ المسؤولية التي لا يجوز حدّها قانوناً.",
    ],
  },
  {
    h: "القانون الحاكم",
    body: [
      "تخضع هذه الشروط لقوانين دولة الإمارات العربية المتحدة، وتختص محاكم دبي وحدها بالفصل فيها. ويجوز لنا تحديث هذه الشروط؛ وستُعلن التغييرات الجوهرية في هذه الصفحة برقم إصدار وتاريخ سريان جديدين.",
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
      meta={{ version: "1.2", effective: "2026-10-02", entity: "SECUREVOICE TECHNOLOGIES FZ-LLC" }}
      sections={TERMS_SECTIONS}
      sectionsAr={TERMS_SECTIONS_AR}
    />
  );
}

/* ————————————————— refund policy ————————————————— */

/**
 * The Refund Policy exists because the publication checklist treats Terms,
 * Refund and Privacy as three separate required documents, and this site had
 * only two. It is deliberately concrete — cancellation window, who pays the
 * processing fee, what happens to unused prepaid credits — because a refund
 * policy that says "contact us" satisfies nobody.
 *
 * Two clauses here are load-bearing and must not be softened:
 *
 *  - Consumed credits are non-refundable, because an intervention that has been
 *    placed has already burned carrier minutes, speech synthesis and an LLM turn.
 *    Refunding those would let a customer probe the platform for free.
 *  - Enterprise deployments are governed by the signed agreement, not this page.
 *    Saying otherwise would create a second, conflicting commitment on a page
 *    nobody negotiated.
 *
 * NOTE on currency: plans are billed in USD through Paddle as a Merchant of
 * Record, and UK/IE/AU buyers are charged a REGIONAL price in GBP/EUR/AUD. A
 * refund therefore goes back in the currency and to the instrument the charge
 * was actually taken in — not necessarily USD. That is why the refund section
 * names both cases instead of promising everyone a USD refund.
 */
const REFUND_SECTIONS = [
  {
    h: "Scope",
    body: [
      'This Refund Policy applies to paid subscriptions to the SecureVoice platform, purchased through this website by SecureVoice Technologies FZ-LLC ("SecureVoice", "we"). It is read together with our Terms of Service; where this policy is more specific about money, it governs the money.',
      "It does not apply to production deployments governed by a signed Master Services Agreement and Data Processing Agreement with a financial institution. Those are quoted per deployment and the commercial terms are in the signed agreement, which takes precedence over anything on this page. It also does not apply to the free public demonstration, which is provided for evaluation and carries no charge to refund.",
    ],
  },
  {
    h: "Monthly subscriptions",
    body: [
      "You may cancel a monthly subscription at any time before its next renewal date. Cancellation takes effect at the end of the current paid period, and we refund the unused portion of that period pro rata.",
      "A refund is issued to the original payment method. Plans are billed in US dollars through Paddle, our Merchant of Record, which collects any sales tax or VAT due — so a refund reverses the net amount and Paddle handles any tax adjustment. We do not convert across currencies at a third party's rate. Buyers in the UK, Ireland and Australia who were charged a regional price in GBP, EUR or AUD are refunded in that same currency.",
      "There is no cancellation fee. We do not charge a restocking or admin fee for a cancellation made under this policy.",
    ],
  },
  {
    h: "Prepaid intervention credits",
    body: [
      "Credits purchased as a prepaid balance are refundable while they are unspent. Once a credit has been consumed by a completed intervention call — an outbound call that was placed and answered — that credit is non-refundable, because the carrier minutes, speech synthesis and model inference it paid for have already been incurred.",
      "We will show you a per-intervention consumption breakdown on request before you decide, so you can see exactly how many credits were spent and on what. Unspent credits are refundable in full on request at any time, pro rata against the purchase price paid for them.",
    ],
  },
  {
    h: "How to request one",
    body: [
      `Email ${SUPPORT_EMAIL} from the address on the account with the word "refund" in the subject and the organisation's name. No form, no ticket bot — a person reads it. We acknowledge within two business days and resolve within fourteen.`,
      "You do not need to give a reason. We will not ask you to justify cancelling, and we will not ask you to complete an exit interview first. If you are cancelling because something is broken, tell us anyway — it is the most useful sentence in the thread, and it does not affect your refund.",
    ],
  },
  {
    h: "What we do not refund",
    body: [
      "Professional services already delivered under a signed agreement; carrier pass-through charges actually incurred before cancellation; and any amount for a period during which the service was suspended for non-payment caused by a failed or expired payment method.",
      "Where a fault on our side caused a material failure to deliver the service, we refund regardless of this policy. That is a commitment under the signed agreement, and it is also simply how we intend to operate.",
    ],
  },
  {
    h: "Changes to this policy",
    body: [
      "We may update this policy. Material changes will be announced on this page with a new version number and effective date, and existing subscriptions keep the terms they were bought under until their next renewal.",
    ],
  },
];

/* ————————————————— refund policy (Modern Standard Arabic) ————————————————— */

const REFUND_SECTIONS_AR = [
  {
    h: "النطاق",
    body: [
      "تنطبق سياسة الاسترداد هذه على الاشتراكات المدفوعة لمنصة SecureVoice، التي تُشترى عبر هذا الموقع من شركة SecureVoice Technologies FZ-LLC («SecureVoice»، «نحن»). وتُقرأ مع شروط الخدمة لدينا؛ وحيثما تكون هذه السياسة أكثر تحديداً لمسائل الدفع، فهي التي تحكم الدفع.",
      "ولا تنطبق على عمليات النشر الإنتاجية الخاضعة لاتفاقية مستوى الخدمة الموقّعة واتفاقية معالجة البيانات مع مؤسسة مالية. فتلك تُسعَّر حسب النشر وتحددها الشروط التجارية في الاتفاقية الموقّعة، التي تتقدّم على أي مما ورد في هذه الصفحة. كما لا تنطبق على العرض التوضيحي العام المجاني، الذي يُقدَّم لأغراض التقييم ولا يحمل أي رسم يُسترد.",
    ],
  },
  {
    h: "الاشتراكات الشهرية",
    body: [
      "يمكنك إلغاء أي اشتراك شهري في أي وقت قبل تاريخ تجديده التالي. ويسري الإلغاء في نهاية الفترة المدفوعة الحالية، ونعيد المبلغ عن الجزء غير المستخدم من تلك الفترة بالتناسب.",
      "يُصدر الاسترداد إلى وسيلة الدفع الأصلية. وتُفوترَط الخطط بالدولار الأمريكي عبر Paddle، التاجر الرسمي، الذي يحصّل أي ضريبة بيع أو قيمة مضافة مستحقة — فيعكس الاسترداد المبلغ الصافي وتتولى Paddle أي تعديل ضريبي. ولا نحوّل بين العملات بسعر طرف ثالث. والمشترون في المملكة المتحدة وأيرلندا وأستراليا الذين خُصموا لهم بسعر محلي بالإسترليني أو اليورو أو دولار أسترالي يُسترد لهم بنفس العملة.",
      "ولا توجد رسوم إلغاء، ولا نفرض رسوم إعادة تخزين أو رسوماً إدارية على الإلغاء الذي يتم وفق هذه السياسة.",
    ],
  },
  {
    h: "أرصدة التدخّل المسبقة المدفوعة",
    body: [
      "الأرصدة التي تُشترى كرصيد مسبق قابلة للاسترداد ما دامت لم تُنفق. وحين يُستهلك رصيد واحد في مكالمة تدخّل مكتملة — أي مكالمة صادرة تمّ الاتصال بها وتم الرد عليها — يصبح ذلك الرصيد غير قابل للاسترداد، لأن دقائق الاتصال وتوليد الكلام واستدلال النموذج التي موّلتها قد تحمّلناها بالفعل.",
      "وسنعرض لكم تفصيل الاستهلاك لكل تدخّل عند الطلب قبل أن تقرّروا، لتعرفوا بدقة عدد الأرصدة التي أُنفقت وعلى ماذا. والأرصدة غير المنفقة قابلة للاسترداد بالكامل عند الطلب في أي وقت، بالتناسب مع السعر المدفوع مقابلها.",
    ],
  },
  {
    h: "كيف تطلب الاسترداد",
    body: [
      `راسلوا ${SUPPORT_EMAIL} من العنوان المسجّل على الحساب، مع وضع كلمة «استرداد» في سطر الموضوع وذكر اسم المؤسسة. لا حاجة إلى نموذج ولا إلى روبوت تذاكر — إنسان يقرأ الرسالة. نُقرّ باستلامها خلال يومي عمل وننهيها خلال أربعة عشر يوماً.`,
      "ولا يلزم ذكر السبب. ولن نطلب منكم تبرير الإلغاء، ولن نطلب منكم إتمام مقابلة خروج قبله. وإذا كان الإلغاء بسبب خلل، فأخبرونا على أي حال — فذلك أنفع ما في الرسالة، ولا يؤثر في استردادكم.",
    ],
  },
  {
    h: "ما لا نعيده",
    body: [
      "الخدمات المهنية التي قُدِّمت بالفعل بموجب اتفاقية موقّعة؛ ورسوم وسط مشغّلي الاتصالات التي تحمّلناها فعلاً قبل الإلغاء؛ وأي مبلغ عن فترة عُلِّقت فيها الخدمة لعدم السداد بسبب وسيلة دفع فاشلة أو منتهية الصلاحية.",
      "وإذا أدى عيب من جانبنا إلى إخفاق جوهري في تقديم الخدمة، فإننا نعيد المبلغ بغضّ النظر عن هذه السياسة. فهذا التزام ضمن الاتفاقية الموقّعة، وهو أيضاً ببساطة كيف نعتزم أن نتعامل.",
    ],
  },
  {
    h: "التغييرات في هذه السياسة",
    body: [
      "يجوز لنا تحديث هذه السياسة. وستُعلن التغييرات الجوهرية في هذه الصفحة برقم إصدار وتاريخ سريان جديدين، وتحتفظ الاشتراكات القائمة بالشروط التي اشترت بها حتى موعد تجديدها التالي.",
    ],
  },
];

export function Refund() {
  return (
    <LegalShell
      kind="refund"
      icon={Undo2}
      titleEn="Refund Policy"
      titleAr="سياسة الاسترداد"
      subtitleEn="Cancel monthly at any time and the unused period is refunded pro rata. Unspent prepaid credits are refundable in full. No cancellation fee, no exit interview."
      subtitleAr="ألغِ الاشتراك الشهري في أي وقت ويُسترد الجزء غير المستخدم بالتناسب. وتُسترد الأرصدة المسبقة غير المنفقة بالكامل. بلا رسوم إلغاء وبلا مقابلة خروج."
      meta={{ version: "1.0", effective: "2026-10-10", entity: "SECUREVOICE TECHNOLOGIES FZ-LLC" }}
      sections={REFUND_SECTIONS}
      sectionsAr={REFUND_SECTIONS_AR}
    />
  );
}
