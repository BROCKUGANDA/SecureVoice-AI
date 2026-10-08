/**
 * Shariah terminology filter.
 *
 * This used to be a plain word-map loop with unanchored regexes, which corrupts
 * real sentences: with no boundary around the key, "apr" matches inside "April"
 * and "interest" inside "interested", so an approved script came out saying
 * "profit rateil" and "profit rated to help you". It also ran one replacement
 * per pass, so "interest rate" became "profit rate rate".
 *
 * The rules now live in the speech gate, which every voice path crosses before
 * audio is requested. This module is kept as the single-purpose entry point for
 * callers that only want the terminology pass, and it delegates to that one
 * implementation so there cannot be two filters that disagree.
 */

import { applyShariahTerms } from "./speech-gate";

export function sanitizeShariah(text: string): string {
  return applyShariahTerms(text ?? "").text;
}
