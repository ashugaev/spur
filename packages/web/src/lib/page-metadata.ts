import { createElement } from "react";
import { ImageResponse } from "next/og";
import { BG_BASE_HEX, PAGE_ICON_FG_HEX } from "@/design/colors";
import { parsePages, type CatalogPage } from "./pages-client";
import { spurRequest, spurRequestJson, SpurDaemonError } from "./spur-daemon";

const MAX_ICON_BYTES = 1024 * 1024;
export type PageIconSize = 32 | 180 | 192 | 512;

export async function loadPageMetadata(id: string): Promise<CatalogPage> {
  const page = parsePages(await spurRequestJson<unknown>("/pages")).find(
    (entry) => entry.id === id,
  );
  if (!page) throw new SpurDaemonError("Page not found", 404);
  return page;
}

export function pageManifest(page: CatalogPage) {
  return {
    id: page.url,
    name: page.title,
    short_name: page.title,
    start_url: page.url,
    scope: page.url,
    display: "standalone",
    prefer_related_applications: false,
    icons: [192, 512].map((size) => ({
      src: `${page.url}_spur/icon-${size}.png`,
      sizes: `${size}x${size}`,
      type: "image/png",
      purpose: "any",
    })),
  };
}

async function iconData(page: CatalogPage): Promise<string | undefined> {
  if (!page.icon) return undefined;
  const response = await spurRequest(
    `/pages/${page.id}/files/${page.icon.split("/").map(encodeURIComponent).join("/")}`,
  );
  if (!response.ok) throw new SpurDaemonError("Page icon unavailable", response.status);
  if (response.headers.get("content-type")?.split(";")[0] !== "image/png" || !response.body)
    throw new Error("Page icon must be PNG");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > MAX_ICON_BYTES) throw new Error("Page icon exceeds 1 MiB");
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel();
  }
  const png = Buffer.concat(chunks);
  if (
    png.length < 24 ||
    !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    png.toString("ascii", 12, 16) !== "IHDR"
  )
    throw new Error("Invalid PNG icon");
  const width = png.readUInt32BE(16);
  if (width < 1 || width > 4096 || width !== png.readUInt32BE(20))
    throw new Error("Page icon must be square and at most 4096px");
  return `data:image/png;base64,${png.toString("base64")}`;
}

export async function renderPageIcon(page: CatalogPage, size: PageIconSize): Promise<Response> {
  const source = await iconData(page);
  const image = source
    ? createElement("img", { src: source, width: size, height: size })
    : createElement(
        "svg",
        { width: size * 0.6, height: size * 0.6, viewBox: "0 0 24 24", fill: "none" },
        createElement("path", {
          d: "M5 2h9l5 5v15H5zM14 2v6h5M8 12h8M8 16h6",
          stroke: PAGE_ICON_FG_HEX,
          strokeWidth: 1.5,
        }),
      );
  const rendered = new ImageResponse(
    createElement(
      "div",
      {
        style: {
          width: size,
          height: size,
          background: BG_BASE_HEX,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        },
      },
      image,
    ),
    { width: size, height: size },
  );
  // Buffer so decoder/renderer failures become an HTTP error before headers are sent.
  return new Response(await rendered.arrayBuffer(), {
    headers: { "Content-Type": "image/png", "Cache-Control": "no-store" },
  });
}
