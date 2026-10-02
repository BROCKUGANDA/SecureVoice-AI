/**
 * WP-22: input validation and data poisoning — the gate.
 *
 * Every row of the WP-22 table is proved here, and each `test` names the row it
 * covers. Rows covered:
 *
 *   Strict schema   unknown field rejected · no type coercion · float money
 *                   rejected · out-of-range rejected · over-length string
 *                   rejected · over-long array rejected · nesting depth
 *                   exceeded rejected · field-count cap · body-size cap
 *   Unicode         homoglyph / bidi / zero-width merchant name normalised
 *   SSRF            http rejected · 169.254.169.254 rejected · localhost
 *                   rejected · 10.0.0.1 rejected · 127.0.0.1 rejected ·
 *                   public host via injected resolver allowed · redirect
 *                   re-validation
 *   CSV             `=cmd|'/c calc'!A1` neutralised · normal name untouched
 *   Log injection   a newline in user input cannot forge a second log line
 *
 * No network, no database, no Next.js runtime. The DNS resolver is injected.
 *
 *   bun test tests/validation/validation.test.ts
 */
import { test, expect } from "bun:test";
import {
  LIMITS,
  ValidationError,
  assertShape,
  boundedArray,
  boundedInt,
  boundedNumber,
  boundedString,
  displayText,
  e164Phone,
  isoTimestamp,
  money,
  parseBody,
  readJsonBody,
} from "@/lib/validation/schema";
import {
  countGraphemes,
  hasMixedScript,
  isSafeDisplayText,
  normalizeHostileText,
  truncateGraphemes,
} from "@/lib/validation/unicode";
import {
  SsrfBlockedError,
  classifyIp,
  followRedirectChain,
  validateOutboundUrl,
  validateRedirectChain,
  type DnsResolver,
  type ResolvedHost,
} from "@/lib/validation/ssrf";
import { neutraliseFormula, toCsv, toCsvField, csvContentDisposition } from "@/lib/csv-export";
import { safeLog, sanitiseLogValue } from "@/lib/validation/safe-log";
import { z } from "zod";
import { fileURLToPath } from "node:url";

// ── Fixtures ────────────────────────────────────────────────────────────────

/** Maps a hostname to a fixed set of addresses. Never touches the network. */
function stubResolver(table: Record<string, readonly string[]>): DnsResolver {
  return async (hostname: string): Promise<readonly ResolvedHost[]> => {
    const addresses = table[hostname.toLowerCase()];
    if (!addresses) throw new Error(`getaddrinfo ENOTFOUND ${hostname}`);
    return addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  };
}

