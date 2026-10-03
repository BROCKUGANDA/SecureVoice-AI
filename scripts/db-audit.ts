import { Client } from "pg";

const url = process.env.DATABASE_URL!;
const c = new Client({ connectionString: url });
await c.connect();

const ms = (s: number) => `${s.toFixed(1)}ms`;

console.log("=== 1. round-trip cost by operation ===");
for (const [label, sql] of [
  ["SELECT 1", "SELECT 1"],
  ["trivial table", `SELECT id FROM "Customer" LIMIT 1`],
  ["count Case", `SELECT count(*) FROM "Case"`],
  ["gauge COUNT (used by admission)", `SELECT count(*) FROM "Case" WHERE state = 'verifying'`],
] as const) {
  const N = 5;
  const t0 = performance.now();
  for (let i = 0; i < N; i++) await c.query(sql);
  const avg = (performance.now() - t0) / N;
  console.log(`  ${label.padEnd(34)} ${ms(avg)}`);
}

console.log("\n=== 2. row counts (is an index even relevant at this size?) ===");
for (const t of [
  "Case",
  "AuditLog",
  "UsageLedger",
  "Customer",
  "dial_job",
  "OutboxEvent",
  "DeadLetter",
  "IdempotencyKey",
  "WebhookEvent",
]) {
  try {
    const r = await c.query(`SELECT count(*)::int n FROM "${t}"`);
    console.log(`  ${t.padEnd(18)} ${r.rows[0].n}`);
  } catch (e) {
    console.log(`  ${t.padEnd(18)} (${(e as Error).message.split("\n")[0].slice(0, 40)})`);
  }
}

console.log("\n=== 3. existing indexes ===");
const idx = await c.query(`
  SELECT tablename, indexname, indexdef
  FROM pg_indexes WHERE schemaname='public'
  ORDER BY tablename, indexname`);
let last = "";
for (const r of idx.rows) {
  if (r.tablename !== last) {
    console.log(`  ${r.tablename}`);
    last = r.tablename;
  }
  console.log(`     ${r.indexdef.replace(/CREATE (UNIQUE )?INDEX \S+ ON \S+ /, "")}`);
}

console.log("\n=== 4. EXPLAIN on the hot admission gauge query ===");
const e1 = await c.query(
  `EXPLAIN (ANALYZE, BUFFERS) SELECT count(*) FROM "Case" WHERE state = 'verifying'`,
);
for (const r of e1.rows) console.log(`  ${r["QUERY PLAN"]}`);

console.log("\n=== 5. EXPLAIN on audit chain verification (the widest scan) ===");
const e2 = await c.query(
  `EXPLAIN (ANALYZE) SELECT * FROM "AuditLog" ORDER BY "createdAt" DESC LIMIT 25`,
);
for (const r of e2.rows) console.log(`  ${r["QUERY PLAN"]}`);

console.log("\n=== 6. table bloat / size ===");
const sz = await c.query(`
  SELECT relname, n_live_tup, pg_size_pretty(pg_total_relation_size(relid)) AS total
  FROM pg_stat_user_tables WHERE n_live_tup > 0 ORDER BY pg_total_relation_size(relid) DESC LIMIT 8`);
for (const r of sz.rows)
  console.log(`  ${r.relname.padEnd(20)} ${String(r.n_live_tup).padStart(7)} rows  ${r.total}`);

await c.end();
