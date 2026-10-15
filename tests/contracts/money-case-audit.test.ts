/**
 * THE MONEY AND CASE PATHS ARE THE MOST AUDITED SURFACES IN THE PRODUCT, AND
 * THIS FILE IS WHAT KEEPS THEM THERE.
 *
 * The property worth protecting is not "these files look right today". It is
 * that the next inbound integration — a bank relay, a gateway webhook, a worker
 * somebody deploys in a hurry — cannot become a second, quieter door into money
 * or a fraud case. Every rule below is therefore a rule about the SET of writers
 * and the SHAPE of their evidence, and every rule is paired with a case that
 * feeds it a violating file and asserts it still reports. A scanner that matches
 * nothing is not a gate.
 *
 * The rules, and the failure each one prevents:
 *
 *  1. MONEY HAS NAMED WRITERS AND NO OTHERS. `PaymentRecord` and `UsageLedger`
 *     are written from four declared modules. A fifth writer is how a credit
 *     appears with no code path anyone reviewed behind it — the shape the
 *     now-deleted inbound webhook scaffold had (it wrote straight through
 *     PostgREST, past the ledger's idempotency keys and the dual-control gate).
 *  2. EVERY MONEY WRITER CAN PROVE WHAT IT WROTE. Each one must reach the
 *     tamper-evident chain, directly or through `payments/audit`. A `PaymentRecord`
 *     insert that imports neither is money moving with no evidence of record.
 *  3. NOTHING TALKS TO THE DATABASE THROUGH POSTGREST. `/rest/v1/` in `src/**`
 *     or `workers/**` means a writer bypassing Prisma — and with it the
 *     migrations, the tenant scope, and the `no_modify_audit` trigger.
 *  4. NO SIGNATURE IS COMPUTED OVER RE-SERIALISED JSON. `HMAC(JSON.stringify(p))`
 *     verifies only against the key order and whitespace this process happened to
 *     emit. The scaffold did exactly that, so a body that round-tripped through
 *     `JSON.parse` could never verify, and any deployment that "fixed" it by
 *     re-stringifying the same way would be verifying its own serialiser.
 *  5. AN INBOUND SURFACE THAT MOVES MONEY OR OPENS A CASE READS RAW BYTES ONCE.
 *     `req.text()` yes, `req.json()` no — the digest is over the bytes, and a
 *     framework-parsed body has already lost them.
 *  6. THE WEBHOOK ACTS ON A MISSING RECORD. `auditRecorded` must be read and must
 *     produce a retryable 5xx, or the flag is a field nobody branches on.
 *  7. THE MONEY `callRef` SCHEME IS NOT RE-INVENTED INLINE. `PAY-${...}` outside
 *     `payments/audit.ts` silently truncates at the chain's 64-character ceiling
 *     and then verifies against a string nothing ever stored.
 *  8. A DECLINED ACTION IS STILL AN ACTION. The case path records its replay, the
 *     money path records its refusals — the decisions that look like nothing
 *     happened are the ones a dispute is actually about.
 *
 *   bun scripts/run-tests.mjs money-case-audit
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";

const ROOT = process.cwd();

const toPosix = (p: string): string =>
  p
    .split(/[\\/]+/)
    .join("/")
    .replace(/\/$/, "");
const ROOT_POSIX = toPosix(ROOT);

/** Repo-relative, POSIX-separated — so a reported offender reads the same on
 *  every platform and can be compared against the declared lists above. */
const rel = (p: string): string => posix.relative(ROOT_POSIX, toPosix(p));

const toAbsolute = (p: string): string => join(ROOT, ...p.split("/"));

function isFile(p: string): boolean {
  try {
    return statSync(toAbsolute(p)).isFile();
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(toAbsolute(p)).isDirectory();
  } catch {
    return false;
  }
}

/** Returns ABSOLUTE paths; `read()` takes them as-is, `rel()` reports them. */
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name === "generated") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

const SRC_FILES = walk(join(ROOT, "src"));
// `workers/` is where the deleted inbound scaffold sat. Its absence is fine and
// asserted below; the scan still covers it, because a directory recreated there
// is exactly the regression being guarded against.
const ALL_SCANNED = isDir("workers") ? [...SRC_FILES, ...walk(toAbsolute("workers"))] : SRC_FILES;

