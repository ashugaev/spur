import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";

/** GET /api/agents — List available agent plugins */
export async function GET() {
  try {
    const { registry } = await getServices();
    const agents = registry.list("agent").map((m) => ({
      name: m.name,
      description: m.description,
    }));
    return NextResponse.json({ agents });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to list agents" },
      { status: 500 },
    );
  }
}
