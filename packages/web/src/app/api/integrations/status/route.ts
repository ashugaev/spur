import { NextResponse } from "next/server";
import { fallbackIntegrationsStatus, readIntegrationsStatusSnapshot } from "@/lib/integration-status";
import type { IntegrationsStatusSnapshot } from "@/lib/types";

export const dynamic = "force-dynamic";

/** GET /api/integrations/status — telegram/jira listener health snapshot */
export async function GET() {
  let snapshot: IntegrationsStatusSnapshot;
  try {
    snapshot = readIntegrationsStatusSnapshot();
  } catch {
    snapshot = fallbackIntegrationsStatus("Health snapshot could not be loaded");
  }
  return NextResponse.json(snapshot, {
    headers: {
      "Cache-Control": "no-store",
    },
  });
}
