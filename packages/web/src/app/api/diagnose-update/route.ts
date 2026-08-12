import { NextResponse, type NextRequest } from "next/server";
import { spurJsonInit, spurRequestJson } from "@/lib/spur-daemon";
import { spurErrorResponse } from "@/lib/spur-error-response";

interface DiagnoseUpdateBody {
  target?: string;
}

interface DiagnoseUpdateResult {
  disposition: "spawned" | "reused";
  session: { id: string; project: string };
}

function isDiagnoseUpdateResult(value: unknown): value is DiagnoseUpdateResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  const session = result.session;
  return (
    (result.disposition === "spawned" || result.disposition === "reused") &&
    typeof session === "object" &&
    session !== null &&
    typeof (session as Record<string, unknown>).id === "string" &&
    typeof (session as Record<string, unknown>).project === "string"
  );
}

const DIAGNOSE_PROMPT = (
  target: string,
) => `A Spur self-update to version ${target} failed: the daemon never confirmed the new version and the UI showed the "Updating Spur failed" overlay. Complete the version bump through the NORMAL release/deploy flow — do not apply hacks that would bypass or break that flow.

Do the following:
1. Read ~/.spur/logs/install-and-restart.log and diagnose why the switch to ${target} was not confirmed. The switch runs \`npm install -g @shugaev/spur@${target}\` then \`systemctl --user restart spur-daemon.service spur-web.service\`, invoked by the daemon's POST /deploy/switch.
2. Bring up a working latest version through the proper mechanism — a legitimate completion of the bump, not a workaround. Fix the actual failure cause (install, restart, prebuild, or config) rather than pinning around it. Use the \`spur\` CLI and shell as needed.
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

    const payload = { prompt: DIAGNOSE_PROMPT(target), reportDisposition: true };

    const result = await spurRequestJson<unknown>("/shepherd/spawn", spurJsonInit("POST", payload));
    if (!isDiagnoseUpdateResult(result)) {
      return NextResponse.json(
        { error: "Spur daemon returned an invalid diagnostic-session response" },
        { status: 502 },
      );
    }

    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return spurErrorResponse(error, "Failed to spawn update-diagnosis agent");
  }
}
