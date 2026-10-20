# Data Protection Impact Assessment — DIFC DP Law Article 20(6)

System: **SecureVoice AI** fraud-intervention platform, `SecureVoice Technologies FZ-LLC`.
Assessment method: Article 20(6)(a)–(e) of DIFC Law No. 5 of 2020 as the required content,
structured and reasoned along the lines of **ISO/IEC 29134** (_Guidelines for privacy impact
assessment_).

## 0. How to read this document

Every statement carries one of three markers, and the marker is the point:

| Marker      | Means                                                                     | Example                                |
| ----------- | ------------------------------------------------------------------------- | -------------------------------------- |
| `file:line` | Read from the tracked source at that line                                 | `src/lib/case-state-machine.ts:64`     |
| `measured`  | Observed against the running deployment or the production database        | 1140 `Case` rows (measured 2026-10-19) |
| `OPEN`      | Neither can prove it. The blank is the compliant entry, not a gap to pad. | the High-Risk characterisation         |

Primary legislation is quoted from the committed extractions `docs/legal-source/difc-law.txt`
and `docs/legal-source/difc-regs.txt` (provenance: `docs/legal-source/README.md`), and every
citation in this file is resolved by `tests/surface/compliance-citations.test.ts` in CI.

What this document is **not**:

- Not legal advice, and not a filing. It is the record the Controller keeps and can hand to the
  Commissioner, a bank's security reviewer, or an auditor.
- Not a substitute for the DPO oversight Article 20(3) requires. No DPO is appointed
  (`docs/ROPA.md:52`), so §8 records that as a finding against this assessment rather than a
  sign-off block.
- Not a paraphrase of ISO/IEC 29134. The licensed text is not held; §9 applies the method's
  published shape — contexts, data flow, internal and external threat modelling, control
  assessment, residual risk — and cites the standard by name and scope only. The Commissioner's
  AI-specific guidance was never retrieved (HTTP 429 on 2026-10-18) and is quoted nowhere.

**Why an assessment exists at all before the High-Risk question is settled:** Article 20(1) makes
a DPIA mandatory _prior to_ High Risk Processing Activities, and permits one voluntarily for
processing that is not High Risk (`difc-law.txt:751-754`). The characterisation is `OPEN`, so this
assessment is written under the second sentence — and treats the first as the contingency §7
prices. A DPIA held back until the classification arrives is a DPIA written after the processing
started.

## 1. Scope, roles and the boundary that changes the answers

Two deployments, two different legal objects — carried from `docs/AI-INVENTORY.md` §7 and
Regulation 10.3.4's deeming rule (`difc-regs.txt:912`):

| Deployment                       | Deployer → deemed Controller | SecureVoice is        | Consequence for this DPIA                                        |
| -------------------------------- | ---------------------------- | --------------------- | ---------------------------------------------------------------- |
| `securevoiceai.me` reference box | **us**                       | Controller + Operator | This assessment is ours, complete, and filed under our name      |
| A bank's own installation        | the bank                     | Operator + Provider   | The bank owns its DPIA (Art 20(1)); we owe it Art 20(11) support |

Data subjects in scope: the **cardholder who is called** (the fraud-signal subject), the **console
operator** at the institution, and **callers who reach the number**. Not in scope: bank core-ledger
subjects, because the platform never reaches beyond a staged intent — §4.

Systems in scope, by Regulation 10.1.1 definition (`difc-regs.txt:614`): the intervention
conversation agent and the dial/SMS/worker plane that acts on its verdicts, plus the audit and
retention machinery. The register is `docs/AI-INVENTORY.md` §2 (S-1 … S-7).

## 2. Article 20(6)(a) — systematic description of the processing and the purposes

Required content verbatim: `difc-law.txt:774-776`.

