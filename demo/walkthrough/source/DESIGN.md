# DESIGN — SecureVoice AI platform demo

## Style Prompt

Clean regulated-fintech product walkthrough. Light surfaces, a single brand green
carrying all the emphasis, generous whitespace, no dark-mode tokens anywhere.
The visual language is the product's own: every colour and font below is read
straight off `src/app/globals.css` and `src/app/layout.tsx`, not invented for
the video. Nothing is a mock-up — every screenshot in the reel is a real capture
of https://securevoiceai.me.

## Colors

| Role | Hex | Source |
| --- | --- | --- |
| Paper / canvas | `#fbfbf8` | `--paper`, `--background` |
| Card surface | `#ffffff` | `--card` |
| Ink (primary text) | `#101812` | `--foreground` |
| Ink 2 (secondary) | `#46524a` | `--ink-2` |
| Ink 3 (tertiary / labels) | `#5c685d` | `--ink-3` |
| Hairline | `#e7eae3` | `--line` |
| Primary / brand green | `#0b7a55` | `--primary` |
| Green deep | `#085c3f` | `--green-deep` |
| Green bright (signal) | `#14a374` | `--green-bright` |
| Green tint (fills) | `#e9f5ef` | `--green-tint` |
| Destructive (the fraud) | `#d64550` | `--destructive` |
| Red soft | `#b63b44` | `--red-soft` |
| Amber (caution / unmeasured) | `#b97a11` | `--amber-soft` |

## Typography

| Family | Use | Source |
| --- | --- | --- |
| Space Grotesk (400/500/600/700) | Display headlines, chapter eyebrows | `--font-display` |
| Inter (400/500/600) | Body copy, captions, bullets | `--font-sans` |
| JetBrains Mono (400/600) | Route paths, hashes, latency figures, state names | `--font-mono` |
| IBM Plex Sans Arabic (300–700) | The Arabic disclosure line, verbatim | `--font-arabic` |

Corner radius `0.75rem` everywhere. Numbers always `font-variant-numeric: tabular-nums`.

## Motion

Measured, not playful. `power2.out` / `power3.out` / `expo.out` entrances,
`back.out(1.4)` only for a single beat (the freeze staging). Scenes crossfade —
each incoming scene fades its own surface in over 0.5s while the outgoing one
stays fully visible underneath; no scene ever animates itself out except the last.

## What NOT to Do

- No dark canvas, no glassmorphism, no neon glow, no gradient washes on flat fills.
- No `#333` / `#3b82f6` / Roboto / system-ui stack.
- No equalizer bars, no confetti, no bouncing.
- No claim the video cannot source from the repo. The 60-second headline is
  labelled **target**; the two measured p95 figures are labelled **measured**.
- No fabricated screenshot. Every frame of the site is a live capture.
