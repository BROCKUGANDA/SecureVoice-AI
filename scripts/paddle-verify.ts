import { Environment, Paddle } from "@paddle/paddle-node-sdk";

// `PADDLE_SANDBOX_API_KEY` is not a variable this repository defines — `.env`,
// `.env.example` and compose all use `PADDLE_API_KEY`, and the environment is
// carried in the key prefix. Reading a name nobody sets meant this script
// constructed a client with `undefined` and answered 401 for every product,
// which reads as "the catalog is broken" rather than "the script is".
const apiKey = (process.env.PADDLE_API_KEY ?? "").trim();
if (apiKey === "") {
  console.error("✗ PADDLE_API_KEY is not set — cannot verify the catalog.");
  process.exit(1);
}
if (!apiKey.startsWith("pdl_sdbx_")) {
  console.error(
    `✗ PADDLE_API_KEY is not a sandbox key (prefix ${JSON.stringify(apiKey.slice(0, 10))}). ` +
      `This script checks the SANDBOX catalog; refuse to point it at live money.`,
  );
  process.exit(1);
}

const paddle = new Paddle(apiKey, { environment: Environment.sandbox });

const IDS = [
  { label: "Starter", id: "pro_01m4kc8a89eb5fs4638p0trbf7" },
  { label: "Growth", id: "pro_01m4kc8b21kpp6eabxrybvb935" },
  { label: "Enterprise", id: "pro_01m4kc8bvk4vjrdhzcgqms3pfk" },
];

for (const { label, id } of IDS) {
  const p = await paddle.products.get(id, { include: ["prices"] });
  console.log(`\n=== ${label} ===`);
  console.log(
    `  ${p.id}  status=${(p as unknown as { status?: string }).status}  tax=${(p as unknown as { taxCategory?: string }).taxCategory}`,
  );
  for (const pr of p.prices ?? []) {
    const o = pr as unknown as {
      billingCycle?: { interval?: string };
      unitPriceOverrides?: {
        countryCodes: string[];
        unitPrice: { amount: string; currencyCode: string };
      }[];
    };
    console.log(
      `  ${pr.id}  /${o.billingCycle?.interval ?? "one-time"}  ${pr.unitPrice?.amount} ${pr.unitPrice?.currencyCode}`,
    );
    for (const u of o.unitPriceOverrides ?? []) {
      console.log(
        `      ${u.countryCodes.join(",")}  ${u.unitPrice.amount} ${u.unitPrice.currencyCode}`,
      );
    }
  }
}

console.log("\n=== retired products are archived ===");
for (const id of [
  "pro_01m4k7r196v73zm54hta4vexwr",
  "pro_01m4k7r2g61fsrtxjscrywe35a",
  "pro_01m4k7r4d7az2zggnavk2392pq",
]) {
  try {
    const p = await paddle.products.get(id);
    console.log(`  ${id}  status=${(p as unknown as { status?: string }).status}`);
  } catch (e) {
    console.log(`  ${id}  NOT VISIBLE (${(e as Error).message.slice(0, 60)})`);
  }
}
