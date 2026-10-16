/**
 * GATE — every declared latency span must have a producer in `src/`.
 *
 * `SPAN_DEFINITIONS` is the published latency contract: eight budgets a bank and a
 * regulator can quote back at us, and `scripts/emit-slo.ts` reports each one as
 * `met` / `missed` / `not_measured`. The third verdict is honest — it says "no
 * samples" instead of passing — but honesty is not detection. Nothing anywhere
 * noticed that three of the eight had no code path capable of producing a sample:
 *
 *   signal_received_to_ringing          — "the customer's phone rings within 5s"
 *   caller_stop_to_agent_audio          — the turn latency the caller HEARS (1.5s)
 *   fraud_confirmed_to_webhook_delivered — the bank's own 2s webhook promise
 *
 * The first two have since been produced (2026-10-16: `signal_received_to_ringing` by
 * src/lib/telemetry/ringing.ts, driven in CI by tests/e2e/signal-received-to-ringing.test.ts;
 * `caller_stop_to_agent_audio` by the Deepgram client's new `UtteranceEnd` half and the
 * worker's turn join, driven in CI by tests/unit/voice-stream-caller-stop.test.ts). The
 * one that remains is listed below with the reason it cannot be measured yet.
 *
 * Two of those are the voice engine's headline promises. They were unmeasured, which
 * means "the voice engine is degraded" was an unfalsifiable claim in both directions:
 * slower would not have shown up, and neither would having stopped dialling entirely.
 *
 * The same file asserts the reverse direction, because that half fails differently:
 * a `recordSpan({ span: "…" })` naming something NOT declared is rejected at runtime
 * (`isSpanName` → `unknown_span`), so the metric is dropped silently and the code
 * looks like it is instrumenting something. A typo in a span name is invisible;
 * this makes it a build failure.
 *
 * Scan-shape tripwire: an empty file list would certify everything, so the walk
 * asserts it read a realistic number of sources before it is allowed to report a
 * clean result. A green from a scan that found nothing is the worst kind of green.
 */
import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { SPAN_NAMES, type SpanName } from "@/lib/telemetry/spans";

/** The module that DECLARES the names is not a producer of them. */
const DECLARATION_FILE = join("src", "lib", "telemetry", "spans.ts");

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "generated" || entry === "node_modules") continue;
      sources(full, out);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const FILES = sources("src").filter((f) => f !== DECLARATION_FILE);
const BODIES = new Map(FILES.map((f) => [f, readFileSync(f, "utf8")]));

test("the scan is looking at the whole tree, not at nothing", () => {
  // Tripwire for the gate itself. `sources("src")` returning an empty array would
  // make every assertion below pass vacuously — which is the failure mode this
  // file exists to prevent, arriving in the file that prevents it.
  expect(FILES.length).toBeGreaterThan(400);
  expect(FILES.some((f) => f.endsWith(join("worker", "voice-stream.ts")))).toBe(true);
  expect([...BODIES.values()].some((b) => b.includes("recordSpan"))).toBe(true);
});

test("no source file reads back empty, which is an instrument fault not a missing producer", () => {
  // Observed: run alongside anything that rewrites a source file (a `git checkout`,
  // an editor save) and one file read as nothing. That surfaces as "this declared
  // span has no producer" — a red that blames the code for a torn read, which is the
  // kind of flake that teaches people to re-run CI instead of read it. Empty is
  // reported as what it is, before the producer assertions get a chance to lie.
  const empty = [...BODIES.entries()]
    .filter(([, body]) => body.trim().length === 0)
    .map(([f]) => f);
  expect(empty).toEqual([]);
});

/**
 * Declared spans with no producer, and why each is still open. This list is the
 * honest form of the gap: the alternative was silence, and silence is how three of
 * eight budgets — two of them the voice engine's own — went unread for their whole
 * life while the SLO file reported `not_measured` and nobody had to look.
 *
 * The assertions below keep it from becoming a place to park things: an entry whose
 * producer has since landed must be deleted (so the list cannot go stale and flatter
 * the tree), an entry with no reason is a failure, and a NEWLY declared span must
 * appear here with a reason or have a producer.
 */
