"use client";

import { ShieldCheck, TriangleAlert } from "lucide-react";

/**
 * The out-of-band verification token, shown to the operator once.
 *
 * This is the console's stand-in for the bank's mobile app — the second surface
 * on which the customer can see that a verification call is genuinely in
 * progress, on a channel the caller cannot reach. In a bank integration the same
 * word arrives in the `verification` block of the `POST /v1/interventions`
 * response and is rendered in the customer's app; here it is rendered in the
 * Command Center so the mechanism is visible and demonstrable.
 *
 * The warning is not decoration, and it is the reason this component exists in
 * this shape: the single most dangerous thing an operator could do with this word
 * is put it into a script, a test line, or a voicemail template — at which point
 * it stops being an out-of-band anchor and becomes exactly the in-band credential
 * it was built to avoid. The speech gate refuses such an utterance
 * (`prepareSpeech` with `verificationToken` bound), so the mistake fails loudly
 * rather than quietly shipping.
 */
export function VerificationTokenBadge({
  token,
  caseRef,
  expiresInMinutes = 30,
}: {
  token: string;
  caseRef?: string;
  /** How long the reference stays meaningful. Mirrors the hang-up-safe exit. */
  expiresInMinutes?: number;
}) {
  if (!token) return null;
  return (
    <div role="status" className="rounded-2xl border border-primary/30 bg-green-tint px-4 py-3.5">
      <p className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-wide text-green-deep">
        <ShieldCheck className="h-3.5 w-3.5" />
        Verification word — second channel
      </p>
      <p className="num mt-1.5 text-xl font-semibold tracking-[0.18em] text-green-deep">{token}</p>
      <p className="mt-1.5 text-[11.5px] leading-relaxed text-green-deep/90">
        Shown in the customer&apos;s app so they can confirm a verification call is real without
        trusting the caller
        {caseRef ? (
          <>
            {" "}
            for case <span className="num font-semibold">{caseRef}</span>
          </>
        ) : null}
        . It stays valid for {expiresInMinutes} minutes.
      </p>
      <p className="mt-2 flex items-start gap-1.5 text-[11px] font-medium leading-snug text-amber-soft">
        <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
        <span>
          Never spoken on the call, and never written into a script, SMS or voicemail. The speech
          gate refuses any utterance containing it — if a line ever tries to say this word, the
          audio is dropped and the refusal is audited.
        </span>
      </p>
    </div>
  );
}
