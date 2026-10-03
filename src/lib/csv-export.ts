/**
 * CSV export that neutralises formula injection.
 *
 * This is a LIVE path, not a demo. The README's audience is bank analysts, and
 * bank analysts live in Excel — the interventions export in `src/views/Console.tsx`
 * exists so a fraud operations team can open a case list in a spreadsheet on
 * Monday morning.
 *
 * That makes every exported cell untrusted input rendered inside a spreadsheet
 * that executes formulas. A merchant descriptor of
 * `=cmd|'/c calc'!A1`, `+HYPERLINK("http://evil/x","click")`, or
 * `@SUM(1+1)*cmd|'/c calc'!A0` becomes live code the moment an analyst double-clicks
 * the cell or opens the file with macros enabled. The payload runs with the
 * analyst's Windows credentials — which is on the machine that can approve a
 * card freeze — and the data is exfiltrated over HTTP by the same cell.
 *
 * CSV has no type system and no escaping layer, so the only defence is textual:
 * prefix a dangerous cell with a single quote, which forces Excel and every
 * RFC-4180 importer we care about to treat the remainder as literal text, and
 * quote the field so the leading `'` and any embedded quotes, commas and
 * newlines survive the round-trip.
 *
 * Documented trade-off, because it is a real one: `-` is in the trigger set, so
 * a negative number exports as the TEXT `-42.00` rather than the number -42.
 * Excel's SUM() ignores the text, which is usually the intent for a delta
 * column, but a numeric formula over such a column will not total it. A caller
 * that knows a column is genuinely numeric can opt out per-column with
 * `{ allowNegativeNumbers: true }`; nothing opts out by default.
 */

/** First characters Excel (and LibreOffice, and Google Sheets) treat as a formula. */
export const FORMULA_TRIGGERS = ["=", "+", "-", "@", "\t", "\r"] as const;

/** Characters that force a field to be quoted per RFC 4180. */
const MUST_QUOTE_RE = /["\r\n,]/;

/** A conservative numeric test used only when `allowNegativeNumbers` is set. */
const NUMERIC_LITERAL_RE = /^-?\d+(?:\.\d+)?$/;

export class CsvExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CsvExportError";
  }
}

export interface CsvOptions {
  /**
   * Prefix a UTF-8 BOM. Default true — without it, Excel on Windows decodes a
   * UTF-8 CSV as the local codepage and mangles every non-ASCII merchant name.
   */
  bom?: boolean;
  /** Row separator. Default CRLF, per RFC 4180. */
  newline?: "\r\n" | "\n";
  /**
   * Allow a leading `-` on an otherwise-numeric cell. Off by default; see the
   * trade-off note above.
   */
  allowNegativeNumbers?: boolean;
  /** Refuse to build a file larger than this many data rows. Default 100_000. */
  maxRows?: number;
  /** Truncate any single cell to this many characters. Default 32_768 (Excel's own cell limit). */
  maxCellLength?: number;
}

const DEFAULTS = {
  bom: true,
  newline: "\r\n" as const,
  allowNegativeNumbers: false,
  maxRows: 100_000,
  maxCellLength: 32_768,
};

/** True when the first character makes this cell a formula in a spreadsheet. */
export function isFormulaShaped(value: string): boolean {
  if (value.length === 0) return false;
  // The `value.length === 0` guard above is what proves index 0 exists; the
  // assertion records that for the checker rather than adding a dead branch.
  return (FORMULA_TRIGGERS as readonly string[]).includes(value[0]!);
}

/**
 * Neutralise a formula-shaped cell by prefixing a single quote.
 *
 * Prefixing, not stripping: the analyst still needs to see what the sender
 * actually sent — the raw descriptor is evidence in a fraud case — but the
 * spreadsheet must not run it.
 */
export function neutraliseFormula(value: string, opts: CsvOptions = {}): string {
  if (!isFormulaShaped(value)) return value;
  const allowNegative = opts.allowNegativeNumbers ?? DEFAULTS.allowNegativeNumbers;
  if (allowNegative && value.startsWith("-") && NUMERIC_LITERAL_RE.test(value)) return value;
  return `'${value}`;
}

/**
 * Render one value as one RFC 4180 field: stringified, formula-neutralised, and
 * quoted only when quoting is required (or when we neutralised it, so the
 * leading quote cannot be misread).
 */
