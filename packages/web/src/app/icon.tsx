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
      }}
    >
      {/* Stylized asterisk/star shape representing 𖤓 */}
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
