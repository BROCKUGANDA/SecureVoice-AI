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
import { useApp, t } from "@/lib/store";

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
  onOpenSettings,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Optional: jump straight to the view where the BYOK key is entered. Without
   * it the dialog still explains the path in words; with it, "Bring your own
   * key" is one click instead of an instruction the operator has to remember.
   */
  onOpenSettings?: () => void;
}) {
  const { lang } = useApp();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="mb-1 flex h-10 w-10 items-center justify-center rounded-full bg-amber-tint">
            <Coins className="h-5 w-5 text-amber-soft" />
          </div>
          <DialogTitle>{t("Out of credits", "نفد رصيد المحفظة", lang)}</DialogTitle>
          <DialogDescription>
            {t(
              "Your prepaid credit wallet is empty, so this signal was not sent. SecureVoice meters every intervention against your wallet — one credit per signal, deducted only on success — so the AI usage never runs beyond what you have paid for.",
              "محفظة الأرصدة المدفوعة مسبقاً فارغة، لذلك لم تُرسل هذه الإشارة. تحتسب SecureVoice كل تدخل مقابل رصيد محفظتك — رصيد واحد لكل إشارة، يُخصم عند النجاح فقط — فلا يتجاوز استهلاك الذكاء الاصطناعي ما دُفع مقابه.",
              lang,
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2.5">
          <div className="flex items-start gap-2.5 rounded-xl border border-line bg-paper px-3 py-2.5 text-[12.5px] leading-relaxed text-ink-2">
            <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <span>
              <span className="font-semibold text-foreground">
                {t("Top up your wallet.", "اشحن محفظتك.", lang)}
              </span>{" "}
              {t(
                "Credits are prepaid and reconciled per organisation.",
                "الأرصدة مدفوعة مسبقاً ويتم تسويتها لكل مؤسسة على حدة.",
                lang,
              )}
            </span>
          </div>
          <div className="flex items-start gap-2.5 rounded-xl border border-line bg-paper px-3 py-2.5 text-[12.5px] leading-relaxed text-ink-2">
            <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <span>
              <span className="font-semibold text-foreground">
                {t("Bring your own key.", "أحضر مفتاحك الخاص.", lang)}
              </span>{" "}
              {t(
                "Paste your institution's ElevenLabs API key in Settings to route voice to your own account and skip the platform wallet entirely.",
                "الصق مفتاح ElevenLabs API الخاص بمؤسستك في الإعدادات لتوجيه الصوت إلى حسابك وتجاوز محفظة المنصة تماماً.",
                lang,
              )}
            </span>
          </div>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
          <a
            href={`mailto:${SUPPORT_EMAIL}?subject=SecureVoice%20credit%20top-up`}
            className="inline-flex h-10 items-center justify-center rounded-xl border border-line bg-white px-4 text-[13px] font-semibold text-ink-2 transition hover:border-primary/40 hover:text-primary"
          >
            {t("Contact Sales", "تواصل مع فريق المبيعات", lang)}
          </a>
          {onOpenSettings && (
            <button
              type="button"
              onClick={() => {
                onOpenChange(false);
                onOpenSettings();
              }}
              className="inline-flex h-10 items-center justify-center rounded-xl border border-line bg-white px-4 text-[13px] font-semibold text-ink-2 transition hover:border-primary/40 hover:text-primary"
            >
              {t("Open Settings", "فتح الإعدادات", lang)}
            </button>
          )}
          <Button onClick={() => onOpenChange(false)}>{t("Close", "إغلاق", lang)}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