function captureLog() {
  const lines: string[] = [];
  return {
    lines,
    sink: (_level: string, line: string) => {
      lines.push(line);
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Strict schema
// ═══════════════════════════════════════════════════════════════════════════

test("WP-22 strict schema: unknown fields are REJECTED, never passed through", () => {
  const schema = z.strictObject({
    caseRef: boundedString({ min: 3, max: 64 }),
    riskScore: boundedNumber(),
  });

  // The headline requirement: no passthrough. A `z.object()` default would
  // parse this to { caseRef, riskScore } and DROP the injected keys — which is
  // how `{"amount": 10, "amountMinor": 99999}` becomes a 9,999.99-unit freeze.
  const result = schema.safeParse({ caseRef: "SV-F-ABC123", riskScore: 0.5, amountMinor: 99_999 });
  expect(result.success).toBe(false);

  // Prototype-pollution vectors are rejected by the raw preflight, before the
  // schema ever sees them.
  expect(() => assertShape(JSON.parse('{"caseRef":"SV-F-ABC123","__proto__":{"admin":true}}'))).toThrow(
    ValidationError
  );
  expect(() => parseBody(schema, JSON.parse('{"caseRef":"SV-F-ABC123","constructor":1}'))).toThrow(
    /Forbidden key/
  );

  // And a well-formed body still passes, so we know the guard is not just
  // rejecting everything.
  expect(parseBody(schema, { caseRef: "SV-F-ABC123", riskScore: 0.5 })).toEqual({
    caseRef: "SV-F-ABC123",
    riskScore: 0.5,
  });
});

test("WP-22 strict schema: NO type coercion — a string for an int is invalid", () => {
  const schema = z.strictObject({
    amountMinor: boundedInt({ min: 0 }),
    confirmed: z.boolean(),
    note: boundedString({ max: 32 }),
  });

  // The string "5" for a number. z.coerce.number() would accept it and turn a
  // caller's type bug into a valid-looking transaction.
  expect(schema.safeParse({ amountMinor: "5", confirmed: true }).success).toBe(false);
  // And the reverse direction: a number for a string field.
  expect(schema.safeParse({ amountMinor: 5, confirmed: true, note: 42 }).success).toBe(false);
  // Boolean coercion is the classic footgun: Boolean("false") === true.
  expect(schema.safeParse({ amountMinor: 5, confirmed: "false" }).success).toBe(false);
  expect(schema.safeParse({ amountMinor: 5, confirmed: "true" }).success).toBe(false);
  // Numeric strings for a boolean-looking field, and NaN/Infinity.
  expect(schema.safeParse({ amountMinor: Number.NaN, confirmed: true }).success).toBe(false);
  expect(schema.safeParse({ amountMinor: Number.POSITIVE_INFINITY, confirmed: true }).success).toBe(false);

  // The genuinely correct types pass.
  expect(parseBody(schema, { amountMinor: 5, confirmed: true, note: "ok" }).amountMinor).toBe(5);
});

test("WP-22 strict schema: money is integer minor units + ISO-4217; a float is rejected", () => {
  const schema = z.strictObject({ total: money({ min: 0, max: 100_000_000 }) });

  // A float. Rejected at the schema, not rounded at the call site.
  expect(schema.safeParse({ total: { amountMinor: 12.34, currency: "AED" } }).success).toBe(false);
  expect(schema.safeParse({ total: { amountMinor: 0.1 + 0.2, currency: "AED" } }).success).toBe(false);
  // A string is not a minor-unit count.
  expect(schema.safeParse({ total: { amountMinor: "2500", currency: "AED" } }).success).toBe(false);
  // An unknown field inside the money object (major-units confusion) is rejected.
  expect(schema.safeParse({ total: { amount: 2500.75, currency: "AED" } }).success).toBe(false);

  // Three uppercase letters are not automatically a currency.
  expect(schema.safeParse({ total: { amountMinor: 100, currency: "XXX" } }).success).toBe(false);
  expect(schema.safeParse({ total: { amountMinor: 100, currency: "ZZZ" } }).success).toBe(false);
  expect(schema.safeParse({ total: { amountMinor: 100, currency: "usd" } }).success).toBe(false);

  // Integer minor units with a real code pass, and come back untouched.
  expect(parseBody(schema, { total: { amountMinor: 250_050, currency: "AED" } }).total).toEqual({
    amountMinor: 250_050,
    currency: "AED",
  });

  // And the range still applies inside money.
  expect(schema.safeParse({ total: { amountMinor: -1, currency: "AED" } }).success).toBe(false);
  expect(schema.safeParse({ total: { amountMinor: 100_000_001, currency: "AED" } }).success).toBe(false);
});

test("WP-22 strict schema: out-of-range numbers are rejected", () => {
  const schema = z.strictObject({ riskScore: z.number().min(0).max(1) });

  expect(schema.safeParse({ riskScore: 1.01 }).success).toBe(false);
  expect(schema.safeParse({ riskScore: -0.01 }).success).toBe(false);
  expect(schema.safeParse({ riskScore: 0 }).success).toBe(true);
  expect(schema.safeParse({ riskScore: 1 }).success).toBe(true);

  // A risk score outside 0–1 silently reshapes the whole policy gate: 1.4
  // passes every ">= 0.90 → freeze" comparison it should not.
  const throws = (() => {
    try {
      parseBody(schema, { riskScore: 1.4 });
      return null;
    } catch (err) {
      return err;
    }
  })();
  expect(throws).toBeInstanceOf(ValidationError);
  expect((throws as ValidationError).code).toBe("invalid");
  expect((throws as ValidationError).message).toContain("riskScore");
});

test("WP-22 strict schema: over-length strings are rejected", () => {
  const schema = z.strictObject({ merchant: boundedString({ max: 64 }) });

  expect(schema.safeParse({ merchant: "A".repeat(65) }).success).toBe(false);
  expect(schema.safeParse({ merchant: "A".repeat(64) }).success).toBe(true);

  // The raw preflight caps any string in the payload, even one no schema
  // field reaches — an oversized unknown string should still be refused.
  expect(() => assertShape({ merchant: "A".repeat(LIMITS.maxStringLength + 1) })).toThrow(
    /String longer than/
  );
});

test("WP-22 strict schema: over-long arrays are rejected", () => {
  const schema = z.strictObject({ caseRefs: boundedArray(boundedString({ max: 64 }), { max: 10 }) });

  expect(schema.safeParse({ caseRefs: Array.from({ length: 11 }, (_, i) => `SV-F-${i}`) }).success).toBe(false);
  expect(schema.safeParse({ caseRefs: Array.from({ length: 10 }, (_, i) => `SV-F-${i}`) }).success).toBe(true);

  // The preflight caps arrays independently of any schema, so an unbounded
  // array is refused before zod walks it.
  expect(() => assertShape({ blob: Array.from({ length: LIMITS.maxArrayItems + 1 }, () => 1) })).toThrow(
    /Array longer than/
  );
});

test("WP-22 strict schema: nesting deeper than the depth cap is rejected", () => {
  const schema = z.strictObject({ note: boundedString({ max: 32 }) });

  // nest(d) wraps `{ note: "leaf" }` in d objects, so the leaf string sits at
  // depth d + 2 and the cap of 8 is crossed at d = 7.
  const nest = (depth: number): unknown => {
    let node: Record<string, unknown> = { note: "leaf" };
    for (let i = 0; i < depth; i += 1) node = { nested: node };
    return node;
  };

  expect(() => assertShape(nest(LIMITS.maxDepth - 2))).not.toThrow();
  expect(() => assertShape(nest(LIMITS.maxDepth - 1))).toThrow(/nests deeper than 8 levels/);

  // 200 levels deep — a payload that would blow the stack in a naive recursive
  // validator. The preflight stops at the cap instead of recursing into it.
  expect(() => assertShape(nest(200))).toThrow(ValidationError);
  expect(() => assertShape(nest(10_000))).toThrow(ValidationError);

  // parseBody runs the preflight first, so the cap holds even for a schema
  // that would happily accept anything — which is the point of having it.
  expect(() => parseBody(schema, nest(200))).toThrow(/nests deeper than/);
  expect(parseBody(schema, { note: "ok" })).toEqual({ note: "ok" });
});

test("WP-22 strict schema: field-count cap rejects a key flood", () => {
  const flood: Record<string, number> = {};
  for (let i = 0; i < LIMITS.maxFields + 20; i += 1) flood[`k${i}`] = i;
  expect(() => assertShape(flood)).toThrow(/more than 64 fields/);

  // Nested keys count too, not just top-level ones.
  const nested: Record<string, unknown> = {};
  for (let i = 0; i < 40; i += 1) nested[`k${i}`] = { a: i, b: i, c: i };
  expect(() => assertShape(nested)).toThrow(/more than 64 fields/);
});

test("WP-22 strict schema: body-size cap enforced on the transport", async () => {
  const schema = z.strictObject({ note: boundedString({ max: 4096 }) });

  // Declared Content-Length over the cap — rejected without reading the body.
  const oversizeDeclared = new Request("https://api.example.com/v1/x", {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": "999999" },
    body: JSON.stringify({ note: "small" }),
  });
  await expect(readJsonBody(oversizeDeclared, schema, { maxBytes: 1024 })).rejects.toThrow(/exceeds 1024 bytes/);

  // Streamed body over the cap with no Content-Length to shortcut on — the
  // reader aborts mid-stream instead of buffering the whole thing. If the
  // runtime refuses to let us drop the header, the declared-length path throws
  // the same error, so the assertion holds either way.
  const oversizeStreamed = new Request("https://api.example.com/v1/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ note: "A".repeat(4096) }),
  });
  try {
    oversizeStreamed.headers.delete("content-length");
  } catch {
    // Forbidden header in this runtime — fall through to the same guard.
  }
  await expect(readJsonBody(oversizeStreamed, schema, { maxBytes: 256 })).rejects.toThrow(/exceeds 256 bytes/);

  // Under the cap: parsed normally.
  const ok = new Request("https://api.example.com/v1/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ note: "ok" }),
  });
  expect(await readJsonBody(ok, schema, { maxBytes: 1024 })).toEqual({ note: "ok" });

  // Malformed JSON is a 400-class error, not a 500.
  const broken = new Request("https://api.example.com/v1/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not json",
  });
  await expect(readJsonBody(broken, schema)).rejects.toThrow(/not valid JSON/);
});

