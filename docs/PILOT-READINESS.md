# Pilot readiness gate

**Status:** internal go/no-go checklist. This is not a claim that a pilot is
approved.
**Last reviewed:** 2026-10-20.
**Applies to:** any bank, insurer/Takaful operator, agency or other institution
using the platform with real customer data or real outbound calls.

The platform is technically capable of a **shadow pilot on an approved
pseudonymised dataset** once the Phase 0 gates below are closed. It cannot be called
"pilot-ready" for live customer contact until the Phase 1 gates are closed and signed.

---

## 1. Readiness at a glance

| Area                   | State         | Why                                                                                                                                         |
| ---------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Core intervention flow | READY         | Signed, idempotent ingest; durable queue; guardrailed agent; human-commit hold; signed outbound events; audit chain.                        |
| Shadow pilot           | CONDITIONAL   | Requires signed DPA, approved pseudonymised dataset, DPIA addendum and the Phase 0 gates.                                                   |
| Live pilot             | **NOT READY** | DIFC notification, High-Risk conclusion, DPO/ASO, Art 11, processor terms, transfers and caller-ID supply remain open.                      |
| Self-serve onboarding  | NOT READY     | An operator still creates the org and issues the first producer key.                                                                        |
| Security assurance     | PARTIAL       | Strong application controls; no SOC 2, ISO 27001 or independent penetration-test report is claimed.                                         |
| Data protection        | PARTIAL       | DPIA, ROPA and AI inventory exist; the open items in `docs/DIFC-DFSA-COMPLIANCE.md` are gating.                                             |
| DFSA perimeter         | OPEN          | Working position is technology provider, not a regulated Financial Service. Counsel must confirm in writing.                                |
| Shariah mode           | CONDITIONAL   | Terminology map is implemented and opt-in; the institution's Shariah supervisory board must approve scripts, product terms and disclosures. |

---

## 1a. Assurance, governance and contractual status

**The honest summary, in one place.** Everything below is a gap unless the row
says otherwise, and a gap that is only written down in a checklist is a gap
nobody is tracking. Each row names the document that holds the detail and the
sign-off that closes it.

### Security assurance

| Item                         | State                    | Detail                                                                                              | Closes when                                                       |
| ---------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| SOC 2 Type I / II            | **NOT STARTED**          | Not claimed anywhere. Trigger is the first tier-1 or insurer procurement.                           | Bank accepts the roadmap, or the engagement completes.            |
| ISO 27001                    | **NOT STARTED**          | Not claimed anywhere. Same trigger.                                                                 | Same.                                                             |
| Independent penetration test | **NOT DONE**             | No report, no attestation, no "we have been tested".                                                | An independent tester has run and the report is shared under NDA. |
| Open dependency advisories   | **OPEN**                 | Automated dependency alerts run on every push; high-severity advisories are open and being triaged. | No unresolved critical/high finding on an internet-facing path.   |
| Disaster recovery / restore  | **DOCUMENTED, UNTESTED** | Backups and a restore procedure exist. **A restore has never been performed and timed.**            | A restore is run, timed, and evidenced.                           |
| Tabletop incident exercise   | **NOT DONE**             | No rehearsal has taken place.                                                                       | A tabletop is run and the actions tracked to completion.          |
| Security questionnaire       | **PRE-ANSWERED**         | `docs/SECURITY-QUESTIONNAIRE.md` — including its own gaps section.                                  | Reviewed with the bank's security team.                           |

**The Phase 1 rule, stated plainly:** Phase 1 requires an **independent
penetration test to be complete** — or the **bank to accept a documented risk
exception with a named risk sign-off**. Both, or neither, is not an option. A
risk exception is a decision by the bank's risk function, recorded in writing
with a name against it; it is not something SecureVoice can grant itself, and
it is not a substitute for a test we then describe as if it had happened.

### Data protection

