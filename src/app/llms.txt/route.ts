import { NextResponse } from "next/server";
import { INDEXABLE_PATHS } from "@/app/sitemap";
import { COMPANY, PLANS, PRICE_CURRENCY } from "@/lib/commercial";
import { env, slaSeconds } from "@/lib/config";
import { DEFAULT_RETENTION_DAYS } from "@/lib/privacy/retention";
import { SUPPORT_EMAIL } from "@/lib/public-config";
import { siteOrigin } from "@/lib/site-origin";

export const dynamic = "force-dynamic";

/**
 * GET /llms.txt — the plain-text brief for an AI answer engine.
 *
 * ## Why this file exists at all
 *
 * An answer engine decides what to cite from a handful of kilobytes of text it can
 * fetch and parse without a browser. The homepage is ~107 KB of styled React; the
 * sitemap is XML built for a crawler's queue, not for a reader. `llms.txt` is the
 * convention for the third thing: a short, factual index of what the product is,
 * where each claim lives, and which machine-readable contracts back it up.
 *
 * It is not a marketing page. Every line is either a URL that resolves or a
 * property the code enforces — because an engine that quotes a sentence and cannot
 * find it on the cited page stops citing the site.
 *
 * ## Why the links are derived rather than typed
 *
 * They come from `INDEXABLE_PATHS` in `src/app/sitemap.ts`, the same list
 * `src/proxy.ts` stamps `X-Robots-Tag` against and `src/app/robots.ts` refuses to
 * disallow. A hand-written copy drifts the first time a route is added, and the
 * drifted copy is the one a crawler reads: a link to a path that answers `noindex`
 * is worse than no link.
 *
 * The pricing lines come from `PLANS` in `src/lib/commercial.ts`, the single source
 * the pricing page, the checkout and the JSON-LD already read. The numbers a search
 * engine quotes are then the numbers a customer is charged.
 */

/**
 * A duration in the unit that reads naturally, from the value the code enforces.
 *
 * This file's own contract is that every line is "a property the code enforces".
 * Until now the two durations were typed in: the audio/transcript days duplicated
 * `DEFAULT_RETENTION_DAYS`, and "a 24-hour hold" sat next to a reversal window the
 * server had defaulted to 300 seconds. An operator changing either setting would
 * change the behaviour and leave the sentence — which is the one an answer engine
 * quotes and a compliance reviewer cites back. The helper is the cheap half of the
 * fix; `tests/surface/llms-txt.test.ts` asserting the numbers against the sources
 * is the half that cannot be forgotten later.
 */
function durationPhrase(secs: number): string {
  if (secs % 3600 === 0) {
    const h = secs / 3600;
    return `${h} hour${h === 1 ? "" : "s"}`;
  }
  if (secs % 60 === 0) {
    const m = secs / 60;
    return `${m} minute${m === 1 ? "" : "s"}`;
  }
  return `${secs} seconds`;
}

/** One-line description of each indexable path, for a reader with no context. */
const PURPOSE: Record<string, string> = {
  "/": "Product overview: real-time phone-based fraud intervention for banks and insurers in the UAE and Gulf markets.",
  "/pricing": "Plans, included volume, per-call overage — the same figures the checkout uses.",
  "/faq":
    "Frequently asked questions: pricing, VAT and Merchant of Record, whether the agent can ask for a PIN, CBUAE alignment, data residency, and refunds.",
  "/docs":
    "Integration documentation: the ingest contract, webhook signing, verification, and the call lifecycle.",
  "/security":
    "Security posture: disclosure policy, data handling, retention, and the RFC 9116 contact.",
  "/privacy": `Privacy notice, including UAE PDPL handling and the retention window — ${DEFAULT_RETENTION_DAYS.audio} days for call audio and ${DEFAULT_RETENTION_DAYS.transcripts} days for transcripts.`,
  "/terms": "Terms of service.",
  "/refund": "Refund and cancellation policy.",
  "/usecases":
    "Worked scenarios: card fraud verification, claim confirmation, and appointment reminders.",
  "/team":
    "The people behind the platform: engineering, compliance, and the fraud operations desk.",
};

/**
 * One `- [Title](url): description` line.
 *
 * A path with no `PURPOSE` entry still gets listed — the list is derived from the
 * sitemap, and dropping a route because its prose is missing would hide the gap.
 * `tests/surface/llms-txt.test.ts` fails on the missing entry instead.
 */
function line(path: string, origin: string): string {
  const url = `${origin}${path === "/" ? "" : path}`;
  const label = path === "/" ? "Homepage" : path.slice(1).replace(/-/g, " ");
  const title = label.charAt(0).toUpperCase() + label.slice(1);
  const purpose = PURPOSE[path];
  return purpose ? `- [${title}](${url}): ${purpose}` : `- [${title}](${url})`;
}

