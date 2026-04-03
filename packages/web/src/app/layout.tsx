import type { Metadata, Viewport } from "next";
import { JetBrains_Mono } from "next/font/google";
import "./globals.css";

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-ibm-plex-mono",
  display: "swap",
  weight: ["300", "400", "500", "700"],
});

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0D0D0E",
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
    <html lang="en" className={`dark ${jetbrainsMono.variable}`}>
      <body
        suppressHydrationWarning
        className="bg-[var(--color-bg-base)] text-[var(--color-text-primary)] antialiased"
      >
        {children}
      </body>
    </html>
  );
}
