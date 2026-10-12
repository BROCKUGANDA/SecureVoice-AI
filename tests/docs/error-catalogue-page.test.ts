/**
 * The page the API sends callers to, and the link that gets them there.
 *
 * `docsUrl` is a field of the failure envelope, so it is part of the published
 * contract: `{ "code": "rate_limited", ..., "docsUrl": "https://…/docs/errors/rate_limited" }`.
 * For a long time the last segment of that URL existed only in the string, and a
 * caller following it hit a 404 — the one response a documentation link is never
 * allowed to give. These tests are the reason it cannot silently become a 404
 * again, in the two ways that happens:
 *
 *   1. A code is added to `FAILURE_CODES` and the route's prerender list is not
 *      updated. With `dynamicParams = false` the new code 404s *permanently*,
 *      which is worse than the old state because nothing ever renders.
 *   2. A code's status or message changes in `STATUS_DISCIPLINE` and the page
 *      keeps asserting the old number. The page is derived from those same
 *      objects, so this is asserted rather than promised: the rendered HTML must
 *      contain the message the runtime actually put in the body.
 *
 * Measured, not inferred, against a live `next dev` while these files were being
 * written: `/docs/errors` → 200, `/docs/errors/rate_limited` → 200 with the
 * runtime's own `PUBLIC_MESSAGE` for that code inside the rendered body block,
 * `/docs/errors/not_a_real_code` → 404, and both new pages carry
 * `x-robots-tag: noindex, nofollow` from `src/proxy.ts` because they are not on
 * `INDEXABLE_PATHS` — the posture `src/app/docs/errors/page.tsx` explains.
 *
 *   bun test tests/docs/error-catalogue-page.test.ts
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { FAILURE_CODES, STATUS_DISCIPLINE, makeFailure } from "@/lib/failures/envelope";
import { ErrorCatalogue, ErrorCodePage, isErrorCode } from "@/views/ErrorCatalogue";
import ErrorRoute, { dynamicParams, generateStaticParams } from "@/app/docs/errors/[code]/page";
import CataloguePage from "@/app/docs/errors/page";

// ── 1. The contract's URL resolves to a real page, for every code ────────────

describe("every docsUrl has a target", () => {
  test("the prerender list is exactly the code set, in both directions", () => {
    // `dynamicParams = false` means a code missing from here is a 404 forever, so
    // the set is compared as a set: absent AND extra. An extra entry is a page for
    // a code the API no longer emits, which is how documentation outlives a rename.
    const prerendered = generateStaticParams().map((p) => p.code);
    expect([...prerendered].sort()).toEqual([...FAILURE_CODES].sort());
    expect(prerendered.length).toBe(FAILURE_CODES.length);
  });

  test("an invented code is refused rather than rendered as an empty card", () => {
    expect(dynamicParams).toBe(false);
    // The flag and the guard are two different refusals and the page holds both:
    // in dev the prerender manifest is not what answers the request.
    expect(isErrorCode("rate_limited")).toBe(true);
    expect(isErrorCode("Rate_Limited")).toBe(false);
    expect(isErrorCode("../../etc/passwd")).toBe(false);
    expect(isErrorCode("")).toBe(false);
  });

  test("the URL the envelope emits is the URL the route serves", () => {
    for (const code of FAILURE_CODES) {
      const emitted = makeFailure(code, { requestId: "svreq_test" }).body.docsUrl;
      const { pathname } = new URL(emitted);
      // Same base the OpenAPI contract quotes, and the per-code path this file's
      // own route component is mounted at.
      expect({ code, pathname }).toEqual({ code, pathname: `/docs/errors/${code}` });
    }
  });

  test("the catalogue index itself is a served page", () => {
    expect(typeof CataloguePage).toBe("function");
  });
});

// ── 2. What the pages say is what the runtime does ───────────────────────────

describe("the page content is derived, not copied", () => {
  test("the catalogue names every code and links every one", () => {
    const html = renderToStaticMarkup(ErrorCatalogue());
    for (const code of FAILURE_CODES) {
      expect(html).toContain(code);
      expect(html).toContain(`href="/docs/errors/${code}"`);
    }
    // The absence of 403 is a claim about this API's discipline, and it is only
    // true because the table says so: asserted from the same source.
    expect(FAILURE_CODES.map((c) => STATUS_DISCIPLINE[c].status)).not.toContain(403);
    expect(html).toContain("403");
  });

  test.each([...FAILURE_CODES])("%s renders its own status, retryability and message", (code) => {
    const html = renderToStaticMarkup(ErrorCodePage({ code }));
    const rule = STATUS_DISCIPLINE[code];
    const body = makeFailure(code, { requestId: "svreq_test" }).body;

    // The literal message the caller reads, not a paraphrase of it.
    expect(html).toContain(body.message);
    expect(html).toContain(code);
    expect(html).toContain(String(rule.status));
    expect(html).toContain(`retryable: ${String(rule.retryable)}`);
    expect(html).toContain(body.docsUrl);
    // The body block carries a sample correlation token and no real one: a page
    // that echoed a live requestId into public HTML would be publishing a key
    // into our logs.
    expect(html).toContain("svreq_example");
    expect(html).not.toContain(body.requestId);
  });

  test("the refusal prose distinguishes the two 409s that behave oppositely", () => {
    // `policy_precondition` and `transaction_contended` share a status and are the
    // opposite of each other in the one way a client acts on. If the page blurs
    // them the status code alone is misleading, so the difference is pinned here.
    const policy = renderToStaticMarkup(ErrorCodePage({ code: "policy_precondition" }));
    const contended = renderToStaticMarkup(ErrorCodePage({ code: "transaction_contended" }));
    expect(policy).toContain("retryable: false");
    expect(contended).toContain("retryable: true");
    expect(policy).not.toEqual(contended);
  });

  test("the per-code page throws for a code that is not ours", async () => {
    // `notFound()` raises; a rendered page instead of a throw means the guard was
    // removed and an invented URL now serves a card with an empty table.
    let threw = false;
    try {
      await ErrorRoute({ params: Promise.resolve({ code: "not_a_real_code" }) });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});
