# DIFC / DFSA compliance map

**Status:** control map and gap register, not a legal opinion, certification or
authorisation.
**Entity:** SecureVoice Technologies FZ-LLC (DIFC), as recorded in
`docs/AI-INVENTORY.md`.
**Last reviewed:** 2026-10-20.
**Owners:** founder for entity actions; DIFC counsel for the High-Risk and
perimeter conclusions; DPO/ASO once appointed.

This document answers three separate questions that are often conflated:

1. What must SecureVoice do as a **DIFC-established data controller/processor**
   and provider/operator of an AI system?
2. What must a **DFSA Authorised Firm** do when it outsources fraud-intervention
   calling to SecureVoice, and what evidence must SecureVoice supply?
3. What may SecureVoice **claim publicly** today?

The short answer to (3): the platform has substantial technical and documentary
controls, but it is **not yet able to claim full DIFC compliance, DFSA
authorisation, or pilot clearance**. Several owner and counsel actions remain
open. They are listed below rather than hidden in marketing copy.

---

## 1. Two regulators, two different questions

| Regulator                                     | Scope                                                                                                                                               | What it means here                                                                                                                                                                                  |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **DIFC Commissioner of Data Protection**      | DIFC Data Protection Law No. 5 of 2020 and the DIFC Data Protection Regulations, including Regulation 10 for autonomous and semi-autonomous systems | Applies to the DIFC entity's processing. This is the data-protection regime that governs the privacy notice, ROPA, DPIA, DPO/ASO, notification, processor terms, transfers, rights and AI register. |
| **Dubai Financial Services Authority (DFSA)** | Financial Services carried on in or from the DIFC under the Regulatory Law 2004 and the DFSA Rulebook                                               | Applies directly only if SecureVoice carries on a regulated Financial Service. A DFSA Authorised Firm that buys the platform remains responsible for its outsourced functions and ICT providers.    |

**No DFSA licence or authorisation is claimed.** The repository contains no
evidence of one, and this document does not create one. Before any deck, data
room or contract says "DFSA-regulated", "DFSA-approved" or "DFSA-compliant",
replace it with the accurate statement: "SecureVoice is a DIFC-established
technology provider; DFSA obligations apply to the Authorised Firm customer."
Confirm the company's public-register status with DIFC/DFSA counsel.

---

## 2. DIFC Data Protection Law control map

Status meanings: **IMPLEMENTED** = enforced in code or runtime; **DOCUMENTED** =
written record exists; **PARTIAL** = some evidence, material gap remains;
**OPEN** = not evidenced and required before a production pilot; **CLIENT** =
the regulated customer owns the duty, with SecureVoice supplying evidence.

