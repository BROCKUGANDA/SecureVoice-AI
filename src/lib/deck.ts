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
    subEn: "An AI voice agent that calls customers in their language within 60 seconds of a fraud signal.",
    subAr: "وكيل صوتي ذكي يتصل بالعملاء بلغتهم خلال ٦٠ ثانية من إشارة الاحتيال.",
    scriptEn:
      "Good morning judges. Before I explain anything, I want you to hold one number in your mind: thirty-eight. That is how many minutes pass between the moment a UAE bank's system detects fraud and the moment a human agent finally reaches the customer on the phone. Thirty-eight minutes is enough for a fraudster to drain an account, max out a card, and disappear. We are SecureVoice AI, and we built the antidote: an AI voice agent that calls the customer in sixty seconds — in their own language — verifies who they are, confirms the fraud, freezes the card, and hands off to a human. Let me show you.",
    scriptAr:
      "رقم واحد يجب أن يبقى في أذهانكم: ثمانية وثلاثون دقيقة — وهي المدة بين اكتشاف الاحتيال ووصول الاتصال للعميل. نحن سيفور فويس، والبديل الذي بنيناه: وكيل صوتي يتصل خلال ستين ثانية، بلغة العميل، يتحقق ويؤكد ويجمّد البطاقة ويسلّم لأخصائي بشري.",
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
    subEn: "An AI voice agent that immediately calls customers in their language when fraud is detected, verifies identity, and executes protective actions within 60 seconds.",
    scriptEn:
      "So here is the idea in one line: an AI voice agent that immediately calls customers in their language when fraud is detected, verifies identity, and executes protective actions within sixty seconds. Three pillars make it work. Immediate: the call starts within a minute of the fraud signal — no queue, no SMS. Multilingual: the agent speaks the customer's language from the first syllable — Arabic, English, Hindi, Urdu, Filipino, Malayalam. And Action-capable: this is not a chatbot. It verifies, confirms, freezes the card, and hands off to humans — all inside one compliant call.",
    scriptAr:
      "وكيل صوتي ذكي يتصل فوراً بالعميل بلغته عند اكتشاف الاحتيال، يتحقق من الهوية، وينفذ إجراءات الحماية خلال ستين ثانية. ثلاث ركائز: فورية، متعددة اللغات، وقادرة على التنفيذ.",
  },
  {
    id: 5,
    layout: "flow",
    kicker: "04 · The Call Flow",
    titleEn: "Five steps. Sixty seconds.",
    titleAr: "خمس خطوات. ستون ثانية.",
    scriptEn:
      "Let me walk you through the five-step call flow. Step one: immediate outbound call — the agent dials within sixty seconds of the fraud signal and introduces itself transparently as the bank's AI security assistant. Step two: identity verification — a challenge flow from the bank's approved question bank. Notice what's missing: no PINs, no passwords, ever. Step three: fraud confirmation — a plain-language question: did you authorize this transaction? Step four: protective action — if fraud is confirmed, the agent executes a pre-approved temporary card freeze with a clear explanation. Step five: human handoff — anything irreversible goes to a specialist with full context. Five steps. Sixty seconds.",
    scriptAr:
      "الخطوة الأولى: اتصال صادر فوري. الثانية: تحقق من الهوية بأسئلة معتمدة — دون أي رمز سري. الثالثة: تأكيد الاحتيال. الرابعة: تجميد مؤقت للبطاقة. الخامسة: التسليم لأخصائي بشري مع كامل السياق.",
  },
  {
    id: 6,
    layout: "components",
    kicker: "05 · Why ElevenLabs",
    titleEn: "Built on ElevenLabs, end to end",
    titleAr: "مبني بالكامل على منصة ElevenLabs",
    scriptEn:
      "Everything you just saw runs on the ElevenLabs platform. Agent Workflows gives us the branching logic between verification outcomes and fraud confirmation. Eleven v3 text-to-speech gives us voices that sound genuinely trustworthy — critical, because a robotic voice destroys customer confidence in exactly the moment they are most anxious. Scribe v2 real-time speech-to-text handles multilingual transcription with keyterm biasing for merchant names and transaction amounts. The Knowledge Base with RAG stores verification protocols and response scripts for consistent compliance. Webhook tools connect to the bank's fraud engine and execute the freeze. Twilio telephony carries the call. And Agent Testing validates every flow before deployment.",
    scriptAr:
      "منطق التفرعات عبر Agent Workflows، أصوات موثوقة عبر Eleven v3، تفريغ نصي متعدد اللغات عبر Scribe v2، قاعدة معرفة RAG لبروتوكولات التحقق، أدوات Webhook للتكامل مع بنك الاحتيال، والهاتف عبر Twilio.",
  },
  {
    id: 7,
    layout: "voice",
    kicker: "06 · Voice Design System",
    titleEn: "The voice is the product",
    titleAr: "الصوت هو المنتج",
    scriptEn:
      "We treat the voice itself as a designed product. For English, Marcus — a mature, professional voice that conveys calm authority. For Arabic, Fatima — clear and reassuring in modern standard Arabic, with dialect tuning for Gulf customers. We tuned stability at 0.7 for consistency, similarity boost at 0.75, and style at 0.3 — the voice stays steady and warm, never theatrical. The pace is deliberately slightly slower than conversational, because our listener is stressed. And the language lock: the agent detects the customer's language in the first response and never switches again mid-call — consistency is trust.",
    scriptAr:
      "ماركوس للإنجليزية وفاطمة للعربية الفصحى مع معايرة للهجة الخليجية. الصوت مصمم ليكون هادئاً وواثقاً وأبطأ قليلاً من الطبيعي — لأن المستخدم في حالة قلق. وتثبيت اللغة من أول رد يبني الثقة.",
  },
  {
    id: 8,
    layout: "architecture",
    kicker: "07 · Integration Architecture",
    titleEn: "Five layers, one SLA",
    titleAr: "خمس طبقات، اتفاقية مستوى خدمة واحدة",
    scriptEn:
      "Under the hood, five layers. The Event Ingestion Layer receives fraud alerts by webhook, validates and enriches them, and queues them with priority handling. The Agent Orchestration Layer runs the ElevenLabs workflow engine with full conversation state. The Integration Layer talks to the core banking APIs — transaction history, card freeze — over OAuth 2.0 with mutual TLS. The Telephony Layer manages Twilio outbound calling with fallback numbers. And the Analytics and Audit Layer records, transcribes, and seals every interaction into immutable storage. Sixty-second SLA from alert to customer contact, with pre-warmed telephony channels.",
    scriptAr:
      "خمس طبقات: استيعاب الأحداث عبر Webhook، تنسيق الوكيل عبر محرك ElevenLabs، التكامل مع أنظمة البنك عبر OAuth 2.0 وmTLS، الهاتف عبر Twilio، والتحليلات والتدقيق مع تخزين غير قابل للتغيير.",
  },
  {
    id: 9,
    layout: "table",
    kicker: "08 · Guardrails",
    titleEn: "Compliance you can audit",
    titleAr: "امتثال قابل للتدقيق",
    scriptEn:
      "Now the part every risk officer cares about: guardrails. One — no PIN or password requests, ever; the system prompt prohibits it and verification draws only from the approved challenge bank. Two — pre-approved actions only: the agent's tool scope contains exactly one write action, the temporary freeze; everything irreversible requires a human. Three — language consistency, locked after the first response. Four — audit completeness: every call recorded, transcribed, and sealed with metadata into an immutable log. Five — calling-hour compliance: time-zone checks against the customer profile before dialing. Six — vulnerability handling: sentiment analysis detects distress and triggers priority human handoff. Compliance was designed in from day one — CBUAE-aligned.",
    scriptAr:
      "ستة ضمانات: لا طلب لرموز سرية أبداً، إجراءات معتمدة فقط، تثبيت اللغة، سجلات تدقيق كاملة غير قابلة للتغيير، احترام أوقات الاتصال المسموحة، واكتشاف الضيق النفسي مع تحويل فوري لأخصائي.",
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
      "Security is not a feature list, it is the architecture. All voice data is end-to-end encrypted with AES-256 in transit and at rest. Sensitive customer information is tokenized — the agent works with references, not raw data. Data purging follows regulatory retention schedules automatically. Dashboard access is role-based and audited. Every interaction generates a compliance-ready audit trail, and compliance reporting is automated, not manual. We involved compliance specialists from the design phase — not as reviewers at the end. The result is an agent that a CBUAE-regulated bank can actually deploy.",
    scriptAr:
      "تشفير كامل AES-256 للصوت أثناء النقل والتخزين، ترميز للبيانات الحساسة، حذف تلقائي وفق الجداول التنظيمية، وصلاحيات مبنية على الأدوار. الامتثال مصمم من اليوم الأول وفق أنظمة المصرف المركزي الإماراتي.",
  },
  {
    id: 12,
    layout: "risks",
    kicker: "11 · Risks & Mitigations",
    titleEn: "Honest about the risks",
    titleAr: "صادقون بشأن المخاطر",
    scriptEn:
      "We are honest about the risks. Customer trust in AI calls — mitigated with transparent introduction, natural voices, and a one-word path to a human. False positives — the agent only triggers above a high-confidence risk threshold, so it never annoys customers about legitimate spending. Integration complexity — standard banking APIs and dedicated integration sprints. Regulatory compliance — built in from design, not bolted on. Multilingual accuracy — extensive native-speaker testing with a continuous feedback loop. And system availability — multi-zone deployment with a 99.99 percent uptime SLA. Every risk has an owner and a mitigation.",
    scriptAr:
      "ثقة العملاء تُبنى بالشفافية وسهولة الوصول لبشري. الإنذارات الكاذبة تُدار بعتبات ثقة عالية. التعقيد التقني عبر واجهات قياسية. الامتثال مدمج بالتصميم. الدقة اللغوية باختبار متوسط مع متحدثين أصليين. والتوفر ببنية متعددة المناطق بنسبة ٩٩.٩٩٪.",
  },
  {
    id: 13,
    layout: "roadmap",
    kicker: "12 · What Will Be Working",
    titleEn: "14 October: fully working prototype",
    titleAr: "١٤ أكتوبر: نموذج أولي كامل",
    scriptEn:
      "By October fourteenth, this is what will be working: the end-to-end prototype — simulated fraud alert in, outbound call, identity verification, card freeze, human handoff. English and Arabic language support fully operational. Integration with mock banking systems. A complete test suite with over ninety percent pass rate on primary flows. And demonstrable audit trail generation with guardrail enforcement. You can see all of it live, right now — which brings us to the demo.",
    scriptAr:
      "نموذج كامل يعمل من البداية للنهاية: تنبيه احتيال محاكى، اتصال صادر، تحقق من الهوية، تجميد بطاقة، وتسليم لأخصائي. دعم كامل للعربية والإنجليزية، وتكامل مع أنظمة بنكية محاكاة، وحزمة اختبارات بنسبة نجاح تتجاوز ٩٠٪.",
  },
  {
    id: 14,
    layout: "team",
    kicker: "13 · The Team",
    titleEn: "Built for exactly this problem",
    titleAr: "فريق صُمم لهذه المشكلة تحديداً",
    scriptEn:
      "Five people, built for exactly this problem. Our lead brings twelve years in fraud detection systems at tier-one banks. Our conversational AI specialist has shipped four ElevenLabs implementations. Our full-stack engineer specializes in banking API integrations. Our Arabic linguist and UX researcher makes sure the voice actually earns trust across Gulf dialects. And our compliance specialist brings CBUAE regulatory experience. Together we have previously deployed voice solutions handling over fifty thousand calls a month. We did not assemble this team last week — we built it for this.",
    scriptAr:
      "خمسة أعضاء: خبرة ١٢ سنة في كشف الاحتيال بالبنوك من الدرجة الأولى، أربع تطبيقات سابقة على ElevenLabs، هندسة تكامل بنكي، لغويات عربية وبحث تجربة مستخدم، وخبرة تنظيمية بمصرف الإمارات المركزي.",
  },
  {
    id: 15,
    layout: "proof",
    kicker: "14 · Proof of Build",
    titleEn: "Don't take our word for it",
    titleAr: "جرّبوه بأنفسكم",
    subEn: "securevoice.ai/demo — simulated fraud scenario, full call flow, mock banking integration",
    scriptEn:
      "Everything I have claimed, you can touch. The live demo is running right now: a simulated fraud scenario with the full call flow, integrated with mock banking systems. Trigger an alert, watch the agent call, listen to the verification, see the freeze execute, and follow the handoff — then explore the operations dashboard: live call monitor, analytics against baseline, configuration, and the compliance audit log. This is not a concept deck. It is a working system.",
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
      "Fraud teams today are using AI to detect crime, then delivering the rescue with SMS and queues. That gap — between detection speed and intervention speed — costs UAE banks three hundred forty million dirhams a year, and costs customers their trust. SecureVoice AI closes that gap from thirty-eight minutes to sixty seconds, in the customer's own language, inside a compliance guardrail. Detection is solved. Intervention is not. We are the intervention. Thank you — and please try the demo.",
    scriptAr:
      "الفجوة بين سرعة الكشف وسرعة التدخل تكلف بنوك الإمارات ٣٤٠ مليون درهم سنوياً. سيفور فويس تُغلق هذه الفجوة من ٣٨ دقيقة إلى ٦٠ ثانية، بلغة العميل، وضمن ضمانات الامتثال. نحن التدخل. شكراً لكم.",
  },
];