export function toCsvField(value: unknown, opts: CsvOptions = {}): string {
  const maxCellLength = opts.maxCellLength ?? DEFAULTS.maxCellLength;

  let text: string;
  if (value === null || value === undefined) {
    text = "";
  } else if (typeof value === "string") {
    text = value;
  } else if (typeof value === "number") {
    text = Number.isFinite(value) ? String(value) : "";
  } else if (typeof value === "boolean") {
    text = value ? "true" : "false";
  } else if (typeof value === "bigint") {
    text = value.toString();
  } else if (value instanceof Date) {
    text = Number.isFinite(value.getTime()) ? value.toISOString() : "";
  } else {
    try {
      text = JSON.stringify(value) ?? "";
    } catch {
      // Cyclic or otherwise unserialisable — never let one cell kill an export.
      text = "";
    }
  }

  if (text.length > maxCellLength) text = text.slice(0, maxCellLength);

  const neutralised = neutraliseFormula(text, opts);
  const needsQuotes =
    MUST_QUOTE_RE.test(neutralised) || neutralised !== text || /^\s|\s$/.test(neutralised);
  if (!needsQuotes) return neutralised;

  // RFC 4180: a literal quote inside a quoted field is doubled.
  return `"${neutralised.replace(/"/g, '""')}"`;
}

export interface CsvColumn<Row> {
  /** Header text. Also passed through the formula guard — headers are code today, but a mapped header from a customer is not. */
  header: string;
  /** Value extractor. Must not throw; an exporter that dies on one row loses the other 4,999. */
  value: (row: Row) => unknown;
}

/**
 * Build a CSV document from rows and an explicit column list.
 *
 * Columns are explicit rather than derived from the first row: an export whose
 * columns depend on the data shape is an export that silently drops fields when
 * one row is thinner than another.
 *
 * @param rows     Data rows. Capped at `maxRows`.
 * @param columns  Column definitions, in output order.
 * @param opts     Formatting and safety options.
 */
export function toCsv<Row>(
  rows: readonly Row[],
  columns: readonly CsvColumn<Row>[],
  opts: CsvOptions = {},
): string {
  const maxRows = opts.maxRows ?? DEFAULTS.maxRows;
  if (rows.length > maxRows) {
    throw new CsvExportError(`Refusing to export ${rows.length} rows (cap ${maxRows})`);
  }

  const lines: string[] = [columns.map((column) => toCsvField(column.header, opts)).join(",")];

  for (const row of rows) {
    const cells: string[] = [];
    for (const column of columns) {
      let value: unknown;
      try {
        value = column.value(row);
      } catch {
        // One broken accessor must not lose the whole export.
        value = "";
      }
      cells.push(toCsvField(value, opts));
    }
    lines.push(cells.join(","));
  }

  const newline = opts.newline ?? DEFAULTS.newline;
  const bom = (opts.bom ?? DEFAULTS.bom) ? "\uFEFF" : "";
  return `${bom}${lines.join(newline)}${newline}`;
}

/**
 * Build a `Content-Disposition` value for a CSV download.
 *
 * Header injection lives here too: a filename taken from a query parameter
 * (`?name=foo\r\nX-Evil: 1`) would otherwise let a caller set arbitrary
 * response headers on our own origin.
 */
export function csvContentDisposition(filename: string): string {
  const ascii = filename
    .replace(/[^\x20-\x7E]/g, "_")
    .replace(/["\\]/g, "_")
    .replace(/[\r\n]/g, "");
  const utf8 = encodeURIComponent(filename).replace(/['()]/g, escape);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

/**
 * The Command Center's "Recent interventions" export — the button in
 * `src/views/Console.tsx`.
 *
 * This exists as a named function rather than staying inline in the click
 * handler for two reasons. First, the handler used to build the file by hand:
 * `[a, b, c].join(",")` with no quoting and no formula guard, so a merchant
 * descriptor or channel label beginning `=` reached Excel as live code — the
 * exact attack this module exists to stop, on the one surface bank analysts
 * actually use. Second, an inline handler cannot be tested; a bank analyst
 * opening Monday-morning's case list in a spreadsheet is a real consumer, not
 * a demo, and the regression has to be catchable by `bun test`.
 */
export type InterventionExportRow = {
  callRef: string;
  riskScore?: number | null;
  channel?: string | null;
  plannedAction?: string | null;
  at: Date | string | number;
};

export function interventionsCsv(rows: readonly InterventionExportRow[]): string {
  return toCsv<InterventionExportRow>(
    rows,
    [
      { header: "case_ref", value: (r) => r.callRef },
      // `riskScore` is a genuine non-negative rate, so the leading-`-` trade-off
      // in the module header cannot apply to it.
      { header: "risk_score", value: (r) => r.riskScore ?? "" },
      { header: "channel", value: (r) => r.channel ?? "" },
      { header: "planned_action", value: (r) => r.plannedAction ?? "" },
      { header: "fired_at", value: (r) => new Date(r.at).toISOString() },
    ],
    {},
  );
}
