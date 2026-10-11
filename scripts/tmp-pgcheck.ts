import { Client } from "pg";

const url = process.argv[2];
const c = new Client({ connectionString: url });
try {
  await c.connect();
  const r = await c.query("select version()");
  console.log("OK", String(r.rows[0].version).slice(0, 40));
} catch (e) {
  console.log("ERR", e instanceof Error ? e.message : String(e));
} finally {
  await c.end().catch(() => {});
}