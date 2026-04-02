import { execFile } from "node:child_process";
import { platform } from "node:os";

export interface DesktopNotification {
  title: string;
  message: string;
  urgent?: boolean;
}

function escapeAppleScript(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");
}

export async function sendDesktopNotification(args: DesktopNotification): Promise<void> {
  await new Promise<void>((resolve) => {
    const os = platform();
    if (os === "darwin") {
      const script = `display notification "${escapeAppleScript(args.message)}" with title "${escapeAppleScript(args.title)}"${args.urgent ? ' sound name "default"' : ""}`;
      execFile("osascript", ["-e", script], () => resolve());
      return;
    }

    if (os === "linux") {
      execFile(
        "notify-send",
        [args.urgent ? "--urgency=critical" : "--urgency=normal", args.title, args.message],
        () => resolve(),
      );
      return;
    }

    resolve();
  });
}
