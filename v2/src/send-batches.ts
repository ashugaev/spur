import { readGitHubSourceSnapshot } from "./metadata.js";
import type {
  GitHubEventData,
  GitHubSignal,
  ServiceProblemEventData,
  SourceType,
} from "./types.js";

export interface SendBatch {
  readonly sessionId: string;
  merge(incoming: SendBatch): void;
  prune(dataDir: string): void;
  isEmpty(): boolean;
  format(): string;
}

export type SendBatchParser = (data: unknown) => SendBatch | null;

class GitHubSendBatch implements SendBatch {
  static parse(
    projectId: string,
    sourceId: string,
    prompt: string | undefined,
    data: unknown,
  ): GitHubSendBatch | null {
    if (!isGitHubEventData(data)) return null;
    return new GitHubSendBatch(projectId, sourceId, prompt, data);
  }

  readonly sessionId: string;
  private prNumber: number;
  private prTitle: string;
  private readonly signals: Map<string, GitHubSignal>;

  private constructor(
    private readonly projectId: string,
    private readonly sourceId: string,
    private readonly prompt: string | undefined,
    data: GitHubEventData,
  ) {
    this.sessionId = data.sessionId;
    this.prNumber = data.prNumber;
    this.prTitle = data.prTitle;
    this.signals = new Map<string, GitHubSignal>();
    for (const signal of data.signals) {
      this.signals.set(signal.key, signal);
    }
  }

  merge(incoming: SendBatch): void {
    const next = incoming as GitHubSendBatch;
    this.prNumber = next.prNumber;
    this.prTitle = next.prTitle;
    for (const signal of next.signals.values()) {
      this.signals.set(signal.key, signal);
    }
  }

  prune(dataDir: string): void {
    const snapshot = readGitHubSourceSnapshot(
      dataDir,
      this.projectId,
      this.sourceId,
      this.sessionId,
    );

    // The latest source snapshot is the truth before delivery, so queued
    // GitHub updates may expire while a session stays busy.
    for (const key of [...this.signals.keys()]) {
      if (snapshot?.has(key)) continue;
      this.signals.delete(key);
    }
  }

  isEmpty(): boolean {
    return this.signals.size === 0;
  }

  private buildActionLines(): string[] {
    if (this.prompt !== undefined) {
      return [this.prompt];
    }

    const kinds = new Set([...this.signals.values()].map((signal) => signal.kind));
    const lines = ["Review the latest GitHub updates on the active PR and act on them."];
    if (kinds.has("changes_requested")) {
      lines.push("Address the requested review changes on the active PR.");
    }
    if (kinds.has("ci_failed")) {
      lines.push("Inspect the failing checks, fix them, and rerun the relevant validation.");
    }
    if (kinds.has("merge_conflict")) {
      lines.push("Resolve the active PR merge conflicts, rerun the relevant validation, and push.");
    }
    if (kinds.has("comment")) {
      lines.push("Read the latest PR comments and act on them.");
    }
    lines.push(
      "Use `gh pr view --comments` and `gh pr checks`, then fix, push, and reply if needed.",
    );
    return lines;
  }

  format(): string {
    const lines = [...this.signals.values()].map((signal) => `- ${signal.text}`);
    return [
      `GitHub updates on PR #${this.prNumber} "${this.prTitle}":`,
      ...lines,
      "",
      ...this.buildActionLines(),
    ].join("\n");
  }
}

class ServiceSendBatch implements SendBatch {
  static parse(prompt: string | undefined, data: unknown): ServiceSendBatch | null {
    if (!isServiceProblemEventData(data)) return null;
    return new ServiceSendBatch(prompt, data);
  }

  readonly sessionId: string;
  private readonly serviceId: string;
  private readonly ruleIds = new Set<string>();

  private constructor(
    private readonly prompt: string | undefined,
    data: ServiceProblemEventData,
  ) {
    this.sessionId = data.sessionId;
    this.serviceId = data.serviceId;
    this.ruleIds.add(data.ruleId);
  }

  merge(incoming: SendBatch): void {
    const next = incoming as ServiceSendBatch;
    for (const ruleId of next.ruleIds) {
      this.ruleIds.add(ruleId);
    }
  }

  prune(_dataDir: string): void {
    // Service alerts are already reduced to the latest per-rule match window.
  }

  isEmpty(): boolean {
    return this.ruleIds.size === 0;
  }

  format(): string {
    const sessionId = this.sessionId;
    const serviceId = this.serviceId;
    return [
      this.prompt ?? `The bound service "${serviceId}" has a problem.`,
      `Triggered rules: ${[...this.ruleIds].sort().join(", ")}`,
      "",
      `Inspect it in Spur list: select ${sessionId} and press l for the live session log view.`,
    ].join("\n");
  }
}

export function isGitHubEventData(value: unknown): value is GitHubEventData {
  if (!value || typeof value !== "object") return false;
  const data = value as Record<string, unknown>;
  return (
    typeof data["sessionId"] === "string" &&
    typeof data["prNumber"] === "number" &&
    typeof data["prTitle"] === "string" &&
    Array.isArray(data["signals"])
  );
}

export function isServiceProblemEventData(value: unknown): value is ServiceProblemEventData {
  if (!value || typeof value !== "object") return false;
  const data = value as Record<string, unknown>;
  return (
    typeof data["sessionId"] === "string" &&
    typeof data["serviceId"] === "string" &&
    typeof data["ruleId"] === "string"
  );
}

export function createSendBatchParser(
  sourceType: SourceType,
  projectId: string,
  sourceId: string,
  prompt?: string,
): SendBatchParser {
  if (sourceType === "github") {
    return (data) => GitHubSendBatch.parse(projectId, sourceId, prompt, data);
  }
  if (sourceType === "service") {
    return (data) => ServiceSendBatch.parse(prompt, data);
  }
  return () => null;
}
