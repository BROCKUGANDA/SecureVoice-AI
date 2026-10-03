/**
 * AUDIT FIX — CSV formula injection in the shipped console export.
 *
 * `src/lib/csv-export.ts` neutralises formula-shaped cells (a leading `=`, `+`,
 * `-`, `@`, tab or CR gets a `'` prefix and RFC-4180 quoting). `/api/auth/export`
 * already went through `toCsv`.
 *
 * The Command Center's "Recent interventions → CSV" button did NOT. It built
 * the file by hand:
 *
 *     [c.callRef, c.riskScore, c.channel, c.plannedAction, at].join(",")
 *
 * No quoting, no formula guard. `plannedAction` and `channel` are derived from
 * the bank's own signal payload, so a descriptor value beginning `=` reached the
 * analyst's spreadsheet as live code — executed on open or on double-click,
 * running with the credentials of the person who can approve a card freeze.
 * The `join(",")` also broke on any field containing a comma.
 *
 * The button now calls `interventionsCsv()`, which routes through `toCsv`.
 *
 * No database, no network, no DOM:
 *   bun test tests/validation/console-csv-export.test.ts
 */
import { expect, test } from "bun:test";
import { interventionsCsv } from "@/lib/csv-export";
import type { InterventionExportRow } from "@/lib/csv-export";

const AT = "2026-06-01T10:00:00.000Z";

function row(overrides: Partial<InterventionExportRow> = {}): InterventionExportRow {
  return {
    callRef: "SV-F-ABCDEF",
    riskScore: 0.94,
    channel: "card",
    plannedAction: "card_freeze_temporary",
    at: AT,
    ...overrides,
  };
}

/**
 * Count RFC 4180 fields in one CSV record — a separator inside a quoted field
 * is DATA, not a delimiter. A naive `split(",")` is exactly the mistake the old
 * `join(",")` exporter made, so the assertion must not repeat it.
 */
function countFields(record: string): number {
  let fields = 1;
  let inQuotes = false;
  for (let i = 0; i < record.length; i++) {
    const ch = record[i];
    if (ch === '"') {
      if (inQuotes && record[i + 1] === '"') i++;
      else inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      fields++;
    }
  }
  return fields;
}

/** Split a document into records, stripping the UTF-8 BOM first. */
function records(csv: string): string[] {
  return csv
    .replace(/^﻿/, "")
    .split("\r\n")
    .filter((line) => line.length > 0);
}

test("console export: a formula-shaped value is neutralised, not emitted raw", () => {
  const csv = interventionsCsv([row({ plannedAction: "=cmd|'/c calc'!A1" })]);

  // The payload must not survive with a leading '=' — that is the cell becoming
  // code in Excel.
  expect(csv).not.toMatch(/,=/);
  expect(csv).not.toMatch(/^=/m);
  // It is preserved as TEXT behind a quote prefix, so the analyst still sees
  // what the sender actually sent (it is evidence in a fraud case).
  expect(csv).toContain("'=cmd|'/c calc'!A1");
});

test("console export: every spreadsheet formula trigger is neutralised", () => {
  // `=` `+` `@` are the classic DDE / data-exfiltration shapes; Excel also
  // treats a leading tab or CR as "evaluate the rest of the cell".
  const payloads = [
    "=cmd|'/c calc.exe'!A1",
    '+HYPERLINK("http://evil.example/x","click")',
    "-2+3+cmd|'/c calc'!A0",
    '@SUM(1+1)*cmd|"/c calc"!A0',
  ];
  for (const payload of payloads) {
    const csv = interventionsCsv([row({ plannedAction: payload })]);
    expect(csv).not.toMatch(/^[=+@-]/m);
    // RFC 4180 doubles an embedded quote, so compare against the payload as it
    // appears in the file rather than the raw string.
    const asWritten = payload.replace(/"/g, '""');
    expect(csv).toContain(`"'${asWritten}"`);
  }
});

test("console export: a formula in ANY column is neutralised, not just planned_action", () => {
  // callRef and channel are also derived from the bank's payload.
  const csv = interventionsCsv([
    row({ callRef: "=1+1", channel: "@SUM(A1:A9)", plannedAction: "+cmd" }),
  ]);
  expect(csv).not.toMatch(/^[=+@]/m);
  expect(csv).toContain("'=1+1");
  expect(csv).toContain("'@SUM(A1:A9)");
  expect(csv).toContain("'+cmd");
});

test("console export: a benign value is left completely alone", () => {
  const csv = interventionsCsv([row()]);
  expect(csv).toContain("SV-F-ABCDEF");
  expect(csv).toContain("card_freeze_temporary");
  expect(csv).toContain("0.94");
  // No stray quote prefix on ordinary data.
  expect(csv).not.toContain("'SV-F-ABCDEF");
  expect(csv).not.toContain("'card_freeze_temporary");
});

test("console export: a field containing a comma no longer shifts the columns", () => {
  // The old `[...].join(",")` emitted this as two cells, silently corrupting
  // every column to its right — a mis-stated amount then reads as a real one.
  const csv = interventionsCsv([row({ plannedAction: "freeze,pending review" })]);
  const lines = records(csv);
  expect(lines).toHaveLength(2); // header + 1 data row
  expect(lines[0]).toBe("case_ref,risk_score,channel,planned_action,fired_at");
  expect(countFields(lines[1]!)).toBe(5);
  expect(csv).toContain('"freeze,pending review"');
});

test("console export: the header row is present and the file is Excel-decodable", () => {
  const csv = interventionsCsv([row(), row({ callRef: "SV-F-SECOND" })]);
  // UTF-8 BOM: without it Excel on Windows decodes the file as the local
  // codepage and mangles every non-ASCII character.
  expect(csv.charCodeAt(0)).toBe(0xfeff);
  const lines = records(csv);
  expect(lines[0]).toBe("case_ref,risk_score,channel,planned_action,fired_at");
  expect(lines).toHaveLength(3); // header + 2 rows
  for (const line of lines) expect(countFields(line)).toBe(5);
});

test("console export: a neutralised cell is quoted so the prefix survives the round-trip", () => {
  // Without the quotes, a spreadsheet would strip the leading `'` and the cell
  // would become live code again — neutralisation that does not survive is not
  // neutralisation.
  const csv = interventionsCsv([row({ plannedAction: "=1+1" })]);
  expect(csv).toContain(`"'=1+1"`);
});