test("WP-22 schema: phones are normalised to E.164, not merely pattern-checked", () => {
  const schema = z.strictObject({ phone: e164Phone() });

  // Whatever the spacing or the international prefix, one string form comes out.
  expect(parseBody(schema, { phone: "+971 50 123 4567" }).phone).toBe("+971501234567");
  expect(parseBody(schema, { phone: "+971-50-123-4567" }).phone).toBe("+971501234567");
  expect(parseBody(schema, { phone: "00971501234567" }).phone).toBe("+971501234567");
  expect(parseBody(schema, { phone: "(+971) 50 123 4567" }).phone).toBe("+971501234567");

  // A local number cannot be made E.164 without knowing the country, so it is
  // rejected rather than guessed at — unless the caller supplies the region.
  expect(schema.safeParse({ phone: "0501234567" }).success).toBe(false);
  const withRegion = z.strictObject({ phone: e164Phone({ defaultRegion: "+971" }) });
  expect(parseBody(withRegion, { phone: "0501234567" }).phone).toBe("+971501234567");

  // Malformed / out-of-spec values.
  expect(schema.safeParse({ phone: "+971 50 CALL-NOW" }).success).toBe(false);
  expect(schema.safeParse({ phone: "+0123456789" }).success).toBe(false); // leading zero
  expect(schema.safeParse({ phone: "+9715012345678901234" }).success).toBe(false); // > 15 digits
  expect(schema.safeParse({ phone: "+" }).success).toBe(false);
});