const read = (absolutePath: string): string => readFileSync(absolutePath, "utf8");
const readRel = (relativePath: string): string => readFileSync(toAbsolute(relativePath), "utf8");

/** Rule 1's allow-list. Adding a file here is a design decision, not a fix. */
const MONEY_WRITERS = [
  "src/lib/payments/provider.ts",
  "src/lib/payments/manual-invoice.ts",
  "src/lib/payments/overage.ts",
  "src/lib/billing/ledger.ts",
];

/**
 * Rule 2 applies to the writers of `PaymentRecord` — the row that IS the money
 * fact. `src/lib/billing/ledger.ts` writes only `UsageLedger`, the append-only
 * trail every `PaymentRecord` writer already calls inside its own transaction,
 * and it is the chained callers above that put the movement in the chain. Two
 * chained writers of one ledger row would double-count the same credit.
 */
const PAYMENT_RECORD_WRITERS = [
  "src/lib/payments/provider.ts",
  "src/lib/payments/manual-invoice.ts",
  "src/lib/payments/overage.ts",
];

/** Rule 5, family A: verification is an HMAC over the exact request bytes. */
const RAW_BODY_ROUTES = [
  "src/app/api/billing/webhook/route.ts",
  "src/app/api/v1/interventions/route.ts",
];

/** Rule 5, family B: the vendor's own scheme, checked by the vendor's verifier. */
const VENDOR_VERIFIED_ROUTES: [string, string][] = [
  // Twilio signs a canonical string built from the SORTED FORM PARAMETERS, not
  // the raw body — demanding `req.text()` here would forbid the correct shape.
  ["src/app/api/twilio/turn/route.ts", "verifyTwilioSignature"],
  ["src/app/api/twilio/inbound-voice/route.ts", "verifyTwilioSignature"],
  // Agent tool calls are guarded by one shared verifier rather than per route.
  ["src/app/api/elevenlabs/tools/card-freeze/route.ts", "guardToolCall"],
];

const MONEY_TABLE = /INSERT INTO "(PaymentRecord|UsageLedger)"/;
const POSTGREST = /\/rest\/v1\//;
const RESERIALISED_DIGEST = /createHmac\([^)]*\)[\s\S]{0,200}?\.update\(\s*JSON\.stringify\(/;
const INLINE_PAY_CALLREF = /`PAY-\$\{/;

/** The writers found in the tree right now, so the gate reports a set, not a count. */
function moneyWriterFiles(files: string[]): string[] {
  return files.filter((f) => MONEY_TABLE.test(read(f)));
}

describe("rule 1 — money has named writers and no others", () => {
  test("only the declared modules insert into PaymentRecord or UsageLedger", () => {
    const found = moneyWriterFiles(ALL_SCANNED).map(rel).sort();
    const undeclared = found.filter((f) => !MONEY_WRITERS.includes(f));
    expect(undeclared).toEqual([]);
    // Non-vacuous: the list must actually be populated, or `undeclared` proves
    // nothing and a scanner that lost its pattern would look identical to a
    // clean tree.
    expect(found.length).toBe(MONEY_WRITERS.length);
  });

  test("the scanner reports an undeclared writer when one is introduced", () => {
    // Guards the guard. This is the case that makes the assertion above a gate
    // rather than a description.
    const violating = `
      const row = await db.$queryRaw\`
        INSERT INTO "PaymentRecord" ("id", "orgId") VALUES ($1, $2)
      \`;`;
    expect(MONEY_TABLE.test(violating)).toBe(true);
    const ledgerWrite = `INSERT INTO "UsageLedger" ("id", "orgId") VALUES ($1, $2)`;
    expect(MONEY_TABLE.test(ledgerWrite)).toBe(true);
    expect(MONEY_TABLE.test('SELECT * FROM "PaymentRecord"')).toBe(false);
  });
});