| Item                             | State    | Detail                                                                       | Closes when                                           |
| -------------------------------- | -------- | ---------------------------------------------------------------------------- | ----------------------------------------------------- |
| ROPA                             | **DONE** | `docs/ROPA.md` — DIFC Article 15 record.                                     | Reviewed with the institution's DPO.                  |
| DPIA                             | **DONE** | `docs/DPIA.md` — DIFC Article 20 assessment.                                 | Accepted; a pilot addendum covers the pilot dataset.  |
| AI inventory                     | **DONE** | `docs/AI-INVENTORY.md` — Regulation 10 register.                             | Reviewed with the institution's risk function.        |
| High-Risk characterisation       | **OPEN** | No written characterisation from DIFC counsel.                               | Counsel opines in writing.                            |
| DPO and ASO                      | **OPEN** | Not appointed, and no legally supported alternative is recorded.             | Appointed, or the alternative is recorded in writing. |
| Art 14(7) notification           | **OPEN** | Not filed.                                                                   | Filed, with a renewal owner and a date.               |
| Art 24 processor terms           | **OPEN** | Not executed with any active processor.                                      | Signed with every active processor.                   |
| Transfer assessment              | **OPEN** | Not done per recipient location.                                             | A transfer assessment exists for every recipient.     |
| Art 11 condition                 | **OPEN** | `hearing_impaired` is a special-category field and no condition is recorded. | The condition is recorded, or the field is disabled.  |
| Non-account-holder rights intake | **OPEN** | Not published.                                                               | Published, or the bank-channel answer is adopted.     |

Detail and the full action list: `docs/DIFC-DFSA-COMPLIANCE.md`.

### Shariah

| Item                           | State                  | Detail                                                                                                                                                                                                               | Closes when                            |
| ------------------------------ | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Opt-in                         | **DONE**               | The tenant's own declaration decides, per institution. It is a language control, not a paid tier, and it is not a certification.                                                                                     | —                                      |
| Shariah supervisory board gate | **OPEN / CONDITIONAL** | SecureVoice does **not** issue a fatwa or a certification. The institution's SSB must approve the terminology map, the scripts, the product terms and the spoken disclosures before any Shariah-mode call is placed. | The SSB's written approval is on file. |

### Operational readiness

| Item              | State        | Detail                                                                                                                                                                                                    | Closes when                                                            |
| ----------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Runbook           | **DONE**     | `docs/RUNBOOK.md` — dependency failures, triage endpoints, rollback, kill switches.                                                                                                                       | Reviewed with the bank's operations lead.                              |
| Kill switch       | **DONE**     | Two halves. `DIAL_KILL_SWITCH` (environment) and an operator switch in the database, read by every dial worker within seconds — `POST /api/console/pilot/kill-switch`, no deploy and no shell on the box. | Tested end to end, including the provider side.                        |
| Rollback          | **DONE**     | `docs/RUNBOOK.md` §4, plus the blue/green colour flip in `scripts/deploy.mjs`.                                                                                                                            | Tested for the app, the workers, the schema and the provider config.   |
| Incident response | **PARTIAL**  | A documented plan and an escalation path exist; **no tabletop has been run**.                                                                                                                             | A tabletop is run and the actions tracked.                             |
| On-call rota      | **TO AGREE** | Not agreed with the institution.                                                                                                                                                                          | Named rota, coverage hours and a number agreed in the pilot agreement. |
| Named pilot owner | **TO AGREE** | Not named in any document yet.                                                                                                                                                                            | A named individual on both sides, with contact details.                |
| Support hours     | **TO AGREE** | Not agreed.                                                                                                                                                                                               | Written into the pilot agreement: hours, channels and response times.  |
| Escalation path   | **TO AGREE** | The platform's path is documented (`docs/PILOT-READINESS.md` §6); the institution's is not agreed.                                                                                                        | Both paths written into the pilot agreement.                           |

**"TO AGREE" means exactly that.** These are not items we forgot to write down
and not items we will resolve unilaterally; they are decisions the institution
and SecureVoice make together, and until they are made the live pilot has
nobody to call.

