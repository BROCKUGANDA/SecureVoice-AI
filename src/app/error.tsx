"use client";

import { useEffect } from "react";
import { ShieldCheck, RotateCcw } from "lucide-react";

/** Route-level error boundary — brand-styled, recoverable */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[SecureVoice] view crashed:", error);
  }, [error]);

  return (
    <div className="flex min-h-[70vh] flex-col items-center justify-center px-6 text-center">
      <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-green-tint">
        <ShieldCheck className="h-7 w-7 text-primary" strokeWidth={1.6} />
      </span>
      <h1 className="font-display mt-6 text-2xl font-semibold tracking-tight">
        Something interrupted this view
      </h1>
      <p className="mt-3 max-w-md text-[14px] leading-relaxed text-ink-2">
        The platform hit an unexpected state while rendering. Your session data is safe — restart
        the view or jump back to the overview.
      </p>
      <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
        <button
          onClick={reset}
          className="flex items-center gap-2 rounded-full bg-primary px-6 py-3 text-[13.5px] font-semibold text-white transition hover:bg-green-deep"
        >
          <RotateCcw className="h-4 w-4" />
          Restart view
        </button>
        <button
          onClick={() => window.location.reload()}
          className="rounded-full border border-line bg-white px-6 py-3 text-[13.5px] font-semibold text-foreground transition hover:border-primary/50 hover:text-primary"
        >
          Reload platform
        </button>
      </div>
      {error.digest && (
        <p className="num mt-6 text-[10.5px] text-ink-3">REF: {error.digest}</p>
      )}
    </div>
  );
}