const UNPRODUCED_WITH_REASON: Record<string, string> = {
  // ── RETIRED 2026-10-16: `signal_received_to_ringing` is no longer unproduced. ──
  // The reasoning below was correct when it was written, and it is what told the fix
  // which two halves were missing. Both now exist: the intake handler persists its own
  // arrival instant (`Case.signalReceivedAt`, taken before the first await — NOT the
  // gate-passed `createdAt`), and the status callback compare-and-sets `Case.ringingAt`
  // from the RAW `ringing` status before the delivery fold collapses it into `queued`.
  // Producer: src/lib/telemetry/ringing.ts. CI drives it in
  // tests/e2e/signal-received-to-ringing.test.ts, which also proves a replayed callback
  // does not double-count. Still honest: every sample today carries origin `harness`,
  // so `evidence/latency/slo.json` keeps the leg `not_measured` for live traffic and the
  // published copy says "case deadline", not a measured time-to-contact.
  //
  // Original note, for the record — Verified 2026-10-15, both halves of the join: the
  // status route can reach
  // the case (`Case @@index([callSid])`; the turn route and the media-stream
  // worker both do `findFirst({ where: { callSid } })`), but the START instant
  // is not persisted anywhere the callback can read. `createCase` runs inside
  // `armAndDial` AFTER the deterministic policy gate has passed
  // (`acceptedAt = Date.now()` precedes it), so `Case.createdAt` is the
  // gate-passed instant, not the signal-received one — and the intake route's
  // own comment puts ~1.2 s per remote DB round-trip on exactly that stretch.
  // A span started at `createdAt` would silently exclude the whole intake the
  // `signal_received_to_accepted` budget already measures: a shorter number
  // than the customer experienced, which is the lie this file exists to
  // refuse. What is missing is a durable received-at written when the signal
  // ARRIVES (a Case column set at intake, or the idempotency claim carrying
  // the caseRef so its pre-gate `createdAt` becomes joinable) — until one
  // exists, recording this span means faking its start.
  // ── RETIRED 2026-10-16: `caller_stop_to_agent_audio` is no longer unproduced. ──
  // The reasoning below was correct when it was written, and it named the one missing
  // half: the client never asked for Deepgram's end-of-utterance signal, so "the instant
  // the caller stops talking" was not an event this platform received. It is now.
  // Producer: `onUtteranceEnd` in src/lib/voice/deepgram-client.ts, which requests
  // `utterance_end_ms` on BOTH listen URLs (pooled and per-call — the two copies of the
  // URL are why this span was ever invisible) and carries `last_word_end` — which the
  // vendor reports in SECONDS, converted at that seam, because adding it to an epoch-ms
  // clock unconverted puts every sample seconds early and the ceiling then refuses them
  // all — next to the wall clock of the first audio frame of that stream; and
  // src/worker/voice-stream.ts,
  // which maps the offset onto that clock and joins the result to the same `onFirstAudio`
  // instant `answered_to_first_agent_word` already closes, at most once per turn.
  // CI drives it in tests/unit/voice-stream-caller-stop.test.ts, whose central assertion
  // is the one the original note warned about: `utterance_end_ms` is a wait Deepgram adds
  // AFTER speech ends, so a span started at the message's arrival subtracts that wait from
  // a published latency and inflates the product's own numbers. The test fixes the wait at
  // a known constant and asserts the sample is exactly that much LONGER than the
  // arrival-gap. A replayed UtteranceEnd, a message that lands between turns (joining an
  // in-flight stop to the turn still finishing can only come out SHORT), and a turn whose
  // audio arrives with no reported stop each add nothing, and an offset that cannot be
  // mapped honestly (-1, absent, no
  // stream anchor, or stale enough to make the "turn" outlast the call) records nothing and
  // logs the reason at error level.
  // That file drives the worker through a FAKE client, which can be handed an anchor it
  // never stamped. tests/unit/deepgram-utterance-end.test.ts is the half that proves the
  // production module asks for the message at all: the configured `utterance_end_ms` on
  // the per-call URL, the pooled URL and a reconnect; `UtteranceEnd` delivered even though
  // it carries no transcript to survive the `if (!transcript) return` below it; the anchor
  // taken from the first frame the socket ACCEPTED rather than the handshake, and
  // re-baselined by a reconnect; `-1` and an absent offset forwarded rather than read as
  // zero; and `stop()` untying the listener before Deepgram's silence timer can fire into
  // a torn-down call.
  //
  // What REMAINS untrue, stated rather than smoothed over: this span has no live sample.
  // `evidence/latency/slo.json` still reports the leg `not_measured`, README still
  // declines to quote a turn-taking figure, and the only samples the plane can make today
  // are `harness`-origin. Two things are still open: a real call has to happen (the
  // calling window and vendor quota gate that, as they always did), and the voice worker
  // records into its own process ring — exactly as the `answered_to_first_agent_word`
  // producer beside it does — so even a live turn's sample does not reach the JSONL
  // `scripts/emit-slo.ts` reads until worker durability is wired. That is unchanged here,
  // and it is the next gap in this file family rather than a caveat about this one.
  //
  // Original note, for the record — verified 2026-10-15 against
  // src/lib/voice/deepgram-client.ts: its message handler parsed exactly
  // `channel.alternatives[0].transcript` + `is_final`, and its listen URL did not request
  // `utterance_end_ms`, so Deepgram's end-of-speech signal (the `UtteranceEnd` message, or
  // the Results `speech` boundary) was never surfaced. The worker saw only `onTranscript`
  // plus socket death/reconnect, which is why measuring from the final transcript was
  // refused: it would start the clock LATE (after the ASR's endpointing silence) and
  // duplicate `answered_to_first_agent_word`, whose producer is driven in CI by
  // tests/unit/voice-stream-first-agent-word.test.ts.
  // ── RETIRED 2026-10-16: `fraud_confirmed_to_webhook_delivered` is no longer unproduced. ──
  // The reason above was accurate when written and named the missing half precisely:
  // "nothing persists the confirmation instant". Two things were wrong in it and both are
  // now fixed rather than reworded. The delivery instant already existed
  // (`OutboxEvent.deliveredAt`, written only on a successful delivery); the start did not,
  // so `Case.fraudConfirmedAt` was added and is stamped by the single state writer when a
  // case enters `CONFIRMED_FRAUD` — which only the customer's own denial in
  // `verify-transaction` can cause, so the instant is a fact about the call, not about a
  // row being touched. Producer: `src/lib/telemetry/confirmation.ts`, called from
  // `src/lib/outbox.ts` at the moment a delivery commits, once per event row, and only
  // for `case.notified`. It refuses a case with no persisted start rather than borrowing
  // `updatedAt`, and it never filters a LONG sample — a nine-second delivery is the exact
  // failure the 2 s budget exists to surface, and a producer that drops its own bad news
  // is how a p95 becomes a marketing number.
  //
  // The map is now empty, which is a shape a gate can pass for the wrong reason. The
  // assertion below is paired with a positive control that proves an unproduced span is
  // still detected when the map is empty.
};