| #   | Operation                                                                       | Personal data touched                                                                      | Purpose                                                      | Subjects   | Retention                                       | Evidence                                                                             |
| --- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------ | ---------- | ----------------------------------------------- | ------------------------------------------------------------------------------------ |
| P1  | Ingest a fraud signal from the institution                                      | handset number, transaction reference, merchant, amount, `consent_record_id`, intake flags | perform the intervention the institution contracted          | cardholder | case tier                                       | `src/app/api/v1/interventions/route.ts:141`                                          |
| P2  | Refuse a signal whose consent has been withdrawn                                | the consent record id                                                                      | honour withdrawal at the boundary, before any dialling       | cardholder | case tier                                       | `src/app/api/v1/interventions/route.ts:279`                                          |
| P3  | Place an outbound voice call and synthesise the agent's turns                   | handset number, spoken turn, call metadata                                                 | reach the cardholder at all                                  | cardholder | call/audio tier — **no audio retained in prod** | `docs/ROPA.md` A5; §3.4 below                                                        |
| P4  | Transcribe the caller's speech and draft the reply                              | audio of the caller, turn text                                                             | conduct the conversation                                     | cardholder | as P3                                           | `src/lib/llm.ts:724`                                                                 |
| P5  | Take the verdict from the caller's own keypad press                             | the digit pressed                                                                          | make the fraud claim the subject's own act, not an inference | cardholder | case tier                                       | `src/lib/voice/dtmf.ts:147-154`                                                      |
| P6  | Stage a freeze and let a human commit it                                        | case state, card last-4, amount                                                            | give the institution an evidenced intent it can act on       | cardholder | case tier                                       | `src/lib/case-state-machine.ts:64`, `src/app/api/console/freeze/commit/route.ts:102` |
| P7  | Text the cardholder where voice is impossible or unanswered, and read the reply | handset number, SMS body and reply                                                         | deliver the same intervention on a second channel            | cardholder | case tier                                       | `src/lib/sms-verdict.ts`                                                             |
| P8  | Append every consequential action to a hash-linked audit chain                  | pseudonymised IP hash, request id, operator email, redacted text                           | make the record tamper-evident                               | both       | never deleted — §5.4                            | `src/lib/audit-chain.ts:136-148`                                                     |
| P9  | Count cases, latency and SLA breaches in aggregate metrics                      | none — counters and labels                                                                 | operate the platform                                         | none       | in-memory/export windows                        | `src/app/api/metrics/route.ts`                                                       |
| P10 | Bill the institution                                                            | operator identity, seat and usage counts                                                   | commercial contract                                          | operator   | billing tier                                    | `docs/ROPA.md` A7                                                                    |

### 2.1 What the production data actually shows

Measured against the live database on 2026-10-19, counts only, no value leaving the box:

| Fact                                                                         | Value                                            | Why it matters here                                              |
| ---------------------------------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------- |
| `Case` rows                                                                  | 1140                                             | the whole population this assessment describes                   |
| newest `Case.createdAt`                                                      | 2026-10-10                                       | **no processing about a live subject has occurred in 9 days**    |
| rows that held a plaintext handset number                                    | 847, **0 on the 2026-10-20 re-measurement**      | §3.2 — the exposure this assessment closes, and has closed       |
| of those, rows with no `orgId`, a fixture `orgId`, or a deleted organization | 825                                              | synthetic: written by the load, isolation and integration suites |
| of those, rows belonging to an organization that exists                      | 22 of 22 seeded ids (`0b0b0b0b-*`, `0a0a0a0a-*`) | no real tenant was ever in the plaintext set                     |
| `pii_vault` rows                                                             | 22 (0 before today)                              | the seal path ran in production for the first time               |
| `AuditLog` rows                                                              | 14,618                                           | the evidence base the retention rule refuses to trim (§5.4)      |
| `organization` rows                                                          | 153                                              | tenants onboarded, of which the billing record shows none paying |
| consent records referenced by case rows                                      | 141 distinct                                     | P2 is exercised with real ids, not a column that nothing writes  |

The second and fourth rows are the honest headline of this assessment: **the platform's privacy
risk profile today is dominated by its own test harness, not by customer traffic.** A DPIA that
described the designed flows and left that out would be describing a product nobody has used.

## 3. Necessity and proportionality — Article 20(6)(b)

Required content verbatim: `difc-law.txt:778-779`.

Test applied per element: could the contracted purpose be met with less, and is the residue
proportionate to the harm the intervention prevents (a cardholder losing money to a live
impersonation fraud)?

### 3.1 Elements that pass

