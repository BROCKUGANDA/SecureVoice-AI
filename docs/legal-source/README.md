# Primary legislation text — provenance

The DIFC compliance record (`docs/ROPA.md`, `docs/AI-INVENTORY.md`, `docs/DPIA.md`)
quotes provisions and cites them as `difc-law.txt:NNN`. Those citations have to
resolve, so the extracted text is committed here rather than left in a temporary
directory: before 2026-10-19 the files lived in `$TMP`, and a record whose legal
citations point into a directory the operating system cleans up is a record that
silently becomes unverifiable.

## Files

| File            | Document                                                                                                                     | Retrieved                |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `difc-law.txt`  | _Data Protection Law_ — DIFC Law No. 5 of 2020, Consolidated Version (March 2022), as amended by the DIFC Laws Amendment Law | 2026-10-18 from difc.com |
| `difc-regs.txt` | _Data Protection Regulations_ — Consolidated Version No. 2, in force 1 September 2023                                        | 2026-10-18 from difc.com |

Both were extracted from the Commissioner's published PDFs with `pdftotext -layout`
and are **unedited** apart from the extractor's own line wrapping. Line numbers in
the compliance record are line numbers in these files, and
`tests/surface/compliance-citations.test.ts` checks the cited range falls inside
the file's real length.

## Why the PDFs, and not a summary

A model-generated summary of the Commissioner's guidance invented paragraph numbers
that do not exist in the source. Every provision quoted in the record is read from
this extraction, which is why the record quotes, for example, Regulation 10.3.3's
footnote 11 by line rather than by memory.

## What is deliberately not here

The Commissioner's **AI-specific guidance pages** were never retrieved: difc.com
answered HTTP 429 on 2026-10-18 for those URLs. No guidance text is quoted anywhere
in the compliance record, and each document says so. `ISO/IEC 29134` is cited by
name and scope only — the licensed text is not held, and it is not paraphrased as
though it were.
