# Self-hosted webfonts

Four families the interface renders: Space Grotesk (`--font-display`), Inter
(`--font-sans`), JetBrains Mono (`--font-mono`) and IBM Plex Sans Arabic
(`--font-arabic`). They were previously requested through `next/font/google`, which
made **the build** fetch them from `fonts.gstatic.com`. When that fetch fails the
build dies inside `[next]/internal/font/google/…module.css` with a module-not-found
error, and because the only variable is the network, the same commit passes on one
runner and fails on the next. A production build must not depend on somebody else's
CDN.

## Layout

| Path                      | What it is                                                                                                                       |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `*.woff2`                 | The font files — 36. Google splits each family by script (`unicode-range` slice), and IBM Plex Sans Arabic is static per weight. |
| `manifest.json`           | Generated inventory: family → CSS variable → files.                                                                              |
| `licenses/*.OFL.txt`      | Each family's own license, copied from its upstream project, copyright lines included.                                           |
| `../../src/app/fonts.css` | The generated `@font-face` sheet referencing these files.                                                                        |

## Naming

`<family>-<content-hash>[-s[.p].<slice>].woff2`

`s` = subsetted, `p` = the **primary** slice, which is the one preloaded on first
paint. The content hash is part of the filename on purpose: `public/` is served
without a build-time URL rewrite, so a refreshed font has to change name or
returning visitors keep serving the old bytes from cache.

Never name files per weight. Three of these four families are variable fonts — one
file serves every weight. The video pipeline's copies under
`demo/walkthrough/source/assets/fonts/` show the mistake: `Inter-400`, `Inter-500`
and `Inter-600` there are one file copied three times, sha256-identical.

## Provenance

Fetched from `fonts.gstatic.com` as served to `next/font/google`, harvested from the
`@font-face` output of a real `bun run build` on 2026-10-18, then copied here by
`scripts/vendor-fonts.mjs`. Every `unicode-range` and every `* Fallback` metric
block is byte-copied from that build, which is why glyph coverage and layout-shift
behaviour did not change. Verify a slice survived with:

```sh
curl -s http://localhost:3000/_next/static/chunks/<css chunk> | grep -c unicode-range
```

which on the build after vendoring reported 63 ranges and 4 size-adjust blocks — the
same as before.

## Changing a font

`scripts/vendor-fonts.mjs` harvests a build that used the Google loader, so it
**refuses to run on this vendored state** rather than rewriting the sheet onto
itself. To change a family or weight:

1. Temporarily restore the `next/font/google` loaders in `src/app/layout.tsx` (git
   history has them) and remove `import "./fonts.css"`.
2. `bun run build` while the CDN is reachable.
3. `node scripts/vendor-fonts.mjs` — regenerates `public/fonts/*.woff2`,
   `manifest.json` and `src/app/fonts.css`. It validates first and writes second, so
   a failure here leaves the current set intact.
4. Put the layout back to the vendored form and set `PRELOAD_FONTS` to the new
   `-s.p.` names.
5. `bun run test self-hosted-fonts`, then `bun run build`.

Never edit `src/app/fonts.css` by hand. The gate fails if the sheet, the files and
the preload list disagree, if a committed file is unreferenced, if a referenced file
is missing, or if `next/font` reappears in the layout.

## License

All four families are under the **SIL Open Font License 1.1**; the exact text and
copyright notice for each is in `licenses/`:

- Inter — Copyright 2020 The Inter Project Authors
- JetBrains Mono — Copyright 2020 The JetBrains Mono Project Authors
- Space Grotesk — Copyright 2020 The Space Grotesk Project Authors
- IBM Plex Sans Arabic — Copyright © 2017 IBM Corp. with Reserved Font Name "Plex"

OFL permits bundling and redistribution of the files unchanged, which is what this
directory is. The Reserved Font Name restriction applies to deriving or renaming a
font; serving the unmodified files to browsers does not engage it.
