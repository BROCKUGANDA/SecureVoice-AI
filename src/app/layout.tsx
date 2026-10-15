import type { Metadata, Viewport } from "next";
import { Space_Grotesk, Inter, JetBrains_Mono, IBM_Plex_Sans_Arabic } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as SonnerToaster } from "@/components/ui/sonner";
import { Providers } from "@/app/providers";
import { JsonLd, ProductJsonLd } from "@/components/seo/JsonLd";
import { COMPANY } from "@/lib/commercial";
import { siteOrigin } from "@/lib/site-origin";
import { TenantBrand } from "@/components/shell/TenantBrand";
import HealthCheck from "@/components/HealthCheck";

const display = Space_Grotesk({
  variable: "--font-display",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

const sans = Inter({
  variable: "--font-sans",
  subsets: ["latin"],
  display: "swap",
});

const mono = JetBrains_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

const arabic = IBM_Plex_Sans_Arabic({
  variable: "--font-arabic",
  subsets: ["arabic"],
  weight: ["300", "400", "500", "600", "700"],
  display: "swap",
});

/**
 * Root metadata — the document head for every route that does not override it.
 *
 * Read the comment on `metadataBase` before adding a per-route `metadata` block:
 * every relative path in a nested metadata object resolves against it, and with
 * it unset Next falls back to `http://localhost:3000`, which silently poisons
 * canonical URLs, OG image URLs and sitemap entries in production.
 *
 * The site has a `title.template`, so a route that sets only `title` gets
 * "… · SecureVoice AI" for free. Setting `default` (not `title`) is what makes
 * the root's own title render undecorated instead of doubled.
 */
export const metadata: Metadata = {
  // Without this, `alternates.canonical` and the OG/Twitter image URLs below are
  // resolved against localhost in production. See src/lib/site-origin.ts for the
  // resolution order; NEXT_PUBLIC_SITE_URL is the variable to set.
  metadataBase: new URL(siteOrigin()),

  title: {
    default: `${COMPANY.name} — Real-Time Fraud Intervention`,
    template: `%s · ${COMPANY.name}`,
  },
  description:
    "SecureVoice AI is a real-time voice fraud-intervention platform for UAE banks and insurers. An AI voice agent calls the customer in their own language within 60 seconds of a fraud signal, verifies identity, holds the card or the claim payout, and hands off to a human. Plans from $99/month.",
  applicationName: COMPANY.name,
  // `legalName`, not the brand: the Terms and Conditions are required to name the
  // company, and the machine-readable version of that obligation belongs in the
  // head as well as on the page.
  authors: [{ name: COMPANY.legalName, url: "/" }],
  creator: COMPANY.legalName,
  publisher: COMPANY.legalName,
  category: "finance",
  keywords: [
    "fraud intervention",
    "AI voice agent",
    "voice bot",
    "fraud prevention",
    "real-time fraud detection",
    "card freeze automation",
    "claim payout hold",
    "UAE banking",
    "UAE insurance",
    "takaful",
    "policy fraud prevention",
    "CBUAE",
    "Middle East banking",
    "Middle East insurance",
    "Arabic voice AI",
    "fraud intervention software",
    "SecureVoice AI",
  ],
  /**
   * The full icon set, not just `/logo.svg`.
   *
   * SVG-only is not enough and the gap is invisible in a browser tab. Safari and
   * iOS do not render SVG favicons at all (they want a 180×180 PNG at
   * `/apple-touch-icon.png`), Windows still asks for `/favicon.ico` unprompted,
   * and `src/app/favicon.ico` is served automatically by Next from the file-based
   * convention. All three files are generated from `public/logo.svg` by
   * `bun scripts/build-icons.mjs`, so there is one source of truth.
   */
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "48x48 32x32 16x16", type: "image/x-icon" },
      { url: "/icon.svg", type: "image/svg+xml" },
    ],
    shortcut: ["/favicon.ico"],
    apple: [{ url: "/apple-icon.png", sizes: "180x180", type: "image/png" }],
  },
  manifest: "/site.webmanifest",

  /**
   * `index: true` is redundant — the proxy omits X-Robots-Tag entirely for
   * indexable paths rather than emitting an affirmative one. It is declared here
   * anyway so the intent lives in one place: if a crawler honours the meta robots
   * tag and nothing else, `/` still resolves to "index, follow".
   */
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true, "max-image-preview": "large" },
  },
  alternates: { canonical: "/" },

  openGraph: {
    type: "website",
    url: "/",
    siteName: COMPANY.name,
    locale: "en_GB",
    alternateLocale: ["ar_AE"],
    title: `${COMPANY.name} — Real-Time Fraud Intervention`,
    description:
      "38 minutes → 60 seconds. A multilingual AI voice agent for UAE banks and insurers: verifies identity, holds the card or the claim payout, and hands off to a human. Plans from $99/month.",
    images: [
      {
        url: "/og-image.png",
        width: 1200,
        height: 630,
        alt: `${COMPANY.name} — Real-Time Fraud Intervention for UAE banks and insurers`,
      },
    ],
  },

  /**
   * Twitter/X takes the card from its own tags, not OpenGraph, so `summary_large_image`
   * has to be declared here or the tweet renders as a bare link.
   */
  twitter: {
    card: "summary_large_image",
    title: `${COMPANY.name} — Real-Time Fraud Intervention`,
    description:
      "An AI voice agent that calls the customer within 60 seconds of a fraud signal, verifies identity, and holds the card or claim payout. Built for UAE banks and insurers.",
    images: ["/og-image.png"],
  },

  appleWebApp: {
    capable: true,
    title: COMPANY.name,
    statusBarStyle: "black-translucent",
  },
  formatDetection: { telephone: false, address: false, email: false },
};

