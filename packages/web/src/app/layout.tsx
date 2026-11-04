import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { BG_BASE_HEX } from "@/design/colors";
import Providers from "./providers";
import "./globals.css";

const jetbrainsMono = localFont({
  src: [
    { path: "../../public/fonts/JetBrainsMono-Light.woff2", weight: "300", style: "normal" },
    { path: "../../public/fonts/JetBrainsMono-Regular.woff2", weight: "400", style: "normal" },
    { path: "../../public/fonts/JetBrainsMono-Medium.woff2", weight: "500", style: "normal" },
    { path: "../../public/fonts/JetBrainsMono-Bold.woff2", weight: "700", style: "normal" },
  ],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Pinned so iOS Safari never auto-zooms when a form field with a
  // sub-16px font size takes focus.
  maximumScale: 1,
  viewportFit: "cover",
  themeColor: BG_BASE_HEX,
};

export const metadata: Metadata = {
  title: "Spur",
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

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={`dark ${jetbrainsMono.variable}`}>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `var t=null;try{t=localStorage.getItem("spur:theme")}catch(e){}var d=true;try{d=matchMedia("(prefers-color-scheme: dark)").matches}catch(e){}var c=t==="light"?"light":t==="dark"?"dark":d?"dark":"light";if(c==="light"){document.documentElement.dataset.theme="light"}else{delete document.documentElement.dataset.theme}document.documentElement.style.colorScheme=c`,
          }}
        />
      </head>
      <body suppressHydrationWarning className="antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
