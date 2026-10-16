import type { ScenarioKind, ScenarioMeta } from "./scenario-types";

/**
 * Swahili (sw) script layer — one entry per event, aligned with the 17-event
 * timeline in buildScenario(). Entries may be plain strings or functions
 * receiving the case metadata (for templated lines). Missing entries fall back
 * to English at render time (sw ?? en), same contract as hi and ur.
 *
 * Register is plain coastal Kiswahili, and the vocabulary is the one the live
 * call paths already use (`outreach-copy.ts`, `voice/conversation.ts`,
 * `compliance/policy.ts`): msaidizi wa usalama wa AI (AI security assistant),
 * udanganyifu (fraud), mtaalamu wa udanganyifu (fraud specialist), kizuizi cha
 * muda (temporary freeze), muamala (transaction), nenosiri (password), msimbo
 * wa matumizi moja (one-time code). Numbers keep the digits the other
 * non-Arabic scripts use so the deck's figures agree with the transcript;
 * merchants, card masks, case ids, YES/NO reply tokens, risk scores and API
 * field values are not translated — only the words around them.
 */
export type SwLine = string | ((m: ScenarioMeta, first: string) => string);

export const SW_PACKS: Record<ScenarioKind, SwLine[]> = {
  /* ————————— CARD-NOT-PRESENT ————————— */
  card: [
    // e01 · alert
    "KIRUDHI CHA UDANGANYIFU KIMEPOKELEWA — kadi •• 4417, muamala wa dirhami 2,500.00 kwa Electronics World, Dubai. Alama ya hatari 0.94 (hatari kubwa). Kifaa kisichotambulika na mwendo wa haraka wa miamala kimegunduliwa.",
    // e02 · queue
    "Tahadhari imethibitishwa na kuimarishwa. Imewekwa kwenye foleni kwa kipaumbele P1 — muda wa kuwasiliana na mteja (SLA): sekunde 60.",
    // e03 · dial
    "Simu ya nje imepigwa kwa namba iliyosajiliwa +971 •• ••• 4567 (Ahmed Al-Rashid). Njia imetayarishwa, wasifu wa sauti ya Kiswahili: Amina.",
    // e04 · connected
    "Simu imeunganishwa kwa sekunde 1.2. Urekodi umeanzishwa. Baada ya jibu la kwanza, msaidizi amefungwa kwenye Kiswahili.",
    // e05 · intro
    (m) =>
      `Habari, mimi ni msaidizi wa usalama wa AI wa benki yako, nakupigia kuhusu shughuli ya hivi karibuni kwenye akaunti yako. Simu hii inarekodiwa ili kulinda akaunti yako. Je, nazungumza na ${m.customer}?`,
    // e06 · identity
    (m, first) => `Ndiyo, mimi ndiye ${first}.`,
    // e07 · verify
    "Asante, Ahmed. Ili nthibitishe utambulisho wako, tafadhali niambie kati ya miamala hii ya hivi karibuni unayotambua: ya kwanza — dirhami 45.50 kwa Carrefour, Septemba 15. ya pili — dirhami 120.00 kwa Amazon, Septemba 16. ya tatu — dirhami 2,500.00 kwa Electronics World, leo.",
    // e08 · verifyAns
    "Ya kwanza na ya pili ni yangu. Dirhami 2,500 kwa Electronics World — mimi sijanunua chochote.",
    // e09 · verifyOk
    "Uthibitisho umefanikiwa — miamala 2 kati ya 3 imetambulika, na jibu halikuhitaji mwongozo. Hisia: wasiwasi mdogo. Hakuna PIN wala nenosiri lililoombwa wakati wowote.",
    // e10 · confirm
    "Naelewa wasiwasi wako, Ahmed. Nikuthibitisie kwa wazi: haukuiidhinisha muamala wa dirhami 2,500.00 kwa Electronics World — ni kweli?",
    // e11 · confirmAns
    "Ni kweli. Si mimi.",
    // e12 · protect
    "Kukulinde, ninaweka kizuizi cha muda kwenye kadi yako inayoishia kwa 4417 sasa hivi. Hii itazuia miamala yoyote ambao haujaidhinishwa, na kinaweza kuondolewa papo hapo akaunti yako itakapokuwa salama.",
    // e13 · api
    "200 OK · staged — kizuizi: cha muda · sababu: washu wa udanganyifu · uthibitisho: 2/3 imefanikiwa",
    // e14 · done
    "Imekamilika — kadi yako imezuiwa. Nikuunganisha na mshirika wangu Sara, mtaalamu wa udanganyifu, ambaye atalinda akaunti yako na kupanga kadi yako mpya. Tafadhali endelea kwenye simu.",
    // e15 · handoff
    (m) =>
      `Uhamisho wa moja kwa moja kwa mtaalamu wa binadamu (Sara H.) — muktadha wote umepitishwa: hali ya uthibitisho, tukio la udanganyifu lililothibitishwa, uhakikisho wa hatua, na alama za hisia. Kesi ${m.caseId} imefunguliwa.`,
    // e16 · audit
    "Kumbukumbu za ukaguzi zimefungwa — rekodi ya simu, nakala kamili ya mazungumzo, njia ya uthibitisho na wakati wa hatua zimeandikwa kwenye hifadhi isiyoweza kubadilishwa (AES-256).",
    // e17 · outcome
    (m) =>
      `IMETATULIWA — kutoka kirudhi cha udanganyifu hadi hatua ya kinga ndani ya muda wa kesi wa sekunde 60 (simulation, muda uliogandamishwa). Hasara iliyokadiriwa kuzuiwa: ${m.preventedLoss.en}. Njia ya zamani: dakika 38..`,
  ],

  /* ————————— ATM CASH-OUT ————————— */
  atm: [
    "KIRUDHI CHA UDANGANYIFU KIMEPOKELEWA — kadi •• 9034, utoaji wa pesa taslimu wa dirhami 8,000.00 kwenye ATM ya Corniche Street, Abu Dhabi. Alama ya hatari 0.97 (hatari kubwa). Kiolezo cha kadi iliyonakiliwa: alama ya usomaji wa uamba na jaribio la tatu ndani ya dakika 10.",
    "Tahadhari imethibitishwa na kuimarishwa. Imewekwa kwenye foleni kwa kipaumbele P1 — muda wa kuwasiliana na mteja (SLA): sekunde 60.",
    "Simu ya nje imepigwa kwa namba iliyosajiliwa +971 •• ••• 7831 (Mariam Haddad). Njia imetayarishwa, wasifu wa sauti ya Kiswahili: Amina. Kadi bado inatumika — utoaji unaendelea.",
    "Simu imeunganishwa kwa sekunde 1.1. Urekodi umeanzishwa. Baada ya jibu la kwanza, msaidizi amefungwa kwenye Kiswahili.",
    (m) =>
      `Habari, mimi ni msaidizi wa usalama wa AI wa benki yako, nakupigia kuhusu shughuli ya hivi karibuni kwenye akaunti yako. Simu hii inarekodiwa ili kulinda akaunti yako. Je, nazungumza na ${m.customer}?`,
    (m, first) => `Ndiyo, mimi ndiye ${first}.`,
    "Asante, Mariam. Ili nthibitishe utambulisho wako, tafadhali niambie kati ya miamala hii ya hivi karibuni unayotambua: ya kwanza — dirhami 34.00 kwa Spinneys, Septemba 14. ya pili — dirhami 250.00 kwa ADNOC, Septemba 16. ya tatu — utoaji wa pesa taslimu wa dirhami 8,000.00 Corniche Street, unaoendelea sasa hivi.",
    "Ya kwanza na ya pili ni yangu. Sipo kwenye ATM yoyote — napo nyumbani kwetu Sharjah. Kuna mtu anatumia kadi yangu!",
    "Uthibitisho umefanikiwa — miamala 2 kati ya 3 imetambulika, na kukoselekana kwa mahali kimethibitishwa (mteja amesajiliwa Sharjah). Hisia: dhiki kubwa. Upandishaji kwa kipaumbele umeanzishwa. Hakuna PIN wala nenosiri lililoombwa wakati wowote.",
    "Naamini, Mariam. Nikuthibitisie kwa wazi: haukuiidhinisha utoaji wa dirhami 8,000.00 kwenye ATM ya Corniche Street — ni kweli?",
    "Ni kweli. Si mimi — tafadhali, zuia huo utoaji!",
    "Nikiuzuia sasa hivi. Ninaweka kizuizi cha muda kwenye kadi yako inayoishia kwa 9034 — utoaji utakataliwa katikati ya muamala. Kinaweza kuondolewa papo hapo kadi yako mpya itakapofika.",
    "200 OK · 210ms — kizuizi: cha muda · sababu: utoaji wa kadi iliyonakiliwa · uthibitisho: 2/3 + kukoselekana kwa mahali",
    "Imekamilika — utoaji umekataliwa na kadi yako imezuiwa. Nikuunganisha na mshirika wangu Sara, mtaalamu wa udanganyifu, ambaye atalinda akaunti yako na kutoa kadi mpya. Tafadhali endelea kwenye simu.",
    (m) =>
      `Uhamisho wa moja kwa moja kwa mtaalamu wa binadamu (Sara H.) — muktadha wote umepitishwa: hali ya uthibitisho, tukio la udanganyifu lililothibitishwa, uhakikisho wa hatua, na alama za hisia. Kesi ${m.caseId} imefunguliwa.`,
    "Kumbukumbu za ukaguzi zimefungwa — rekodi ya simu, nakala kamili ya mazungumzo, njia ya uthibitisho na wakati wa hatua zimeandikwa kwenye hifadhi isiyoweza kubadilishwa (AES-256).",
    (m) =>
      `IMETATULIWA — kutoka kirudhi cha udanganyifu hadi hatua ya kinga ndani ya muda wa kesi wa sekunde 60 (simulation, muda uliogandamishwa). Hasara iliyokadiriwa kuzuiwa: ${m.preventedLoss.en}. Njia ya zamani: dakika 38..`,
  ],

  /* ————————— IMPERSONATION WIRE SCAM ————————— */
  wire: [
    "KIRUDHI CHA UDANGANYIFU KIMEPOKELEWA — uhamishaji wa nje wa dirhami 48,000.00 kwa mpokeaji mpya M. TRADING LLC, unaangojea idhinisho. Alama ya hatari 0.99 (hatari kubwa). Mpokeaji amewekwa alama kuwa akaunti ya kupitishia pesa haramu inayojulikana; mwenendo wa udanganyifu wa kijamii kwenye simu za hivi karibuni.",
    "Tahadhari imethibitishwa na kuimarishwa. Imewekwa kwenye foleni kwa kipaumbele P1 — muda wa kuwasiliana na mteja (SLA): sekunde 60.",
    "Simu ya nje imepigwa kwa namba iliyosajiliwa +971 •• ••• 2210 (Khalid Al-Mansoori). Njia imetayarishwa, wasifu wa sauti ya Kiswahili: Amina. Mteja yupo kwenye simu nyingine — inadhaniwa ni simu ya mwinjijini.",
    "Simu imeunganishwa kwa sekunde 1.0, na iliingilia mzunguko uliokuwa ukiendelea. Urekodi umeanzishwa. Baada ya jibu la kwanza, msaidizi amefungwa kwenye Kiswahili.",
    (m) =>
      `Habari, mimi ni msaidizi wa usalama wa AI wa benki yako, nakupigia kuhusu shughuli ya hivi karibuni kwenye akaunti yako. Simu hii inarekodiwa ili kulinda akaunti yako. Je, nazungumza na ${m.customer}?`,
    (m, first) => `Ndiyo, mimi ndiye ${first}.`,
    "Asante, Khalid. Ili nthibitishe utambulisho wako, tafadhali niambie kati ya shughuli hizi za hivi karibuni unazotambua: ya kwanza — dirhami 210.00 kwa Talabat, Septemba 15. ya pili — malipo yako ya kodi ya nyumba ya dirhami 5,500.00, Septemba 1. ya tatu — mpokeaji mpya, M. TRADING LLC, wa dirhami 48,000.00, unaangojea idhini yako sasa hivi.",
    "Ya kwanza na ya pili ni yangu. Kuhusu uhamishaji — mwanaume kutoka timu ya usalama ya benki yangu aliniambia nihamishe akiba yangu kwenye akaunti salama. Je, haikuwa nyinyi?",
    "Uthibitisho umefanikiwa — vitu 2 kati ya 3 vimetambulika. Udanganyifu wa kuigilia benki unaendelea sasa umethibitishwa: «timu ya usalama ya benki» si benki. Hakuna PIN wala nenosiri lililoombwa wakati wowote.",
    "Khalid, sikiliza kwa makini: simu hiyo haikuwa ya benki yako. Benki yako haitakuwahi kuomba uhamishe pesa kwenda akaunti salama. Nikuthibitisie: haukuiidhinisha uhamishaji wa dirhami 48,000.00 kwa M. TRADING LLC — ni kweli?",
    "Ni kweli. Sijawahi kuuidhinisha kamwe. Nashukuru Mungu mmepiga simu.",
    "Kukulinde, ninaweka kizuizi papo hapo kwenye uhamishaji wa dirhami 48,000.00 — pesa hazitotoka kamwe kwenye akaunti yako. Ninamzuia pia mpokeaji mpya. Hatua zote mbili zimeandikwa kikamilifu, na timu yetu ya udanganyifu inaweza kuzirudisha.",
    "200 OK · 260ms — kizuizi: cha uhamishaji · sababu: udanganyifu wa kijamii · mpokeaji: amezuiwa · uthibitisho: 2/3",
    "Imekamilika — uhamishaji umesimishwa na pesa zako ziko salama. Nikuunganisha na mshirika wangu Sara, mtaalamu wa udanganyifu, ambaye atalinda akaunti yako na kufungua ripoti. Tafadhali endelea kwenye simu.",
    (m) =>
      `Uhamisho wa moja kwa moja kwa mtaalamu wa binadamu (Sara H.) — muktadha wote umepitishwa: hali ya uthibitisho, tukio la udanganyifu lililothibitishwa, uhakikisho wa hatua, na alama za hisia. Kesi ${m.caseId} imefunguliwa.`,
    "Kumbukumbu za ukaguzi zimefungwa — rekodi ya simu, nakala kamili ya mazungumzo, njia ya uthibitisho na wakati wa hatua zimeandikwa kwenye hifadhi isiyoweza kubadilishwa (AES-256).",
    (m) =>
      `IMETATULIWA — kutoka kirudhi cha udanganyifu hadi hatua ya kinga ndani ya muda wa kesi wa sekunde 60 (simulation, muda uliogandamishwa). Hasara iliyokadiriwa kuzuiwa: ${m.preventedLoss.en}. Njia ya zamani: dakika 38..`,
  ],

  /* ————————— INSURANCE · CLAIM PAYOUT REDIRECT ————————— */
  claim: [
    // e01 · alert
    "KIRUDHI CHA UDANGANYIFU KIMEPOKELEWA — malipo ya fidia CLM-70412 ya dirhami 62,000.00 yamehamishiwa akaunti ya benki iliyoongezwa kwenye wasifu wa mmiliki wa sera dakika 4 zilizopita, baada ya kuingia kutoka kifaa kipya. Alama ya hatari 0.96 (hatari kubwa). Malipo yapangiliwa kutolewa kwa dakika 15.",
    // e02 · queue
    "Tahadhari imethibitishwa na kuimarishwa. Imewekwa kwenye foleni kwa kipaumbele P1 — muda wa kuwasiliana na mteja (SLA): sekunde 60.",
    // e03 · dial
    "Simu ya nje imepigwa kwa namba iliyosajiliwa +971 •• ••• 3390 (Fatima Al-Zaabi). Njia imetayarishwa, wasifu wa sauti ya Kiswahili: Amina. Malipo ya fidia bado yanasubiri — hayajatolewa.",
    // e04 · connected
    "Simu imeunganishwa kwa sekunde 1.1. Urekodi umeanzishwa. Baada ya jibu la kwanza, msaidizi amefungwa kwenye Kiswahili.",
    // e05 · intro (insurer, not bank)
    (m) =>
      `Habari, mimi ni msaidizi wa usalama wa AI wa kampuni yako ya bima, nakupigia kuhusu shughuli ya hivi karibuni kwenye sera yako. Simu hii inarekodiwa ili kulinda sera yako. Je, nazungumza na ${m.customer}?`,
    // e06 · identity
    (m, first) => `Ndiyo, mimi ndiye ${first}.`,
    // e07 · verify
    "Asante, Fatima. Ili nthibitishe utambulisho wako, tafadhali niambie kati ya vitu hivi vya hivi karibuni unavyotambua: cha kwanza — malipo ya kusasisha tena sera yako ya gari, dirhami 1,840.00, Agosti 30. cha pili — fidia uliyoripoti Septemba 9 kwa ajili ya kuharibika kwa sehemu ya nyuma ya gari. cha tatu — ombi la malipo la Septemba 17 kwenda akaunti ya benki iliyoongezwa kwenye wasifu wako dakika nne tu zilizopita.",
    // e08 · verifyAns
    "Cha kwanza na cha pili ni vyangu. Sijaongeza akaunti yoyote mpya ya benki, na sijawomba malipo bado — ninasubiri ripoti ya garaji.",
    // e09 · verifyOk
    "Uthibitisho umefanikiwa — vitu 2 kati ya 3 vimetambulika, jibu halikuhitaji mwongozo. Mwingio kutoka kifaa kipya haukutambulika na mteja. Hakuna PIN, nenosiri wala namba ya sera ziliombwa wakati wowote.",
    // e10 · confirm
    "Naelewa, Fatima. Nikuthibitisie kwa wazi: haukutomba malipo ya dirhami 62,000.00 ya fidia CLM-70412 kwenda akaunti mpya ya benki — ni kweli?",
    // e11 · confirmAns
    "Ni kweli. Si mimi.",
    // e12 · protect
    "Kukulinde, ninaweka alama ya kizuizi kwenye malipo haya na kuzuia mabadiliko ya maelezo ya malipo yako hadi mtaalamu wa binadamu wa usalama wa fidia ayakague. Hakuna kitu kitakachokuwa cha mwisho mtaalamu hakuuthibitisha, na fidia yako yenyewe haitaathiriwa.",
    // e13 · api
    "200 OK · 250ms — kizuizi cha malipo: cha mpito · sababu: washu wa udanganyifu kwa kubadilisha mpokeaji · bado si cha mwisho · uthibitisho: 2/3 imefanikiwa",
    // e14 · done
    "Imekamilika — malipo yamewekwa alama ya kizuizi na fidia yako iko salama. Nikuunganisha na mshirika wangu Sara, mtaalamu wa usalama wa fidia, ambaye atathibitisha kizuizi hicho na kulinda akaunti yako. Tafadhali endelea kwenye simu.",
    // e15 · handoff
    (m) =>
      `Uhamisho wa moja kwa moja kwa mtaalamu wa binadamu (Sara H.) — muktadha wote umepitishwa: hali ya uthibitisho, tukio la udanganyifu lililothibitishwa, uhakikisho wa hatua, na alama za hisia. Kesi ${m.caseId} imefunguliwa.`,
    // e16 · audit
    "Kumbukumbu za ukaguzi zimefungwa — rekodi ya simu, nakala kamili ya mazungumzo, njia ya uthibitisho na wakati wa hatua zimeandikwa kwenye hifadhi isiyoweza kubadilishwa (AES-256).",
    // e17 · outcome
    (m) =>
      `IMETATULIWA — kutoka kirudhi cha udanganyifu hadi hatua ya kinga ndani ya muda wa kesi wa sekunde 60 (simulation, muda uliogandamishwa). Hasara iliyokadiriwa kuzuiwa: ${m.preventedLoss.en}. Njia ya zamani: dakika 38..`,
  ],

  /* ————————— FAILURE / ESCALATION · VOICEMAIL → SMS FALLBACK ————————— */
  voicemail: [
    // e01 · alert
    (m) =>
      `KIRUDHI CHA UDANGANYIFU KIMEPOKELEWA — kadi •• 2087, dirhami 3,900.00 kwa Gold Souk Online, Dubai. Alama ya hatari 0.95 (hatari kubwa). Kesi ${m.caseId}.`,
    // e02 · queue
    "Tahadhari imethibitishwa na kuimarishwa. Imewekwa kwenye foleni kwa kipaumbele P1 — muda wa kuwasiliana na mteja (SLA): sekunde 60.",
    // e03 · dial
    (m) =>
      `Simu ya nje imepigwa kwa namba iliyosajiliwa ${m.phone} (Omar Siddiqui). Njia imetayarishwa, wasifu wa sauti ya Kiswahili: Amina.`,
    // e04 · answering machine
    "Simu imeunganishwa kwa sekunde 1.4 — mashine ya kujibu imetambuliwa (salamu + mlio). Ugunduzi wa mashine umeanzishwa: msaidizi haanzishi mazungumzo na kisanduku cha ujumbe.",
    // e05 · generic voicemail message (no amount, merchant or case number)
    "Habari, mimi ni msaidizi wa usalama wa kiotomatiki wa AI wa benki yako. Tulijaribu kukupigia simu kuhusu shughuli ya hivi karibuni kwenye kadi yako. Tafadhali piga simu kwa benki yako kwa namba iliyo nyuma ya kadi yako. Hatutakuomba kamwe PIN wala msimbo wa matumizi moja. Kwaheri.",
    // e06 · voicemail_detection fired
    "Zana voicemail_detection imeanzishwa — simu imekamilika bila mazungumzo. Hali ya kesi: DIALING → VOICEMAIL → UNREACHABLE. Mdirisho wa kujibu kwa SMS wa saa 24 umeanzishwa.",
    // e07 · blind-ping SMS
    (m) =>
      `Ujumbe mfupi wa SMS umetumwa kwa ${m.phone} bila kutaja maelezo: «Benki yako: tulijaribu kukupigia simu kuhusu shughuli ya hivi karibuni kwenye kadi yako inayoishia kwa 2087. Tafadhali jibu YES ikiwa ni wewe, au NO ikiwa si wewe. Usirudishie ujumbe mwingine yeyote.»`,
    // e08 · why so little
    "Kwa nini ujumbe una maelezo machache: ujumbe wa SMS hauna siri, huonekana kwenye skrini ya kufunga na hukaa kwenye kumbukumbu za kampuni ya simu — kwa hivyo hautaji jina la duka wala kiasi, tarakimu nne za mwisho pekee.",
    // e09 · customer replies NO
    "NO",
    // e10 · parser
    "SMS ya kuingia imechambuliwa: ujumbe mzima unasomwa kamili kama NO — hakuna kulinganisha sehemu ya maandishi. Namba ya mtumaji inalingana NA TAHADHARI MOJA iliyofunguka (taasisi moja), ndani ya mdirisho wa kujibu wa saa 24.",
    // e11 · reply sent
    "Jibu limetumwa kwa mteja: «Asante. Tumeweka alama ya udanganyifu unaowezekana; mtaalamu atakagua na kuwasiliana nawe.» Hakuna kitu kilichohakikishwa kuhusu hali ya kadi.",
    // e12 · api
    "200 OK · 180ms — hali: NOTIFIED · resolution_method: sms_reply_no · customer_response: no · handoff_queued: true · freeze_staged: false (hakuna kitu kinachozuiwa kiotomatiki — binadamu ndiye anayefanya uamuzi)",
    // e13 · review ticket
    (m) =>
      `Tikiti ya ukaguzi wa udanganyifu wa binadamu imeundwa na kupangiwa mtaalamu Sara H. — kumbukumbu SV-F-20417, kesi ${m.caseId}. Foleni: ukaguzi wa udanganyifu · P1.`,
    // e14 · evidence, not authorisation
    "Kumbuka: jibu la SMS linathibitisha umiliki wa simu, si utambulisho. Limesajiliwa kama ushahidi kwa timu ya udanganyifu — si kama idhini ya kuchukua hatua.",
    // e15 · operator console
    (m) =>
      `Tahadhari ya konsoli ya mwendeshi imetumwa — kesi ${m.caseId} · P1 · mteja amejibu kwa SMS «NO», anasubiri ukaguzi wa binadamu.`,
    // e16 · audit
    "Kumbukumbu za ukaguzi zimefungwa — jaribio la simu, ugunduzi wa ujumbe wa kisanduku, SMS iliyotumwa, jibu la mteja, uamuzi wa kichambuzi na tikiti ya ukaguzi wa binadamu zimeandikwa kwenye hifadhi isiyoweza kubadilishwa (AES-256).",
    // e17 · outcome
    (m) =>
      `IMEPANDISHWA — simu ya sauti imeshindwa; mteja amefikiwa kwa SMS ya mbadala na kesi ikapelekwa kwa ukaguzi wa udanganyifu wa binadamu kwa sekunde 66 (muda wa onyesho, umepunguzwa). Hakuna kitu kilichozuiwa bila binadamu. Kiasi kinachokaguliwa: ${m.preventedLoss.en}.`,
  ],
};