export const viewport: Viewport = {
  // THE PAPER COLOUR, NOT THE INK ONE. `themeColor` paints the browser chrome
  // — the mobile address bar, the task-switcher card — so it has to match the
  // canvas the visitor actually lands on. This pair used to read
  // `#0D1512` (the ink) for BOTH schemes, which is why the product still
  // *looked* dark-mode on a light page: the browser furniture around it was ink.
  // The palette is light now, and the two media entries are kept as a pair
  // because they are the same value on purpose — the chrome must not change
  // with the OS preference, or Safari's toolbar and the page would disagree.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fbfbf8" },
    { media: "(prefers-color-scheme: dark)", color: "#fbfbf8" },
  ],
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* The answer-engine payload: who this is, what it costs, what it does.
            Server-rendered so it is in the first byte of HTML, not something a
            crawler has to run JS to find. */}
        <JsonLd />
        <ProductJsonLd />
      </head>
      <body
        className={`${display.variable} ${sans.variable} ${mono.variable} ${arabic.variable} antialiased bg-background text-foreground`}
      >
        {/* The tenant's brand colour, resolved server-side from the session's
            organisation and emitted before anything paints. A `<style>` in the
            SSR output applies at first paint, so the console never shows the
            platform green and then corrects itself. Renders nothing when the
            visitor has no tenant or the tenant set no colour, which is the
            default path and costs one session cookie parse. See the component
            for why this is a database read rather than a cookie. */}
        <TenantBrand />
        <HealthCheck />
        {/* Better Auth has no provider component: sessions are read from the
            database by `auth.api.getSession({ headers })` wherever they are
            needed, and the browser reads them through `authClient.useSession()`.
            There is deliberately nothing auth-shaped wrapped around the tree here
            — a client-side provider would be a cached session, and an
            authorisation decision must never be taken from one (hazard AU-4).
            `Providers` carries the colour theme and product analytics only; it
            holds no session, and src/app/providers.tsx says the same. */}
        <Providers>
          {children}
          {/* Two toast families are live and each has callers: the radix
              pipeline (hooks/use-toast → Dashboard, Home) and sonner
              (CreditWidget's toast.success/error). Only the radix one was
              mounted, so every sonner call rendered nowhere. Mount both until
              the call sites consolidate — an unmounted toast is a silent
              failure of a feedback channel. */}
          <Toaster />
          <SonnerToaster />
        </Providers>
      </body>
    </html>
  );
}
