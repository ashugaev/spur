import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

function normalizePort(value: string | undefined, fallback: number): string {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535
    ? String(parsed)
    : String(fallback);
}

export async function GET() {
  return NextResponse.json(
    {
      directTerminalPort: normalizePort(process.env["DIRECT_TERMINAL_PORT"], 14801),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