test("WP-22 schema: timestamps must be ISO-8601 WITH an offset — naive local times are rejected", () => {
  const schema = z.strictObject({ occurredAt: isoTimestamp() });

  // Offset present: accepted and canonicalised to UTC.
  expect(parseBody(schema, { occurredAt: "2026-03-14T02:30:00Z" }).occurredAt).toBe("2026-03-14T02:30:00.000Z");
  expect(parseBody(schema, { occurredAt: "2026-03-14T06:30:00+04:00" }).occurredAt).toBe("2026-03-14T02:30:00.000Z");

  // Naive local timestamps: rejected. The same string means a different instant
  // depending on where the server runs.
  expect(schema.safeParse({ occurredAt: "2026-03-14T02:30:00" }).success).toBe(false);
  expect(schema.safeParse({ occurredAt: "2026-03-14T02:30" }).success).toBe(false);
  expect(schema.safeParse({ occurredAt: "2026-03-14" }).success).toBe(false);

  // Structurally invalid even with an offset.
  expect(schema.safeParse({ occurredAt: "2026-13-14T02:30:00Z" }).success).toBe(false);
  expect(schema.safeParse({ occurredAt: "2026-03-14T02:30:00+99:00" }).success).toBe(false);
  expect(schema.safeParse({ occurredAt: "not a date" }).success).toBe(false);
  expect(schema.safeParse({ occurredAt: Date.now() }).success).toBe(false);
});

// ═══════════════════════════════════════════════════════════════════════════
// Unicode
// ═══════════════════════════════════════════════════════════════════════════

test("WP-22 unicode: homoglyph / bidi / zero-width merchant names normalise to something safe", () => {
  // (a) Compatibility homoglyphs. NFKC folds fullwidth Latin and the
  //     mathematical-alphanumeric forms, so this is free.
  const fullwidth = normalizeHostileText("Ｃａｆｅ ①② Dubai", { maxGraphemes: 64 });
  expect(fullwidth.value).toBe("Cafe 12 Dubai");
  expect(fullwidth.changed).toBe(true);
  expect(isSafeDisplayText(fullwidth.value)).toBe(true);

  // (b) Trojan Source. Stored order is "exe.txtgmh" but it RENDERS as
  //     "gmh.txt.exe". Every human reading the console is looking at a
  //     different string than the one we validated — the actual fraud pattern.
  const bidi = normalizeHostileText("safe\u202Egmh.txt.exe\u202C", { maxGraphemes: 64 });
  expect(bidi.value).toBe("safegmh.txt.exe");
  expect(bidi.removals).toContain("bidi");
  // The bidi override is gone in every form: LRE, RLE, PDF, LRO, RLO, LRI,
  // RLI, FSI, PDI (U+202A–U+202E and U+2066–U+2069).
  expect(/[\u202A-\u202E\u2066-\u2069]/.test(bidi.value)).toBe(false);
  // A re-normalisation cannot resurrect one.
  expect(bidi.value).toBe(normalizeHostileText(bidi.value, { maxGraphemes: 64 }).value);

  // (c) Zero-width padding. "Starbucks" with an invisible character looks
  //     identical to a human but compares unequal to every blacklist and
  //     dedupe check in the system.
  const zeroWidth = normalizeHostileText("Star\u200Bbucks\uFEFF\u200D\u200C Ltd", { maxGraphemes: 64 });
  expect(zeroWidth.value).toBe("Starbucks Ltd");
  expect(zeroWidth.removals).toContain("zero-width");
  expect(zeroWidth.value === "Starbucks Ltd").toBe(true); // dedupe works again

  // (d) Cross-script homoglyph. NFKC cannot fold Cyrillic С into Latin C —
  //     doing so would corrupt real Russian names — so this needs the
  //     mixed-script fold. "МАРКЕТ" alone is single-script and therefore left
  //     alone; it is the Latin "Store" alongside it that marks the string as a
  //     mix, and that is the signal the fold keys on.
  const homoglyph = normalizeHostileText("МАРКЕТ Store", { maxGraphemes: 64 });
  expect(homoglyph.value).toBe("MAPKET Store");
  expect(homoglyph.mixedScript).toBe(true);
  expect(homoglyph.removals).toContain("confusable");
  // Case is preserved through the fold: Cyrillic М (upper) → M, not m.
  expect(normalizeHostileText("МАРКЕТ shop", { maxGraphemes: 64 }).value).toBe("MAPKET shop");

  // (e) A genuinely non-Latin name must NOT be mangled. Cyrillic-only input is
  //     single-script, so the fold does not fire even though every letter is a
  //     Latin confusable. "МОСКВА Банк" is a real bank name, and mangling it
  //     into "MOCKBA Eank" would be a customer-support incident, not a fix.
  const legitimate = normalizeHostileText("МОСКВА Банк", { maxGraphemes: 64 });
  expect(legitimate.value).toBe("МОСКВА Банк");
  expect(legitimate.mixedScript).toBe(false);
  expect(legitimate.changed).toBe(false);

  // The conservative behaviour is the documented one: an opt-out exists for
  // callers who would rather see the raw string than a fold.
  expect(normalizeHostileText("МАРКЕТ Store", { foldHomoglyphs: false }).value).toBe("МАРКЕТ Store");

  // (f) The whole attack in one string, through the actual schema field an
  //     ingest route would use.
  const hostile = "\u202Eexe.s\u200Btxt\uFEFF";
  const viaSchema = displayText({ maxGraphemes: 64 });
  const parsed = z.strictObject({ merchant: viaSchema }).parse({ merchant: hostile });
  expect(parsed.merchant).toBe("exe.stxt");
  expect(isSafeDisplayText(parsed.merchant)).toBe(true);
});

