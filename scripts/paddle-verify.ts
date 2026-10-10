/**
 * Verify the Paddle sandbox catalog.
 *
 * Reads by ID rather than `products.list()`. That is not a preference: in
 * sandbox, `list()` returned zero products for a catalog that demonstrably
 * existed — `get()` on each returned the product, active, with its prices.
 * Trusting `list()` would have meant reporting "nothing was created" for a
 * catalog that was. The IDs below come from the seed run's own output.
 *
 * Usage: PADDLE_SANDBOX_API_KEY=... bun scripts/paddle-verify.ts
 */
import { Environment, Paddle } from "@paddle/paddle-node-sdk";

const paddle = new Paddle(process.env.PADDLE_SANDBOX_API_KEY!, {
  environment: Environment.sandbox,
});

const IDS = [
  { label: "Starter", id: "pro_01m4k7r196v73zm54hta4vexwr" },
  { label: "Pro", id: "pro_01m4k7r2g61fsrtxjscrywe35a" },
  { label: "Advanced", id: "pro_01m4k7r4d7az2zggnavk2392pq" },
];

for (const { label, id } of IDS) {
  const p = await paddle.products.get(id, { include: ["prices"] });
  console.log(`\n=== ${label} ===`);
  console.log(`product id : ${p.id}`);
  console.log(`status     : ${(p as unknown as { status?: string }).status}`);
  console.log(`tax category: ${(p as unknown as { taxCategory?: string }).taxCategory}`);
  for (const pr of p.prices ?? []) {
    const o = pr as unknown as {
      billingCycle?: { interval?: string };
      trialPeriod?: { interval?: string; frequency?: number };
      unitPriceOverrides?: {
        countryCodes: string[];
        unitPrice: { amount: string; currencyCode: string };
      }[];
    };
    console.log(
      `  ${pr.id}  ${o.billingCycle?.interval ?? "one-time"}  ${pr.unitPrice?.amount} ${pr.unitPrice?.currencyCode}` +
        (o.trialPeriod ? `  trial=${o.trialPeriod.frequency} ${o.trialPeriod.interval}` : ""),
    );
    for (const u of o.unitPriceOverrides ?? []) {
      console.log(
        `      ${u.countryCodes.join(",")}  ${u.unitPrice.amount} ${u.unitPrice.currencyCode}`,
      );
    }
  }
}
