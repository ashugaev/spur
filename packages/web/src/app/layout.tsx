import type { Metadata, Viewport } from "next";
import { JetBrains_Mono } from "next/font/google";
import "./globals.css";

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
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
    manifest: "/manifest.webmanifest",
    applicationName: "Spur",
    appleWebApp: {
      capable: true,
      title: "Spur",
      statusBarStyle: "black-translucent",
    },
    icons: {
      icon: [{ url: "/icon-192" }, { url: "/icon-512" }],
      apple: [{ url: "/apple-icon" }],
    },
  };
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={`dark ${jetbrainsMono.variable}`}>
      <body suppressHydrationWarning className="antialiased">
        {children}
      </body>
    </html>
  );
}
