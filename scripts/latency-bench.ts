import { db } from "../src/lib/db";
import { caseByConversation } from "../src/lib/case-state-machine";

const conv = `conv-bench-${Date.now().toString(36)}`;
await db.case.create({
  data: { caseRef: `SV-F-BENCH${Date.now().toString(36).toUpperCase()}`, conversationId: conv, orgId: "org-test", state: "ANSWERED" },
});

async function oneCall() {
  const t0 = performance.now();
  const c = await caseByConversation(conv);
  const t1 = performance.now();
  await db.case.updateMany({ where: { conversationId: conv }, data: { language: "ar" } });
  const t2 = performance.now();
  return { guard: t1 - t0, update: t2 - t1, total: t2 - t0 };
}

// warm-up
await oneCall();
console.log("warm:", JSON.stringify(await oneCall()));

// sequential 30
const seq: number[] = [];
for (let i = 0; i < 30; i++) seq.push((await oneCall()).total);
seq.sort((a, b) => a - b);
console.log(`seq p50=${seq[14].toFixed(0)}ms p95=${seq[28].toFixed(0)}ms min=${seq[0].toFixed(0)} max=${seq[29].toFixed(0)}`);

// parallel 50, concurrency 5
const par: number[] = [];
for (let b = 0; b < 10; b++) {
  const rs = await Promise.all(Array.from({ length: 5 }, () => oneCall()));
  rs.forEach((r) => par.push(r.total));
}
par.sort((a, b) => a - b);
console.log(`par p50=${par[24].toFixed(0)}ms p95=${par[47].toFixed(0)}ms min=${par[0].toFixed(0)} max=${par[49].toFixed(0)}`);

await db.$disconnect();
