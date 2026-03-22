import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const STATUS_COMMAND_SOURCE = `#!/usr/bin/env node
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const nextStatus = process.argv[2];
if (!new Set(["running", "needs_input", "done"]).has(nextStatus)) {
  console.error("Usage: spur-status <running|needs_input|done>");
  process.exit(1);
}

const dataDir = process.env["SPUR_DATA_DIR"];
const projectId = process.env["SPUR_PROJECT"];
const sessionId = process.env["SPUR_SESSION"];
if (!dataDir || !projectId || !sessionId) {
  console.error("SPUR_DATA_DIR, SPUR_PROJECT, and SPUR_SESSION are required");
  process.exit(1);
}

const sessionPath = join(dataDir, "sessions", projectId, \`\${sessionId}.json\`);
let session;
try {
  session = JSON.parse(readFileSync(sessionPath, "utf-8"));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(\`Failed to read session metadata: \${message}\`);
  process.exit(1);
}

const updated = {
  ...session,
  status: nextStatus,
  updatedAt: new Date().toISOString(),
};
const tmpPath = \`\${sessionPath}.tmp.\${process.pid}.\${Date.now()}\`;
writeFileSync(tmpPath, JSON.stringify(updated, null, 2) + "\\n", "utf-8");
renameSync(tmpPath, sessionPath);
process.stdout.write(\`\${nextStatus}\\n\`);
`;

export function ensureStatusCommand(dataDir: string): string {
  const binDir = join(dataDir, "bin");
  const commandPath = join(binDir, "spur-status");
  mkdirSync(binDir, { recursive: true });

  const tmpPath = `${commandPath}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmpPath, STATUS_COMMAND_SOURCE, { encoding: "utf-8", mode: 0o755 });
  renameSync(tmpPath, commandPath);

  return commandPath;
}

export function appendStatusInstructions(prompt: string): string {
  return `${prompt.trimEnd()}

Spur session status:
- When you need human input, run: "$SPUR_STATUS_COMMAND" needs_input
- When you finish the task, run: "$SPUR_STATUS_COMMAND" done
- If you need to clear one of those states without waiting for a human reply, run: "$SPUR_STATUS_COMMAND" running`;
}
