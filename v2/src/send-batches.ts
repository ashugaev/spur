import { readGitHubSourceSnapshot, readReviewSourceSnapshot } from "./metadata.js";
import { reviewProvider } from "./review-providers/index.js";
import type {
  ReviewEventData,
  ReviewProviderId,
  ReviewSignal,
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

class ReviewSendBatch implements SendBatch {
  static parse(
    providerId: ReviewProviderId,
    projectId: string,
    sourceId: string,
    prompt: string | undefined,
    data: unknown,
  ): ReviewSendBatch | null {
    if (!isReviewEventData(data)) return null;
    return new ReviewSendBatch(providerId, projectId, sourceId, prompt, data);
  }

  readonly sessionId: string;
  private prNumber: number;
  private prTitle: string;
  private readonly signals: Map<string, ReviewSignal>;

  private constructor(
    private readonly providerId: ReviewProviderId,
    private readonly projectId: string,
    private readonly sourceId: string,
    private readonly prompt: string | undefined,
    data: ReviewEventData,
  ) {
    this.sessionId = data.sessionId;
    this.prNumber = data.prNumber;
    this.prTitle = data.prTitle;
    this.signals = new Map<string, ReviewSignal>();
    for (const signal of data.signals) {
      this.signals.set(signal.key, signal);
    }
  }

  merge(incoming: SendBatch): void {
    const next = incoming as ReviewSendBatch;
    this.prNumber = next.prNumber;
    this.prTitle = next.prTitle;
    for (const signal of next.signals.values()) {
      this.signals.set(signal.key, signal);
    }
  }

  prune(dataDir: string): void {
    const snapshot =
      this.providerId === "github"
        ? readGitHubSourceSnapshot(dataDir, this.projectId, this.sourceId, this.sessionId)
        : readReviewSourceSnapshot(
            dataDir,
            this.providerId,
            this.projectId,
            this.sourceId,
            this.sessionId,
          );

    for (const key of [...this.signals.keys()]) {
      if (snapshot?.has(key)) continue;
      this.signals.delete(key);
    }
  }

  isEmpty(): boolean {
    return this.signals.size === 0;
  }

  private buildActionLines(): string[] {
    const provider = reviewProvider(this.providerId);
    if (this.prompt !== undefined) {
      return [this.prompt];
    }

    const kinds = new Set([...this.signals.values()].map((signal) => signal.kind));
    const lines = [provider.instructionsLine];
    if (kinds.has("changes_requested")) {
      lines.push(`Address the requested review changes on the active ${provider.requestLabel}.`);
    }
    if (kinds.has("ci_failed")) {
      lines.push("Inspect the failing checks, fix them, and rerun the relevant validation.");
    }
    if (kinds.has("merge_conflict")) {
      lines.push(
        `Resolve the active ${provider.requestLabel} merge conflicts, rerun the relevant validation, and push.`,
      );
    }
    if (kinds.has("comment")) {
      lines.push(`Read the latest ${provider.requestLabel} comments and act on them.`);
    }
    if (kinds.has("ready_for_review")) {
      lines.push(`The ${provider.requestLabel} is ready for review.`);
    }
    if (kinds.has("approved")) {
      lines.push(`The ${provider.requestLabel} received an approving review.`);
    }
    if (kinds.has("merged")) {
      lines.push(`The ${provider.requestLabel} was merged.`);
    }
    if (kinds.has("closed")) {
      lines.push(`The ${provider.requestLabel} was closed without merging.`);
    }
    lines.push(provider.commandLine);
    return lines;
  }

  format(): string {
    const lines = [...this.signals.values()].map((signal) => `- ${signal.text}`);
    const provider = reviewProvider(this.providerId);
    return [
      `${provider.displayName} updates on ${provider.requestLabel} #${this.prNumber} "${this.prTitle}":`,
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
  private readonly runtimeKind: ServiceProblemEventData["runtimeKind"];
  private readonly ruleIds = new Set<string>();

  private constructor(
    private readonly prompt: string | undefined,
    data: ServiceProblemEventData,
  ) {
    this.sessionId = data.sessionId;
    this.serviceId = data.serviceId;
    this.runtimeKind = data.runtimeKind;
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
    const noun = this.runtimeKind === "sidecar" ? "sidecar" : "service";
    return [
      this.prompt ?? `The bound ${noun} "${serviceId}" has a problem.`,
      `Triggered rules: ${[...this.ruleIds].sort().join(", ")}`,
      "",
      `Inspect it in Spur list: select ${sessionId} and press l for the live session log view.`,
    ].join("\n");
  }
}

export function isReviewEventData(value: unknown): value is ReviewEventData {
  if (!value || typeof value !== "object") return false;
  const data = value as Record<string, unknown>;
  return (
    typeof data["sessionId"] === "string" &&
    typeof data["prNumber"] === "number" &&
    typeof data["prTitle"] === "string" &&
    Array.isArray(data["signals"])
  );
}

export function isGitHubEventData(value: unknown): value is ReviewEventData {
  return isReviewEventData(value);
}

export function isServiceProblemEventData(value: unknown): value is ServiceProblemEventData {
  if (!value || typeof value !== "object") return false;
  const data = value as Record<string, unknown>;
  return (
    typeof data["sessionId"] === "string" &&
    typeof data["serviceId"] === "string" &&
    typeof data["ruleId"] === "string" &&
    (data["runtimeKind"] === undefined ||
      data["runtimeKind"] === "service" ||
      data["runtimeKind"] === "sidecar")
  );
}

export function createSendBatchParser(
  sourceType: SourceType,
  projectId: string,
  sourceId: string,
  prompt?: string,
): SendBatchParser {
  if (sourceType === "github" || sourceType === "gitlab") {
    return (data) => ReviewSendBatch.parse(sourceType, projectId, sourceId, prompt, data);
  }
  if (sourceType === "service") {
    return (data) => ServiceSendBatch.parse(prompt, data);
  }
  return () => null;
}
