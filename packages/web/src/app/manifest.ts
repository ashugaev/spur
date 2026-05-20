import type { MetadataRoute } from "next";
import { BG_BASE_HEX } from "@/design/colors";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Spur",
    short_name: "Spur",
    description: "Spur dashboard UI",
    start_url: "/",
    display: "standalone",
    background_color: BG_BASE_HEX,
    theme_color: BG_BASE_HEX,
    icons: [
      {
        src: "/icon-192",
        sizes: "192x192",
        type: "image/png",
      },
      {
        src: "/icon-512",
        sizes: "512x512",
        type: "image/png",
      },
      {
        src: "/icon-512",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
