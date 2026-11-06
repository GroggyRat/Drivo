import type { Metadata, Viewport } from "next";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Drivo", template: "%s | Drivo" },
  description: "Delivery routing and fleet tracking",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#0b1f44" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-GB">
      <body>{children}</body>
    </html>
  );
}
