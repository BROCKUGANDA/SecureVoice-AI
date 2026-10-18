# AI Systems Inventory — DIFC Regulations, Division 10

**Entity:** SecureVoice Technologies FZ-LLC (DIFC)
**Maintained under:** DIFC Data Protection Regulations, Regulation 10 — _Personal Data Processed
through Autonomous and Semi-Autonomous Systems_; and DIFC Data Protection Law No. 5 of 2020, Article 38
**Purpose:** the "register listing" required by **Regulation 10.2.2(g)**, plus the notice contents
required by **10.2.2(a) and (b)** and the design evidence required by **10.3.1 / 10.3.2**
**Version:** 1.0 · **Prepared:** 2026-10-18 · Companion to `docs/ROPA.md` (same evidence discipline)

---

## 1. Is this a "System"? Roles under 10.1.1 and the deeming rule at 10.3.4

**Regulation 10.1.1(a)** defines a System as _any machine-based system operating in an autonomous or
semi-autonomous manner, that can (i) Process Personal Data for human-defined purposes or purposes that
the system itself defines, or both; and (ii) generate output as a result of or on the basis of such
Processing._

Applying it: the SecureVoice intervention agent is machine-based, operates semi-autonomously, processes
personal data for human-defined purposes, and generates output — a spoken turn and a case-state
transition. **Yes, it is a System**, and so are several of the models underneath it (§3). The
determination is not marginal: it turns on the definition's two limbs, both of which are plainly met.

| Role         | Definition                                                                                                                                                                                              | Who it is here                                 |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| **Provider** | 10.1.1(d) — develops the System, or procures its development, with a view to making it available to Operators or Deployers                                                                              | SecureVoice Technologies FZ-LLC                |
| **Deployer** | 10.1.1(b) — the person under whose authority, direction or for whose benefit the System is operated, _or who receives the benefit of its output_, **irrespective of whether it hosts or supervises it** | the deploying bank or insurer                  |
| **Operator** | 10.1.1(c) — **a Provider** that operates or supervises a System on behalf and on the direction of a Deployer                                                                                            | SecureVoice, when it hosts a tenant deployment |

**Consequence, from 10.3.4:** _"a Deployer of a System shall be deemed to act as a Controller … and an
Operator of a System shall be deemed to act as a Processor (or, mutatis mutandis, a Sub-processor)."_
So in a bank deployment the bank owns the Controller duties (notice, lawful basis, rights response,
DPIA ownership) and SecureVoice owns Processor duties — and SecureVoice additionally owns the
**Provider-side design duties in 10.3.1 and 10.3.2**, which guidance note 9 deliberately extends past
developers to Deployers and Operators because they are the parties visible to data subjects.

Two things follow that are easy to miss and expensive to discover late:

1. **Being "only" a processor does not discharge 10.3.1/10.3.2.** The design principles bind the System
   itself, and the Operator is accountable for them. So the evidence in §5 is not optional collateral —
   it is the deliverable.
2. **A pilot run under our own brand on our own box makes SecureVoice the Deployer**, and therefore the
   deemed **Controller**, for that environment's data. The reference deployment at `securevoiceai.me`
   (measured: `APP_BASE_URL=https://securevoiceai.me`, `BETTER_AUTH_URL=https://securevoiceai.me`) is
   exactly that case. §7 keeps the two roles separate.

---

## 2. The register required by Regulation 10.2.2(g)

Regulation 10.2.2(g) asks for a register listing, "(i) use cases, necessity and proportionality …,
(ii) how information in the System can be accessed by Data Subjects in accordance with Articles 32 to
40 of the Law; (iii) whether the System will be used solely to make automated decisions; (iv) with
which Third Parties or … Requesting Authorities any Personal Data used in the Systems is Processed as
part of stable arrangements, other than on an occasional basis, (v) … in accordance with one or more of
the lawful bases set out in Article 10 or Article 11 of the Law; (vi) contractual obligations of Joint
Controllers, Processors or Sub-processors; and (vii) where Third Parties or Regulatory Authorities …
are located and appropriate safeguards for exporting the Personal Data thereto".

