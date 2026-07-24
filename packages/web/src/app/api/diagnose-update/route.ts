import { NextResponse, type NextRequest } from "next/server";
import { spurJsonInit, spurRequestJson } from "@/lib/spur-daemon";
import { spurErrorResponse } from "@/lib/spur-error-response";
import type { SpurSessionView } from "@/lib/types";

interface DiagnoseUpdateBody {
  target?: string;
}

const DIAGNOSE_PROMPT = (
  target: string,
) => `A Spur self-update to version ${target} failed: the daemon never confirmed the new version and the UI showed the "Updating Spur failed" overlay. Complete the version bump through the NORMAL release/deploy flow — do not apply hacks that would bypass or break that flow.

Do the following:
1. Read ~/.spur/logs/install-and-restart.log and diagnose why the switch to ${target} was not confirmed. Read v2/scripts/install-and-restart.sh to understand what the switch does (npm install -g @shugaev/spur@${target}, then systemctl --user restart of spur-daemon.service and spur-web.service) and how the daemon's POST /deploy/switch invokes it.
2. Bring up a working latest version through the proper mechanism — a legitimate completion of the bump, not a workaround. Fix the actual failure cause (install, restart, prebuild, or config) rather than pinning around it.
3. Verify the daemon reports the target version (GET /runtime/info or \`spur --version\`) and that the web UI can reload cleanly.
4. Explain in plain language what went wrong and what you changed.

Opening a GitHub issue on ashugaev/spur is OPTIONAL: you may PROPOSE one to the user if the root cause is a reproducible product bug, but do NOT create it automatically.`;

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as DiagnoseUpdateBody;
    const target = body.target?.trim();

    if (!target) {
      return NextResponse.json({ error: "target is required" }, { status: 400 });
    }

    const project = process.env["SPUR_SELF_PROJECT_ID"]?.trim() || "sp";
    const payload = { project, prompt: DIAGNOSE_PROMPT(target), agent: "claude" };

    const session = await spurRequestJson<SpurSessionView>(
      "/sessions/background",
      spurJsonInit("POST", payload),
    );

    return NextResponse.json(session, { status: 201 });
  } catch (error) {
    return spurErrorResponse(error, "Failed to spawn update-diagnosis agent");
  }
}
