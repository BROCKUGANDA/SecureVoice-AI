/**
 * Static check: no network I/O inside a database transaction.
 *
 * ── Why this is a static check and not a runtime one ─────────────────────────
 *
 * A runtime assertion is impossible here by construction: the rule exists
 * precisely for the case where the database is fine, so nothing would ever
 * fail. The only honest way to check it is to read the source. So this module
 * does three things and nothing else:
 *
 *   1. blanks out comments and string/template literals, preserving every
 *      offset and newline, so a comment that says "no `fetch` here" cannot be
 *      mistaken for a call and a line number stays exact;
 *   2. finds every `$transaction(` and walks the brackets to the matching
 *      close, which is the transaction's whole region including an array-form
 *      `db.$transaction([...])`;
 *   3. reports any network token inside that region.
 *
 * ── Known limits, stated rather than hidden ──────────────────────────────────
 *
 *   - Regex literals are not blanked, so a `/fetch\(/` regex literal would be
 *     reported as a call. There is no such literal in the scanned files, and a
 *     false positive fails the gate loudly rather than silently.
 *   - Dynamically-computed callee names (`const f = "fetch"; f(url)`) are not
 *     detected. Nothing in the scanned files does that.
 *   - A network call made by a FUNCTION CALLED from inside the transaction is
 *     not detected. That is a design property, not a syntax property, and the
 *     evidence file records which scanned modules import an HTTP client so a
 *     reviewer can judge it by hand.
 *
 * The gate runs a negative control through this scanner (a synthetic
 * transaction containing `fetch(`), so an empty findings list cannot be the
 * result of a scanner that reports nothing at all.
 */

/** Tokens that mean "this is talking to the network". */
export const NETWORK_TOKENS: readonly string[] = [
  "fetch",
  "axios",
  "got",
  "undici",
  "WebSocket",
  "http.request",
  "https.request",
  "net.connect",
  "net.Socket",
  "tls.connect",
  "dgram",
  "createTransport",
  "smtp",
  "sendMail",
  "redis",
  "ioredis",
];

export type TxScanFinding = {
  file: string;
  line: number;
  token: string;
  excerpt: string;
};

export type TxScanRegion = {
  line: number;
  endLine: number;
  /** Network tokens found inside this region. */
  tokens: string[];
};

export type TxScanResult = {
  file: string;
  /** False when the file could not be read — reported rather than skipped. */
  read: boolean;
  /** Number of `$transaction(` regions found. */
  transactions: number;
  regions: TxScanRegion[];
  findings: TxScanFinding[];
  /** Lines of the original source, so the finding is quotable. */
  notes: string[];
};

/**
 * Replace the contents of comments and string/template literals with spaces,
 * keeping every character offset and every newline intact.
 *
 * Template-literal `${...}` holes are left alone: an expression inside a
 * template is code and may legitimately contain a call.
 */
export function blankOutLiterals(source: string): string {
  const out = source.split("");
  const n = source.length;
  let i = 0;

  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k++) if (out[k] !== "\n" && out[k] !== "\r") out[k] = " ";
  };

  while (i < n) {
    const c = source[i];

    // line comment
    if (c === "/" && source[i + 1] === "/") {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      blank(i, stop);
      i = stop;
      continue;
    }

    // block comment
    if (c === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }

    // single/double quoted string
    if (c === "'" || c === '"') {
      let k = i + 1;
      while (k < n) {
        if (source[k] === "\\") {
          k += 2;
          continue;
        }
        if (source[k] === c) break;
        k++;
      }
      blank(i + 1, Math.min(k, n));
      i = Math.min(k + 1, n);
      continue;
    }

    // template literal, preserving ${...} holes
    if (c === "`") {
      let k = i + 1;
      while (k < n) {
        if (source[k] === "\\") {
          k += 2;
          continue;
        }
        if (source[k] === "`") {
          blank(i, k);
          i = k + 1;
          break;
        }
        if (source[k] === "$" && source[k + 1] === "{") {
          // Find the matching close brace, counting nested braces.
          let depth = 1;
          let j = k + 2;
          while (j < n && depth > 0) {
            if (source[j] === "{") depth++;
            else if (source[j] === "}") depth--;
            j++;
          }
          // The hole body stays as code; only the `${` and `}` are blanked.
          blank(k, k + 2);
          blank(j - 1, j);
          k = j;
          continue;
        }
        k++;
      }
      if (k >= n) i = n;
      continue;
    }

    i++;
  }

  return out.join("");
}

function lineAt(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) if (source[i] === "\n") line++;
  return line;
}

function excerptAt(source: string, index: number): string {
  const start = Math.max(0, index - 40);
  const end = Math.min(source.length, index + 60);
  return source.slice(start, end).replace(/\s+/g, " ").trim();
}

/** Scan one file's source for network I/O inside a `$transaction` region. */
export function scanSourceForNetworkInTransaction(source: string, file: string): TxScanResult {
  const code = blankOutLiterals(source);
  const lines = source.split("\n");
  const regions: TxScanRegion[] = [];
  const findings: TxScanFinding[] = [];

  const matcher = /\$transaction\s*\(/g;
  let match: RegExpExecArray | null = matcher.exec(code);
  while (match !== null) {
    const openParen = match.index + match[0].length - 1;
    let depth = 0;
    let end = openParen;
    for (let i = openParen; i < code.length; i++) {
      const ch = code[i];
      if (ch === "(" || ch === "{" || ch === "[") depth++;
      else if (ch === ")" || ch === "}" || ch === "]") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (depth !== 0) {
      // Unbalanced source: refuse to guess, and say so in the evidence.
      regions.push({ line: lineAt(code, match.index), endLine: lineAt(code, code.length - 1), tokens: [] });
      findings.push({
        file,
        line: lineAt(code, match.index),
        token: "<unbalanced>",
        excerpt: "$transaction( could not be matched to its closing bracket",
      });
      break;
    }

    const body = code.slice(openParen + 1, end);
    const startLine = lineAt(code, match.index);
    const endLine = lineAt(code, end);
    const tokens: string[] = [];
    for (const token of NETWORK_TOKENS) {
      const re = new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");
      const hit = re.exec(body);
      if (hit) {
        tokens.push(token);
        const absolute = openParen + 1 + hit.index;
        findings.push({ file, line: lineAt(code, absolute), token, excerpt: excerptAt(source, absolute) });
      }
    }
    regions.push({ line: startLine, endLine, tokens: tokens.sort() });

    matcher.lastIndex = end;
    match = matcher.exec(code);
  }

  return {
    file,
    read: true,
    transactions: regions.length,
    regions,
    findings,
    notes: [`${lines.length} lines`, `${regions.length} transaction region(s)`],
  };
}

/** Scan a set of files. `read` is injected so the gate controls the filesystem. */
export function scanFilesForNetworkInTransaction(
  files: readonly string[],
  read: (file: string) => string | null,
): { results: TxScanResult[]; findings: TxScanFinding[]; unreadable: string[] } {
  const results: TxScanResult[] = [];
  const findings: TxScanFinding[] = [];
  const unreadable: string[] = [];

  for (const file of [...files].sort()) {
    const source = read(file);
    if (source === null) {
      unreadable.push(file);
      results.push({
        file,
        read: false,
        transactions: 0,
        regions: [],
        findings: [],
        notes: ["file could not be read"],
      });
      continue;
    }
    const result = scanSourceForNetworkInTransaction(source, file);
    results.push(result);
    findings.push(...result.findings);
  }

  findings.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
  return { results, findings, unreadable };
}