Columns are that sub-paragraph list. Nothing is invented, and every cell that cannot be evidenced from
this repository or the running deployment says so.

### S-1 — Intervention conversation agent

| (g) field                                                       | Entry                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **(i) use case; necessity; proportionality**                    | Confirm with the account holder, within minutes, whether a disputed transaction was authorised, and if not, stage a protective hold before the money moves. _Necessity:_ the alternative the bank has today is a call centre queue the next morning — the loss window closes first. _Proportionality:_ the platform holds no PAN, never asks for a PIN/password/OTP/full card number, redacts before persist, and its only write action is a **staged** hold a human must commit (`docs/ROPA.md` A4; `src/lib/compliance/policy.ts` items 3-4).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **(ii) Data Subject access, Arts 32-40**                        | `OPEN`. The person on the call has no account and no portal. Rights are exercised through the bank (`src/views/Legal.tsx:226`: "direct your request to the bank; we support the bank in fulfilling it"). What exists on our side: opt-out honoured immediately and permanently (`SmsSuppression`, `DoNotCall`, `schema.prisma:624-641`), stop-on-request in call (`*` → `cancel`, `src/lib/voice/dtmf.ts:153`), human handoff on demand (`9` → `request_human`), and erasure by key destruction (`src/lib/privacy/crypto-shred.ts`, reaches the Pinecone index via `forgetTranscript`, `:78`). **Missing:** an intake channel for an Art 40 request that arrives here, and an Art 33 access/rectification path for a non-account holder.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **(iii) solely automated decisions?**                           | **No** — and the reasons are structural, not incidental: (1) the fraud verdict is the caller's own keypad press (`src/lib/voice/dtmf.ts:147-154`: `1`→`deny_fraud`, `2`→`confirm_authorized`), not a model inference; (2) the LLM is a _drafter_ that receives the already-verified intent (`src/lib/llm.ts:724`) — and for every intent whose reply is a commitment it **declines to call any provider at all**, so the vetted script is spoken verbatim (`SCRIPTED_ONLY` at `src/lib/llm.ts:58-62`, enforced by the early return at `:590`); (3) the hold is staged only — "this platform never wrote a hold at the bank", so there is nothing for it to undo (`src/lib/ai/ai-authz.ts:69`); (4) commit is a human action in the console and the operator's identity is written to the audit row (`src/app/api/console/freeze/commit/route.ts:13`, `:102`); (5) an unreached case **escalates rather than self-resolves** — `FREEZE_STAGED` expires by escalating, and `src/lib/freeze-window.ts:12` states the rule as "Expiry escalates; it never reverses"; (6) **`FREEZE_STAGED` is entered only from `CONFIRMED_FRAUD`** (`src/lib/case-state-machine.ts:64`, invariant I-2 at `:6-7`), so an unverified or uncertain case can never produce a protective action at all. This is the row a reviewer will read first, and it is the row the architecture was built to make true. |
| **(iv) third parties / authorities in stable arrangements**     | ElevenLabs (voice), Groq (reply drafting), Deepgram (STT fallback), Supabase (database), Twilio (voice+SMS), Resend (email), Pinecone (transcript index), Paddle (billing) — all wired with credentials present in the production deployment (measured 2026-10-18, presence only). Requesting Authorities: no standing arrangement; an authority request runs through the bank or through `src/app/api/regulatory/export/route.ts`, which is gated by `requireOperator()` (`:4`, `:8`) — a human, not the System.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **(v) lawful basis, Art 10 / Art 11**                           | Art 10(c) Applicable Law and Art 10(d) vital interests, **established by the bank** (`src/views/Legal.tsx:183`). For the automated-decision question the DIFC route is **Art 38(3)**: DIFC law on fraud, counter-terrorism, money-laundering and tax-evasion monitoring "is regarded as falling within Article 38(2)(b)". Art 11: the `hearing_impaired` channel-selection field is health data and **no Art 11 condition is recorded** — the gap flagged in `docs/ROPA.md` §7.3.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **(vi) joint controller / processor / sub-processor contracts** | `OPEN`. Article 24(2) sub-processor terms and the DPA template exist as documents; **no executed agreement is in evidence.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **(vii) recipient locations + export safeguards**               | Database in Frankfurt (`aws-0-eu-central-1`, measured). Vendor processing locations `OPEN` — see `docs/ROPA.md` §3.1/§3.2. No Article 26/27 transfer assessment exists in the repository, and the published safeguard language is GDPR SCC wording (`src/views/Legal.tsx:184`), which is not the instrument Articles 26/27 contemplate.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