### Contractual

| Item                          | State    | Detail                                                                                                     | Closes when                                |
| ----------------------------- | -------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| MSA                           | **OPEN** | Not executed. Liability, indemnity, insurance, service levels and termination assistance are all unagreed. | Signed.                                    |
| DPA                           | **OPEN** | Not executed. Controller/processor roles, purposes, retention, deletion and transfers are unagreed.        | Signed.                                    |
| LOI / pilot agreement         | **OPEN** | A **template** exists — `docs/LOI-TEMPLATE.md` — and it is unsigned. A template is not an agreement.       | Signed by both parties.                    |
| Sub-processor list            | **DONE** | Published in `docs/SECURITY-QUESTIONNAIRE.md` §8, with 30 days' notice of change.                          | —                                          |
| Security pack / evidence pack | **DONE** | `docs/PILOT-READINESS.md` §8 lists every document to hand over.                                            | Reviewed with the bank's procurement team. |

---

## 2. Phase 0 gate - shadow only

Phase 0 places no calls and touches no customer. It still processes
pseudonymised personal data, so it is not a compliance-free zone.

### Required before the first dataset is accepted

- [ ] Signed MSA/DPA or pilot agreement naming the controller, processor,
      purposes, retention and deletion.
- [ ] Approved pseudonymisation specification. Direct identifiers removed or
      replaced; no account numbers, PANs, credentials or free-text customer
      notes unless specifically agreed.
- [ ] Special-category fields excluded unless the Art 11 condition for
      `hearing_impaired` is closed. If the dataset includes them, stop.
- [ ] DPIA addendum covering the pilot dataset and the shadow workflow.
- [ ] DIFC Art 14(7) notification status confirmed in writing, or counsel's
      written advice that the pilot can proceed while it is filed.
- [ ] Named data-protection contact (DPO if appointed, otherwise the allocated
      oversight owner) and named security contact.
- [ ] Processor terms and transfer route confirmed for every recipient that will
      see the data. If they are not signed, the data does not leave the agreed
      environment.
- [ ] Access limited to named personnel; no production customer data; no live
      telephony credentials in the shadow environment.
- [ ] Retention and deletion date written into the pilot schedule.
- [ ] Success metrics and the holdout/control method agreed before analysis.
- [ ] Bank-side data-protection and fraud-ops approval recorded.

### Phase 0 deliverables

- Decision and script for every alert in the agreed sample.
- A readout separating contained, not contained and indeterminate cases.
- A limitations section: sample bias, missing outcomes, false-positive
  friction, and anything the shadow run could not observe.
- A written recommendation: proceed to Phase 1, revise, or stop.

### Phase 0 stop conditions

Stop and escalate on any of:

- unexpected direct identifier or special-category data in the dataset;
- a recipient receiving data without a signed term or approved transfer route;
- a request from the institution's DPO or risk function to pause;
- any indication that the dataset is being used to train a model or improve a
  vendor model outside the agreed purpose.

---

## 3. Phase 1 gate - limited live calls

Phase 1 is one alert type, an opt-in cohort, a hard daily call cap, human
approval of every dial, and a kill switch held by the institution. It starts
only when every item below is closed or has a written, owner-signed exception.

### Legal and data protection

- [ ] Written High-Risk characterisation from DIFC counsel.
- [ ] DPO and ASO appointed, or the legally supported alternative recorded.
- [ ] DIFC Art 14(7) notification filed; renewal owner and date recorded.
- [ ] Art 11 condition recorded for `hearing_impaired`, or the field disabled.
- [ ] Executed Art 24 processor terms with every active processor.
- [ ] DIFC transfer assessment for every recipient location.
- [ ] Regulation 10.2.2 System notice published with all five parts.
- [ ] Non-account-holder rights intake published, or the bank-channel answer
      formally adopted.
