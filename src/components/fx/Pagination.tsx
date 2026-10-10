"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { useApp, t } from "@/lib/store";
import { cn } from "@/lib/utils";

/** Custom minimal pagination — ellipsis style, mono numerals */
export function Pagination({
  page,
  pages,
  onChange,
  className,
}: {
  page: number;
  pages: number;
  onChange: (p: number) => void;
  className?: string;
}) {
  const { lang } = useApp();
  if (pages <= 1) return null;
  const items: (number | "…")[] = [];
  if (pages <= 7) {
    for (let i = 1; i <= pages; i++) items.push(i);
  } else {
    const around = [page - 1, page, page + 1].filter((p) => p > 1 && p < pages);
    items.push(1);
    if (around[0] !== undefined && around[0] > 2) items.push("…");
    around.forEach((p) => items.push(p));
    if (around[around.length - 1] !== undefined && around[around.length - 1] < pages - 1)
      items.push("…");
    items.push(pages);
  }

  return (
    <nav
      className={cn("flex items-center gap-1", className)}
      aria-label={t("Pagination", "التنقل بين الصفحات", lang)}
    >
      <button
        onClick={() => onChange(Math.max(1, page - 1))}
        disabled={page === 1}
        aria-label={t("Previous page", "الصفحة السابقة", lang)}
        className="flex h-8 w-8 items-center justify-center rounded-lg border border-line bg-white text-ink-2 transition hover:border-primary/40 hover:text-primary disabled:opacity-35 disabled:hover:border-line disabled:hover:text-ink-2"
      >
        <ChevronLeft className="h-3.5 w-3.5" />
      </button>
      {items.map((it, i) =>
        it === "…" ? (
          <span key={`e${i}`} className="px-1 text-[11px] text-ink-3 select-none">
            …
          </span>
        ) : (
          <button
            key={it}
            onClick={() => onChange(it)}
            aria-current={page === it ? "page" : undefined}
            className={cn(
              "num h-8 min-w-8 rounded-lg border px-2 text-[12px] transition",
              page === it
                ? "border-primary bg-primary text-white font-semibold"
                : "border-line bg-white text-ink-2 hover:border-primary/40 hover:text-primary",
            )}
          >
            {it}
          </button>
        ),
      )}
      <button
        onClick={() => onChange(Math.min(pages, page + 1))}
        disabled={page === pages}
        className="flex h-8 w-8 items-center justify-center rounded-lg border border-line bg-white text-ink-2 transition hover:border-primary/40 hover:text-primary disabled:opacity-35 disabled:hover:border-line disabled:hover:text-ink-2"
        aria-label={t("Next page", "الصفحة التالية", lang)}
      >
        <ChevronRight className="h-3.5 w-3.5" />
      </button>
    </nav>
  );
}