| #   | Obligation                                                                 | Current evidence                                                                                                              | Status                                       | What closes it                                                                                                                           |
| --- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Role mapping: Provider, Operator, Deployer; controller vs processor        | `docs/AI-INVENTORY.md` section 1; `docs/ROPA.md` Parts 1-2; privacy notice                                                    | DOCUMENTED                                   | Keep aligned when hosting model changes.                                                                                                 |
| 2   | Notification of processing operations, Art 14(7); Regulations 3.1.1, 3.2.1 | No filing in evidence                                                                                                         | **OPEN**                                     | File through the DIFC Client Portal; record date, fee and renewal owner.                                                                 |
| 3   | Record of processing, Art 15; Regulation 2.1                               | `docs/ROPA.md` with code/runtime citations                                                                                    | DOCUMENTED                                   | Refresh on any new processor, data class or purpose.                                                                                     |
| 4   | DPIA, Art 20(1)-(6); ISO/IEC 29134 method                                  | `docs/DPIA.md`                                                                                                                | DOCUMENTED; DPO oversight **OPEN**           | DPO (or allocated oversight owner) reviews and signs; re-run on material change.                                                         |
| 5   | High-Risk Processing characterisation, Art 16 / Regulation 10.3.3          | Three postures recorded; no written conclusion                                                                                | **OPEN**                                     | Written DIFC counsel conclusion adopting one posture with reasons.                                                                       |
| 6   | DPO appointment, Arts 16-19; ASO under Reg 10.3.3(d)                       | Roles and constraints documented; nobody appointed                                                                            | **OPEN**                                     | Appoint DPO and ASO (or record the legally supported alternative), with UAE residency/independence analysis and Annual Assessment owner. |
| 7   | Lawful basis, Arts 10-11                                                   | Bank establishes basis for intervention data; `hearing_impaired` health data lacks an Art 11 condition                        | **PARTIAL**                                  | Record the Art 11 condition on the intake contract or stop collecting the field; keep the bank's basis in the DPA.                       |
| 8   | Transparency, Arts 29-31; Regulation 10.2.2(a)-(b)                         | `/privacy` now names DIFC Law No. 5 of 2020 and the DIFC Commissioner; `docs/AI-INVENTORY.md` maps the Reg 10 notice contents | **PARTIAL**                                  | Publish the standalone System notice with all five 10.2.2(b) parts before live deployment.                                               |
| 9   | Data-subject rights, Arts 32-40                                            | Account holders routed through the bank; opt-out, stop-on-request and human handoff exist; no non-account-holder intake       | **PARTIAL**                                  | Publish and operate an Art 40 request channel, or formally adopt the bank-channel answer.                                                |
| 10  | Security and confidentiality, Arts 14, 23-25                               | TLS, encryption at rest, PII redaction, tenant scoping, strict schemas, signed webhooks, audit chain, rate limits             | IMPLEMENTED; no external attestation claimed | Complete the security questionnaire honestly; close open dependency advisories; schedule independent test.                               |
| 11  | Processor and sub-processor terms, Art 24                                  | DPA template and processor register exist; executed terms not in evidence for every processor                                 | **OPEN**                                     | Execute Art 24 terms with each active processor; record locations and subcontractor flow-down.                                           |
| 12  | Cross-border transfers, Arts 26-27                                         | EU hosting and named US/UK processors; no DIFC transfer assessment                                                            | **OPEN**                                     | Document the Art 26/27 route per recipient; stop relying on GDPR SCC language as the DIFC answer.                                        |
| 13  | Breach notification, Arts 41-42                                            | Incident process described as partial; no breach register                                                                     | **OPEN**                                     | Stand up a breach register with decision timers, owner and notification templates.                                                       |
| 14  | AI register and design duties, Regulation 10.2.2(g), 10.3.1-10.3.2         | `docs/AI-INVENTORY.md` registers S-1 to S-8 with evidence and `OPEN` cells                                                    | DOCUMENTED                                   | Keep the register current; close the `OPEN` cells that affect live deployment.                                                           |
| 15  | Automated decisions, Art 38                                                | Fraud verdict is the caller's keypad press; model only phrases replies; hold is staged; human commits                         | IMPLEMENTED                                  | Preserve invariant I-2 and the human-commit path; re-test on any workflow change.                                                        |
| 16  | Retention and erasure, Art 22                                              | Per-case crypto-shredding and retention workers exist; pilot-request deletion sweeper not evidenced                           | **PARTIAL**                                  | Add the sweeper; the published 24-month figure was withdrawn on 2026-10-20.                                                              |

Primary sources:

- DIFC Data Protection Law No. 5 of 2020:
  <https://www.difc.com/business/laws-and-regulations/legal-database/difc-laws/data-protection-law-difc-law-no-5-2020>
- Commissioner notification and fees:
  <https://www.difc.com/business/registrars-and-commissioners/commissioner-of-data-protection/notifications>
- Regulation 10 guidance:
  <https://www.difc.com/business/registrars-and-commissioners/commissioner-of-data-protection/regulation-10>
- Committed extracts and line-level citations: `docs/legal-source/difc-law.txt`,
  `docs/legal-source/difc-regs.txt`, exercised by
  `tests/surface/compliance-citations.test.ts`.

### 2.1 The High-Risk fork is the gating legal question

`docs/DPIA.md` and `docs/AI-INVENTORY.md` record the same fork:

- If the processing is **not** High Risk, the DPIA and ordinary accountability
  measures apply, and a DPO is not automatically mandatory.
- If it **is** High Risk, Regulation 10.3.3 adds a certification bar, makes a
  DPO mandatory even for a small entity, and requires an ASO. The Commissioner
  has not promulgated the certification requirements, so the repository treats
  this as a market-entry condition, not an engineering ticket.

Do not start Phase 1 live calls until counsel has signed one posture. The
technical guardrails do not decide a legal characterisation.

