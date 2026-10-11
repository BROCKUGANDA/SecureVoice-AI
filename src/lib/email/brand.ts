// Shared email presentation tokens.
//
// Every template hard-codes these values rather than referencing the Tailwind
// custom properties in src/app/globals.css. Email clients do not run the app's
// CSS, and a `<style>`-less table layout is the only thing that survives
// Outlook's Word rendering engine. The literals below are therefore kept in
// sync with globals.css by hand:
//
//   --primary        #0b7a55   -> BRAND.primary
//   --green-deep     #085c3f   -> BRAND.primaryDeep
//   --primary-foreground #f4faf7 -> BRAND.onPrimary
//   --background     #0c110e   -> BRAND.canvas (dark theme)
//
// Changing a colour here means changing it in globals.css too.

export const BRAND = {
  name: "SecureVoice AI",
  /** Button and accent fill. */
  primary: "#0b7a55",
  /** Header bar, footer text. Sits darker than `primary` for contrast. */
  primaryDeep: "#085c3f",
  /** Text/icon colour on top of `primary`. */
  onPrimary: "#f4faf7",
  canvas: "#0c110e",
  ink: "#0c110e",
  muted: "#5b6b63",
  hairline: "#d8e2dd",
  surface: "#ffffff",
  warnSurface: "#f4faf7",
} as const;

/**
 * Absolute URL to the logo, used as the <img> src in the header.
 *
 * Email <img> src must be absolute — a relative path is not fetched. Built from
 * the deployment's own base URL so staging mail never points at production
 * assets (or the reverse). Resend's CDN proxy is deliberately NOT used here:
 * it rewrites the host, which defeats the point of showing the recipient a
 * verifiable image source on the same origin as the button.
 */
export function logoUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/logo.svg`;
}

/**
 * Render the origin the way a recipient should verify it: scheme + host, no
 * trailing slash, no "www." rewriting.
 *
 * This string is a SECURITY CONTROL, not decoration. The magic-link template
 * prints it in the preheader and the footer so an operator can compare it
 * against the button's domain without expanding anything. Anything that could
 * hide a homograph or a subdomain (unicode, userinfo, a port) is rejected by
 * the caller's URL parsing rather than silently normalised here.
 */
export function displayOrigin(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}