| Element                                 | Necessity                                                                                       | Less-intrusive alternative considered and rejected                                                 |
| --------------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Handset number                          | It is the only address of the subject the institution holds; without it there is no call or SMS | One-way hash for dialling is impossible — dialling requires the recoverable value, hence the vault |
| Card last four                          | The subject must recognise which card is at stake                                               | Full PAN — never collected; the platform is not in the card data path                              |
| Transaction reference, merchant, amount | The verdict is worthless without the transaction it refers to                                   | A blind "was that you?" call, which the policy refuses as too weak to consent to                   |
| The spoken turn                         | Conversation is the medium                                                                      | App-only push — the product exists for the case where the caller is being impersonated             |
| Operator email in the commit row        | The whole point of Article 38's human route is that a named human decided                       | Anonymous operator ids — would void the evidence value of the row                                  |

### 3.2 The element that failed proportionality, and what was done about it

`Case.phone` held plaintext handset numbers on 847 rows on 2026-10-19 — a figure the compliance
record had been carrying as "~85" (§42 of the register), which was wrong by an order of magnitude
until it was counted rather than remembered.

Two facts made the naive remedy unsafe, and both are reasons this is recorded as a **control
decision** rather than a cleanup:

1. **Most of it could not be sealed.** The vault's blind index is scoped by tenant
   (`src/lib/compliance/pii-vault.ts:92`), and 372 rows have no tenant at all. A token that no
   tenant can resolve is a number that has been lost, not protected.
2. **Deleting the rows would have destroyed evidence.** 5,764 audit rows name those cases and the
   chain is append-only (`src/lib/audit-chain.ts:136-148`); a further 1,229 rows in `Notification`,
   `OutboxEvent`, `DeadLetter` and `UsageLedger` (billing) reference them by `caseRef`, with no
   foreign key to warn anyone. The retention guard refuses to edit or trim the chain at all.

So the 825 unsealable rows had their number cleared and their row kept
(`scripts/clear-unvaultable-case-phone.ts`), and the 22 sealable rows went through the vault.
End state, re-measured the same day: `pending: 0` — no row holds a plaintext number, and the
sealed rows still resolve for the dial
(`src/lib/compliance/pii-vault.ts:112`, `src/lib/sms-verdict.ts`).

Proportionality conclusion: the plaintext column is now **not held at all**, which is the strictest
answer available short of not collecting the number, and the collection itself is necessary (§3.1).

### 3.3 Audio, which is the proportionality question the marketing answer skips

`measured` 2026-10-18: the entire object-storage block is UNSET in production, so the reference
deployment retains **no call audio**. The 30-day audio tier in
`src/lib/privacy/retention.ts:76` is therefore correct and dormant — a promise about a file nobody
stores. Schedule 1 makes audio special-category only where it is used to uniquely identify
(`docs/ROPA.md:289-303`), and no speaker-identification code path exists in this repository. That
is a finding of **absence**, verified by search, and it must be re-verified if a voiceprint feature
ever lands — the DPIA's conclusion on audio flips with it.

### 3.4 The health-data element, which is not proportionate today

`hearing_impaired` arrives on the intake signal (`src/app/api/v1/interventions/route.ts:146`),
decides that voice is skipped and the case goes SMS-only (`:773-806`), survives with the case, and
is counted in analytics (`src/lib/analytics.ts:104`). Health data sits inside the Law's Schedule 1
definition of Special Categories, which means it needs an Article 11 condition on top of an Article
10 basis. **No Article 11 condition is recorded anywhere** — `OPEN`, owner-plus-counsel, and it is
the one item in this assessment where the platform processes a special category with a documented
purpose (accessibility) and an undocumented basis. The engineering is right; the records are not.

## 4. Lawful basis — Article 20(6)(c)

Required content verbatim, including both sub-limbs: `difc-law.txt:781-795`.

### 4.1 The basis claimed

