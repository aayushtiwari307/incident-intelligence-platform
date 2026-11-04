import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, Source_Sans_3 } from "next/font/google";
import type { ReactNode } from "react";
import { SessionProvider } from "../lib/session";
import "./globals.css";

// Free Google fonts, self-hosted by Next at build time (no runtime request to Google).
const sourceSans = Source_Sans_3({ subsets: ["latin"], weight: ["400", "500", "600", "700"], variable: "--font-source-sans", display: "swap" });
const plexMono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-plex-mono", display: "swap" });

export const metadata: Metadata = {
  title: "IIP Console",
  description: "Incident workspace for small teams: alerts, context and past fixes on one screen.",
};

export const viewport: Viewport = { themeColor: "#0B0B0C", colorScheme: "dark" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${sourceSans.variable} ${plexMono.variable}`}>
      <body>
        <SessionProvider>{children}</SessionProvider>
      </body>
    </html>
  );
}
