"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useApp, t } from "@/lib/store";

/**
 * Light / dark / system.
 *
 * The label is the accessible name AND the visible text, because this control
 * changes what the whole console looks like: an icon with no word on it is
 * guessable at best. `title` repeats the resolved value so a customer on
 * "system" can see what that currently means rather than wondering why the
 * button says system and the screen changed.
 *
 * `theme` is undefined for the first render, since the stored preference is only
 * readable in the browser. The icons and labels are chosen so that render is
 * complete rather than a layout shift.
 */
const ORDER = ["light", "dark", "system"] as const;

export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const { theme, setTheme } = useTheme();
  const { lang } = useApp();

  const current = theme === "dark" ? "dark" : theme === "light" ? "light" : "system";
  const next = ORDER[(ORDER.indexOf(current) + 1) % ORDER.length];

  const label =
    current === "dark"
      ? t("Dark", "داكن", lang)
      : current === "light"
        ? t("Light", "فاتح", lang)
        : t("System", "النظام", lang);

  const Icon = current === "dark" ? Moon : current === "light" ? Sun : Monitor;

  return (
    <button
      type="button"
      onClick={() => setTheme(next)}
      aria-label={t("Colour theme", "سمة الألوان", lang)}
      title={`${label} → ${next}`}
      className={
        compact
          ? "flex items-center gap-1.5 rounded-full px-2 py-1.5 text-[12.5px] font-semibold text-ink-2 transition hover:text-primary"
          : "flex items-center gap-1.5 rounded-full border border-line bg-white px-3 py-1.5 text-[12.5px] font-semibold text-ink-2 transition hover:border-primary/40 hover:text-primary"
      }
    >
      <Icon className="h-3.5 w-3.5" aria-hidden />
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}