### S-2 … S-7 — the other Systems

| ID   | Component                                                                                                 | Model / engine (as configured in the reference deployment)                            | 10.1.1 System?                              | Personal data it sees                                        | Live in prod?                                                                                                  | (iii) solely automated                                                                     | Notable evidence                                                                                                                                                                                                                                                                                    |
| ---- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S-2  | Text-to-speech of the agent's reply                                                                       | ElevenLabs `eleven_v4_turbo` (measured; code default `src/lib/config.ts:185`)         | yes                                         | the reply text, after egress sanitising (`policy.ts` item 7) | **yes** (key SET)                                                                                              | n/a — renders, never decides                                                               | consented voice identity required for cloned voices: `Voice.consentUrl`/`consentAt`, enforced with a 422 (`policy.ts` item 5)                                                                                                                                                                       |
| S-3  | Speech-to-text of the caller                                                                              | ElevenLabs `scribe_v2` (`src/lib/config.ts:188`), Deepgram `nova-2` fallback (`:495`) | yes                                         | the caller's **voice** and words                             | **yes** (both keys SET)                                                                                        | n/a                                                                                        | see §4 on whether voice here is biometric data                                                                                                                                                                                                                                                      |
| S-4  | Reply-drafting LLM, rung 1                                                                                | Groq `qwen/qwen3.8-27b` (measured; `src/lib/config.ts:249`)                           | yes                                         | redacted turn text                                           | **yes** (key SET)                                                                                              | no — output is wording only (`llm.ts:724`)                                                 | a 27B **multimodal (vision+text), thinking/instruct-mode** model per the vendor's model card. Vision capability is relevant to 10.3.2(a): the contract must state that no image input is ever sent. `OPEN` — nothing in the code proves the modality is unused beyond the absence of an image path. |
| S-5  | Reply-drafting LLM, rung 2                                                                                | Gemini `gemini-1.5-flash` (`src/lib/config.ts:270`)                                   | would be                                    | —                                                            | **no — `GEMINI_API_KEY` UNSET** (measured)                                                                     | —                                                                                          | The rung cannot answer today. Two consequences: the ladder's documented failover is shorter than the code reads, and Google's own deprecations page lists 1.5-era flash variants as retired, so the _default identifier itself_ needs re-validation before it is ever enabled. `OPEN`.              |
| S-6  | Self-hosted proxy rung                                                                                    | LiteLLM, `llama-3.3-70b-instruct` (`src/lib/config.ts:300`)                           | would be                                    | —                                                            | **no** — service is profile-gated (`docker-compose.yml` `profiles: ["llm-proxy"]`) and `LITELLM_API_KEY` UNSET | —                                                                                          | the only rung whose data stays inside the deployment's boundary; that is its reason for existing                                                                                                                                                                                                    |
| S-7  | Semantic reply cache                                                                                      | embeddings + intent-keyed cache, `src/lib/voice/semantic-cache.ts`                    | yes                                         | intent label + cached phrasing                               | yes (code path)                                                                                                | no — it refuses on a mislabelled intent rather than trusting one (`semantic-cache.ts:534`) | a cache keyed by intent cannot promote an unverified intent; that refusal is the control                                                                                                                                                                                                            |
| S-8  | Transcript embedding index                                                                                | `llama-text-embed-v2` (`src/lib/config.ts:826`), Pinecone                             | yes                                         | transcript-derived vectors                                   | **yes** (`PINECONE_API_KEY` SET)                                                                               | n/a                                                                                        | deletion reaches the index (`crypto-shred.ts:78`)                                                                                                                                                                                                                                                   |
| S-9  | Scripted reply fallback                                                                                   | deterministic templates                                                               | no — not autonomous                         | turn text                                                    | yes                                                                                                            | n/a                                                                                        | the rung that keeps a call coherent when no model answers; it is the answer to "what happens when S-4/S-5 are both down", and it is why a missing key is a degradation, not an outage                                                                                                               |
| S-10 | Decision layer: policy gate, abuse tiers, geo, terminology, speech gate, prayer-times, case state machine | —                                                                                     | **no.** Deterministic, human-authored rules | case data                                                    | yes                                                                                                            | it _is_ the human-defined constraint required by 10.3.2(a)                                 | `src/lib/policy-gate.ts`, `src/lib/abuse/*`, `src/lib/compliance/*`, `src/lib/case-state-machine.ts`                                                                                                                                                                                                |