- [ ] Breach register and notification decision path live.
- [ ] DFSA perimeter opinion in writing; contract accurately describes the
      company as a technology provider.
- [ ] Bank's own outsourcing, DPIA and procurement approvals complete.

### Security and operations

- [ ] `bun run verify` green on the exact release commit, or a written
      exception approved by the pilot owner and the bank's security reviewer.
- [ ] The committed gate status is stated accurately. A prior run recorded
      `load` and `surface` red; do not describe the suite as "all green" until
      it is.
- [ ] Independent penetration test complete, or the bank accepts a documented
      risk exception. No attestation is implied.
- [ ] Open dependency advisories triaged; no unresolved critical/high finding
      on an internet-facing path.
- [ ] Restore from backup tested, not just documented.
- [ ] Incident response tabletop complete; on-call rota, escalation and
      regulator/bank notification path agreed.
- [ ] Kill switch tested end to end, including provider-side stop.
- [ ] Rollback plan tested for the app, workers, schema and provider config.
- [ ] `/api/health` and `/api/readyz` monitored; alerts routed to a named human.
- [ ] Tenant isolation and producer-key revocation re-tested on the pilot
      deployment.

### Telephony and recording

- [ ] Caller ID is owned or attributable to the institution, carrier-verified,
      and not a shared or foreign number. The current UAE-number gap is a hard
      blocker for a UAE pilot.
- [ ] Recording decision recorded per tenant. Default is no recording; the
      media-stream plane has no recording path today. Audio retention is only
      claimed where the recording plane and object storage are configured.
- [ ] Recorded-call disclosure reconciled with the actual recording plane:
      either record on every live plane, or change the spoken disclosure and the
      privacy policy. The current disclosure says the call is recorded.
- [ ] Disclosure, opt-out, do-not-call, calling-window and prayer-window rules
      tested with the pilot's language set.
- [ ] SMS fallback and unreachable-customer path tested; no SMS contains a
      merchant, amount or credential ask.

### AI and Shariah

- [ ] Model and prompt versions pinned; provider preview models replaced with
      production-tier identifiers.
- [ ] Tool allow-list minimised for the pilot; per-tool secrets tracked as a
      known gap.
- [ ] Human-commit invariant re-tested: no path from an uncertain case to a
      committed hold.
- [ ] If Shariah mode is enabled: the institution's Shariah supervisory board
      approves the terminology map, scripts, product terms and disclosures.
      SecureVoice does not issue a fatwa or certification.

### Commercial and governance

- [ ] Named institution, named executive sponsor, named fraud-ops owner and
      named data-protection contact.
- [ ] Signed MSA/DPA and order form; liability, indemnity, insurance, service
      levels and termination assistance agreed.
- [ ] Pilot charter: scope, alert type, cohort, daily cap, control group,
      duration, success metrics and stop conditions.
- [ ] Data-retention schedule per data class signed by both parties.
- [ ] Exit plan: data return, deletion, key destruction, audit export and
      transition assistance.

---

## 4. Live pilot operating rules

1. **Human approval per dial.** No auto-dial in Phase 1, regardless of the
   institution's fraud-engine confidence.
2. **No irreversible action by the agent.** The only protective write is a
   reversible, staged hold. The institution's human commits it.
3. **One alert type.** Do not expand scope mid-pilot without a change record
   and a new go/no-go.
4. **Hard cap.** The daily intervention cap and concurrency cap are enforced in
   config, not in a spreadsheet. The unit is the INTERVENTION — one case —
   and it counts the cases this organisation has **admitted today or acted on
   today** (a case admitted yesterday and dialled today counts today). It is
   not a count of calls placed: a case still waiting for a human is already
   against the cap, because it is volume the pilot has committed to.
5. **Kill switch.** The institution can stop outbound calls immediately; the
   switch is tested before the first dial.
6. **Daily review.** Contact rate, containment, false-positive friction,
   complaints, opt-outs, incidents and latency are reviewed daily.
