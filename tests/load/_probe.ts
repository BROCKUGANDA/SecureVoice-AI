// TEMPORARY PROBE — deleted immediately after use.
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const p = new PrismaClient({
  adapter: new PrismaPg({ connectionString: "postgresql://postgres@127.0.0.1:5432/securevoice_test", max: 5 }),
});
const before = await p.$queryRawUnsafe<{ state: string; n: number }[]>(
  `SELECT state, count(*)::int AS n FROM dial_job GROUP BY state ORDER BY state`,
);
console.log("before:", JSON.stringify(before));
const deleted = await p.$executeRawUnsafe(`DELETE FROM dial_job WHERE "case_ref" LIKE 'SV-PROBE%' OR "case_ref" LIKE 'SV-DIAG%'`);
console.log("deleted probe rows:", deleted);
const after = await p.$queryRawUnsafe<{ state: string; n: number }[]>(
  `SELECT state, count(*)::int AS n FROM dial_job GROUP BY state ORDER BY state`,
);
console.log("after:", JSON.stringify(after));
await p.$disconnect();