**One boundary deserves its own sentence, because it changes what this register has to disclose.**
Four intents — `deny_fraud`, `confirm_authorized`, `doubt`, `handoff` — are `SCRIPTED_ONLY`
(`src/lib/llm.ts:58-62`), and the reply drafter returns before touching any provider for them
(`src/lib/llm.ts:590`). The code states the reason itself, and it is the Reg 10 argument in one line:
_"COMMITMENT SENTENCES ARE NEVER REPHRASED… The scripted lines were written and reviewed to be
exactly true; a model 'improving' them is how a demo ends up telling a fraud victim their card is
frozen when only a human can freeze it"_ (`src/lib/llm.ts:583-589`). So **the sentences that commit
this platform are never generated by a third-party model and never leave the deployment's boundary**;
S-4 and S-5 see only the low-stakes turns the comment names — greeting and clarifying question. That
is both the strongest Regulation 10.3.2(a) fact in this document, since the System cannot drift into a
commitment the script does not authorise, and the data-minimisation answer a bank's security reviewer
actually takes seriously.

`RAG_EMBEDDING_MODEL` defaults to `text-embedding-3-small` (`src/lib/config.ts:846`) — an OpenAI identifier —
while `OPENAI_API_KEY` is UNSET in production and the codebase's stated position is no OpenAI on the
voice path. Recorded as **declared-but-inert**, and it is exactly the kind of stray identifier a
reviewer mistakes for a processor. Delete it or document it; leaving it is the worst of the three.

---

## 3. The notice required by Regulation 10.2.2(a) and (b)

10.2.2(a) requires a notice, in clear and explicit terms, on initial use or access, alerting users to
the underlying technology that may process personal data **not human-initiated, controlled or
directed**, and indicating the impact on individual rights (Art 29(1)(h)(ix)).
10.2.2(b) requires that notice to include a "comprehensive, true and plain description" of five things.
The table is that list, with what exists and what does not.

| 10.2.2(b) | Required                                                                                                                                                                                                      | What exists                                                                                                                                                                                                                                                                           | Gap                                                                                                                                                                                                                            |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| (i)       | human-defined purposes for which the System processes personal data                                                                                                                                           | the opening disclosure in every call states the bank's identity, that the call is recorded, and that a PIN/password/OTP will never be asked (`policy.ts` item 1); the `/privacy` page describes the platform in plain terms (`src/views/Legal.tsx:204-208`)                           | a written, versioned **System notice** as such — the policy has a paragraph, not a notice with the five parts                                                                                                                  |
| (ii)      | the human-defined principles and limits within which the System may itself define further purposes                                                                                                            | **the System defines no purposes at all.** Its purposes are fixed in code: verify, and on a denial stage a hold and hand off. `src/lib/deck.ts:96` states it as the product's own limit: "the only write action in the agent's tool scope is the one that needs a human to finish it" | none on the substance; the statement needs a document, not a demo script                                                                                                                                                       |
| (iii)     | the output produced and how it is used                                                                                                                                                                        | a spoken turn, an intent label, a case-state transition, an audit row, and a bank webhook event (`src/lib/outbox.ts`); the output is used by the bank's fraud desk, never as a marketing signal                                                                                       | none material                                                                                                                                                                                                                  |
| (iv)      | the principles the System was designed to, including safeguards built in by design                                                                                                                            | §5 maps all of 10.3.1(a)-(e) to code                                                                                                                                                                                                                                                  | the _narrative_ is missing; the evidence is not                                                                                                                                                                                |
| (v)       | the codes/certifications the System follows — the Regulation names OECD, NIST AI RMF, UNESCO, Dubai Digital Authority, and the **CBUAE Guidelines for Financial Institutions adopting Enabling Technologies** | CBUAE consumer-protection and ElevenLabs Prohibited-Use reasoning is already embedded in `policy.ts` (items 1-7 name the clauses they answer); an OECD-derived framing is present in the architecture notes                                                                           | **no formal adoption statement exists**, and 10.2.2(b)(v) invites exactly this citation. Cheapest unclaimed win in the document: name CBUAE + NIST AI RMF + ISO/IEC 29134, and hold the mapping to the controls already built. |

