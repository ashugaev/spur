import { execFile } from "node:child_process";
import { platform } from "node:os";

export interface DesktopNotification {
  title: string;
  message: string;
  urgent?: boolean;
}

// Both notifier binaries are awaited inside the attention tick with no other
// settle path (session-service.ts pollAttentionStates -> notifyAttention). A
// blocked notify-send (no notification daemon, stale D-Bus) or osascript
// without a display never exits on its own; the timeout guarantees the
// callback still fires so attentionMonitorRunning is always released.
const NOTIFY_TIMEOUT_MS = 5_000;

function escapeAppleScript(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");
}

export async function sendDesktopNotification(args: DesktopNotification): Promise<void> {
  await new Promise<void>((resolve) => {
    const os = platform();
    if (os === "darwin") {
      const script = `display notification "${escapeAppleScript(args.message)}" with title "${escapeAppleScript(args.title)}"${args.urgent ? ' sound name "default"' : ""}`;
      execFile("osascript", ["-e", script], { timeout: NOTIFY_TIMEOUT_MS }, () => resolve());
      return;
    }

    if (os === "linux") {
      execFile(
        "notify-send",
        [args.urgent ? "--urgency=critical" : "--urgency=normal", args.title, args.message],
        { timeout: NOTIFY_TIMEOUT_MS },
        () => resolve(),
      );
      return;
    }

    resolve();
  });
}
