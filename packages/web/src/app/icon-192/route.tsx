import { ImageResponse } from "next/og";

export function GET() {
  return new ImageResponse(
    <div
      style={{
        width: "192px",
        height: "192px",
        background: "#0D0D0E",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <svg width="130" height="130" viewBox="0 0 24 24" fill="none">
        <path
          d="M12 2v20M2 12h20M4.93 4.93l14.14 14.14M19.07 4.93 4.93 19.07"
          stroke="white"
          strokeWidth="1.75"
          strokeLinecap="round"
        />
      </svg>
    </div>,
    { width: 192, height: 192 },
  );
}
