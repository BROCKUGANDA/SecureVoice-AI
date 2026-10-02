# Security questionnaire — pre-answered

**For:** the institution's information-security, risk and vendor-management
reviewers. Read 2026-10-02.

**The rule we hold ourselves to:** if the answer is "not yet", we say "not yet"
and give the date and the reason. A bluff here is worse than a gap, because a
gap is a project and a caught bluff is a termination. **Where we are early, we
have marked it early.**

---

## 1. Encryption

| # | Question | Answer |
| --- | --- | --- |
| 1.1 | Is data encrypted in transit? | **Yes.** TLS 1.3 at the edge (Caddy, Let's Encrypt), HSTS preloaded with a two-year max-age. No plaintext ingress. |
| 1.2 | Is data encrypted at rest? | **Yes.** AES-256 at rest for object storage. Database volumes rely on the host's encrypted-at-rest service; **a managed encrypted database is not yet in place — target Q1.** |
| 1.3 | Are database credentials encrypted? | **Yes.** Secrets live in the environment/secret store, never in code or images. BYOK customer keys are additionally encrypted **in application** with AES-256-GCM under a per-deployment key. |
| 1.4 | Who can decrypt? | Two roles only: the operator role for their own organisation, and break-glass via the platform owner. Every access is logged. |

## 2. Access control

| # | Question | Answer |
| --- | --- | --- |
| 2.1 | Is there public sign-up? | **No.** Invite-only. No self-service account creation exists on any surface, including the API. |
| 2.2 | How are users authenticated? | Clerk-hosted authentication with verified email, brute-force lockout and password policy. Sessions are server-side with an enforced idle timeout (15 min) and absolute lifetime (8 h). |
| 2.3 | Is authorisation enforced server-side? | **Yes, at the data-access layer**, not in route handlers or the UI. Organisation scoping is applied by a single enforcement point, not per-query by convention. |
| 2.4 | Roles | Owner, Admin, Analyst, Auditor (read-only). Role changes revoke sessions automatically. |
| 2.5 | Can two customers see each other's data? | Structurally no: cross-organisation isolation is enforced at the query layer and covered by an automated isolation test over every read path. **Not yet externally pen-tested — see §10.** |
| 2.6 | Is there step-up authentication for high-risk actions? | **Yes** for committing a freeze, rotating a producer key, changing a stored vendor credential, inviting an administrator, and bulk export. |

## 3. Logging and auditability

| # | Question | Answer |
| --- | --- | --- |
| 3.1 | Is there an audit trail? | **Yes, tamper-evident.** Every agent turn, delivery attempt and outcome is one row in a SHA-256 hash chain. Any edit breaks the chain and the built-in verifier names the exact row. |
| 3.2 | Can an administrator alter the trail? | Not without breaking verification. Rows are append-only at the application layer and the chain is verified end-to-end on read. |
| 3.3 | What is logged? | Case reference, action, actor, timestamp, org id, redacted transcript snippet. **No credentials, no secrets, no full card data.** |
| 3.4 | Are third-party logs redacted? | **Yes.** Cookies, `Authorization`, agent tool secrets and signature headers are redacted in the proxy logs, and query strings are never written. |

## 4. Data protection

| # | Question | Answer |
| --- | --- | --- |
| 4.1 | What personal data is processed? | See the minimisation list in the integration one-pager. The short answer: an alert reference, your customer token, a phone number, a language, an amount, a merchant, a risk score, a consent reference, and a transcript. |
| 4.2 | Do you process card data? | **No.** PAN never transits or is stored. Identifiers are tokens and last-4. PCI scope is **SAQ A**. |
| 4.3 | Where is data processed? | Application and database in the EU (Frankfurt). Speech synthesis/transcription in the US and UK. **In-VPC deployment available** for in-country processing. |
| 4.4 | Cross-border transfers? | Yes, to our named sub-processors under contract, with Standard Contractual Clauses where applicable. The full register is provided on request. |
| 4.5 | Can you delete my data? | **Yes.** Per-case crypto-shredding destroys the encryption key; the audit hash chain still verifies, so deletion is provable and the record of it is retained. |
| 4.6 | Is PII redacted automatically? | **Yes**, before persistence — in transcripts, audit rows and webhooks. |
| 4.7 | Do you use customer data to train models? | **No.** No customer audio or transcript is used for training, by us or by our processors. |

## 5. Application security

| # | Question | Answer |
| --- | --- | --- |
| 5.1 | Is there an LLM in the authorization path? | **No — and this is structurally enforced.** Intent classification and every protective action are deterministic server-side code. The model may only phrase a line that policy has already approved, and its output is scanned before it is spoken. |
| 5.2 | Can the agent be prompted into a high-stakes action? | **No.** Server tools validate a signed secret *and* a per-tool allow-list *and* the case state. A freeze attempt from an ambiguous answer is refused by the server with a typed 409, and the refusal is written to the audit chain. |
| 5.3 | Can the agent obtain credentials? | **No.** It never requests a PIN, OTP, CVV, password or full card number, and requests for one are refused by the policy layer and recorded. |
| 5.4 | Content Security Policy | Enforced, including `frame-ancestors 'none'`, `object-src 'none'`, `base-uri` and `form-action`. `unsafe-eval` is **excluded** from production builds. |
| 5.5 | Dependency scanning | **Yes** — automated dependency alerts run on every push. Two high-severity advisories are open as of this date and are being triaged. |
| 5.6 | Input validation | Strict schema validation on every endpoint, unknown fields rejected, no type coercion, bounded payload sizes enforced at the edge before buffering. |
| 5.7 | SSRF controls | Callback and outbound URLs are restricted to public HTTPS destinations; loopback, link-local and RFC-1918 addresses are refused. |
| 5.8 | Rate limiting | Applied at the edge (per client IP) and per endpoint, keyed on a proxy-resolved address rather than a client-supplied header. |

## 6. Telephony and carrier risk

| # | Question | Answer |
| --- | --- | --- |
| 6.1 | What stops someone using your platform to make calls to premium-rate numbers? | Destination allow-listing per organisation, a hard cap on the demo tier, per-destination cooldowns, concurrency caps, and **carrier-level geographic lock-down at the carrier console** — the control an application bug cannot bypass. |
| 6.2 | What stops a bot draining your voice quota? | Metered characters/seconds per organisation, a global kill switch reachable without a deploy, and spend ceilings with alerting. |
| 6.3 | Can you place calls to a customer who opted out? | **No.** Opt-out is honoured immediately and permanently for that account, across all channels. |

## 7. Infrastructure

| # | Question | Answer |
| --- | --- | --- |
| 7.1 | Deployment model | Containerised, single ingress behind a reverse proxy. The origin is reachable only from the proxy; every external surface terminates TLS at the edge. |
| 7.2 | Secrets management | Environment/secret store only. No secrets in source, images or repositories; `.env` is never tracked and excluded from build context. |
| 7.3 | Backup and recovery | Nightly database dumps retained 14 days, off-host copy recommended. **Recovery-time objective is untested — target Q1 for a documented and rehearsed restore.** |
| 7.4 | Disaster recovery | **Not yet documented as a tested plan — target Q1.** Single-region today; multi-region is roadmap, triggered by a second-country or residency requirement. |
| 7.5 | Patch management | Base images pinned per release, dependency alerts on every push, deployment is a `git pull` + rebuild. |

## 8. Sub-processors

| Processor | Purpose | Location |
| --- | --- | --- |
| Cloud infrastructure provider | Hosting | EU |
| Managed database provider | Primary datastore | EU |
| Clerk | Identity and session management | US/EU |
| Twilio | Outbound voice and SMS | US/global |
| ElevenLabs (+ Deepgram fallback) | Speech synthesis and transcription | US/UK |
| Groq or Google Gemini (optional) | Reply phrasing on the continuity path | US |

All under written contract, limited to the stated purpose. Register provided on
request; 30 days' notice before any change.

## 9. Incident response

| # | Question | Answer |
| --- | --- | --- |
| 9.1 | Is there an incident process? | **Partially — this is an early-stage company and we say so.** Detection, triage and a documented escalation path exist; a formal, tabletop-tested IRP is target Q1. |
| 9.2 | Breach notification | We notify the institution without undue delay and within 72 hours of confirmation, and support their regulatory notification obligations. |
| 9.3 | Contact for security reports | `otemaach@gmail.com`. Responsible disclosure is welcome; we acknowledge within one business day. |

## 10. Assurance — where we are genuinely early

| Item | Status |
| --- | --- |
| SOC 2 Type I / II | **Not started.** Trigger: first tier-1 or insurer procurement. Budget 3–6 months. |
| ISO 27001 | **Not started.** Same trigger. |
| External penetration test | **Not yet.** An independent test is scheduled; we will share the report under NDA. We do not claim one. |
| Continuous penetration testing | Roadmap. |
| Tabletop / breach drill | Target Q1. |

**We would rather hand you this table as-is than a page of ticks we cannot
substantiate.** The items above are the honest gap, and each has a trigger and a
plan rather than a promise.

---

## 11. Quick reference — the five things that matter most to a reviewer

1. **No model in the authorization path.** The model talks; deterministic code decides.
2. **A freeze is staged, never committed.** The agent requests; a second actor commits, and it is reversible.
3. **No PAN, ever.** SAQ A scope.
4. **Tamper-evident audit on every action**, verifiable end to end.
5. **Phase 0 requires nothing from you** — no credentials, no network access, no customer contact.