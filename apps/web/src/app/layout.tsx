import type { ReactNode } from "react";
import { SessionProvider } from "../lib/session";
import "./globals.css";

export const metadata = { title: "Incident platform" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <SessionProvider>{children}</SessionProvider>
      </body>
    </html>
  );
}