test("every declared span has a producer, or a named reason for not having one", () => {
  const unproduced = SPAN_NAMES.filter(
    (span) => ![...BODIES.entries()].some(([, body]) => body.includes(`"${span}"`)),
  );

  // Nothing may be unproduced without being written down.
  const undeclaredGaps = unproduced.filter((s) => !(s in UNPRODUCED_WITH_REASON));
  // …and nothing may stay written down once its producer lands.
  const staleGaps = (Object.keys(UNPRODUCED_WITH_REASON) as SpanName[]).filter(
    (s) => !unproduced.includes(s),
  );

  expect({ unproduced, undeclaredGaps, staleGaps }).toEqual({
    unproduced,
    undeclaredGaps: [],
    staleGaps: [],
  });

  // A reason field one line long is not a reason.
  for (const [span, why] of Object.entries(UNPRODUCED_WITH_REASON)) {
    expect({ span, explained: why.length > 80 }).toEqual({ span, explained: true });
  }
});

test("no producer names a span the contract never declared", () => {
  // An undeclared name is rejected by `recordSpan` at runtime, so the call site
  // reads as instrumented and the metric does not exist.
  const recorded = new Set<string>();
  for (const body of BODIES.values()) {
    for (const m of body.matchAll(/span:\s*"([a-z0-9_]+)"/g)) recorded.add(m[1]!);
  }
  const undeclared = [...recorded].filter((n) => !(SPAN_NAMES as readonly string[]).includes(n));
  expect(undeclared).toEqual([]);
});

