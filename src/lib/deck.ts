/**
 * SecureVoice AI — pitch deck content.
 * 16 bilingual slides with full verbatim speaker scripts.
 */

export type SlideLayout =
  | "cover"
  | "statement"
  | "stats"
  | "pillars"
  | "flow"
  | "components"
  | "voice"
  | "architecture"
  | "table"
  | "metrics"
  | "security"
  | "risks"
  | "roadmap"
  | "team"
  | "proof"
  | "closing";

export interface Slide {
  id: number;
  layout: SlideLayout;
  kicker: string;
  titleEn: string;
  titleAr: string;
  subEn?: string;
  subAr?: string;
  scriptEn: string;
  scriptAr: string;
}

export const DECK: Slide[] = [
  {
    id: 1,
    layout: "cover",
    kicker: "SecureVoice AI · Banking & Insurance",
    titleEn: "Real-Time Fraud Intervention",
    titleAr: "التدخل الفوري في الاحتيال",
    subEn:
      "An AI voice agent that places the verification call in the customer's own language, on a 60-second case deadline.",
    subAr: "وكيل صوتي ذكي يجري مكالمة التحقق بلغة العميل، ضمن مهلة حالة مدتها ٦٠ ثانية.",
    scriptEn:
      "Good morning judges. Before I explain anything, I want you to hold one number in your mind: thirty-eight. That is how many minutes pass between the moment a UAE bank's system detects fraud and the moment a human agent finally reaches the customer on the phone. Thirty-eight minutes is enough for a fraudster to drain an account, max out a card, and disappear. We are SecureVoice AI, and we built the antidote: an AI voice agent that dials inside a sixty-second case deadline — in the customer's own language — verifies who they are, confirms the fraud, stages a card freeze for a human to commit, and routes the case to a specialist. The deadline is ours and it is measured; the sixty seconds is a commitment we are still instrumenting end to end. Let me show you.",
    scriptAr:
      "رقم واحد يجب أن يبقى في أذهانكم: ثمانية وثلاثون دقيقة — وهي المدة بين اكتشاف الاحتيال ووصول الاتصال للعميل. نحن سيفور فويس، والبديل الذي بنيناه: وكيل صوتي يتصل خلال مهلة حالة مدتها ستون ثانية، بلغة العميل، يتحقق من الهوية ويؤكد الاحتيال ويجمّد البطاقة مبدئيًا بانتظار اعتماد بشري، ثم يسلّم الحالة إلى أخصائي.",
  },
  {
    id: 2,
    layout: "statement",
    kicker: "01 · The Problem",
    titleEn: "38 minutes of open door",
    titleAr: "٣٨ دقيقة والباب مفتوح",
    subEn: "Detection is instant. Intervention is not. Fraudsters finish their work in the gap.",
    subAr: "الاكتشاف فوري، لكن التدخل ليس كذلك. المحتال ينهي عمله في هذه الفجوة.",
    scriptEn:
      "Here is what breaks today. Fraud detection works — the systems flag suspicious transactions in real time. But intervention does not. Banks send SMS alerts that get ignored, or queue manual outbound calls staffed by twelve to fifteen full-time employees per million accounts. Thirty to forty-five minutes later, someone finally dials. And in the UAE there is another layer: eighty-eight percent of the population are expatriates, and multilingual support covers only English and Arabic — leaving over a third of customers waiting even longer, in a language they may barely trust. By the time contact happens, the money is gone. Detection without immediate intervention is just an expensive alarm.",
    scriptAr:
      "أنظمة الكشف تعمل بفاعلية، لكن التدخل متأخر. الرسائل النصية تُتجاهل، والمكالمات اليدوية تنتظر في طوابير. وفي الإمارات، حيث ٨٨٪ من السكان مقيمون، الدعم اللغوي يغطي الإنجليزية والعربية فقط — فيبقى ثلث العملاء دون خدمة فعلية.",
  },
  {
    id: 3,
    layout: "stats",
    kicker: "02 · Today's Baseline",
    titleEn: "The numbers we are here to kill",
    titleAr: "الأرقام التي جئنا ليهزيمها",
    subEn: "Top-5 UAE retail banks · current state",
    scriptEn:
      "Let's ground this in numbers from top UAE retail banks. Average delay from detection to customer contact: thirty-eight minutes. Only twenty-two percent of fraud alerts get an immediate customer response. Current prevention success after detection: forty-three percent — meaning more than half of confirmed frauds still complete. Annual losses across the top five retail banks: three hundred forty million dirhams — despite all the detection systems. Customer satisfaction with the fraud experience: 2.8 out of 5. And language coverage: sixty-five percent. Every one of these numbers is our baseline, and every one is an opportunity.",
    scriptAr:
      "متأخرات الاتصال: ٣٨ دقيقة. الاستجابة الفورية للتنبيهات: ٢٢٪ فقط. نسبة منع الاحتيال بعد الاكتشاف: ٤٣٪. الخسائر السنوية لأكبر خمسة بنوك: ٣٤٠ مليون درهم. رضا العملاء: ٢.٨ من ٥. تغطية لغوية: ٦٥٪.",
  },
  {
    id: 4,
    layout: "pillars",
    kicker: "03 · The Idea",
    titleEn: "One line. Three pillars.",
    titleAr: "فكرة واحدة. ثلاث ركائز.",
    subEn:
      "An AI voice agent that calls customers in their language when fraud is detected, verifies identity, and stages a protective action inside the case deadline.",
    scriptEn:
      "So here is the idea in one line: an AI voice agent that calls customers in their language when fraud is detected, verifies identity, and stages a protective action inside the case deadline. Three pillars make it work. Immediate: the dial job is written as the signal clears its gates, on a sixty-second case deadline — and when voice cannot be admitted, the case degrades to SMS or an app push rather than vanishing. Multilingual: six languages in the voice layer — Arabic, English, Hindi, Urdu, French, Kiswahili — with the live agent plane configured on Arabic, English and Hindi presets today. And Action-capable: this is not a chatbot. It verifies, confirms, stages a freeze that a human commits, and routes to a specialist — all inside one compliant call.",
    scriptAr:
      "الفكرة في سطر واحد: وكيل صوتي يتصل بالعميل بلغته عند اكتشاف الاحتيال، يتحقق من الهوية، ويجمّد البطاقة مبدئيًا ضمن مهلة الحالة. الركائز ثلاث: الفورية (تُكتب مهمة الطلب فور اجتياز الإشارة للبوابات ضمن مهلة ستين ثانية، ومع تعذر الصوت تتدهور الحالة إلى رسالة نصية أو إشعار)، وتعدد اللغات (ست لغات في طبقة الصوت، والوكيل الحيّ يعمل اليوم بإعدادات العربية والإنجليزية والهندية)، والقدرة على التنفيذ (يتحقق ويؤكد ويجمّد مبدئيًا بانتظار اعتماد بشري).",
  },
  {
    id: 5,
    layout: "flow",
    kicker: "04 · The Call Flow",
    titleEn: "Five steps. One staged action.",
    titleAr: "خمس خطوات. إجراء واحد مُعلّق للاعتماد.",
    scriptEn:
      "Let me walk you through the five-step call flow. Step one: outbound dial on the case deadline — the agent places the call inside sixty seconds of the signal clearing its gates and introduces itself transparently as the bank's AI security assistant. Step two: identity verification — a challenge flow from the bank's approved question bank. Notice what's missing: no PINs, no passwords, ever. Step three: fraud confirmation — a plain-language question: did you authorize this transaction? Step four: protective action — if fraud is confirmed, the agent STAGES a pre-approved temporary card freeze with a clear explanation, and the platform never commits it itself: nothing is frozen on the bank's ledger by this software, so there is nothing for it to undo. Step five: human handoff — anything irreversible goes to a specialist with full context, and if no specialist line is configured the case lands in the queue with the same context rather than being dropped. Five steps, and the only write action in the agent's tool scope is the one that needs a human to finish it.",
    scriptAr:
      "الخطوة الأولى: اتصال صادر ضمن مهلة الحالة، خلال ستين ثانية من اجتياز الإشارة للبوابات، مع تعريف واضح بنفسه كمساعد أمني للبنك. الثانية: تحقق من الهوية بأسئلة معتمدة — دون أي رمز سري. الثالثة: تأكيد الاحتيال. الرابعة: يُعلّق الوكيل تجميدًا مؤقتًا معتمدًا مسبقًا ولا يعتمده بنفسه — فلا ينفّذ هذا البرنامج أي تجميد على سجل البنك، ولا يوجد ما يمكنه التراجع عنه. الخامسة: التسليم لأخصائي بشري بكامل السياق، وعند غياب خط متاح تُضاف الحالة إلى قائمة الانتظار بنفس السياق بدل أن تُفقد.",
  },
  {
    id: 6,
    layout: "components",
    kicker: "05 · Why ElevenLabs",
    titleEn: "ElevenLabs for the voice plane. The rest is ours.",
    titleAr: "ElevenLabs لطبقة الصوت. والبقية ملكنا.",
    scriptEn:
      "The voice plane is ElevenLabs, and it is worth being precise about what is and is not theirs. Agent Workflows gives us the branching logic between verification outcomes and fraud confirmation. Text-to-speech runs on Eleven v4 Turbo — v3 is refused on this account's plan, and we say so rather than claiming it. Speech-to-text runs on the agent plane with a Deepgram fallback for the telephony plane, so a provider outage degrades the call instead of ending it. The Knowledge Base holds verification protocols and response scripts, and retrieval sits inside the reply path. Webhook tools bring the signed signal in and stage the freeze out. Twilio telephony is ours, not ElevenLabs'. The case state machine, the policy gate, the audit chain and the ledger are ours too — which is the point: the vendor is a layer, not the product. Agent Testing exists and we run it, but the committed record says five of nine runs executed and the tool-call criterion is unverified, so we are not claiming pre-deploy validation we do not have.",
    scriptAr:
      "طبقة الصوت على ElevenLabs، ومن الدقة بيان ما يخصّه وما لا يخصّه: منطق التفرعات عبر Agent Workflows، وتوليد الكلام على Eleven v4 Turbo لأن v3 مرفوض على خطة هذا الحساب، وتفريغ الكلام عبر طبقة الوكيل مع احتياط Deepgram لطبقة الهاتف، وقاعدة معرفة تدخل استعادتها في مسار الرد، وأدوات Webhook تستقبل الإشارة الموقعة وتُخرج التجميد المبدئي. أما الهاتف عبر Twilio وآلة حالة السجل وبوابة السياسيات وسجل التدقيق والدفتر فهي ملكنا — أي أن المزوّد طبقة وليس المنتج. اختبار الوكيل موجود ومُشغّل، لكن السجل المُودَع يقول إن خمسة من تسعة تشغيلات نُفّذت وإن معيار استدعاء الأدوات غير متحقق، فلا ندّعي تحققًا قبل النشر لا نملكه.",
  },
  {
    id: 7,
    layout: "voice",
    kicker: "06 · Voice Design System",
    titleEn: "The voice is the product",
    titleAr: "الصوت هو المنتج",
    scriptEn:
      "We treat the voice as a designed product, and the honest version of that is narrower than the marketing version. Voice cloning is disabled on this account, so the live agent speaks one stock Library voice; the persona names in our demos — Marcus for English, Fatima for Gulf Arabic — are operator catalogue entries in the scripted demo, not provisioned voices. What is genuinely tuned is in the committed agent config: Eleven v4 Turbo, stability 0.5, similarity boost 0.8, and no style parameter at all, with the continuity path slowed deliberately — eight percent for English, twelve for Arabic — because the listener is stressed. And the agent follows the customer's language instead of locking it: the prompt says switch when the caller switches, and a switch_language tool is attached to the agent. A voice that keeps its character while answering in your language is the consistency that actually earns trust.",
    scriptAr:
      "نتعامل مع الصوت كمنتج مصمم، والنسخة الصادقة من هذا الكلام أضيق من نسخة التسويق: استنساخ الصوت معطّل على هذا الحساب، فيتكلم الوكيل الحيّ بصوت مكتبي واحد جاهز؛ وأسماء الشخصيات في العرض التجريبي — ماركوس للإنجليزية وفاطمة لخليجية العربية — هي قيود كتالوج المشغّل في النص المكتوب، لا أصوات مُهيّأة. ما هو مضبوط فعلًا موجود في إعداد الوكيل المُودَع: Eleven v4 Turbo مع ثبات 0.5 وتعزيز تشابه 0.8 وبدّ أي معامل أسلوب، مع إبطاء متعمّد لمسار الاستمرارية — ثمانية بالمئة للإنجليزية واثنتا عشرة للعربية — لأن المتسمع في حالة قلق. كما أن الوكيل يتبع لغة العميل بدل تثبيتها: التعليمات تقول بدّل عندما يبدّل المتصل، وأداة switch_language ملحقة به.",
  },
  {
    id: 8,
    layout: "architecture",
    kicker: "07 · Integration Architecture",
    titleEn: "Five layers, one case deadline",
    titleAr: "خمس طبقات، مهلة حالة واحدة",
    scriptEn:
      "Under the hood, five layers. The Event Ingestion Layer receives signed fraud alerts by webhook, validates them against a strict contract, checks consent and idempotency, and queues a durable dial job with priority handling. The Agent Orchestration Layer runs the ElevenLabs workflow with full conversation state. The Integration Layer is deliberately modest: it takes the signed signal in, stages one freeze action out, and opens CRM case tickets — the platform reads no card history and writes nothing to a core banking system, because a permanent action requires the bank's own human. The Telephony Layer manages Twilio outbound calling with fallback numbers. And the Analytics and Audit Layer records, transcribes and hash-seals every interaction into an append-only chain. The case deadline is sixty seconds from alert — that is our clock, and the intake path is measured against it, while time-to-contact is not yet instrumented end to end. And because streamed media is off by default, a channel is opened for the call rather than pre-warmed ahead of it.",
    scriptAr:
      "خمس طبقات: استيعاب الأحداث عبر Webhook موقّع مع تحقق صارم وفحص للموافقة ولمفتاح التكرار ثم كتابة مهمة اتصال دائمة، وتنسيق الوكيل عبر محرك ElevenLabs بحالة حوار كاملة، وطبقة تكامل متواضعة عن قصد — تستقبل الإشارة الموقعة وتُخرج إجراء تجميد مبدئيًا وتفتح تذاكر CRM، ولا تقرأ تاريخ البطاقات ولا تكتب في نظام البنك المركزي لأن الإجراء الدائم يتطلب بشريًا من البنك، وطبقة هاتف عبر Twilio مع أرقام احتياطية، وطبقة تحليلات وتدقيق تسجّل وتفرّغ وتربط كل تفاعل بسلسلة إضافة فقط. مهلة الحالة ستون ثانية من الإنذار — وهذا عدسنا الذي يُقاس عليه مسار الاستيعاب بينما زمن الوصول للعميل غير مُقاس بعد، ولأن البث الإعلامي متوقف افتراضيًا تُفتح القناة للاتصال ولا تُجهّز مسبقًا.",
  },
  {
    id: 9,
    layout: "table",
    kicker: "08 · Guardrails",
    titleEn: "Compliance you can audit",
    titleAr: "امتثال قابل للتدقيق",
    scriptEn:
      "Now the part every risk officer cares about: guardrails. One — no PIN or password requests, ever; the system prompt prohibits it, a shared sentence-scoped detector checks the draft, and verification draws only from the approved challenge bank. Two — staged actions only: the agent's tool scope contains exactly one write, the temporary freeze, and it returns pending-specialist rather than committed; everything permanent requires a human, and if the audit append fails the freeze is refused, not performed. Three — language following: the call opens in the profile's language and switches when the caller does, which is a capability, not a drift. Four — audit completeness: every call is recorded, transcribed and hash-linked into an append-only chain that refuses mutation. Five — calling-hour compliance: time-zone checks against the customer profile, plus prayer-window suppression for routine categories, before dialing. Six — vulnerability handling: sentiment analysis detects distress and third-party pressure and raises a human handoff, which queues with full context when no specialist line is available. One thing we do NOT claim: a risk-score threshold of our own. The threshold belongs to the bank's detection engine; our gates are consent, do-not-call, hours, geography, velocity, cooldown and credit.",
    scriptAr:
      "الضمانات الست: لا طلب لرموز سرية أبدًا — المنع في التعليمات، وكاشف مشترك على مستوى الجملة يفحص المسودة، والتحقق من بنك أسئلة معتمد فقط. إجراءات مُعلّقة فقط — أداة كتابة واحدة هي التجميد المؤقت الذي يعود بانتظار أخصائي لا معتمدًا، وأي إجراء دائم يتطلب بشريًا، وإذا فشل إلحاق سجل التدقيق يُرفض التجميد ولا يُنفَّذ. تتبّع اللغة — يفتح الاتصال بلغة الملف الشخصي ويبدّل عندما يبدّل المتصل. اكتمال التدقيق — كل اتصال يُسجَّل ويُفرَّغ ويُربط بسلسلة إضافة فقط. أوقات الاتصال — فحص المنطقة الزمنية وقمع أوقات الصلاة للفئات الروتينية قبل الطلب. ومعالجة الضعف — تحليل المشاعر يكشف الضيق والضغط الخارجي ويرفع تسليمًا بشريًا يُوضع في قائمة الانتظار عند عدم توفر خط. وأمر لا ندّعيه: عتبة مخاطر خاصة بنا؛ العتبة لمحرك كشف البنك، وبواباتنا هي الموافقة وعدم الاتصال والأوقات والجغرافيا والسرعة والتبريد والائتمان.",
  },
  {
    id: 10,
    layout: "metrics",
    kicker: "09 · Success Metrics",
    titleEn: "Baseline → Target",
    titleAr: "من الواقع إلى الهدف",
    scriptEn:
      "What does success look like? We measure against the baseline you saw. Fraud prevention rate: from forty-three percent to eighty-five percent. Contact delay: from thirty-eight minutes to under ninety seconds — a twenty-five-fold improvement. Verification completion: from sixty-two to over ninety percent. Customer satisfaction: from 2.8 to a target of 4.2. Operational cost: down forty percent through automation of first-response calls. And multilingual coverage: from sixty-five to ninety-five percent of the customer base. We track all of this at thirty-day, ninety-day, and twelve-month milestones, live in the dashboard you are about to see.",
    scriptAr:
      "منع الاحتيال: من ٤٣٪ إلى ٨٥٪. التأخير: من ٣٨ دقيقة إلى أقل من ٩٠ ثانية. اكتمال التحقق: من ٦٢٪ إلى ٩٠٪+. الرضا: من ٢.٨ إلى ٤.٢. التكاليف: أقل بـ ٤٠٪. التغطية اللغوية: من ٦٥٪ إلى ٩٥٪.",
  },
  {
    id: 11,
    layout: "security",
    kicker: "10 · Security & Compliance",
    titleEn: "Security is the architecture",
    titleAr: "الأمن هو البنية",
    scriptEn:
      "Security is not a feature list, it is the architecture. Every inbound connection terminates at TLS with HSTS and a locked Content-Security-Policy. An organisation's own voice credentials are stored AES-256-GCM encrypted at rest, and every authentication secret we hold is hashed rather than encrypted, so a database dump yields nothing usable. Personal data is redacted before it is written, not on the way out. Call audio IS retained — thirty days, then deleted; transcripts ninety days; case records seven years — and after each window the audit chain keeps the hash-linked metadata, so the evidence outlives the recording. The pilot runs on zero-day audio, which is a deployment choice we can make, not the default we ship. Retention is tiered by data class and enforced by the retention worker, and the audit chain is append-only: the code that would mutate it refuses to run. Dashboard access is role-based, enforced in Postgres row-level security rather than only in the application, and every interaction generates a compliance-ready audit trail. We involved compliance specialists from the design phase — not as reviewers at the end.",
    scriptAr:
      "الأمن ليس قائمة مزايا، بل هو البنية. جميع الاتصالات تنتهي عند TLS مع HSTS وسياسة محتوى مقيّدة. مفاتيح الصوت الخاصة بالمنظمة محفوظة بتشفير AES-256-GCM في السكون، والأسرار الوصفية تُخزَّن مجزّأة لا مشفّرة، فلا يُنتج تسريب قاعدة بيانات شيئًا قابلًا للاستخدام. تُحذف البيانات الشخصية قبل الكتابة لا بعدها. تسجيلات الصوت تُحتفظ فعلًا — ثلاثون يومًا ثم تُحذف، والمفرّغات تسعون يومًا، وسجلات الحالات سبع سنوات — وبعدها تحتفظ سلسلة التدقيق بالبيانات الوصفية المرتبطة بالتجزئة، فتعمُر الأدلة أطول من التسجيل. يعمل المشروع التجريبي على صفر يوم للصوت، وهذا خيار نشر نتخذه لا الافتراض المُسلَّم. الاحتفاظ مصنّف حسب نوع البيانات وينفّذه عامل الاحتفاظ، وسجل التدقيق للإضافة فقط إذ ترفض شيفرة تغييره عملها. الوصول إلى لوحة التحكم قائم على الأدوار ومُطبَّق عبر أمن الصفوف في Postgres لا في التطبيق وحده، وكل تفاعل يُنتج سجل تدقيق جاهز للامتثال. الامتثال صُمم من اليوم الأول وفق أنظمة المصرف المركزي الإماراتي.",
  },
  {
    id: 12,
    layout: "risks",
    kicker: "11 · Risks & Mitigations",
    titleEn: "Honest about the risks",
    titleAr: "صادقون بشأن المخاطر",
    scriptEn:
      "We are honest about the risks. Customer trust in AI calls — mitigated with a transparent introduction, one stock Library voice that does not pretend to be a person, and an escalation path to a specialist that fires on repeated ambiguity or detected distress and queues the case with full context when no line is free. False positives — the risk threshold belongs to the bank's own detection engine; our gates are consent, do-not-call, hours, geography, velocity, cooldown and credit. Integration complexity — standard signed webhooks, an adapter registry, and dedicated integration sprints. Regulatory compliance — built in from design, not bolted on. Multilingual accuracy — six languages in the voice layer, with Arabic and English the two proven end to end in the recorded evidence. And system availability — one region today on one host, with multi-zone deployment on the roadmap and a tested disaster-recovery plan targeted for Q1. Every risk has an owner and a mitigation.",
    scriptAr:
      "ثقة العملاء تُبنى بالشفافية: مقدمة واضحة، وصوت مكتبي واحد لا يدّعي أنه إنسان، ومسار تصعيد إلى أخصائي يعمل عند الغموض المتكرر أو عند كشف الضيق، ويضع الحالة في قائمة الانتظار بكامل السياق إذا لم يتوفر خط. والإنذارات الكاذبة عتبتها في محرك كشف البنك نفسه، أما بواباتنا فهي الموافقة وعدم الاتصال والأوقات والجغرافيا والسرعة والتبريد والائتمان. والتعقيد التقني عبر واجهات موقعة قياسية وسجل محوّللات ورحلات تكامل مخصصة. والامتثال مدمج بالتصميم. والدقة اللغوية بست لغات في طبقة الصوت، والعربية والإنجليزية هما المثبتتان من البداية للنهاية في الأدلة المسجلة. والتوفر اليوم على منطقة واحدة ومضيف واحد، مع تعدد المناطق ضمن خارطة الطريق وخطة تعافٍ مُختبَرة مستهدفها الربع الأول.",
  },
  {
    id: 13,
    layout: "roadmap",
    kicker: "12 · What Is Working, What Is Next",
    titleEn: "Working today — and the list we still owe",
    titleAr: "يعمل اليوم — والقائمة المتبقية",
    scriptEn:
      "This is what is working, and what the committed record actually says: the end-to-end prototype — a signed simulated fraud alert in, an outbound call, identity verification, a staged card freeze, human handoff. Arabic and English are the two languages with a recorded end-to-end conversation in the evidence bundle; four more are wired in the voice layer and are not yet proven end to end. Integration with mock banking systems, and adapters for the real CRM APIs. And an audit trail with guardrail enforcement you can re-compute. On test status we quote the artifact rather than a wish: nineteen gates were run, seventeen passed — 89.5 percent — with the load and surface gates failing, and the agent layer's tool-call criterion recorded as unverified. That is the honest denominator, and you can read it in the repository.",
    scriptAr:
      "هذا ما يعمل، وما يقوله السجل المُودَع فعلًا: نموذج يعمل من البداية للنهاية — تنبيه احتيال موقّع ومحاكى يدخل، اتصال صادر، تحقق من الهوية، تجميد بطاقة مبدئي، وتسليم لأخصائي. العربية والإنجليزية هما اللغتان الوحيدتان بحوار مُسجّل من البداية للنهاية في حزمة الأدلة؛ وأربع لغات أخرى موصولة في طبقة الصوت ولم تُثبت من البداية للنهاية. تكامل مع أنظمة بنكية محاكاة ومحوّلات لتطبيقات CRM الحقيقية، وسجل تدقيق مع تطبيق الضمانات يمكن إعادة حسابه. أما حالة الاختبارات فننقلها كما هي لا كما نودّ: تسع عشرة بوابة أُنجِزت، وسبع عشرة نجحت — ٨٩.٥٪ — مع إخفاق بوّابتَي الحَمْل والسطح، ومعيار استدعاء الأدوات في طبقة الوكيل مُسجَّل بوصفه غير متحقق.",
  },
  {
    id: 14,
    layout: "team",
    kicker: "13 · The Team",
    titleEn: "Built for exactly this problem",
    titleAr: "فريق صُمم لهذه المشكلة تحديداً",
    scriptEn:
      // Was: "Five people, built for exactly this problem. Our lead brings twelve
      // years in fraud detection systems at tier-one banks. Our conversational AI
      // specialist has shipped four ElevenLabs implementations. Our full-stack
      // engineer specializes in banking API integrations. Our Arabic linguist and
      // UX researcher makes sure the voice actually earns trust across Gulf
      // dialects. And our compliance specialist brings CBUAE regulatory
      // experience. Together we have previously deployed voice solutions handling
      // over fifty thousand calls a month."
      //
      // Every clause of that was invented, and the public /team page says one
      // founder. A due-diligence reader who opens both would find the appendix
      // describing a bench the team page contradicts, and the credibility cost
      // would land on everything else in the deck — including the claims that are
      // true. There is one person. Say so, and say what that means for the
      // engagement, which is the thing a reader actually wants to know.
      "One person. I build this end to end — the voice pipeline, the guardrail layer, the ledger, and the console you are looking at. That is worth saying plainly rather than dressing up, because it changes what an engagement with us looks like: you talk to the person who will answer your questions and ship the fix, and there is no handoff between a demo and production. What it does not change is the engineering standard the code is held to, because that is enforced by the test suite and the audit chain, not by headcount. Every number I have quoted on the previous slides is in this repository and can be re-run.",
    scriptAr:
      "شخص واحد، وأنا من يبني هذا من طرفه إلى طرفه: خط أنابيب الصوت، وطبقة الضوابط، والسجل، ولوحة التشغيل.说出来 ذلك صراحةً أفضل من تجميله، لأنه يغيّر شكل التعامل: تتحدثون إلى من سيردّ على أسئلتكم ويصلح المشكلة، ولا تسليم بين عرض تجريبي وإنتاج. ولا يغيّر ذلك المعيار الهندسي الذي يُحاسَب عليه الكود، لأن ذلك تفرضه اختبارات وسلسلة التدقيق لا أعداد الموظفين.",
  },
  {
    /*
     * ── INSURANCE ────────────────────────────────────────────────────────────
     *
     * Sixteen slides, every number bank-specific, and a cover chip reading
     * "Banking & Insurance". An insurer opening the appendix found a card-freeze
     * product with an insurance label on the front. These three give the second
     * half of the platform the same treatment the bank half gets: the vector, the
     * two cases that matter, and the honest boundary of what is built.
     */
    id: 17,
    layout: "statement",
    kicker: "15 · For Insurers",
    titleEn: "The payout is the softest target in insurance",
    titleAr: "التعويض هو أضعف الأهداف في التأمين",
    subEn: "Where the money actually goes",
    scriptEn:
      "Banks defend against an adversary taking money from a transaction. Insurers defend against an adversary moving money out of a claim — and that is a structurally easier problem to attack, because the money is expected. The policyholder should receive the payout. The caller claims to be the insurer. The payee account was added four minutes ago. Every element of a fraudulent claim payout looks exactly like a legitimate one, which is why it is caught by asking the policyholder rather than by any score. We run this case in the demo today: a sixty-two thousand dirham motor claim redirected to a new payee account, caught by a two-of-three challenge that never asks for a policy number, a PIN, or a password.",
    scriptAr:
      "تدافع المصارف ضد خصم يسحب مالاً من معاملة. وتدافع شركات التأمين ضد خصم يحوّل مالاً خارج مطالبة — وهي المشكلة البنيوية الأسهل هجوماً، لأن المال متوقَّع. من المفترض أن يتلقى حامل الوثيقة تعويضه، والمتصل يدّعي أنه جهة التأمين، وحساب المستفِد أُضيف قبل أربع دقائق. كل عنصر في مطالبة احتيالية مطابقة تماماً للشرعية. لهذا تُكتشف بالسؤال إلى حامل الوثيقة، لا بأي درجة خطورة.",
  },
  {
    id: 18,
    layout: "table",
    kicker: "16 · Two Claims Cases",
    titleEn: "Claims fraud and policy servicing",
    titleAr: "احتيال المطالبات وخدمة الوثيقة",
    subEn: "Same engine, same guardrails, different nouns",
    scriptEn:
      "Two insurer conversations, running on the same spine as the bank ones — the customer's own language, an institution-signed guardrail policy, and a human who commits anything irreversible. Claims fraud: a payout redirected, a claim filed against coverage the policy does not support, or duplicate claims staged on one policy; the agent confirms the claim and the destination account, stages a payout hold, and a human adjuster commits or releases it. Policy servicing: a beneficiary changed, a policy re-opened after lapse, a contact-detail change followed immediately by a servicing request — the quietest place a fraudster operates, because a benefit change looks exactly like a normal request. For a Takaful operator the terminology engine substitutes contribution and disbursement for premium and payout automatically; that switch is not a paid tier, it applies to every tenant.",
    scriptAr:
      "محادثتان لشركة تأمين تعملان على العمود نفسه: لغة العميل، وسياسة ضمانات يوقّعها المؤسسة، وبشري يقرّر كل ما لا يجوز للوكيل تنفيذه. احتيال المطالبات: تحويل تعويض، أو مطالبة على تغطية لا يدعمها العقد، أو مطالبات مكرّرة؛ فيؤكّد الوكيل المطالبة وحساب المستفِد، ويجهّز حجز الصرف، ويقرّر المحكّم الإفراج أو الإلغاء. وخدمة الوثيقة: تغيير مستفيد، أو إعادة فتح وثيقة بعد الانتهاء. ولمشغّل التكافل تُبدّل محرّك المصطلحات الاشتراك والصرف تلقائياً؛ وهذا التبديل ليس طبقة مدفوعة بل يسري على كل مستأجر.",
  },
  {
    id: 19,
    layout: "roadmap",
    kicker: "17 · What Is Honest",
    titleEn: "Built, referenced, and owed",
    titleAr: "ما بُني، وما هو مرجعي، وما هو مدين",
    scriptEn:
      "So you know exactly where we are. Shipped and running end to end today: the bank card-fraud intervention, and the insurer claim-payout redirection — both staged, both auditable, neither executing an irreversible action without a human. Referenced and running on the same engine but not yet a product of its own: collections and arrears, policy servicing, and provider pre-authentication intake. And owed, stated plainly because a due-diligence reader will find it anyway: a dedicated payout-hold endpoint of its own rather than the card-freeze action reinterpreted for insurers, an insurance-specific state branch in the case machine, and an insurer tenant in the seeded demo environment. The claims-fraud call runs today; the claims backend is on this list, not behind it.",
    scriptAr:
      "حتى تعرفوا موقعنا بالضبط. مُشحن ويعمل من طرفه إلى طرفه اليوم: تدخّل احتيال البطاقات للمصارف، وتحويل تعويض المطالبة لشركات التأمين — كلاهما مُجهَّز وقابل للتدقيق ولا ينفّذ إجراءً لا رجعة فيه دون بشري. مُرجعي ويعمل بالمحرّك نفسه: التحصيل وال-service، وخدمة الوثيقة، واستقبال التصويقات المسبقة. ومُدَين، ونقوله صراحة: نقطة نهاية مستقلة لحجز الصرف بدل إعادة تفسير تجميد البطاقة، وفرع خاص بالتأمين في آلة الحالات، ومستأجر تأمين في بيئة العرض. مكالمة احتيال المطالبات تعمل اليوم؛ وخلفية المطالبات على هذه القائمة، لا خلفها.",
  },
  {
    id: 15,
    layout: "proof",
    kicker: "14 · Proof of Build",
    titleEn: "Don't take our word for it",
    titleAr: "جرّبوه بأنفسكم",
    subEn: "securevoiceai.me — simulated fraud scenario, full call flow, mock banking integration",
    scriptEn:
      "Everything I have claimed, you can touch. The live demo is running right now: a simulated fraud scenario with the full call flow, integrated with mock banking systems. Trigger an alert, watch the agent call, listen to the verification, see the freeze STAGED with `committed: false` and `stage: pending_specialist` — that is the invariant, not a limitation — then follow the handoff and explore the operations dashboard: live call monitor, analytics against baseline, configuration, and the compliance audit log. This is not a concept deck. It is a working system, and the guided simulation is honest about being a simulation: it replays a real case shape without dialling anyone.",
    scriptAr:
      "العرض الحي يعمل الآن: سيناريو احتيال محاكى بمسار الاتصال الكامل متكاملاً مع أنظمة بنكية محاكاة. أطلقوا التنبيه، وشاهدوا الاتصال والتحقق والتجميد والتسليم — ثم استكشفوا لوحة العمليات الكاملة.",
  },
  {
    id: 16,
    layout: "closing",
    kicker: "SecureVoice AI",
    titleEn: "Detection is solved. Intervention is not.",
    titleAr: "الكشف محلول. التدخل ليس كذلك.",
    subEn: "We are the intervention. Thank you — please try the demo.",
    subAr: "نحن التدخل. شكراً لكم — جربوا العرض الحي.",
    scriptEn:
      "Fraud teams today are using AI to detect crime, then delivering the rescue with SMS and queues. That gap — between detection speed and intervention speed — costs UAE banks three hundred forty million dirhams a year, and costs customers their trust. SecureVoice AI moves that gap onto a sixty-second case deadline, in the customer's own language, inside a compliance guardrail — and stages every irreversible action for a human to commit, because an intervention that overreaches is its own kind of loss. Detection is solved. Intervention is not. We are the intervention. Thank you — and please try the demo.",
    scriptAr:
      "الفجوة بين سرعة الكشف وسرعة التدخل تكلف بنوك الإمارات ٣٤٠ مليون درهم سنوياً. سيفور فويس تنقل هذه الفجوة من ٣٨ دقيقة إلى مهلة حالة مدتها ٦٠ ثانية، بلغة العميل وضمن ضمانات الامتثال، وتُعلّق كل إجراء دائم بانتظار اعتماد بشري — لأن تدخلاً يتجاوز حدّه هو نوعٌ آخر من الخسارة. الكشف محلول، والتدخل ليس كذلك، ونحن التدخل. شكراً لكم.",
  },
];