7. **Control group.** Agreed before the first call. It cannot be retrofitted.
8. **No silent model changes.** Prompt, model or tool changes during the pilot
   require a change record and re-test.

### Stop conditions

Pause the pilot and escalate on:

- a privacy or security incident;
- a misdial or wrong-tenant call;
- a complaint spike or regulator contact;
- a containment result worse than the control group at the agreed interim
  checkpoint;
- a provider outage that affects disclosure, verification or audit;
- any attempt to use the platform outside the agreed scope;
- a request from the institution's DPO, risk owner or the pilot sponsor.

---

## 5. Metrics and evidence

| Metric                   | Definition                                          | Source                                                            |
| ------------------------ | --------------------------------------------------- | ----------------------------------------------------------------- |
| Contact rate             | answered / dialled                                  | telecom outbox + case timeline                                    |
| Time to contact          | alert fired to customer on the line                 | telephony + case timestamps; do not substitute dial acceptance    |
| Containment rate         | fraud stopped / fraud attempted, treated vs control | institution's case outcome, reconciled                            |
| False-positive friction  | legitimate customers called unnecessarily           | institution's disposition data                                    |
| Deflection               | cases resolved without a human agent                | case state + console                                              |
| Opt-out / complaint rate | per 1,000 calls                                     | suppression + support records                                     |
| Incident rate            | security, privacy, misdial, provider                | incident register                                                 |
| Latency                  | ingest, dial leg, tool leg, staged hold             | `evidence/latency/slo.json`; state the measured leg, not a target |

Do not publish "time to contact" from the dial-acceptance span. The repository
does not yet measure ring, answer or first word.

---

## 6. RACI

| Decision            | Accountable                               | Consulted                                               | Informed               |
| ------------------- | ----------------------------------------- | ------------------------------------------------------- | ---------------------- |
| Proceed to Phase 0  | Founder / pilot lead                      | Bank data-protection and fraud owner                    | Bank sponsor           |
| Proceed to Phase 1  | Founder / pilot lead                      | DIFC counsel, DPO/ASO, bank risk and DPO, security lead | Bank sponsor           |
| Enable Shariah mode | Bank's Shariah supervisory board          | SecureVoice product and compliance                      | Pilot team             |
| Pause or stop       | Bank pilot sponsor or SecureVoice founder | DPO, security, fraud ops                                | All pilot stakeholders |
| Change scope        | Founder and bank sponsor                  | DPO, security, fraud ops                                | Delivery team          |
| Security exception  | Founder and bank security reviewer        | Engineering                                             | Pilot team             |

Roles that must be named before Phase 1: pilot lead, security owner, data
protection owner, incident commander, bank fraud-ops owner, bank data-protection
owner and executive sponsor.

---

## 7. Evidence pack for the institution

Give the buyer the documents, not a verbal assurance:

- `docs/DIFC-DFSA-COMPLIANCE.md` - regulatory map and open actions.
- `docs/DPIA.md` - DIFC Article 20 assessment.
- `docs/ROPA.md` - Article 15 record.
- `docs/AI-INVENTORY.md` - Regulation 10 register.
- `docs/SECURITY-QUESTIONNAIRE.md` - security answers, including the gaps.
- `docs/INTEGRATION-CONTRACT.md` - API and webhook contract.
- `docs/INTEGRATION.md` and `docs/INTEGRATION-MATRIX.md` - connection paths.
- `docs/TRUST-MODEL.md` - caller-ID and trust design.
- `docs/SUBMISSION.md` - product and evidence narrative.
- `/openapi` and `/asyncapi` - generated machine-readable contracts.
- `evidence/INDEX.md` - measured versus targeted claims.

---

## 8. What this document does not claim

- It does not claim DIFC compliance, DFSA authorisation or a passed audit.
- It does not claim SOC 2, ISO 27001, a penetration test or a tested DR plan.
- It does not claim a Shariah certification or fatwa.
- It does not claim a live pilot is approved. The unchecked boxes are the work.
