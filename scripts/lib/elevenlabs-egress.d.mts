/**
 * Types for `elevenlabs-egress.mjs`, the script-side vendor guard.
 *
 * The module is JavaScript because it is run by plain `node`/`bun` from
 * `scripts/walkthrough/`, and its only typed consumer is
 * `tests/unit/elevenlabs-script-egress.test.ts`. Declaring it here is what keeps
 * the test project able to `checkJs: false` the script: the guard's whole purpose
 * is a shape the compiler can see (`claim` refuses BEFORE the request), so an
 * `any` here would typecheck the test without testing anything.
 */

export declare const DEFAULT_SCRIPT_CHAR_CAP: number;

export type LedgerClaim =
  { ok: true; used: number } | { ok: false; used: number; cap: number; reason: string };

export interface ScriptCharLedger {
  /** Characters already committed for the current month. */
  used(): number;
  remaining(): number;
  /** Reserve before the call. A refusal means nothing was spent. */
  claim(chars: number): LedgerClaim;
  /** Give the reservation back when the vendor never accepted it. */
  release(chars: number): void;
}

export declare function createCharLedger(opts?: {
  file?: string;
  cap?: number;
  label?: string;
}): ScriptCharLedger;

export declare function fetchWithBackoff(
  url: string | URL,
  init?: RequestInit,
  opts?: { maxRetries?: number; timeoutMs?: number },
): Promise<Response>;

export declare function synthWithGuard(
  args: { voiceId: string; text: string; model?: string; apiKey: string; outputFormat?: string },
  ledger: ScriptCharLedger,
): Promise<Response>;

export declare function jsonWithGuard(
  args: { pathname: string; method?: string; body?: unknown; apiKey: string },
  opts?: { maxRetries?: number; timeoutMs?: number },
): Promise<unknown>;