**Not `OPEN` but worth stating plainly:** the `/privacy` notice does not mention the DIFC regime at all.
Measured 2026-10-18, `DIFC` appears **zero times** under `src/app` and `src/views`. For a DIFC-registered
Deployer/Operator this is the first thing a Commissioner's reviewer notices, and it is a copy fix, not
an engineering project.

---

## 4. Voice data and the biometric question

Schedule 1 of the Law makes Special Categories include "genetic data and **biometric data where it is
used for the purpose of uniquely identifying a natural person**" (`difc-law.txt:3057-3061`) — the
qualifier matters, and it is what makes this section answerable rather than hand-wringing.

**Determination: call audio in this product is not currently special-category biometric data**, because
nothing in it is used to identify a speaker. Evidence: a repository-wide search for
`voiceprint|speaker ident|speaker verif|voice_biometric` returns **zero matches** (verified 2026-10-18);
identity is established by the bank's own challenge questions from an approved question bank, verified
without being stored (`src/views/Legal.tsx:177`), and the fraud verdict comes from a keypad press (S-1
(iii)).

This is a **conditional** conclusion and it must be re-tested whenever any of the following changes —
each is a feature that would silently convert ordinary personal data into Special Categories and drag
Art 11's conditions in with it:

- speaker verification or "voice match" added to the identity step;
- a voiceprint anti-fraud signal supplied by a vendor (including anything ElevenLabs or Twilio adds on
  their side of a call);
- a cloned agent voice **of a real customer** rather than a licensed studio voice — today a cloned voice
  requires `consentUrl` + `consentAt` or the endpoint 422s (`policy.ts` item 5), which is the right
  control, and it must stay.

---

## 5. Design requirements, Regulation 10.3.1, mapped to code

10.3.1 requires the System to be _designed_ in accordance with five concepts. Guidance note 9 extends
the duty past developers to Deployers and Operators, so this is the Operator's evidence, not the
model vendor's.

