import { createElement } from "react";
import { ImageResponse } from "next/og";
import { BG_BASE_HEX } from "@/design/colors";

export function GET() {
  return new ImageResponse(
    createElement(
      "div",
      {
        style: {
          width: "192px",
          height: "192px",
          background: BG_BASE_HEX,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        },
      },
      createElement(
        "svg",
        { width: "130", height: "130", viewBox: "0 0 24 24", fill: "none" },
        createElement("path", {
          d: "M12 2v20M2 12h20M4.93 4.93l14.14 14.14M19.07 4.93 4.93 19.07",
          stroke: "white",
          strokeWidth: "1.75",
          strokeLinecap: "round",
        }),
      ),
    ),
    { width: 192, height: 192 },
  );
}