| Processing           | Article 10 limb                                                                     | Reasoning                                                                                                                                  |
| -------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| P1, P3–P7 (the call) | `OPEN` — expect Art 10(1)(f)/contract, and Art 10(b) for the institution's own duty | The platform acts on an instruction from the institution, not on the subject's contract with us. Who the Controller is, is §1.             |
| Fraud classification | Article 38(2)(b) via 38(3)                                                          | DIFC fraud, cyber-crime, AML and tax-evasion monitoring is **deemed** to fall within the Art 38(2)(b) exemption (`difc-law.txt:1871-1873`) |
| P8 (audit)           | Art 10 legitimate interests, plus Art 15(1) record-keeping duty                     | The chain exists so a dispute can be adjudicated; the balancing test is §4.2                                                               |
| P9 (metrics)         | Art 10 legitimate interests, operator-facing                                        | Aggregate counters; no subject is identifiable in a counter (`src/app/api/metrics/route.ts`)                                               |
| P10 (billing)        | Art 10(b)/contract with the institution                                             | The subject's own data in the billing path is the operator's identity, not the cardholder's                                                |

### 4.2 Legitimate-interests analysis, per the limb at `difc-law.txt:786-789`

Three-part test, applied as written:

- **Purpose test.** Preventing a cardholder's money leaving their account to an impersonator is a
  legitimate interest of the institution, and ours in performing the contracted intervention.
- **Necessity test.** §3.1 answers it per element: the alternatives considered (hash-only dialling,
  full PAN, blind confirmation call, app push) each fail.
- **Balancing test.** Favourable, with two named weights against us: the call is **unsolicited and
  outbound** to a distressed person, and it is placed **from a line that looks like vishing** (§5.1,
  R3). The mitigations that carry the balance are the ones a data subject can actually feel: the
  verdict is the subject's own keypad press, so nothing adverse to them is decided by a model
  (`src/lib/voice/dtmf.ts:147-154`); the commitment turn is a vetted script that never leaves the
  boundary (`src/lib/llm.ts:58-62`); a freeze is staged, never executed, and only a human commits
  (`src/app/api/console/freeze/commit/route.ts:102`); and an unanswered call is recorded, not
  re-attempted into harassment (`src/lib/sla-breach.ts:61`, `:115`).

### 4.3 Consent, and its withdrawal, per the limb at `difc-law.txt:792-795`

- **Validly obtained?** The intake signal **requires** a `consent_record_id`
  (`src/app/api/v1/interventions/route.ts:141`) — the institution asserts it, and `measured` 141
  distinct ids are actually referenced in production, so the column is not decoration. Whether what
  the institutions collect **is** valid DIFC consent (specific, freely given, informed, in a form
  complying with Article 13) is `OPEN` — it is their notice, not ours, and it is the first thing a
  bank's counsel should be asked for.
- **Effect of withdrawal.** Withdrawal is honoured before any dialling: the combined
  idempotency-plus-consent check refuses an opted-out record
  (`src/app/api/v1/interventions/route.ts:279`), so a withdrawn consent cannot generate a call. The
  case row and its audit evidence survive withdrawal by design — the record of having been told to
  stop is itself evidence.
- **How compliance with the right is ensured.** Refusal at ingest (above), erasure through the
  crypto-shred path that destroys the sealed value and not merely the pointer
  (`src/lib/privacy/crypto-shred.ts:740`), and suppression of further voice attempts on the
  accessibility path (`src/lib/case-state-machine.ts:105-108`).
- **The Article 22 question consent does not answer.** Article 22 requires that where the basis
  ceases to exist or a subject's rights require it, personal data held **including by Processors**
  is securely and permanently deleted (`difc-law.txt:909-915`). The audit chain is append-only and
  is deliberately never deleted (`src/lib/privacy/retention.ts:298`). Those two requirements are in
  tension, and this assessment resolves it as: retention of the **evidence** under Art 15(1) and
  the institution's AML duties, with the **payload** shredded. That resolution is a legal position
  the Controller has not had tested — `OPEN`, counsel, and it is the item most likely to be
  challenged by a bank's own DPO.

## 5. Risks to the rights of data subjects — Article 20(6)(d)

Required content verbatim: `difc-law.txt:797`. Assessed in the ISO/IEC 29134 shape: a threat agent
and an offense against a identified asset, then the impact on the subject — not "a breach might
happen". Confidence is stated because most of this system has never met real traffic (§2.1).

