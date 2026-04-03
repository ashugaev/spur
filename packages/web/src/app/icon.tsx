import { ImageResponse } from "next/og";

export const size = { width: 32, height: 32 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    <div
      style={{
        width: "32px",
        height: "32px",
        background: "#0D0D0E",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "#FFFFFF",
        fontSize: "20px",
        fontWeight: 700,
        fontFamily: "sans-serif",
      }}
    >
      𖤓
    </div>,
    { ...size },
  );
}
