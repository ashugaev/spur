import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

function normalizePort(value: string | undefined, fallback: number): string {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535
    ? String(parsed)
    : String(fallback);
}

export async function GET() {
  const bindPort = normalizePort(
    process.env["DIRECT_TERMINAL_BIND_PORT"] ?? process.env["DIRECT_TERMINAL_PORT"],
    14801,
  );
  return NextResponse.json(
    {
      directTerminalPort: normalizePort(process.env["DIRECT_TERMINAL_PUBLIC_PORT"], Number(bindPort)),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