| #   | Threat agent → offense                                                            | Asset                                  | Impact on the data subject                                                                                                      | Likelihood   | Severity | Evidence / status                                                                                                                                                                                        |
| --- | --------------------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | Fraudster → learns that a live AI line calls on behalf of "their bank"            | trust in the institution's channel     | a real fraud call is believed because it resembles ours; the subject is talked into handing over the very thing we protect      | **high**     | severe   | `measured`: caller ID is `TWILIO_FROM_NUMBER=+256…`, a Ugandan line; owner decided 2026-09→10-19 to buy an in-region number — **not yet executed**                                                       |
| R2  | Any tenant → enumerates another tenant's cardholders by number                    | handset number, case existence         | a person's fraud history at bank A is disclosed to bank B                                                                       | low          | severe   | two indexes scoped deliberately (`src/lib/compliance/pii-vault.ts:92`); the cross-tenant fail-safe is tested; `orgId` is a sibling of the OR, never an arm                                               |
| R3  | Our own platform → dials a distressed person repeatedly                           | freedom from nuisance, health, dignity | a customer reporting fraud is then harassed by it                                                                               | medium       | major    | the SLA sweep records a breach and does **not** fire the fallback SMS (`src/lib/sla-breach.ts:115`); voice is refused where `hearing_impaired`                                                           |
| R4  | Model or provider → receives committed fraud language                             | the subject's account of a crime       | an inaccurate output denies a real claim, or an inference of fraud is made about a person                                       | low          | major    | commitment turns return before any provider call (`src/lib/llm.ts:58-62`); the prompt receives an already-verified intent (`src/lib/llm.ts:724`)                                                         |
| R5  | Insider / full-database reader → groups pseudonyms                                | the vault's value                      | a person is linked across cases by an index even though the number is sealed                                                    | medium       | moderate | **accepted by the owner 2026-10-15**: `Case.phoneIndex` carries no tenant, because the inbound-callback and SMS-reply paths have no tenant to hash in                                                    |
| R6  | A test suite → writes personal-data-shaped rows into production                   | the integrity of the record itself     | a regulator or a bank reads our registers and finds hundreds of "customers" who are fixtures; erasure requests cannot be scoped | **realised** | major    | `measured` today: 825 of 847 plaintext numbers were harness rows, one with `orgId` NULL and 445 under fixture ids                                                                                        |
| R7  | Cross-border flow → data leaves the DIFC perimeter without a safeguard            | everything in §2                       | the subject's protection depends on a foreign regime nobody contracted for                                                      | **realised** | major    | primary datastore is `aws-0-eu-central-1` (Frankfurt) and mail is `eu-west-1` (`docs/ROPA.md:180-206`); the export-safeguard column is `OPEN` for every vendor                                           |
| R8  | Telemetry → traces or logs carry caller data to a foreign stack                   | spoken turns, case state               | verbatim content about a fraud loss sitting in Canada East                                                                      | controlled   | major    | owner decided 2026-10-19: **metrics only** leave the region; per-signal endpoints (`src/lib/telemetry/otlp-config.ts:89`, `:101-103`); `measured`: no OTLP credential on the box, so nothing ships today |
| R9  | Key rotation or loss of `AUTH_SECRET` → sealed values become unresolvable         | the vault                              | a case cannot be dialled or a reply answered — the platform says "no open alert" to a live fraud report                         | low          | severe   | fail-closed by design (`src/lib/compliance/pii-vault.ts:220`); a migration cannot seal anything by itself; rotation runbook `OPEN`                                                                       |
| R10 | Deletion of a case row → strands the evidence that names it                       | the audit chain, billing history       | a dispute cannot be reconstructed; a subject's erasure request deletes the proof that the request was honoured                  | considered   | major    | refused in favour of §3.2's clear-not-delete: 5,764 audit rows and 1,229 operational rows depend on the rows                                                                                             |
| R11 | Automated-decision perception → a subject believes a machine decided against them | the right to human review (Article 38) | an objection right that looks unavailable, and a complaint that lands with the Commissioner                                     | low          | major    | "solely automated" is structurally unreachable (§4.2); `FREEZE_STAGED` is entered only from `CONFIRMED_FRAUD` (`src/lib/case-state-machine.ts:64`) and committed by a named human                        |

