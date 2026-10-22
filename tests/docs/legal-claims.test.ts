/**
 * Legal-page claims gate.
 *
 * These pages are what an institution's counsel reads, so a sentence there that
 * the code cannot perform is not a wording problem — it is a representation. Two
 * shipped examples this gate now pins:
 *
 *   1. The terms, the refund policy and their Arabic twins promised that unused
 *      credits expire 12 months after purchase. Nothing in the platform expires
 *      a credit: the wallet balance is the sum of append-only `UsageLedger` rows
 *      and the model has no expiry column, so an expiry would have to be a
 *      mutation the ledger exists to forbid.
 *   2. The retention paragraph listed the three deleting tiers without the
 *      evidence hold, while `src/lib/privacy/retention.ts` now refuses to age a
 *      locked row at any of them.
 *
 * Each test compares the published text against the source, and the source
 * against the text, so the claim cannot drift in either direction without a red
 * gate. No network, no database.
 *
 *   bun run test docs/legal-claims
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), "utf8");

const legal = read("src/views/Legal.tsx");
const refundPage = read("src/app/refund/page.tsx");
const security = read("src/views/Security.tsx");
const docsView = read("src/views/Docs.tsx");
const faq = read("src/views/Faq.tsx");
const schema = read("prisma/schema.prisma");
const retention = read("src/lib/privacy/retention.ts");
const evidenceHold = read("src/lib/privacy/evidence-hold.ts");
const twilio = read("src/lib/twilio.ts");
const submission = read("docs/SUBMISSION.md");
const pilot = read("docs/PILOT-READINESS.md");

/** Everything a customer or counsel can read about credits, in either language. */
const PUBLISHED = [legal, refundPage, security, docsView, faq].join("\n");

describe("published claims about credit expiry must match the ledger", () => {
  test("the ledger has nothing to expire a credit with", () => {
    const model = /model UsageLedger \{([\s\S]*?)\n\}/.exec(schema)?.[1] ?? "";
    expect(model.length).toBeGreaterThan(20);
    // The structural reason the claim was always false: a balance that is a sum of
    // immutable rows has no field a lapse could act on.
    expect(model).not.toMatch(/expir/i);
    expect(model).toMatch(/balanceAfter/);
  });

  test("no legal or product page promises that credits expire", () => {
    // Patterns for the AFFIRMATIVE claim that shipped, not the word "expire" —
    // the truthful sentence now says the opposite in both languages, and a gate
    // that bans a vocabulary word would ban the correction too.
    const offenders: string[] = [];
    const claimEn =
      /credits?[ _-]?(are )?(non-)?refundable and unused credits expir|expire[sd]? [0-9]+ months? (from|after) (the date of )?purchase|unused credits expir/i;
    const claimAr = /تنتهي صلاحيتها بعد [0-9٠-٩]+ ?شهر|تنتهي الأرصدة بعد/;
    for (const [name, text] of Object.entries({
      "src/views/Legal.tsx": legal,
      "src/app/refund/page.tsx": refundPage,
      "src/views/Security.tsx": security,
      "src/views/Docs.tsx": docsView,
      "src/views/Faq.tsx": faq,
    })) {
      for (const line of text.split(/\r?\n/)) {
        if (claimEn.test(line) || claimAr.test(line)) {
          offenders.push(`${name}: ${line.trim().slice(0, 110)}`);
        }
      }
    }
    expect(
      offenders,
      `a published page promises a credit expiry the code cannot perform:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  test("the wallet is still described truthfully about what it does not do", () => {
    expect(legal).toMatch(/do not expire on a clock/);
    expect(legal).toMatch(/non-refundable/);
    // The Arabic twin has to say the same thing, or the two legal texts for the
    // same jurisdiction disagree — the defect class this page has already had.
    expect(legal).toMatch(/فلا يُطبّق النظام مؤقّت انتهاء صلاحية على الرصيد/);
    // One credit funds one intervention signal is the shipping rate card; if the
    // text drifts from it, the pricing page and the ledger disagree.
    expect(legal).toMatch(/One credit funds one intervention signal/);
  });
});

describe("published retention text must match the sweeper", () => {
  test("the evidence hold exists in code, on every deleting tier", () => {
    expect(retention).toMatch(/EVIDENCE_RETENTION_DAYS/);
    // The three tiers are audio, transcripts, case records. A locked row must be
    // refused by each of them, so `isEvidenceLocked` has to appear in the shared
    // age predicate rather than in one tier's clause.
    const lockedClauses = retention.match(/isEvidenceLocked/g) ?? [];
    expect(lockedClauses.length).toBeGreaterThanOrEqual(3);
  });

  test("the legal page states the hold instead of only the three clocks", () => {
    expect(legal).toMatch(/flagged as evidence/i);
    expect(legal).toMatch(/5 years/);
  });

  test("the default hold is five years and is configurable", () => {
    // The default moved into the shared hold module so the erasure path can
    // re-check the same window; the gate follows the code.
    const m =
      /const raw = Number\(process\.env\.PRIVACY_EVIDENCE_RETENTION_DAYS\)[\s\S]{0,140}/.exec(
        evidenceHold,
      );
    expect(m?.[0]).toMatch(/5 \* 365/);
    expect(read(".env.example")).toMatch(/PRIVACY_EVIDENCE_RETENTION_DAYS/);
  });
});

describe("recording claims must match the wiring", () => {
  test("the Twilio plane requests a recording when storage exists", () => {
    expect(twilio).toMatch(/RecordingStatusCallback/);
    expect(twilio).toMatch(/TWILIO_RECORDING_CALLBACK_PATH/);
    expect(read("src/app/api/twilio/recording/route.ts")).toMatch(
      /X-Twilio-Signature|twilioSignedUrl/,
    );
  });

  test("no document still claims the media-stream plane has no recording path", () => {
    // That sentence was true when it was written and is false now: the callback is
    // wired, and what remains unproven is provider-side capture of the streamed
    // leg — which is a different, narrower claim.
    expect(PUBLISHED + submission + pilot).not.toMatch(/no recording path at all/);
    expect(submission.toLowerCase()).toMatch(
      /provider-side capture of a[\s\S]{0,40}media-stream leg[\s\S]{0,120}never been verified/,
    );
  });
});
