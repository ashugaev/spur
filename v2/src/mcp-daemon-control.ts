import {
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { restartDaemonIfRunning } from "./client.js";
import { appendUserAction } from "./user-action-log.js";

const operationId = z.string().uuid();
const receiptSchema = z.object({
  operationId,
  action: z.literal("daemon.restart"),
  status: z.enum(["accepted", "completed", "unknown"]),
  acceptedAt: z.string(),
  previousPid: z.number().int().positive(),
  previousInstanceId: z.string().min(1),
  executorPid: z.number().int().positive(),
  dispatchedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  observedAt: z.string().optional(),
  instanceId: z.string().optional(),
  message: z.string().optional(),
});
export type DaemonRestartReceipt = z.infer<typeof receiptSchema>;
export interface DaemonIdentity {
  pid: number;
  lifecycleInstanceId: string;
}

/** Durable admission belongs to the instance, not a client connection or MCP host. */
export class McpDaemonControl {
  private readonly directory: string;
  constructor(
    private readonly dataDir: string,
    private readonly configPath: string,
  ) {
    this.directory = join(dataDir, "mcp-operator-actions");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (!lstatSync(this.directory).isDirectory())
      throw new Error("Invalid operator receipt directory");
  }

  private read(id: string): DaemonRestartReceipt | undefined {
    const path = join(this.directory, `${operationId.parse(id)}.json`);
    let fd: number | undefined;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const value: unknown = JSON.parse(readFileSync(fd, "utf8"));
      return receiptSchema.parse(value);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
        return undefined;
      throw new Error("Operator receipt unavailable or invalid; do not repeat restart");
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  private write(receipt: DaemonRestartReceipt): void {
    const path = join(this.directory, `${receipt.operationId}.json`);
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(receipt), { mode: 0o600 });
    renameSync(temporary, path);
  }

  get(id: string, current?: DaemonIdentity): DaemonRestartReceipt | undefined {
    const receipt = this.read(id);
    let executorAlive = true;
    if (receipt && receipt.status !== "completed") {
      try {
        process.kill(receipt.executorPid, 0);
      } catch {
        executorAlive = false;
      }
    }
    if (
      receipt &&
      receipt.status !== "completed" &&
      receipt.dispatchedAt &&
      (receipt.finishedAt || !executorAlive) &&
      current &&
      current.lifecycleInstanceId !== receipt.previousInstanceId
    ) {
      const completed: DaemonRestartReceipt = {
        ...receipt,
        status: "completed",
        observedAt: new Date().toISOString(),
        instanceId: current.lifecycleInstanceId,
        message:
          "A different ready daemon generation was observed after dispatch; session agents were not restarted",
      };
      this.write(completed);
      return completed;
    }
    if (receipt?.status === "accepted") {
      if (!executorAlive || Date.now() - Date.parse(receipt.acceptedAt) > 90_000) {
        const unknown: DaemonRestartReceipt = {
          ...receipt,
          status: "unknown",
          observedAt: new Date().toISOString(),
          message:
            "Executor unavailable or recovery deadline elapsed; retain this operation ID. No retry was made",
        };
        this.write(unknown);
        return unknown;
      }
    }
    return receipt;
  }

  accept(
    id: string,
    current: DaemonIdentity,
  ): { receipt: DaemonRestartReceipt; duplicate: boolean } {
    operationId.parse(id);
    const lock = join(this.directory, "admission.lock");
    // A crashed admission holds the lock: fail closed rather than replay effects.
    mkdirSync(lock, { mode: 0o700 });
    try {
      const existing = this.get(id, current);
      if (existing) return { receipt: existing, duplicate: true };
      const activePath = join(this.directory, "active");
      let active: string | undefined;
      try {
        active = readFileSync(activePath, "utf8");
      } catch (error) {
        if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT"))
          throw error;
      }
      if (active) {
        const previous = this.get(active, current);
        if (!previous || previous.status !== "completed")
          throw new Error(`Restart unresolved; reconcile original operation ${active}`);
      }
      const receipt: DaemonRestartReceipt = {
        operationId: id,
        action: "daemon.restart",
        status: "accepted",
        acceptedAt: new Date().toISOString(),
        previousPid: current.pid,
        previousInstanceId: current.lifecycleInstanceId,
        executorPid: process.pid,
      };
      this.write(receipt);
      writeFileSync(activePath, id, { mode: 0o600 });
      appendUserAction(this.dataDir, {
        ts: receipt.acceptedAt,
        actor: "user",
        origin: "mcp",
        action: "daemon.restart",
        method: "MCP",
        path: "restart_daemon",
        params: { operationId: id },
        outcome: { status: 202, ok: true },
        latencyMs: 0,
      });
      // Client cancellation cannot cancel an admitted lifecycle operation.
      setImmediate(() => {
        void this.run(receipt).catch(() => undefined);
      });
      return { receipt, duplicate: false };
    } finally {
      rmSync(lock, { recursive: true });
    }
  }

  private async run(receipt: DaemonRestartReceipt): Promise<void> {
    try {
      if (this.get(receipt.operationId)?.status !== "accepted") return;
      this.write({ ...receipt, dispatchedAt: new Date().toISOString() });
      await restartDaemonIfRunning(
        fileURLToPath(new URL("./cli.js", import.meta.url)),
        this.configPath,
        receipt.previousPid,
      );
      const latest = this.read(receipt.operationId);
      if (latest) this.write({ ...latest, finishedAt: new Date().toISOString() });
      // Completion requires the gateway's selected-instance/build/generation check.
    } catch {
      const latest = this.read(receipt.operationId);
      if (latest && latest.status !== "completed")
        this.write({
          ...latest,
          status: "unknown",
          finishedAt: new Date().toISOString(),
          observedAt: new Date().toISOString(),
          message:
            "Lifecycle call did not confirm recovery; inspect this operation after reconnect. No retry was made",
        });
    }
  }
}
