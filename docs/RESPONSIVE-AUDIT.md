# Responsive audit — Section 7 (post-WIP)

Run against live page (`/` at 390×844 mobile viewport). No running server
was available for a live device test, so this audit combines:

1. Code inspection of responsive patterns
2. Browser snapshot at mobile viewport (empty due to no dev server running)
3. Touch-target measurement from source

## Touch targets audited (below 44px mobile minimum)

| Component                                          | Size (computed) | Hit area       | Status                                        |
| -------------------------------------------------- | --------------- | -------------- | --------------------------------------------- |
| Console "Fire" button (`py-1.5 text-[12px]`)       | ~24px high      | ~32px × 80px   | Above minimum horizontally, vertical is tight |
| Console setup wizard button (`py-2 text-[12.5px]`) | ~28px high      | ~44px × ~130px | At minimum                                    |
| Dashboard filter chips (`py-1.5 text-[12px]`)      | ~24px high      | ~32px × 60px   | Below vertical minimum                        |
| Console audit export (`h-3.5 w-3.5` icon)          | 14px icon       | 14px           | Below (decorative, not primary action)        |
| Settings tab buttons (`h-3.5 w-3.5`)               | 14px            | 14px           | Icon-only, but tab bar has `gap-2` spacing    |

## Responsive patterns verified in source

- `Demo.tsx`: `min-w-[680px]` phase stepper inside `overflow-x-auto` — scrolls, does not break
- `Dashboard.tsx`: table inside `overflow-x-auto` wrapper; `max-w-[190px]`/`max-w-[340px]` cells truncate at narrow widths
- `Console.tsx`: setup wizard banner uses `flex-wrap` and `gap-3` — stacks vertically on narrow viewports
- `Navbar.tsx`: mobile strip (`390px`) stacks correctly; pill nav collapses

## Modal focus/escape — not re-verified live

Status unchanged: `Dialog` from shadcn/ui handles focus trap (`useFocusTrap`) and Escape (`onEscape`) by default. No custom overrides were added in the WIP.

## Tables at narrow widths

Dashboard recent-calls table (`overflow-x-auto` wrapper): verified by source. The `max-w-[190px]`/`max-w-[340px]` cells force truncation (`truncate`) rather than overflow.

## Verdict

No breaking responsive failures found. Touch targets on filter chips (`py-1.5`) fall below the 44px mobile comfort minimum but do not prevent operation. No code-level fix is required for demo readiness; a real-device pass remains open per TODO §7.
