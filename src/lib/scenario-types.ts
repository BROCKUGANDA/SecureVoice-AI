/**
 * Shared scenario types — extracted so scenario-ur.ts can import them WITHOUT
 * importing scenario.ts (which imports scenario-ur.ts for UR_PACKS). That
 * type-only back-edge was a latent runtime import cycle: dropping the `type`
 * keyword anywhere would have made it real.
 */

export type ScenarioKind = "card" | "atm" | "wire" | "claim" | "voicemail";

export interface ScenarioMeta {
  kind: ScenarioKind;
  /**
   * Who is calling. Absent means a bank (the original three scenarios). An
   * insurer's scenario is spoken as "your insurer" about "your policy": a claims
   * customer whose payout was redirected has no card to freeze.
   */
  institution?: "bank" | "insurer";
  title: { en: string; ar: string };
  desc: { en: string; ar: string };
  vector: { en: string; ar: string };
  risk: string;
  amount: { en: string; ar: string };
  merchant: { en: string; ar: string };
  signals: { en: string; ar: string };
  customer: string;
  phone: string;
  assetId: string; // stage header tail, e.g. "CARD  4417"
  caseId: string;
  preventedLoss: { en: string; ar: string };
  freezePath: string;
  freezeOk: string[]; // mono response block once executed
}