### 5.1 The risk the platform is currently the loudest about

R1 is the highest-rated risk in this assessment and it is not a code defect. An AI voice agent
claiming to call on behalf of a Gulf bank, placed from a +256 line, is the exact shape of a
vishing pattern, which is the most probable explanation for `securevoiceai.me` repeatedly being
reported to its hosts. `measured` alongside it: DMARC is `p=none`, which publishes that we do not
ask for the domain to be protected. Both are owner-side configuration, both are cheap, and both
were decided on 2026-10-19 with neither yet executed. Until they land, the platform's most likely
concrete harm to a data subject is **helping a real fraudster sound legitimate**.

### 5.2 Internal versus external, which ISO/IEC 29134 separates and this table folds

External agents: R1, R2 (a malicious or careless tenant), R4's provider. Internal agents: R3, R5,
R6, R9, R10 and R11 — every one of those is a decision our own code or our own operations took, and
R6 was realised by our test suites. That split matters for the next version of this document: the
controls that mitigate the majority of the assessed risk are governance controls over our own
engineering habits, not perimeter controls.

## 6. Measures envisaged — Article 20(6)(e)

Required content verbatim: `difc-law.txt:799-805`.

### 6.1 Implemented, and where to see it

| Risk  | Measure                                                                                                 | Evidence                                                                                                |
| ----- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| R11   | Verdict is the subject's keypad press; the model words a reply it did not decide; commit is a human act | `src/lib/voice/dtmf.ts:147-154`, `src/lib/llm.ts:724`, `src/app/api/console/freeze/commit/route.ts:102` |
| R4    | Commitment-bearing turns never reach a provider                                                         | `src/lib/llm.ts:58-62`                                                                                  |
| R3    | A missed deadline is recorded, not acted on; no re-dial into an accessibility failure                   | `src/lib/sla-breach.ts:61`, `:115`, `src/lib/case-state-machine.ts:105-108`                             |
| R2    | Tenant-scoped vault index plus an org-free case index, with the tenant kept outside the OR              | `src/lib/compliance/pii-vault.ts:92`, `:238`                                                            |
| R5    | Owner-accepted trade, recorded rather than hidden; the vault cannot reveal one customer at two banks    | `src/lib/compliance/pii-vault.ts:92` (scope argument)                                                   |
| R6    | Plaintext cleared from unsealable rows, sealable rows vaulted, `pending: 0` re-measured                 | `scripts/clear-unvaultable-case-phone.ts`, `scripts/backfill-case-phone-vault.ts`                       |
| R7/R8 | Per-signal residency: an endpoint on any one signal is a verdict, not a misread "nothing ships"         | `src/lib/telemetry/otlp-config.ts:89`, `:101-103`                                                       |
| R9    | Fail-closed resolution: no key means no sealed match, and the dial treats null as "no destination"      | `src/lib/compliance/pii-vault.ts:220`, `:259-267`                                                       |
| R6    | The backfill's dry run actually writes nothing, and the gate can fail on the defect it names            | `scripts/backfill-case-phone-vault.ts:119-131`, `tests/privacy/pii-vault-blind-index.test.ts:395-413`   |
| R10   | The audit tier is unconditionally undeletable, asserted in code                                         | `src/lib/privacy/retention.ts:298`, `:435`                                                              |
| all   | Citation rot fails CI instead of reaching a regulator                                                   | `tests/surface/compliance-citations.test.ts`                                                            |

### 6.2 Planned, not yet real

1. In-region or attributable caller ID, and a DMARC policy above `p=none` (R1) — decided 2026-10-19,
   not executed. Owner action; costs a number rental and a Twilio account upgrade off Trial.
2. Harness isolation: the load and integration suites must not write into the production database
   (R6). The clear script is a mop, not a control.
3. An Article 11 condition for `hearing_impaired`, or the flag stops being collected (§3.4).
4. A key-rotation runbook that says what happens to sealed rows when `AUTH_SECRET` moves (R9).
5. Executed Article 24 sub-processor terms naming processing locations, which closes the `OPEN`
   column in `docs/ROPA.md:180-206` and most of R7.

### 6.3 Owner-gated, and therefore not this document's to decide