| 10.3.1                                                                                                                                                                          | Requirement, in the Regulation's words                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Evidence in this codebase |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| (a) **Ethical** — "algorithmic decisions and the associated data lineage … should be unbiased and mitigated"                                                                    | data lineage is a hash chain every decision is written into (`src/lib/audit-chain.ts`); the decision itself is the caller's keypress, so there is no model to have a bias about in the verdict path (S-1 (iii))                                                                                                                                                                                                                                                                                                                                          |
| (b) **Fairness** — treat all individuals equally "regardless of race, gender, or other specifically subjective factors", avoid or mitigate unjust bias                          | the classifier and reply table are checked against a credential-extraction deny-list and refusals are audited (`policy.ts` item 3); red-teaming exercises the pressure cases (`src/lib/redteam/scenarios.ts`, `tests/redteam/redteam.test.ts`); language coverage is per-tenant, not per-person-typology. `OPEN`: **no demographic fairness measurement exists**, because no demographic field is collected — which is a deliberate minimisation, and also the reason a bias metric cannot be computed. State it that way rather than claiming a metric. |
| (c) **Transparent** — processing "explainable to Data Subjects and other stakeholders in non-technical terms, with appropriate supporting evidence"                             | the opening disclosure (item 1); plain-language scripts that never claim a freeze the platform cannot perform — the prompt forbids it outright: "NEVER say a card or account is frozen, blocked, cancelled or closed … only a human specialist confirms it" (`src/lib/llm.ts:725`); the caller-facing trust narrative is documented in `docs/TRUST-MODEL.md`                                                                                                                                                                                             |
| (d) **Secure** — keep personal data protected and prevent breaches causing "reputational, psychological, financial, professional or other types of harm"                        | envelope encryption with per-case keys, ciphertext bound to the case reference, egress sanitising, tenant-scoped object keys, presigned URLs treated as bearer credentials and never logged (`src/lib/storage/index.ts:46-52`), and the privacy gate green in CI (`evidence/privacy/privacy.json`)                                                                                                                                                                                                                                                       |
| (e) **Accountability** — mechanisms for "responsibility and accountability for … outcomes", including internal governance and the ability to assess algorithms, data and design | every action is attributable: operator identity in the audit row on a commit (`src/app/api/console/freeze/commit/route.ts:102`), 2FA-gated privileged actions, step-up before bulk export (`src/app/api/auth/export/route.ts:14`), and an append-only chain that fails loudly if a mutation breaks it (`src/lib/privacy/retention.ts:42`). `OPEN`: the _organisational_ half — a DPO/ASO, a review board, an audit cadence — does not exist. 10.3.1(e) names internal governance explicitly.                                                             |

**10.3.2** — a System may only be made available for commercial use if (a) it processes personal data
only for human-defined or human-approved purposes, or purposes it defines itself _solely_ on
human-defined principles within human-defined limits, and (b) it is designed per 10.3.1 and complies
with any audit/certification requirements the Commissioner establishes.
Limb (a) is satisfied by construction (§2 S-10: purposes are code; the model's only latitude is
wording; tool scope excludes anything irreversible). **Limb (b) is the open half**, and the
certification requirements do not exist yet — see §6.

---

## 6. High Risk Processing: 10.3.3, and the bar that is not an engineering problem

The full determination is in `docs/ROPA.md` §7. Short version: limb (a) of the Schedule's definition
(new technology that can make rights harder to exercise) and limb (d) (a Special Category field,
`hearing_impaired`) put this System on the boundary, and limb (c) — "systematic and extensive
evaluation … based on automated Processing … decisions … that produce legal effects … or similarly
significantly affect" — is the one a reviewer will press. The architecture answers limb (c) at its
weakest joint: the decision is never _solely_ automated (Art 38(1)), the hold is never executed by the
System, and a human commits it.

If High Risk is accepted — and the prudent planning assumption in these documents is that a bank
deployment **is** High Risk — Regulations 10.3.3 requires all four of:

| 10.3.3 | Requirement                                                                                                                       | State                                                                                                |
| ------ | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| (a)    | the Commissioner has established audit and certification requirements for Systems used in High Risk Processing                    | **not established.** Nothing in the repository evidences a promulgated DIFC AI certification scheme. |
| (b)    | the System complies with all such requirements                                                                                    | cannot be assessed before (a) exists; interim posture = the §5 mapping plus the DPIA                 |
| (c)    | the System processes personal data **solely for human-defined or human-approved purposes**                                        | satisfied by construction (§2 S-10) — this is the strongest of the four                              |
| (d)    | the Deployer or Operator has appointed an **Autonomous Systems Officer** with DPO-equivalent competencies and status (Arts 17-18) | **OPEN — none appointed**                                                                            |

Guidance footnote 11 to 10.3.3 is the sentence to read twice: _"it is the regulatory intent that no
System may be used for High Risk Processing Activities until the Commissioner has promulgated these
certification and other requirements."_

**That is a market-entry condition, not a code review.** It cannot be closed by writing more
guardrails, and it would be dishonest to imply otherwise in a pitch deck. What it does change is the
sequencing of commercial steps, and there are three defensible responses:

