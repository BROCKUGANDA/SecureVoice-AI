import { Client } from "pg";

/**
 * Distinguishes the three costs that all show up as "the database is slow":
 *
 *   1. TCP + TLS handshake, paid ONCE per new connection
 *   2. Network round-trip per query
 *   3. Actual server-side execution
 *
 * If (1) dominates, connection pooling is the fix and no index will ever help.
 * If (2) dominates, only fewer queries help. These need different answers, so
 * measure before changing anything.
 */

const url = process.env.DATABASE_URL!;
const ms = (n: number) => `${n.toFixed(1)}ms`;

console.log("=== a. cold connection: handshake cost ===");
const t0 = performance.now();
const cold = new Client({ connectionString: url });
await cold.connect();
const connectMs = performance.now() - t0;
console.log(`  connect() incl. TCP+TLS   ${ms(connectMs)}`);

console.log("\n=== b. warm query round-trip on that connection ===");
const t1 = performance.now();
await cold.query("SELECT 1");
const firstQuery = performance.now() - t1;
console.log(`  first query on a new conn ${ms(firstQuery)}`);

const N = 20;
const t2 = performance.now();
for (let i = 0; i < N; i++) await cold.query("SELECT 1");
const warm = (performance.now() - t2) / N;
console.log(`  subsequent queries (avg)  ${ms(warm)}`);

console.log("\n=== c. a real query, warm ===");
const t3 = performance.now();
for (let i = 0; i < 10; i++) await cold.query(`SELECT count(*) FROM "Case"`);
console.log(`  count(Case) avg           ${ms((performance.now() - t3) / 10)}`);

await cold.end();

console.log("\n=== d. verdict ===");
console.log(`  handshake is ${((connectMs / warm) * 100).toFixed(0)}% of one query round-trip`);
if (connectMs > warm * 3) {
  console.log("  -> CONNECTION SETUP DOMINATES. Pooling/reusing connections is the lever.");
} else if (warm > 50) {
  console.log("  -> ROUND-TRIP DOMINATES. Only fewer queries and caching help.");
} else {
  console.log("  -> Neither dominates; the database is simply far away.");
}
console.log(`  (that verdict rule uses handshake vs round-trip; a far-away host still`);
console.log(`   makes ${ms(warm)} per query the floor)`);