The High-Risk characterisation (§7), the DPO and Autonomous Systems Officer appointments, the
Regulation 3 notification status, and whether the reference deployment or a bank is the Controller
of record for a given institution. Each is a decision with a cost attached; none is a test failure.

## 7. Residual risk, and the consultation Article 21 makes the next question

With §6.1 in place, the residual risks that remain **high** are R1 (channel impersonation), R6's
governance half (harness data still reaching production), R7 (transfers with no executed
safeguard) and the unassessed §3.4 health-data basis. None is closed by writing more guardrails.

Article 21(1) requires consulting the Commissioner **where a DPIA indicates high residual risk**
without the Controller having a mitigation (`difc-law.txt:841-848`). Read against §5, this
assessment is the artifact that arguably triggers that duty — which is exactly why the
characterisation is on the critical path rather than beside it:

| Contingency                     | Effect                                                                                                                                                                                                                                                                                                                   |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Processing **is** High Risk     | Reg 10.3.3 applies, DPO becomes mandatory (Art 16(2)(b), small-entity carve-out disapplied by Reg 3.1.1 at `difc-regs.txt:149`), an ASO is required (10.3.3(d)), Art 21 consultation is due, and **footnote 11 bars any System from being used for it until certification requirements exist** (`difc-regs.txt:889-892`) |
| Processing is **not** High Risk | This document stands as a voluntary Art 20(1) assessment, Art 20(4)'s list does not catch us, and the register stays on the ROPA plus notice                                                                                                                                                                             |
| Uncharacterised (today)         | Every one of the above is unresolvable, and the compliance record is a record of that fact                                                                                                                                                                                                                               |

The bar in footnote 11 is a **market-entry condition, not an engineering defect**. No control in
§6.1 moves it, and it is stated here plainly so nobody reads a green test suite as clearance to
sell into the DIFC.

## 8. Oversight, review, and the parts of Article 20 this document cannot satisfy

| Limb       | Requirement                                                                 | Status                                                                                                                                |
| ---------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Art 20(3)  | A DPO, where appointed, oversees DPIAs                                      | `OPEN` — no DPO appointed (`docs/ROPA.md:52`); this assessment has no owner-side reviewer, and that is a finding, not a formality     |
| Art 20(2)  | Reliance on a group member's equivalent assessment                          | not used; nothing here is inherited                                                                                                   |
| Art 20(7)  | Approved codes of conduct taken into account                                | `OPEN` — none adopted                                                                                                                 |
| Art 20(8)  | Seek the input of data subjects or their representatives, where appropriate | `OPEN` — the subject of a fraud call is not a consultable population; a bank's accessibility users would be, and §3.4 depends on them |
| Art 20(9)  | When a new assessment is not required                                       | not relied on                                                                                                                         |
| Art 20(10) | Review on a regular basis, or on a change in risk                           | **trigger list below**                                                                                                                |
| Art 20(11) | A Processor assists the Controller with information                         | this document is that assistance package for a bank's own DPIA                                                                        |
| Art 21     | Prior consultation on high residual risk                                    | `OPEN`, gated on §7                                                                                                                   |
| Art 22     | Cessation of processing where a basis ceases                                | §4.3, resolved as payload-shred-plus-evidence-retention, untested legally                                                             |
| Reg 3      | Notify the Commissioner within 30 days of commencing, renew annually        | `OPEN` — owner; and this record cannot see whether it has ever been filed                                                             |

**Review triggers (Art 20(10)(b) — "a change in the risk"):** any speaker-identification or
voiceprint feature (flips §3.3 and the Schedule-1 analysis); any retention of call audio;
a bank deployment going live (flips §1 roles); the caller ID and DMARC changes in §6.2(1); the
High-Risk characterisation arriving in writing; adoption of a code of conduct; any new
special-category intake flag; `AUTH_SECRET` rotation being automated rather than manual.
Otherwise annually, from the date of this document.

## 9. The method actually applied

ISO/IEC 29134 is cited by name and scope only — the licensed text is not held, and this section
says what was done rather than quoting a standard nobody here has read. Applied in the standard's
published order:

1. **Context description** (§1, §2): system boundary, roles under Regulation 10.1.1, the two
   deployment postures, and the measured data population.
2. **Data flow diagram** (§2, and `docs/INFRASTRUCTURE.md`): signal in → dial → provider turn →
   keypad verdict → staged freeze → human commit → audit append, with the channels and each
   vendor's hop marked as a potential transfer (§5 R7).
3. **Systematic description of processing features** (§2): each Pn given an asset, a subject class
   and a retention tier.
4. **Risk identification as offense/impact pairs, split internal/external** (§5, §5.2) rather than
   as a confidentiality-integrity-availability matrix, which is the standard's shape and is the
   reason a §5 row names a _threat agent_ and not a _vulnerability_.
5. **Control assessment** (§6.1): implemented controls cited to code, assessed for whether they
   change the likelihood or the impact.
6. **Residual risk and decision** (§7, §6.3): four risks stay high, three of them owner-side, and
   the document says so instead of averaging them into amber.
7. **Action plan with owners** (§6.2, §6.3, §10) and a review trigger list (§8).

Where the standard's method was not followed, it is because a licensed text was not available to
follow it from; that is recorded here so a reviewer can weigh the shape of the reasoning rather
than assume the citation is deeper than it is.

## 10. Actions this assessment creates

| #   | Action                                                                       | Who               | Provision                | Status                                        |
| --- | ---------------------------------------------------------------------------- | ----------------- | ------------------------ | --------------------------------------------- |
| 1   | Buy an in-region or attributable caller ID; move DMARC above `p=none`        | owner             | §5 R1, Art 5(1)(a)       | decided, not done                             |
| 2   | Written High-Risk characterisation from DIFC counsel                         | owner+counsel     | Reg 10.3.3, Art 21       | `OPEN`, blocks §7                             |
| 3   | Appoint a DPO (Art 16(2)(b)) and an ASO (10.3.3(d)), or record why not       | owner             | Art 20(3), Art 16(2)(b)  | `OPEN`                                        |
| 4   | Establish the Regulation 3 notification status and renewal date              | owner             | Reg 3.1.1                | `OPEN`                                        |
| 5   | Executed Article 24 sub-processor terms with processing locations            | owner+vendors     | Art 24, Art 15(1)(f)–(g) | `OPEN`, closes R7                             |
| 6   | Record an Article 11 condition for `hearing_impaired`, or stop collecting it | owner+counsel     | Art 11, §3.4             | `OPEN`                                        |
| 7   | Stop the test suites writing into the production database                    | engineering       | §5 R6                    | not started                                   |
| 8   | Re-measure the plaintext count on a schedule instead of from memory          | engineering       | Reg 2.1 accuracy         | **done 2026-10-19** (the "~85" claim was 847) |
| 9   | Set the metrics-only OTLP destination once the access-policy token exists    | owner+engineering | §5 R8, Art 15(1)(f)      | `OPEN` on the token                           |
| 10  | A key-rotation runbook for `AUTH_SECRET` with the sealed-row consequence     | engineering       | §5 R9                    | not started                                   |

## 11. Sources

Primary, quoted from the committed extractions: Article 20 in full (`difc-law.txt:749-840`),
Article 21 (`:841-848`), Article 22 (`:909-915`), Article 38 (`:1854-1877`, the deemed route at
`:1871-1873`), Schedule 1 definitions (`:2975-2994`, `:3057-3061`); Regulations 3.1.1
(`difc-regs.txt:149`), 10.1.1 (`:614`), 10.2.2 (`:685-815`), 10.3.3 with footnote 11 (`:876-892`),
10.3.4 (`:912`).

Sibling records: `docs/ROPA.md` (Article 15(1)(a)–(h)), `docs/AI-INVENTORY.md` (Regulation
10.2.2(g) register and the 10.3.1 design mapping), `docs/GAP-REGISTER.md` §42 (how the record came
to exist and what it found wrong in the published notice), `docs/TRUST-MODEL.md`,
`docs/INFRASTRUCTURE.md`.

Named but not quoted: **ISO/IEC 29134** (licensed text not held). **Not retrieved and not quoted
anywhere**: the Commissioner's AI guidance pages, HTTP 429 on 2026-10-18.