test("each span's producer file is named, so the contract is navigable", () => {
  // Not a pass/fail assertion about correctness — a guard against the contract
  // becoming folklore. If a span is produced from a file nobody can name, the
  // budget attached to it is not owned by anything.
  const owners = new Map<SpanName, string[]>();
  for (const span of SPAN_NAMES) {
    owners.set(
      span,
      [...BODIES.entries()].filter(([, body]) => body.includes(`"${span}"`)).map(([path]) => path),
    );
  }
  const gaps = Object.keys(UNPRODUCED_WITH_REASON);
  const printed: string[] = [];
  for (const span of SPAN_NAMES) {
    const files = owners.get(span) ?? [];
    if (gaps.includes(span)) {
      // The gap list may only contain what genuinely has no producer; that is
      // asserted above. Here it just keeps the printout honest.
      expect(files.length).toBe(0);
      printed.push(`  ${span}\n    (no producer yet — recorded in UNPRODUCED_WITH_REASON)`);
      continue;
    }
    expect(files.length).toBeGreaterThan(0);
    printed.push(`  ${span}\n    ${files.join("\n    ")}`);
  }
  console.log("\nspan producers:\n" + printed.join("\n"));
});

/**
 * A span recorded into memory only is a span that was never measured.
 *
 * `recordSpan` fills the in-process ring that `/api/status/spans` reads; the durable
 * artifact `scripts/emit-slo.ts` turns into a verdict is the JSONL written by
 * `recordSpanAndPersist`. Both return the same shape and neither fails, so a producer
 * can be completely correct and completely invisible: the voice worker did exactly that
 * for its whole life — `answered_to_first_agent_word` and `caller_stop_to_agent_audio`
 * were recorded on every turn and reached no artifact, so the published SLO kept saying
 * `not_measured` while the code looked instrumented.
 *
 * Long-running processes matter most here: a web route's ring is read by the next
 * request, while a worker's ring is read by nobody and dies with the container.
 */
test("no producer records through the ring-only recorder", () => {
  // `store.ts` is the recorder's own implementation, and the status route only reads
  // the ring. Everything else in src/ that calls `recordSpan(` is a producer that
  // chose the memory-only path — the substring `recordSpan(` cannot match
  // `recordSpanAndPersist(`, so the distinction is exact rather than a name guess.
  const EXEMPT = [
    DECLARATION_FILE,
    join("src", "lib", "telemetry", "store.ts"),
    join("src", "app", "api", "status", "spans", "route.ts"),
  ];
  const offenders = [...BODIES.entries()]
    .filter(([f, body]) => !EXEMPT.includes(f) && body.includes("recordSpan("))
    .map(([f]) => f);
  expect(offenders, `${offenders.join(", ")} record spans into memory only`).toEqual([]);

  // Positive control: the check must be able to fail, and specifically on the mistake
  // it exists to catch. A regex-free substring test that nobody has reddened is
  // indistinguishable from a check whose target file was renamed.
  const RING_ONLY = 'void recordSpan({ span: "tool_request_to_response", startedAtMs: 1 });';
  const DURABLE =
    'void recordSpanAndPersist({ span: "tool_request_to_response", startedAtMs: 1 });';
  expect(RING_ONLY.includes("recordSpan(")).toBe(true);
  expect(DURABLE.includes("recordSpan(")).toBe(false);
});

test("the empty gap map is a result, not a blindfold", () => {
  // Every entry has now been retired, so `UNPRODUCED_WITH_REASON` is empty and the main
  // assertion passes by finding nothing to complain about. That is exactly the state in
  // which a producer gate is worth the least, so the predicate itself is tested here:
  // the same search the gate runs must be able to report "no producer" at all. If it
  // cannot, an empty map means nothing and a future span can go unproduced quietly.
  expect(Object.keys(UNPRODUCED_WITH_REASON)).toEqual([]);
  expect(FILES.length).toBeGreaterThan(400);

  const phantom = "signal_received_to_moonshine";
  const producedByAnything = [...BODIES.values()].some((body) => body.includes(`"${phantom}"`));
  expect(producedByAnything).toBe(false);

  // And the predicate does find the real ones — per span, so a rename that leaves a
  // declaration orphaned cannot pass by the loop having nothing to iterate.
  for (const span of SPAN_NAMES) {
    const found = [...BODIES.values()].some((body) => body.includes(`"${span}"`));
    expect({ span, found }).toEqual({ span, found: true });
  }
});