---

## 3. DFSA perimeter and outsourcing position

### 3.1 Perimeter test

The DFSA regulates Financial Services carried on in or from the DIFC. The
Regulatory Law 2004, Articles 41-42, prohibit carrying on a Financial Service
without authorisation, and GEN 2.2.2 lists the activities. The list includes
deposits, credit, dealing, arranging, advising, insurance, money services,
custody, fund administration and similar activities.

On the current product scope, SecureVoice:

- receives a risk signal from the institution's fraud engine;
- calls the institution's customer to verify a transaction;
- stages a reversible hold for the institution's human team to commit;
- reports the outcome and evidence back to the institution;
- does not approve or decline a transaction, move money, hold client assets,
  execute orders, effect or carry out insurance contracts, or make a credit
  decision.

That shape is consistent with a **technology provider to regulated firms**, not
a firm carrying on a Financial Service itself. The DFSA's own innovation guidance
recognises that a technology provider or a firm partnering with regulated firms
may not need a DFSA licence. This is a **working position, not a conclusion**:
counsel must confirm it against the final contract, marketing and any future
feature that exercises discretion over a customer's account or claim.

Reassess immediately if any of these change:

- SecureVoice commits a hold, blocks a card, approves a refund or claim, or
  otherwise executes a transaction;
- SecureVoice holds client money or client assets;
- SecureVoice decides creditworthiness, insurance eligibility or claims;
- SecureVoice markets or distributes a financial product under its own name;
- the deployment is described as a bank, insurer, money-services business or
  investment firm.

### 3.2 What the Authorised Firm remains responsible for

DFSA GEN 5.3.21 provides that an Authorised Person which outsources a function
or activity related to Financial Services is **not relieved of its regulatory
obligations** and remains responsible for compliance. The outsourced function is
deemed carried out by the Authorised Person itself, and it must perform due
diligence, supervise the provider, and deal with failures.

DFSA GEN 5.5.3 extends technology and cyber expectations to ICT services that may
affect Financial Services. The guidance expects regular verification of the
provider's security, not self-verification, and adequate controls over
subcontractors.

SecureVoice therefore supplies the evidence a bank needs, but cannot take over
the bank's regulatory accountability. The DFSA-facing control map is:

| DFSA-facing need                       | SecureVoice evidence                                                                                      | Status                                                                                       |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Due diligence on the provider          | Security questionnaire, architecture, sub-processor register, audit-chain design, contracts               | PARTIAL: no SOC 2, ISO 27001 or independent penetration test yet; the questionnaire says so. |
| Effective supervision and audit access | Operator console, `/api/console/audit`, regulatory export, `/api/readyz`                                  | IMPLEMENTED for platform evidence; contract must grant the bank audit/verification rights.   |
| Subcontractor transparency             | Sub-processor list and processing locations                                                               | PARTIAL: executed Art 24 terms OPEN.                                                         |
| ICT security and incident cooperation  | TLS, encryption, redaction, signed webhooks, rate limits, incident process                                | PARTIAL: formal tabletop-tested IRP and tested DR are not yet evidenced.                     |
| Exit, return and deletion              | Retention tiers, crypto-shredding, export; hosting can move to the bank's VPC                             | PARTIAL: written exit plan and tested restore still needed.                                  |
| Complaints handling                    | Bank remains the complaints owner; case evidence and audit export support it                              | CLIENT obligation; SecureVoice support channel exists.                                       |
| AML/CFT                                | Product does not perform customer due diligence, transaction monitoring or sanctions screening on its own | N/A on current scope; reassess before adding financial-crime decisioning.                    |
| Recordkeeping                          | Hash-chained audit, case retention, regulatory export                                                     | IMPLEMENTED; legal retention schedule must match the bank's rulebook obligations.            |

Primary sources:

- DFSA innovation / "do I need to be regulated":
  <https://www.dfsa.ae/innovation>
- DFSA GEN 5.3.21 (outsourcing responsibility):
  <https://dfsaen.thomsonreuters.com/rulebook/gen-5321>
- DFSA GEN 5.5.3 guidance (ICT and cyber risk):
  <https://dfsaen.thomsonreuters.com/rulebook/gen-553-guidance>

---

