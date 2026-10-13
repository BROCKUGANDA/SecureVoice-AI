import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { FAILURE_CODES } from "@/lib/failures/envelope";
import { PublicPageLayout } from "@/components/shell/PublicPageLayout";
import { ErrorCodePage, isErrorCode } from "@/views/ErrorCatalogue";

/**
 * `/docs/errors/[code]` — the page every `docsUrl` resolves to.
 *
 * `src/lib/failures/envelope.ts` hands a caller `docsUrl: <base>/<code>` on
 * every failure, and `<base>` defaults to `https://securevoiceai.me/docs/errors`.
 * Until this file existed, that link was a 404: the API's own error body pointed
 * at documentation that was not there, in a contract whose whole purpose is that
 * a machine can act on a code without a human reading our source.
 *
 * The code set is closed and known at build time — `FAILURE_CODES` is a
 * `const` array — so `generateStaticParams` prerenders all of them and
 * `dynamicParams = false` makes any other value a 404 without rendering. That
 * pairing matters: without `generateStaticParams` the flag would 404 the codes
 * themselves, and without the flag an invented code would reach the page
 * component and be rendered as an empty card. `notFound()` below is the same
 * refusal stated a second time, because in dev the prerender manifest is not
 * what answers the request.
 */

export const dynamicParams = false;

export function generateStaticParams(): { code: string }[] {
  return FAILURE_CODES.map((code) => ({ code }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ code: string }>;
}): Promise<Metadata> {
  const { code } = await params;
  if (!isErrorCode(code)) return { title: "Unknown error code" };
  return {
    title: `${code} — error code`,
    description:
      "What this failure means, what the caller should do about it, and the exact response body the API returns.",
    alternates: { canonical: `/docs/errors/${code}` },
  };
}

export default async function ErrorCodeRoute({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  if (!isErrorCode(code)) notFound();
  return (
    <PublicPageLayout current="/docs">
      <ErrorCodePage code={code} />
    </PublicPageLayout>
  );
}
