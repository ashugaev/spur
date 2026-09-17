import { cleanupIsolatedWebTestTarget } from "./daemon-target.js";

// Runs once in the main process after the last worker exits. Without it the
// harness's temp config dir outlives every run, since a module-scope allocation
// has nothing to await.
export default function globalTeardown(): void {
  cleanupIsolatedWebTestTarget();
}
