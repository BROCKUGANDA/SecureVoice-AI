"use client";

import { Coins, KeyRound, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SUPPORT_EMAIL } from "@/lib/public-config";

/**
 * Shown when a fire is refused because the prepaid credit wallet is empty.
 *
 * This is the Managed-Credit model made visible, without faking a payment
 * gateway: the operator tops the wallet up, or brings their own ElevenLabs key
 * (BYOK) and the platform resumes. The copy states the unit economics plainly —
 * one credit per intervention, deducted only on success — so a judge sees the
 * monetisation instead of a dead Stripe button.
 */
export function TopUpDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="mb-1 flex h-10 w-10 items-center justify-center rounded-full bg-amber-tint">
            <Coins className="h-5 w-5 text-amber-soft" />
          </div>
          <DialogTitle>Out of credits</DialogTitle>
          <DialogDescription>
            Your prepaid credit wallet is empty, so this signal was not sent. SecureVoice meters
            every intervention against your wallet — one credit per signal, deducted only on success
            — so the AI usage never runs beyond what you have paid for.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2.5">
          <div className="flex items-start gap-2.5 rounded-xl border border-line bg-paper px-3 py-2.5 text-[12.5px] leading-relaxed text-ink-2">
            <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <span>
              <span className="font-semibold text-foreground">Top up your wallet.</span> Credits are
              prepaid and reconciled per organisation.
            </span>
          </div>
          <div className="flex items-start gap-2.5 rounded-xl border border-line bg-paper px-3 py-2.5 text-[12.5px] leading-relaxed text-ink-2">
            <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <span>
              <span className="font-semibold text-foreground">Bring your own key.</span> Paste your
              institution&apos;s ElevenLabs API key in Settings to route voice to your own account
              and skip the platform wallet entirely.
            </span>
          </div>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
          <a
            href={`mailto:${SUPPORT_EMAIL}?subject=SecureVoice%20credit%20top-up`}
            className="inline-flex h-10 items-center justify-center rounded-xl border border-line bg-white px-4 text-[13px] font-semibold text-ink-2 transition hover:border-primary/40 hover:text-primary"
          >
            Contact Sales
          </a>
          <Button onClick={() => onOpenChange(false)}>Close</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
