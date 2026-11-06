import { homedir } from "node:os";
import { join } from "node:path";

// Same file v2/scripts/install-and-restart.sh locks: $HOME/.spur/install-and-restart.lock.
export function spurInstallLockPath(home: string = homedir()): string {
  return join(home, ".spur", "install-and-restart.lock");
}