1. **Argue the categorisation.** Present §7.2 of the ROPA with the Art 38(3) point and the
   never-solely-automated architecture, and take the position that the processing is High Risk only on
   limb (a), mitigated — which does not by itself trip 10.3.3, because the limbs are alternatives to a
   _characterisation_, not to a _prohibition_. This needs counsel's signature, not ours.
2. **Move the Deployer.** A bank that deploys inside its own VPC becomes the Deployer and the deemed
   Controller; SecureVoice becomes Operator/Provider only. That re-allocates 10.3.3(a)-(b) duty to the
   regulated party that already has a CBUAE supervisory relationship — and the codebase already supports
   it as a deployment shape (§1, and `src/views/Legal.tsx:192`).
3. **Pilot outside the High Risk framing.** Inbound verification and SMS-first confirmation carry much
   of the value with less of the autonomous-decision character.

Whichever is chosen, the **ASO appointment (d) should happen now**: it is a person, it is cheap relative
to everything else on this list, it is required by 10.3.3(d) _and_ by Art 16(2)(b) if High Risk stands,
and its absence is visible in one question.

---

## 7. Two postures, because the reference deployment and a bank deployment are different Systems legally

|                                  | Reference deployment (`securevoiceai.me`)                                                                                                                        | A bank's deployment                                                      |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| SecureVoice's Reg 10 role        | **Provider + Deployer** → deemed **Controller** (10.3.4(a))                                                                                                      | **Provider + Operator** → deemed **Processor** (10.3.4(b))               |
| Data subjects                    | Company staff, demo visitors, pilot contacts — no real bank customers                                                                                            | the bank's customers                                                     |
| Whose lawful basis               | ours: Art 10(a) consent, 10(f) legitimate interests                                                                                                              | the bank's: Art 10(c)/(d), and Art 38(3) for the automated-decision limb |
| Whose DPIA / Art 21 consultation | ours                                                                                                                                                             | the bank's, with us supplying the §5 evidence                            |
| Whose rights channel             | ours — and it does not exist yet (`docs/ROPA.md` item 10)                                                                                                        | the bank's                                                               |
| Measured reality                 | live, healthy, near-zero traffic; **no object storage configured, so no call audio retained**; Twilio outbound configured with a `+256` origin number (measured) | no bank deployment exists yet                                            |

The `+256` origin number is worth a line in an AI-systems document because Reg 10.2.2(a) is a
notice-and-trust provision and the artifact the regulator or the called party actually sees is the
caller ID. An AI voice agent from a Ugandan number, calling on behalf of a Gulf bank, is the precise
shape of a vishing pattern — and it is the most probable explanation for a domain that keeps attracting
abuse reports. `OPEN`, owner action: provision a +971 / DIFC-attributable number or a registered
caller-ID, and record it here.

---

## 8. Evidence discipline

10.2.2(c), (d), (e) and (f) each require **evidence on request** — of audit/certification compliance,
of an algorithm that seeks human intervention where processing may cause unfair or discriminatory
impact, of one that does so where data must be handed to competent authorities, and of one that does
so where processing may breach Regulation 9 (collection and use of personal data in digital
communications and services). Regulation 10.2.2(h)'s closing paragraph permits redaction or summary to
protect IP, provided the full underlying information is produced to the Commissioner on request.

What can be produced today, mapped to the sub-paragraph that asks for it:

