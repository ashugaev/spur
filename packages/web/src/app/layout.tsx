import type { Metadata, Viewport } from "next";
import { Geist, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  subsets: ["latin"],
  variable: "--font-ibm-plex-sans",
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-ibm-plex-mono",
  display: "swap",
  weight: ["400", "500"],
});

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0d1117",
};

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: {
      template: "%s | Spur",
      default: "Spur | Dashboard",
    },
    description: "Spur dashboard UI",
  };
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`dark ${geistSans.variable} ${jetbrainsMono.variable}`}>
      <body suppressHydrationWarning className="bg-[var(--color-bg-base)] text-[var(--color-text-primary)] antialiased">
        {children}
      </body>
    </html>
  );
}