## 4. Claim discipline

Use these formulations in decks, the data room and procurement answers.

| Do say                                                                                                                 | Do not say                                              |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| "DIFC-established technology provider."                                                                                | "DFSA-regulated", "DFSA-approved", "DFSA-compliant".    |
| "Designed against DIFC Data Protection Law No. 5 of 2020; gaps are tracked in the compliance map."                     | "Fully DIFC compliant" or "all requirements met".       |
| "Human commits every irreversible action."                                                                             | "The AI freezes cards."                                 |
| "Shariah-aware terminology is opt-in; the institution's Shariah supervisory board approves product terms and scripts." | "Shariah-certified" or "fatwa-approved" by SecureVoice. |
| "Signed webhooks, idempotent ingest, strict schemas, audit chain."                                                     | "Bank-grade security" without the evidence list.        |
| "Pilot entry is gated by the readiness checklist."                                                                     | "Pilot-ready" as a blanket claim.                       |
| "No external SOC 2, ISO 27001 or penetration-test report is claimed."                                                  | Implying an attestation that does not exist.            |

---

## 5. Open actions and owners

| #   | Action                                                                                       | Owner                                           | Gate                                                                                        |
| --- | -------------------------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 1   | File DIFC Art 14(7) notification and record renewal date                                     | Founder                                         | Before any pilot data processing; confirm current status immediately.                       |
| 2   | Obtain written High-Risk characterisation from DIFC counsel                                  | Founder + counsel                               | Before Phase 1; blocks DPO/ASO shape and Reg 10 posture.                                    |
| 3   | Appoint DPO and ASO, or record the legally supported alternative                             | Founder                                         | Before Phase 1 if High Risk; otherwise document oversight allocation.                       |
| 4   | Record Art 11 condition for `hearing_impaired`, or stop collecting it                        | Founder + counsel + engineering                 | Before live intake.                                                                         |
| 5   | Execute Art 24 processor terms and SCCs with every active processor                          | Founder                                         | Before Phase 1; before any transfer of pilot data.                                          |
| 6   | Write the DIFC transfer assessment for each recipient location                               | Founder + counsel                               | Before cross-border pilot data.                                                             |
| 7   | Publish the Regulation 10.2.2 System notice with all five parts                              | Founder                                         | Before live deployment.                                                                     |
| 8   | Stand up the breach register and 72-hour decision path                                       | Founder                                         | Before Phase 1.                                                                             |
| 9   | Add the non-account-holder rights intake, or publish the bank-channel answer                 | Engineering + founder                           | Before live deployment.                                                                     |
| 10  | Add the pilot-request deletion sweeper and record retention operationally                    | Engineering                                     | Before the retention practice is described as automated.                                    |
| 11  | Obtain a written DFSA perimeter opinion                                                      | Founder + counsel                               | Before any DFSA-regulated customer contract or public regulatory claim.                     |
| 12  | Close security assurance gaps: dependency advisories, independent test, DR restore, tabletop | Engineering + founder                           | Before Phase 1; buyer due diligence.                                                        |
| 13  | Obtain Shariah supervisory board approval for terminology, scripts and disclosures           | Institution's SSB; SecureVoice supplies the map | Before enabling Shariah mode in a live pilot.                                               |
| 14  | Reconcile the recorded-call disclosure with the actual recording plane                       | Engineering + founder                           | Before live calls; either record on every plane or change the spoken disclosure and policy. |

---

## 6. What is already strong enough to show a reviewer

- The platform **cannot** move money, approve a transaction or commit an
  irreversible account action. The agent stages; a human commits.
- The fraud verdict is the caller's keypad press, not an LLM inference.
- PII is redacted before persistence and vendor egress; account identifiers are
  tokens.
- Ingest is HMAC-signed or producer-key authenticated, strict-schema and
  idempotent; outbound events are signed and retried.
- The audit chain is tamper-evident and exportable; tenant scoping is enforced in
  the data model and tool guard.
- The DPIA, ROPA, AI inventory, privacy notice and legal-source citations are
  versioned in the repository and checked by tests.
- The pilot can run in shadow mode without placing calls, and the platform can
  run with no audio recording at all.

Those are controls, not a certificate. The open actions above are what stand
between this control set and a defensible "pilot-ready" statement.
