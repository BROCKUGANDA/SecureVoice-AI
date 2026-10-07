/**
 * Browser-safe configuration. NEXT_PUBLIC_* vars are inlined by the Next.js
 * compiler at build time; everything server-side goes through src/lib/config.ts.
 */
export const SUPPORT_EMAIL = process.env.NEXT_PUBLIC_SUPPORT_EMAIL ?? "otemaach@gmail.com";
export const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE ?? "https://api.securevoice.ae";
