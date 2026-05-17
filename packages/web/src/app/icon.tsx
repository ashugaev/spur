import { ImageResponse } from "next/og";
import { BG_BASE_HEX } from "@/design/colors";

export const size = { width: 32, height: 32 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    <div
      style={{
        width: "32px",
        height: "32px",
        background: BG_BASE_HEX,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
        <path
          d="M12 2v20M2 12h20M4.93 4.93l14.14 14.14M19.07 4.93 4.93 19.07"
          stroke="white"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
    </div>,
    { ...size },
  );
}
