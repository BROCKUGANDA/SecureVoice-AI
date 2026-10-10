import Link from "next/link";
import { CheckCircle2 } from "lucide-react";

/**
 * `/welcome` — where Paddle Checkout returns on success.
 *
 * It is deliberately DUMB. It does not read the query string, does not verify
 * anything, and does not tell the buyer they have been credited. That is because
 * the browser's return is not evidence of anything: the ONLY thing that credits a
 * wallet is the `transaction.completed` webhook reaching
 * `src/app/api/billing/webhook/route.ts`, and that may still be in flight when
 * this page renders.
 *
 * A page that says "you're all set" based on a redirect would be exactly as
 * reliable as a client-side payment confirmation, which is to say not at all.
 *
 * `?_status=cancelled` is what Paddle's own cancelled return carries, so the two
 * outcomes are distinguished without ever asserting a settled state.
 */

export const metadata = {
  title: "Welcome — SecureVoice AI",
  robots: { index: false, follow: false },
};

export default function WelcomePage({ searchParams }: { searchParams: { status?: string } }) {
  const cancelled = searchParams.status === "cancelled";

  return (
    <main className="mx-auto flex min-h-[70vh] max-w-2xl flex-col items-center justify-center px-6 py-16 text-center">
      <span
        aria-hidden="true"
        className={
          cancelled
            ? "flex h-14 w-14 items-center justify-center rounded-full bg-line text-ink-3"
            : "flex h-14 w-14 items-center justify-center rounded-full bg-green-tint text-primary"
        }
      >
        <CheckCircle2 className="h-7 w-7" strokeWidth={1.8} />
      </span>

      <h1 className="font-display mt-6 text-3xl font-semibold tracking-tight">
        {cancelled ? "Checkout cancelled" : "Thanks — you're nearly there"}
      </h1>

      <p className="mt-3 text-[15px] leading-relaxed text-ink-2">
        {cancelled
          ? "Nothing was charged. You can pick a plan again whenever you are ready."
          : "Your payment is being confirmed. Paddle is notifying us of the transaction, and your credits appear in the Command Center as soon as that lands — usually within a few seconds."}
      </p>

      <p className="mt-4 rounded-2xl border border-line bg-white px-5 py-3.5 text-[12.5px] leading-relaxed text-ink-3">
        Confirmation is the signed webhook, not this page. If your credits have not appeared after a
        minute, email support and we will reconcile it by hand.
      </p>

      <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
        <Link
          href="/"
          className="rounded-full bg-primary px-6 py-3 text-[13.5px] font-semibold text-white transition hover:bg-green-deep"
        >
          Back to the platform
        </Link>
        <Link
          href="/pricing"
          className="rounded-full border border-line bg-paper px-6 py-3 text-[13.5px] font-semibold text-ink-2 transition hover:border-primary/40 hover:text-primary"
        >
          See the plans
        </Link>
      </div>
    </main>
  );
}
