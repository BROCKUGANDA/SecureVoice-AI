import { test } from "bun:test";
import { db } from "@/lib/db";

test("probe", async () => {
  const t = await db.$queryRawUnsafe<{ table_name: string }[]>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name ILIKE '%dial%'`,
  );
  console.log("TABLES", JSON.stringify(t));
  const c = await db.$queryRawUnsafe<{ table_name: string; column_name: string }[]>(
    `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema='public' AND (table_name ILIKE '%dial%' OR table_name IN ('UsageLedger','PaymentRecord')) ORDER BY table_name, column_name`,
  );
  console.log("COLUMNS", c.map((x) => `${x.table_name}.${x.column_name}`).join(" "));
}, 60_000);