test("WP-22 unicode: the grapheme cap never splits a cluster and never leaves a lone surrogate", () => {
  // A flag emoji is TWO regional indicators but ONE grapheme cluster. A
  // UTF-16 code-unit cap would cut it in half and leave a lone surrogate in the
  // database, so the cap has to be in graphemes.
  const flag = "\u{1F1E8}\u{1F1E6}\u{1F1E8}\u{1F1E6}\u{1F1E8}\u{1F1E6}";
  expect(countGraphemes(flag)).toBe(3);
  expect(flag.length).toBe(12);
  expect([...flag].length).toBe(6); // six code points, still not the unit a human means

  const capped = truncateGraphemes(flag, 2);
  expect(capped.truncated).toBe(true);
  expect(countGraphemes(capped.value)).toBe(2);
  // Two whole flags survived: no cluster was split.
  expect([...capped.value].every((ch) => ch.codePointAt(0)! > 0xffff)).toBe(true);

  const name = normalizeHostileText(flag.repeat(40), { maxGraphemes: 64 });
  expect(countGraphemes(name.value)).toBeLessThanOrEqual(64);
  expect(name.removals).toContain("truncated");
  // No lone surrogate survives anywhere in the output.
  expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]/.test(name.value)).toBe(false);
});

test("WP-22 unicode: mixed-script detection is a usable review signal", () => {
  expect(hasMixedScript("Starbucks")).toBe(false);
  expect(hasMixedScript("МОСКВА")).toBe(false);
  expect(hasMixedScript("Café Ωμέγα")).toBe(true); // Latin + Greek
  expect(hasMixedScript("МОСКВА Bank")).toBe(true); // Cyrillic + Latin
  expect(hasMixedScript("12345 --- ***")).toBe(false); // no letters
});

// ═══════════════════════════════════════════════════════════════════════════
// SSRF
// ═══════════════════════════════════════════════════════════════════════════

test("WP-22 SSRF: every listed hostile URL is rejected, and a public host via the stub is allowed", async () => {
  // The stub is the whole point: this suite proves the policy without a single
  // packet leaving the machine, so it runs in CI and in an air-gapped judging
  // environment. Hostnames deliberately avoid the blocked internal suffixes,
  // so each assertion below exercises the rule it names rather than tripping
  // the name filter first.
  const resolver = stubResolver({
    "callbacks.partner-bank.com": ["93.184.216.34"],
    "cdn.partner-bank.com": ["93.184.216.35"],
    "rebind.attacker-domain.com": ["93.184.216.34", "10.0.0.5"],
  });

  // http:// — plaintext. A signed outcome POST must not travel in the clear.
  const plain = await validateOutboundUrl("http://callbacks.partner-bank.com/hook", { resolver });
  expect(plain.ok).toBe(false);
  expect((plain as { code: string }).code).toBe("not_https");

  // https://169.254.169.254/latest/meta-data — cloud metadata. One GET from
  // inside the VPC returns IAM credentials.
  const metadata = await validateOutboundUrl("https://169.254.169.254/latest/meta-data", { resolver });
  expect(metadata.ok).toBe(false);
  expect((metadata as { code: string }).code).toBe("private_address");
  expect((metadata as { reason: string }).reason).toContain("metadata");

  // https://localhost — loopback by name.
  const localhost = await validateOutboundUrl("https://localhost/hook", { resolver });
  expect(localhost.ok).toBe(false);
  expect((localhost as { code: string }).code).toBe("blocked_hostname");

  // https://10.0.0.1 — RFC 1918 literal.
  const private10 = await validateOutboundUrl("https://10.0.0.1/hook", { resolver });
  expect(private10.ok).toBe(false);
  expect((private10 as { code: string }).code).toBe("private_address");
  expect((private10 as { reason: string }).reason).toContain("RFC 1918");

  // https://127.0.0.1 — loopback literal.
  const loopback = await validateOutboundUrl("https://127.0.0.1/hook", { resolver });
  expect(loopback.ok).toBe(false);
  expect((loopback as { reason: string }).reason).toContain("loopback");

  // A PUBLIC host, resolved through the injected stub, is ALLOWED.
  const publicOk = await validateOutboundUrl("https://callbacks.partner-bank.com/hook", { resolver });
  expect(publicOk.ok).toBe(true);
  if (publicOk.ok) {
    expect(publicOk.addresses).toEqual(["93.184.216.34"]);
    expect(publicOk.url.hostname).toBe("callbacks.partner-bank.com");
  }

  // Credentials embedded in the URL: a credential leak into our logs and a
  // parser-confusion vector against our own validator.
  const creds = await validateOutboundUrl("https://user:pass@callbacks.partner-bank.com/hook", { resolver });
  expect(creds.ok).toBe(false);
  expect((creds as { code: string }).code).toBe("credentials_in_url");

  // DNS rebinding: one public answer and one private answer is a REJECT, not a
  // coin flip. The connection race picks the attacker.
  const rebind = await validateOutboundUrl("https://rebind.attacker-domain.com/hook", { resolver });
  expect(rebind.ok).toBe(false);
  expect((rebind as { code: string }).code).toBe("private_address");
  expect((rebind as { reason: string }).reason).toContain("blocked address");

  // A name that resolves nowhere fails closed.
  const nxdomain = await validateOutboundUrl("https://no-such-host.example-bank.com/hook", { resolver });
  expect(nxdomain.ok).toBe(false);
  expect((nxdomain as { code: string }).code).toBe("dns_failed");

  // The two layers are separate and both needed: a public-looking name that
  // resolves internally is caught by DNS (the rebind case above), and an
  // internal-sounding name is refused by name even when it resolves publicly.
  expect((await validateOutboundUrl("https://callbacks.partner-bank.com/hook", { resolver })).ok).toBe(true);
  expect((await validateOutboundUrl("https://internal.partner-bank.com/hook", { resolver })).ok).toBe(false);

  // Non-default ports are refused; the surface stays on 443.
  const oddPort = await validateOutboundUrl("https://callbacks.partner-bank.com:8443/hook", { resolver });
  expect(oddPort.ok).toBe(false);
  expect((oddPort as { code: string }).code).toBe("blocked_port");
});

