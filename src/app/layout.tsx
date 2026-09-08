import type { Metadata, Viewport } from "next";
import {
  Space_Grotesk,
  Inter,
  JetBrains_Mono,
  IBM_Plex_Sans_Arabic,
} from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import { dark } from "@clerk/themes";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

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

export const metadata: Metadata = {
  title: "SecureVoice AI — Real-Time Fraud Intervention",
  description:
    "An AI voice agent that calls customers in their language within 60 seconds of a fraud signal — verifies identity, freezes the card, and hands off to humans. Built for UAE banking on ElevenLabs.",
  keywords: [
    "SecureVoice AI",
    "fraud intervention",
    "voice agent",
    "ElevenLabs",
    "UAE banking",
    "CBUAE",
  ],
  authors: [{ name: "SecureVoice AI" }],
  icons: {
    icon: "/logo.svg",
  },
  openGraph: {
    title: "SecureVoice AI — Real-Time Fraud Intervention",
    description:
      "38 minutes → 60 seconds. Multilingual AI voice agent for real-time fraud intervention.",
    siteName: "SecureVoice AI",
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: "#0D1512",
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
      <body
        className={`${display.variable} ${sans.variable} ${mono.variable} ${arabic.variable} antialiased bg-background text-foreground`}
      >
        {/* ClerkProvider sits inside <body> (never wrapping <html>) per Clerk docs */}
        <ClerkProvider
          appearance={{ theme: dark }}
          signInUrl="/auth"
          signUpUrl="/auth"
        >
          {children}
          <Toaster />
        </ClerkProvider>
      </body>
    </html>
  );
}