describe("rule 2 — every money writer can prove what it wrote", () => {
  test("each PaymentRecord writer reaches the tamper-evident chain", () => {
    const unwired = PAYMENT_RECORD_WRITERS.filter(
      (f) => !/@\/lib\/payments\/audit|@\/lib\/audit-chain/.test(readRel(f)),
    );
    expect(unwired).toEqual([]);
    // And the list is the one rule 1 declares, not a subset that quietly
    // stopped covering a writer.
    const recordWriters = ALL_SCANNED.filter((f) =>
      /INSERT INTO "PaymentRecord"/.test(read(f)),
    ).map(rel);
    expect(recordWriters.sort()).toEqual([...PAYMENT_RECORD_WRITERS].sort());
  });

  test("settlePayment reports whether its record landed", () => {
    const src = readRel("src/lib/payments/provider.ts");
    expect(src).toContain("auditRecorded");
    // The reconstruction path: a redelivery must be able to rebuild evidence an
    // outage destroyed, from the payment row that survived it.
    expect(src).toContain("reconstructed");
  });
});

describe("rule 3 — nothing bypasses the database layer", () => {
  test("no source file writes through PostgREST", () => {
    const offenders = ALL_SCANNED.filter((f) => POSTGREST.test(read(f))).map(rel);
    expect(offenders).toEqual([]);
  });

  test("the scanner catches the exact shape the deleted scaffold used", () => {
    const scaffold = `
      const res = await fetch(\`\${env.SUPABASE_URL}/rest/v1/interventions\`, {
        method: "POST",
        headers: { apikey: env.SUPABASE_SERVICE_KEY },
      });`;
    expect(POSTGREST.test(scaffold)).toBe(true);
  });

  test("the inbound webhook bypass is gone from both worker locations", () => {
    for (const path of ["src/worker/inbound-webhook.ts", "workers/inbound-webhook.ts"]) {
      expect({ path, present: isFile(path) }).toEqual({ path, present: false });
    }
    // And nothing still points at the route only that scaffold published to.
    const dangling = ALL_SCANNED.filter((f) => read(f).includes("worker-trigger-call")).map(rel);
    expect(dangling).toEqual([]);
  });
});

describe("rule 4 — no digest is computed over re-serialised JSON", () => {
  test("the tree contains none", () => {
    const offenders = ALL_SCANNED.filter((f) => RESERIALISED_DIGEST.test(read(f))).map(rel);
    expect(offenders).toEqual([]);
  });

  test("the scanner catches the scaffold's verifier", () => {
    const scaffoldVerifier = `
      const expected = createHmac("sha256", secret).update(JSON.stringify(payload)).digest("hex");`;
    expect(RESERIALISED_DIGEST.test(scaffoldVerifier)).toBe(true);
    // The correct shape must NOT trip it: raw bytes, prefixed with the timestamp.
    const correct = `
      const expected = createHmac("sha256", secret).update(\`\${t}.\${rawBody}\`).digest("hex");`;
    expect(RESERIALISED_DIGEST.test(correct)).toBe(false);
  });
});

describe("rule 5 — a signed inbound surface reads raw bytes once", () => {
  test("every body-digest route reads the bytes and never re-parses them", () => {
    expect(RAW_BODY_ROUTES.length).toBeGreaterThanOrEqual(2);
    const broken: string[] = [];
    for (const path of RAW_BODY_ROUTES) {
      const src = readRel(path);
      if (!src.includes("req.text()")) broken.push(`${path}: no raw-body read`);
      if (/await req\.json\(\)/.test(src)) broken.push(`${path}: parsed body on a signed path`);
    }
    expect(broken).toEqual([]);
  });

  test("every vendor-scheme route calls the vendor's verifier", () => {
    // Twilio's signature covers a canonical string built from the sorted FORM
    // PARAMETERS and the request URL, and agent tool calls are guarded by one
    // shared verifier. Demanding `req.text()` from either would forbid the
    // shape that is actually correct, so this family is checked on its own term:
    // the vendor's verifier must be the thing that decides.
    const broken: string[] = [];
    for (const [path, verifier] of VENDOR_VERIFIED_ROUTES) {
      if (!readRel(path).includes(verifier)) broken.push(`${path}: ${verifier} not called`);
    }
    expect(broken).toEqual([]);
  });

  test("a route that parses the body instead of reading it is reported", () => {
    const violating = `export async function POST(req: NextRequest) {
      const payload = await req.json();
      return NextResponse.json({ ok: true });
    }`;
    expect(violating.includes("req.text()")).toBe(false);
    expect(/await req\.json\(\)/.test(violating)).toBe(true);
  });
});

