import { ImageResponse } from "next/og";

export function GET() {
  return new ImageResponse(
    <div
      style={{
        width: "512px",
        height: "512px",
        background: "#0D0D0E",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <svg width="348" height="348" viewBox="0 0 24 24" fill="none">
        <path
          d="M12 2v20M2 12h20M4.93 4.93l14.14 14.14M19.07 4.93 4.93 19.07"
          stroke="white"
          strokeWidth="1.75"
          strokeLinecap="round"
        />
      </svg>
    </div>,
    { width: 512, height: 512 },
  );
}