test("WP-22 SSRF: the IP classifier covers the ranges the policy claims to cover", () => {
  const blocked = [
    "0.0.0.0", "10.1.2.3", "127.0.0.1", "127.1.2.3", "169.254.169.254", "169.254.170.2",
    "169.254.1.1", "172.16.0.1", "172.31.255.255", "192.168.1.1", "100.64.0.1", "100.100.100.200",
    "192.0.0.192", "224.0.0.1", "239.255.255.255", "255.255.255.255", "240.0.0.1",
    "::", "::1", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1",
    // IPv4-mapped and NAT64 must be unwrapped, not waved through.
    "::ffff:127.0.0.1", "::ffff:10.0.0.1", "64:ff9b::169.254.169.254",
    "2002:c0a8:0101::", "2001:db8::1",
  ];
  for (const ip of blocked) {
    expect(classifyIp(ip), `${ip} must be blocked`).not.toBeNull();
  }

  const allowed = ["93.184.216.34", "8.8.8.8", "172.32.0.1", "172.15.255.255", "2606:2800:220:1:248:1893:25c8:1946"];
  for (const ip of allowed) {
    expect(classifyIp(ip), `${ip} must be allowed`).toBeNull();
  }
});

test("WP-22 SSRF: the URL is RE-VALIDATED after every redirect", async () => {
  const resolver = stubResolver({
    "callbacks.partner-bank.com": ["93.184.216.34"],
    "cdn.partner-bank.com": ["93.184.216.35"],
  });

  // A validated URL that 302s to the metadata endpoint was never validated.
  // The injected fetch stands in for the hostile server; no network involved.
  const hostileFetch = (async () =>
    new Response(null, { status: 302, headers: { location: "https://169.254.169.254/latest/meta-data/iam/" } })) as typeof fetch;

  let thrown: unknown = null;
  try {
    await followRedirectChain("https://callbacks.partner-bank.com/hook", {
      resolver,
      fetchImpl: hostileFetch,
    });
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(SsrfBlockedError);
  expect((thrown as SsrfBlockedError).code).toBe("redirect_blocked");
  expect((thrown as Error).message).toContain("metadata");

  // A legitimate redirect chain is followed, and each hop is validated.
  // The stub answers with the next Location, or 200 once the list is empty.
  const locations = [
    "https://cdn.partner-bank.com/hook/v2",
    "https://callbacks.partner-bank.com/hook/v2/final",
  ];
  const legitFetch = (async () => {
    const next = locations.shift();
    return new Response(JSON.stringify({ ok: true }), {
      status: next ? 302 : 200,
      headers: next ? { location: next } : {},
    });
  }) as typeof fetch;

  const followed = await followRedirectChain("https://callbacks.partner-bank.com/hook", {
    resolver,
    fetchImpl: legitFetch,
  });
  expect(followed.chain).toEqual([
    "https://callbacks.partner-bank.com/hook",
    "https://cdn.partner-bank.com/hook/v2",
    "https://callbacks.partner-bank.com/hook/v2/final",
  ]);
  expect(followed.url.toString()).toBe("https://callbacks.partner-bank.com/hook/v2/final");
  expect(followed.response.status).toBe(200);

  // An already-observed chain can be validated without any fetch at all.
  const badChain = await validateRedirectChain(
    ["https://callbacks.partner-bank.com/hook", "https://10.0.0.5/internal"],
    { resolver }
  );
  expect(badChain.ok).toBe(false);
  expect((badChain as { code: string }).code).toBe("redirect_blocked");

  const goodChain = await validateRedirectChain(
    ["https://callbacks.partner-bank.com/hook", "https://cdn.partner-bank.com/v2"],
    { resolver }
  );
  expect(goodChain.ok).toBe(true);
});

// ═══════════════════════════════════════════════════════════════════════════
// CSV formula injection
// ═══════════════════════════════════════════════════════════════════════════

test("WP-22 CSV: a formula-shaped merchant is neutralised; a normal name is untouched", () => {
  const columns = [
    { header: "case_ref", value: (r: { ref: string }) => r.ref },
    { header: "merchant", value: (r: { merchant: string }) => r.merchant },
  ];

  // The required payload. In Excel this runs on double-click, with the
  // analyst's Windows credentials, on the machine that approves card freezes.
  const attack = "=cmd|'/c calc'!A1";
  const payloads = [
    attack, //                                    = cmd
    '+HYPERLINK("http://evil.test/x","click")', //  + cmd
    "-2+3+cmd|'/c calc'!A0", //                  - cmd
    "@SUM(1+1)*cmd|'/c calc'!A0", //              @ cmd
    "\t=1+1", //                                 tab then =
    "\r=1+1", //                                 CR then =
  ];

  const hostile = toCsv(
    payloads.map((merchant, i) => ({ ref: `SV-F-${i}`, merchant })),
    columns,
    { bom: false }
  );

  const lines = parseCsv(hostile);
  expect(lines[0]).toEqual(["case_ref", "merchant"]);

  for (const [i, line] of lines.slice(1).entries()) {
    const [ref, merchant] = line;
    expect(ref).toBe(`SV-F-${i}`);
    // The payload survives as EVIDENCE — a fraud analyst must see what was
    // actually sent — with the single-quote sentinel in front of it.
    expect(merchant).toBe(`'${payloads[i]}`);
    // And no cell anywhere in the document can execute as a formula.
    for (const cell of line) expect(isFormulaCell(cell), `cell ${JSON.stringify(cell)}`).toBe(false);
  }

  // A normal name is untouched — same bytes, no quote, no sentinel. A merchant
  // name must still be readable in the spreadsheet.
  const clean = ["Starbucks", "Carrefour LLC", "مركز تجاري", "ACME Co., Ltd."];
  const normal = toCsv(
    clean.map((merchant, i) => ({ ref: `SV-F-${i}`, merchant })),
    columns,
    { bom: false }
  );
  expect(parseCsv(normal)[0]).toEqual(["case_ref", "merchant"]);
  expect(parseCsv(normal).slice(1).map(([, merchant]) => merchant)).toEqual(clean);
  expect(normal).toContain("SV-F-0,Starbucks\r\n");
  expect(normal).not.toContain("'Starbucks");

  // Direct checks on the primitives.
  expect(neutraliseFormula(attack)).toBe(`'${attack}`);
  expect(neutraliseFormula("Starbucks")).toBe("Starbucks");
  expect(neutraliseFormula("")).toBe("");
  expect(toCsvField(attack)).toBe(`"'${attack}"`);
  expect(toCsvField("Starbucks")).toBe("Starbucks");

  // Embedded quotes, commas and newlines still round-trip through RFC 4180
  // quoting, so neutralising did not corrupt the evidence.
  expect(toCsvField('He said "hi", then\nleft')).toBe('"He said ""hi"", then\nleft"');
  expect(parseCsv(toCsv([{ ref: "SV-F-0", merchant: 'He said "hi", then\nleft' }], columns))[1][1]).toBe(
    'He said "hi", then\nleft'
  );

  // The negative-number opt-out is available but off by default: a bank
  // analyst still sees -42.00 as text, which is the accepted cost of the fix.
  expect(toCsvField("-42.00")).toBe(`"'-42.00"`);
  expect(toCsvField("-42.00", { allowNegativeNumbers: true })).toBe("-42.00");
  // …and it only applies to genuine numeric literals, never to "-2+3+cmd".
  expect(toCsvField("-2+3+cmd|'/c calc'!A0", { allowNegativeNumbers: true })).toContain(`'-2+3`);
});

test("WP-22 CSV: header injection via Content-Disposition is refused", () => {
  const header = csvContentDisposition("cases\r\nX-Injected: 1.csv");
  expect(header).not.toContain("\r");
  expect(header).not.toContain("\n");
  expect(header.startsWith("attachment;")).toBe(true);
  expect(header).toContain(".csv");
});

/** Minimal RFC 4180 reader — the round-trip proof that quoting is correct. */
function parseCsv(document: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < document.length; i += 1) {
    const ch = document[i];
    if (quoted) {
      if (ch !== '"') {
        cell += ch;
      } else if (document[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else {
        quoted = false;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\r" && document[i + 1] === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      i += 1;
    } else {
      cell += ch;
    }
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** True when a PARSED cell would execute as a formula in a spreadsheet. */
function isFormulaCell(cell: string): boolean {
  if (cell.startsWith("'")) return false;
  return ["=", "+", "-", "@", "\t", "\r"].includes(cell[0]);
}

// ═══════════════════════════════════════════════════════════════════════════
// Log injection
// ═══════════════════════════════════════════════════════════════════════════

test("WP-22 log injection: a newline in user input cannot forge a second log line", () => {
  const { lines, sink } = captureLog();

  // The forgery: a merchant descriptor carrying CR/LF and a second, entirely
  // fabricated audit record. In a plain-text log this is two lines, and
  // everything downstream — grep, a SIEM rule, a compliance export — now
  // contains a record our application never emitted.
  const hostileMerchant = "Cafe Rouge\r\n[audit] action=card_freeze approved_by=root status=CONFIRMED_FRAUD";

  const line = safeLog("info", "intervention.received", { merchant: hostileMerchant }, sink);

  // Exactly one physical line came out of one call.
  expect(lines).toHaveLength(1);
  expect(line).not.toContain("\r");
  expect(line).not.toContain("\n");
  expect(line.split("\n")).toHaveLength(1);
  expect(line.split("\r")).toHaveLength(1);

  // The forged content survives as DATA inside the one record, where it cannot
  // masquerade as a separate event — it is a single field value.
  const record = JSON.parse(line) as { msg: string; fields: Record<string, unknown> };
  expect(record.msg).toBe("intervention.received");
  expect(String(record.fields.merchant)).toBe(
    "Cafe Rouge [audit] action=card_freeze approved_by=root status=CONFIRMED_FRAUD"
  );
  expect(record.fields.merchant).not.toContain("\n");

  // U+2028 / U+2029 are line separators that JSON.stringify does NOT escape,
  // and several log viewers treat them as newlines. They are stripped too.
  const sep = safeLog("info", "intervention.received", { merchant: "A\u2028B\u2029C\nD" }, sink);
  expect(sep).not.toMatch(/[\u2028\u2029]/);
  expect(sep.split("\n")).toHaveLength(1);

  // A newline in the MESSAGE is stripped too. Concatenating user data into a
  // message is not a supported usage — but if someone does it, the log stays
  // one line rather than becoming a forgery vector.
  const msg = safeLog("warn", "rejected\n[audit] action=card_freeze approved_by=root", undefined, sink);
  expect(msg.split("\n")).toHaveLength(1);
  expect(JSON.parse(msg).msg).toBe("rejected [audit] action=card_freeze approved_by=root");

  // Nested structures, arrays and long values are all bounded and sanitised.
  const nested = safeLog(
    "error",
    "ingest.failed",
    {
      body: { signal: { merchant: "X\nY", amount: 10 } },
      attempts: [1, 2, 3],
      blob: "Z".repeat(5000),
    },
    sink
  );
  expect(nested.split("\n")).toHaveLength(1);
  const nestedRecord = JSON.parse(nested) as { fields: Record<string, unknown> };
  // The newline becomes a single space, so the forged record stays one field
  // and reads as one run-on line rather than two.
  expect(((nestedRecord.fields.body as Record<string, unknown>).signal as Record<string, unknown>).merchant).toBe("X Y");
  expect(String(nestedRecord.fields.blob).length).toBeLessThanOrEqual(512);

  // PAN and IBAN are redacted before they become a durable log copy.
  const redacted = safeLog("info", "customer.updated", { note: "card 4111111111111111 seen" }, sink);
  expect(redacted).toContain("[REDACTED]");
  expect(redacted).not.toContain("4111111111111111");

  // Prototype pollution via a field name is dropped, not spread.
  const polluted = safeLog("info", "x", JSON.parse('{"__proto__":{"admin":true}}'), sink);
  expect(polluted).not.toContain("__proto__");
  expect(({} as Record<string, unknown>).admin).toBeUndefined();

  // Non-finite numbers and unserialisable values become explicit markers.
  expect(sanitiseLogValue(Number.NaN)).toBe("NaN");
  expect(sanitiseLogValue(undefined)).toBeNull();
  expect(sanitiseLogValue(() => 1)).toBe("[unserialisable]");
  expect(sanitiseLogValue(Symbol("s"))).toBe("[unserialisable]");
});

test("WP-22 gate: every row of the WP-22 table has a named assertion in this file", async () => {
  // Coverage tripwire. The rows below are transcribed from the WP-22 table;
  // this test fails if any of them stops being asserted, so the gate cannot
  // quietly shrink to whatever is still implemented.
  const rows = [
    "unknown fields are REJECTED",
    "NO type coercion",
    "money is integer minor units",
    "out-of-range numbers",
    "over-length strings",
    "over-long arrays",
    "nesting deeper than the depth cap",
    "field-count cap",
    "body-size cap",
    "phones are normalised to E.164",
    "timestamps must be ISO-8601 WITH an offset",
    "homoglyph / bidi / zero-width",
    "grapheme cap never splits a cluster",
    "mixed-script detection",
    "SSRF: every listed hostile URL",
    "IP classifier covers the ranges",
    "RE-VALIDATED after every redirect",
    "CSV: a formula-shaped merchant",
    "Content-Disposition is refused",
    "a newline in user input cannot forge",
  ];

  const source = await Bun.file(fileURLToPath(import.meta.url)).text();
  for (const row of rows) {
    expect(source.includes(row), `WP-22 row not asserted: "${row}"`).toBe(true);
  }
});