/** A plan line, with every `null` meaning "negotiated" rather than "zero". */
function planLine(p: (typeof PLANS)[number]): string {
  // `llms.txt` exists to be quoted by answer engines verbatim, so a plan whose
  // price is not published must not have one inferred here. The public pricing
  // page says "Custom"; this file has to say the same thing, or the site
  // contradicts itself depending on who is reading it.
  const price =
    p.monthlyUsd === null || !p.publiclyPriced
      ? "contract-priced"
      : `${p.monthlyUsd} ${PRICE_CURRENCY} per month (${p.yearlyUsd} per year, ten monthly)`;
  const included =
    p.includedPerMonth === null
      ? "volume by contract"
      : `${p.includedPerMonth} intervention calls per month`;
  const overage =
    p.overageCents === null
      ? "overage negotiated"
      : `${(p.overageCents / 100).toFixed(2)} ${PRICE_CURRENCY} per additional call`;
  const seats = p.seats === null ? "unlimited seats" : `${p.seats} seat${p.seats === 1 ? "" : "s"}`;
  return `- ${p.name}: ${price}, ${included}, ${overage}, ${seats}. ${p.tagline}`;
}

export async function GET() {
  const origin = siteOrigin();
  const pages = INDEXABLE_PATHS.map((p) => line(p, origin)).join("\n");
  const plans = PLANS.map(planLine).join("\n");

  const body = `# ${COMPANY.name}

> ${COMPANY.industry} in ${COMPANY.region}: real-time phone intervention that confirms or denies a suspicious transaction or claim on a ${slaSeconds()}-second case deadline.

${COMPANY.name} (${COMPANY.legalName}) places and receives real phone calls between an AI agent and a bank or insurance customer. It is B2B software sold to financial institutions: a customer never signs up, and no payment is ever taken from an end user by this platform.

## Pages

${pages}

## Plans and pricing

Source of truth: ${origin}/pricing

${plans}

Prepaid credit packs are also available as one-time purchases, and an unused balance is spent down rather than forfeited.

## Machine-readable contracts

- [OpenAPI document](${origin}/openapi): the REST ingest and case endpoints, including the failure envelope every refusal returns.
- [AsyncAPI document](${origin}/asyncapi): the outbound webhook event schema a bank's system consumes.
- [robots.txt](${origin}/robots.txt): crawl policy. Search and answer-engine indexers are allowed; training-only crawlers are not.
- [sitemap.xml](${origin}/sitemap.xml): every indexable URL on this deployment.
- [security.txt](${origin}/.well-known/security.txt): vulnerability disclosure contact, RFC 9116.

## What the platform enforces in code, not in marketing

- Every outbound call passes a policy gate first: consent record, do-not-call registry, calling hours, country allowlist, cooldown, concurrency cap, spend ceiling, then a credit reservation. A refusal is a 409 with a machine-readable code, never a 500.
- Regulatory calling windows are honoured for routine calls, including UAE prayer times and Friday Jumu'ah. A time-critical fraud verification is not blocked by them.
- Call audio is retained for ${DEFAULT_RETENTION_DAYS.audio} days and then deleted. Transcripts are retained for ${DEFAULT_RETENTION_DAYS.transcripts} days, after which the per-case encryption key is shredded; they are redacted before storage, and a raw card number is never held. The tamper-evident audit chain is retained permanently and holds hashes only.
- The AI cannot give financial advice, cannot unfreeze an account, and cannot ask for a PIN or password. Those are prompt-level rules AND post-processing checks on the spoken output; a request for advice transfers to a human.
- A soft freeze is staged, not executed: ${durationPhrase(env.reversalWindowSecs)} for a second actor on the bank's side to commit it, and if that window closes undecided the hold is escalated to a human rather than reversed — nothing is ever frozen on the bank's ledger by this platform, so there is nothing to unfreeze. A permanent action requires that human, and the audit chain — hash-linked, append-only — records who did what.
- Tenant isolation is enforced in Postgres row-level security on tenant-owned tables, not only in the application layer.
- Integrations are adapters, and the port list is declared in the registry at src/lib/ports/registry.ts: risk-signal source, conversation provider (LLM, TTS, STT), telephony provider, notification sink, payment provider, secret store, audit sink. Each takes per-tenant keys, so a bank that mandates a different vendor is a configuration change. Signal ingest is push-only today — the registry names poll, kafka and sftp as adapters that are declared and not implemented, rather than implying a bank can already connect by those means. This platform writes no core-banking system: the one action it takes is a staged freeze a human commits.

## Contact

Support and demonstrations: ${SUPPORT_EMAIL}
Company: ${COMPANY.legalName}, ${COMPANY.city}, ${COMPANY.country}
`;

  return new NextResponse(body, {
    headers: {
      // `text/plain` because that is what an answer engine reads; the body is
      // Markdown for the human who opens the URL and wants to check what they are
      // being told.
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600, s-maxage=3600",
      // Indexable-but-not-a-page: engines may follow it to reach the pages it
      // lists, and it should not itself appear as a search result.
      "X-Robots-Tag": "noindex, follow",
    },
  });
}