| Asks                                                         | Our answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Anchor                                                                                                                                       |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 10.2.2(d) human intervention on unfair/discriminatory impact | an uncertain case cannot self-resolve into a protective action — `FREEZE_STAGED` is entered **only** from `CONFIRMED_FRAUD` (`src/lib/case-state-machine.ts:64`, invariant I-2 at `:6-7`), and `UNCERTAIN`'s first legal edge is `ESCALATED` (`:66`); `9`→`request_human`, `*`→`cancel` (`src/lib/voice/dtmf.ts:150-153`); a staged hold that nobody commits **escalates on the worker's tick rather than resolving itself** (`src/lib/freeze-window.ts:12`, `src/lib/ai/ai-authz.ts:69`); warm transfer and human-handoff tools (`src/app/api/elevenlabs/tools/*`) | verified                                                                                                                                     |
| 10.2.2(e) human intervention before authority access         | `src/app/api/regulatory/export/route.ts` requires `requireOperator()` (`:8`); bulk export additionally requires `export:bulk` **and a fresh step-up** (`src/app/api/auth/export/route.ts:14`)                                                                                                                                                                                                                                                                                                                                                                       | verified                                                                                                                                     |
| 10.2.2(f) human intervention on Regulation 9 risk            | suppression is honoured at the data layer and never re-attempted (`SmsSuppression`, `DoNotCall`); no advertising trackers and no cross-site profiling cookies claimed (`src/views/Legal.tsx:176`) and consistent with the measured fact that **`POSTHOG_KEY` is UNSET in production**                                                                                                                                                                                                                                                                               | verified in part; `OPEN`: no automated cookie/consent scan asserts the no-trackers claim, so it is a promise the CI does not currently check |
| 10.2.2(c) audit/certification compliance                     | nothing to produce                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | **`OPEN` — and, per footnote 11, nothing exists to comply with yet (§6 (a))**                                                                |

`MODEL_CARD.md` is the closest thing in the repository to a System description a reviewer would accept
for 10.2.2(b)(iv), and it should be cited from this inventory rather than left beside it.

---

## 9. Actions this inventory creates

| #   | Action                                                                                                                  | Kind                    | Closes                                               |
| --- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------- | ---------------------------------------------------- |
| 1   | Appoint the ASO (and resolve the DPO question)                                                                          | owner decision, no code | Regs 10.3.3(d), Art 16(2)(b)                         |
| 2   | Get a written High-Risk characterisation from DIFC counsel, choosing among §6's three postures                          | legal                   | the sequencing of every commercial step              |
| 3   | Write the System notice with the five 10.2.2(b) parts, citing CBUAE + NIST AI RMF + ISO/IEC 29134 as adopted principles | document                | Regs 10.2.2(a), (b)(i)-(v)                           |
| 4   | Fix the `/privacy` regime gap: name the DIFC Law; re-examine the Irish-DPC lead-authority sentence                      | copy                    | Art 29-31; Regs 10.2.2(a)                            |
| 5   | Record an Article 11 condition for `hearing_impaired` on the intake contract and scope its retention to the case        | code + contract         | Art 11; `docs/ROPA.md` §7.3                          |
| 6   | Build a non-account-holder rights intake (Art 40 methods), or publish the bank-channel alternative as the formal answer | code + document         | Regs 10.2.2(g)(ii); Arts 33-35, 38(1), 40            |
| 7   | Provision an in-region / attributable caller ID                                                                         | owner, carrier          | Regs 10.2.2(a) trust; the abuse-report problem in §7 |
| 8   | Re-validate or remove the S-5 rung id and the stray OpenAI embedding default                                            | code                    | inventory accuracy (Reg 2.1's duty)                  |
| 9   | Add a CI check for the no-trackers claim, and a drift gate so this inventory cannot silently fall behind the schema     | code                    | Reg 2.1 accuracy; 10.2.2(f)                          |

---

## 10. Sources

Primary law text as in `docs/ROPA.md` §9 — the DIFC Data Protection Law No. 5 of 2020 and the Data
Protection Regulations (including Regulation 10, effective 1 September 2023) were downloaded as PDFs
and text-extracted on 2026-10-18, and every provision quoted here was read in that extraction
(`difc-regs.txt:612-935` for Regulation 10). The Commissioner's Regulation 10 and guidance pages
(<https://www.difc.com/business/registrars-and-commissioners/commissioner-of-data-protection/regulation-10>)
returned HTTP 429 when fetched and are therefore **not** relied on; no guidance text is quoted.

ISO/IEC 29134 (_Guidelines for privacy impact assessment_, <https://www.iso.org/standard/62289.html>) is
cited by name and scope only; the licensed text is not held. Vendor model identifiers were read from
`src/lib/config.ts` and the production environment, and the Groq model id was corroborated against the
vendor's published model list; **no vendor capability claim in §2 is taken from a model's memory of a
vendor's documentation.** Production facts are measurements from 2026-10-18, with credentials read as
presence and length only.