describe("rule 6 — the webhook acts on a missing record", () => {
  test("an unsettled audit is refused with a retryable status", () => {
    const src = readRel("src/app/api/billing/webhook/route.ts");
    expect(src).toContain("if (!result.auditRecorded)");
    expect(src).toContain("audit_record_incomplete");
    expect(/audit_record_incomplete[\s\S]{0,160}status: 500/.test(src)).toBe(true);
  });

  test("a delivery with no reference of ours never mints a chain row", () => {
    // The boundary that keeps the tamper-evident log from becoming somebody
    // else's mailbox: only money we minted a reference for is chained.
    const src = readRel("src/app/api/billing/webhook/route.ts");
    const ignored = src.slice(
      src.indexOf("transaction without our reference"),
      src.indexOf("transaction without our reference") + 400,
    );
    expect(ignored).not.toContain("auditMoney");
    expect(src).toContain("auditMoney");
  });
});

describe("rule 7 — the money callRef scheme is not re-invented inline", () => {
  test("only payments/audit.ts builds a PAY- reference", () => {
    const offenders = SRC_FILES.filter((f) => {
      const p = rel(f);
      return p !== "src/lib/payments/audit.ts" && INLINE_PAY_CALLREF.test(read(f));
    }).map(rel);
    expect(offenders).toEqual([]);
  });

  test("the helper exists, and it is the ceiling-aware one", () => {
    const src = readRel("src/lib/payments/audit.ts");
    expect(src).toContain("export function moneyChainRef");
    expect(src).toContain("64");
  });
});

describe("rule 8 — a declined action is still an action", () => {
  test("the case path records the replay it refuses", () => {
    const src = readRel("src/app/api/v1/interventions/route.ts");
    expect(src).toContain('intent: "signal_replay"');
  });

  test("the money path records the refusals it returns", () => {
    const intents = [
      "settlement_refused",
      "payment_settlement_failed",
      "payment_refund_unknown_reference",
      "invoice_issuance_failed",
      "price_adhoc_failed",
      "gateway_refund_requested",
    ];
    const money = [
      readRel("src/app/api/billing/webhook/route.ts"),
      readRel("src/lib/payments/provider.ts"),
      readRel("src/lib/payments/paddle.ts"),
    ].join("\n");
    const missing = intents.filter((i) => !money.includes(i));
    expect(missing).toEqual([]);
  });

  test("the negotiated amount a gateway price was minted for is named in the record", () => {
    // The artifact no query of ours can see afterwards: a `price_id` for an
    // arbitrary figure, created on the gateway's side with our key.
    const src = readRel("src/lib/payments/paddle.ts");
    expect(src).toContain('"price_adhoc_minted"');
    expect(src).toContain("priceId");
    expect(src).toContain('"invoice_issued"');
  });
});

describe("the scans themselves are not vacuous", () => {
  test("the walk found the surface it claims to cover", () => {
    expect(SRC_FILES.length).toBeGreaterThan(200);
    const routes = SRC_FILES.filter((f) => rel(f).startsWith("src/app/api/")).length;
    expect(routes).toBeGreaterThan(20);
    for (const path of [...RAW_BODY_ROUTES, ...VENDOR_VERIFIED_ROUTES.map(([p]) => p)]) {
      expect(isFile(path)).toBe(true);
    }
    for (const path of MONEY_WRITERS) {
      expect(isFile(path)).toBe(true);
    }
    // The scaffold's second home must stay absent: `workers/` was where the
    // byte-identical duplicate lived, and recreating it recreates the bypass.
    expect(isDir("workers")).toBe(false);
  });

  test("POSTGREST, RESERIALISED_DIGEST and INLINE_PAY_CALLREF each fire on their own violation", () => {
    expect(POSTGREST.test("fetch(`${url}/rest/v1/things`)")).toBe(true);
    expect(RESERIALISED_DIGEST.test('createHmac("sha256", k).update(JSON.stringify(p))')).toBe(
      true,
    );
    expect(INLINE_PAY_CALLREF.test("const callRef = `PAY-${reference}`;")).toBe(true);
    // And not on the corrected forms.
    expect(INLINE_PAY_CALLREF.test("const callRef = moneyChainRef(reference);")).toBe(false);
  });
});
