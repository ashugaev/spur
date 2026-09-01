import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  AutoPingDestination,
  AutoPingRouteDescriptor,
  AutoPingScope,
  AutoPingSuppressionView,
  AutoPingTarget,
} from "./types.js";

const STATE_VERSION = 1;
const EVENT_GRACE_MS = 24 * 60 * 60 * 1_000;
const CREDENTIAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const GC_INTERVAL_MS = 60 * 60 * 1_000;
const HANDLE_PATTERN = /^ap1_[A-Za-z0-9_-]{43}$/;

type GrantState = "pending" | "bound" | "consumed" | "revoked";

interface PersistedGrant {
  handleHash: string;
  scope: AutoPingScope;
  routeFingerprint: string;
  destination: AutoPingDestination;
  target: AutoPingTarget;
  canonicalKey: string;
  createdAt: string;
  state: GrantState;
  actorSessionId?: string;
  suppressionId?: string;
  invalidatedAt?: string;
}

interface PersistedSuppression extends AutoPingSuppressionView {
  canonicalKey: string;
  actorSessionId: string;
  resumedAt?: string;
  unreferencedAt?: string;
}

interface AutoPingState {
  version: 1;
  routes: PersistedRoute[];
  grants: PersistedGrant[];
  suppressions: PersistedSuppression[];
}

interface PersistedRoute {
  routeFingerprint: string;
  descriptor: AutoPingRouteDescriptor;
}

interface RouteLease {
  routeFingerprint: string;
  leaseId: string;
}

export class AutoPingError extends Error {
  constructor(
    readonly code:
      | "invalid_request"
      | "forbidden"
      | "session_not_found"
      | "grant_not_found"
      | "grant_not_ready"
      | "grant_consumed"
      | "suppression_not_found",
    readonly status: 400 | 403 | 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = "AutoPingError";
  }
}

interface AutoPingServiceOptions {
  now?: () => number;
  setInterval?: typeof globalThis.setInterval;
  clearInterval?: typeof globalThis.clearInterval;
}

export interface CreatedAutoPingGrant {
  handle: string;
  handleHash: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => canonical(entry)).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function autoPingRouteFingerprint(route: AutoPingRouteDescriptor): string {
  return sha256(canonical(route));
}

function routeAuthority(route: AutoPingRouteDescriptor): string {
  return canonical({
    version: route.version,
    projectId: route.projectId,
    triggerId: route.triggerId,
    sourceId: route.sourceId,
    sourceType: route.sourceType,
    eventName: route.eventName,
    actionKind: route.actionKind,
    destinationKind: route.destination.kind,
    spawnDeskGroup: route.spawnDeskGroup,
  });
}

function suppressionCanonicalKey(
  scope: AutoPingScope,
  routeFingerprint: string,
  destination: AutoPingDestination,
  target: AutoPingTarget,
): string {
  return sha256(canonical({ scope, routeFingerprint, destination, target }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDestination(value: unknown): value is AutoPingDestination {
  return (
    isRecord(value) &&
    ((value.kind === "trigger" && Object.keys(value).length === 1) ||
      (value.kind === "session" && typeof value.sessionId === "string"))
  );
}

function isTarget(value: unknown): value is AutoPingTarget {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  if (value.kind === "occurrence") return typeof value.occurrenceId === "string";
  if (value.kind === "subscription") return true;
  if (value.kind === "github-review-thread") return typeof value.threadId === "string";
  if (value.kind === "gitlab-discussion") {
    return typeof value.mergeRequestIid === "number" && typeof value.discussionId === "string";
  }
  return (
    value.kind === "telegram-topic" &&
    typeof value.chatId === "number" &&
    typeof value.messageThreadId === "number"
  );
}

function isRouteDescriptor(value: unknown): value is AutoPingRouteDescriptor {
  return (
    isRecord(value) &&
    value.version === 1 &&
    typeof value.projectId === "string" &&
    typeof value.triggerId === "string" &&
    typeof value.sourceId === "string" &&
    typeof value.sourceType === "string" &&
    typeof value.eventName === "string" &&
    (value.actionKind === "send" || value.actionKind === "spawn") &&
    isDestination(value.destination) &&
    typeof value.spawnDeskGroup === "boolean"
  );
}

function parseState(raw: unknown): AutoPingState {
  if (
    !isRecord(raw) ||
    raw.version !== STATE_VERSION ||
    !Array.isArray(raw.grants) ||
    !Array.isArray(raw.suppressions)
  ) {
    throw new Error("Invalid auto-ping policy state");
  }
  const grants: PersistedGrant[] = raw.grants.map((value) => {
    if (
      !isRecord(value) ||
      typeof value.handleHash !== "string" ||
      !["event", "thread", "subscription"].includes(String(value.scope)) ||
      typeof value.routeFingerprint !== "string" ||
      !isDestination(value.destination) ||
      !isTarget(value.target) ||
      typeof value.canonicalKey !== "string" ||
      typeof value.createdAt !== "string" ||
      !["pending", "bound", "consumed", "revoked"].includes(String(value.state))
    ) {
      throw new Error("Invalid auto-ping grant state");
    }
    return value as unknown as PersistedGrant;
  });
  const suppressions: PersistedSuppression[] = raw.suppressions.map((value) => {
    if (
      !isRecord(value) ||
      typeof value.suppressionId !== "string" ||
      !["event", "thread", "subscription"].includes(String(value.scope)) ||
      typeof value.routeFingerprint !== "string" ||
      !isDestination(value.destination) ||
      !isTarget(value.target) ||
      typeof value.canonicalKey !== "string" ||
      typeof value.actorSessionId !== "string" ||
      typeof value.createdAt !== "string"
    ) {
      throw new Error("Invalid auto-ping suppression state");
    }
    return value as unknown as PersistedSuppression;
  });
  const routes = Array.isArray(raw.routes)
    ? raw.routes.map((value) => {
        if (
          !isRecord(value) ||
          typeof value.routeFingerprint !== "string" ||
          !isRouteDescriptor(value.descriptor)
        ) {
          throw new Error("Invalid auto-ping route state");
        }
        return value as unknown as PersistedRoute;
      })
    : [];
  return { version: STATE_VERSION, routes, grants, suppressions };
}

function view(record: PersistedSuppression): AutoPingSuppressionView {
  return {
    suppressionId: record.suppressionId,
    scope: record.scope,
    routeFingerprint: record.routeFingerprint,
    destination: record.destination,
    target: record.target,
    createdAt: record.createdAt,
  };
}

export class AutoPingService {
  private readonly path: string;
  private readonly now: () => number;
  private readonly clearIntervalFn: typeof globalThis.clearInterval;
  private state: AutoPingState;
  private readonly routeTails = new Map<string, Promise<void>>();
  private readonly leases = new Map<string, RouteLease>();
  private readonly configuredRoutes = new Set<string>();
  private readonly configuredRouteAuthorities = new Set<string>();
  private readonly occurrenceReferences = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null;
  private disposed = false;

  constructor(dataDir: string, options: AutoPingServiceOptions = {}) {
    this.path = join(dataDir, "auto-ping.json");
    this.now = options.now ?? Date.now;
    this.clearIntervalFn = options.clearInterval ?? globalThis.clearInterval;
    this.state = existsSync(this.path)
      ? parseState(JSON.parse(readFileSync(this.path, "utf8")) as unknown)
      : { version: STATE_VERSION, routes: [], grants: [], suppressions: [] };
    const setIntervalFn = options.setInterval ?? globalThis.setInterval;
    this.timer = setIntervalFn(() => this.gc(), GC_INTERVAL_MS);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) this.clearIntervalFn(this.timer);
    this.timer = null;
  }

  async withRouteLock<T>(routeFingerprint: string, task: () => Promise<T>): Promise<T> {
    const prior = this.routeTails.get(routeFingerprint) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = prior.catch(() => undefined).then(() => gate);
    this.routeTails.set(routeFingerprint, tail);
    await prior.catch(() => undefined);
    try {
      return await task();
    } finally {
      release?.();
      if (this.routeTails.get(routeFingerprint) === tail) this.routeTails.delete(routeFingerprint);
    }
  }

  registerRoute(routeFingerprint: string, descriptor?: AutoPingRouteDescriptor): string {
    const leaseId = randomUUID();
    this.configuredRoutes.add(routeFingerprint);
    if (
      descriptor &&
      !this.state.routes.some((route) => route.routeFingerprint === routeFingerprint)
    ) {
      this.state.routes.push({ routeFingerprint, descriptor });
      this.persist();
    }
    this.leases.set(leaseId, { routeFingerprint, leaseId });
    return leaseId;
  }

  releaseRoute(leaseId: string, configured = true): void {
    const lease = this.leases.get(leaseId);
    if (!lease) return;
    this.leases.delete(leaseId);
    if (
      !configured ||
      ![...this.leases.values()].some(
        (active) => active.routeFingerprint === lease.routeFingerprint,
      )
    ) {
      this.configuredRoutes.delete(lease.routeFingerprint);
    }
    this.gc();
  }

  isRouteLeaseActive(leaseId: string): boolean {
    return this.leases.has(leaseId);
  }

  setConfiguredRouteAuthorities(routes: Iterable<AutoPingRouteDescriptor>): void {
    this.configuredRouteAuthorities.clear();
    for (const route of routes) this.configuredRouteAuthorities.add(routeAuthority(route));
    this.gc();
  }

  createGrant(input: {
    scope: AutoPingScope;
    routeFingerprint: string;
    destination: AutoPingDestination;
    target: AutoPingTarget;
    actorSessionId?: string;
  }): CreatedAutoPingGrant {
    const handle = `ap1_${randomBytes(32).toString("base64url")}`;
    const handleHash = sha256(handle);
    const createdAt = new Date(this.now()).toISOString();
    this.state.grants.push({
      handleHash,
      scope: input.scope,
      routeFingerprint: input.routeFingerprint,
      destination: input.destination,
      target: input.target,
      canonicalKey: suppressionCanonicalKey(
        input.scope,
        input.routeFingerprint,
        input.destination,
        input.target,
      ),
      createdAt,
      state: input.actorSessionId ? "bound" : "pending",
      ...(input.actorSessionId ? { actorSessionId: input.actorSessionId } : {}),
    });
    this.persist();
    return { handle, handleHash };
  }

  bindGrant(handleHash: string, actorSessionId: string): void {
    const grant = this.state.grants.find((entry) => entry.handleHash === handleHash);
    if (!grant || grant.state !== "pending") return;
    grant.state = "bound";
    grant.actorSessionId = actorSessionId;
    this.persist();
  }

  revokeGrant(handleHash: string): void {
    const grant = this.state.grants.find((entry) => entry.handleHash === handleHash);
    if (!grant || grant.state === "consumed") return;
    grant.state = "revoked";
    delete grant.actorSessionId;
    this.persist();
  }

  async unsubscribe(
    actorSessionId: string,
    scope: AutoPingScope,
    handle: string,
  ): Promise<{ record: AutoPingSuppressionView; created: boolean }> {
    if (!HANDLE_PATTERN.test(handle)) {
      throw new AutoPingError("invalid_request", 400, "Invalid auto-ping handle");
    }
    const handleHash = sha256(handle);
    const snapshot = this.state.grants.find((entry) => entry.handleHash === handleHash);
    if (!snapshot || snapshot.state === "revoked" || this.isExpired(snapshot.createdAt)) {
      throw new AutoPingError("grant_not_found", 404, "Auto-ping grant not found");
    }
    if (snapshot.scope !== scope) {
      throw new AutoPingError("invalid_request", 400, "Auto-ping scope does not match handle");
    }
    if (snapshot.state === "pending") {
      throw new AutoPingError(
        "grant_not_ready",
        409,
        "Grant activation is still finishing; retry the same command",
      );
    }
    return this.withRouteLock(snapshot.routeFingerprint, async () => {
      const grant = this.state.grants.find((entry) => entry.handleHash === handleHash);
      if (!grant || grant.state === "revoked" || this.isExpired(grant.createdAt)) {
        throw new AutoPingError("grant_not_found", 404, "Auto-ping grant not found");
      }
      if (grant.scope !== scope) {
        throw new AutoPingError("invalid_request", 400, "Auto-ping scope does not match handle");
      }
      if (grant.state === "pending") {
        throw new AutoPingError(
          "grant_not_ready",
          409,
          "Grant activation is still finishing; retry the same command",
        );
      }
      if (grant.actorSessionId !== actorSessionId) {
        throw new AutoPingError("forbidden", 403, "Auto-ping grant belongs to another session");
      }
      if (grant.state === "consumed") {
        const existing = this.state.suppressions.find(
          (entry) => entry.suppressionId === grant.suppressionId,
        );
        if (!existing || existing.resumedAt) {
          throw new AutoPingError("grant_consumed", 409, "Auto-ping grant was already consumed");
        }
        return { record: view(existing), created: false };
      }
      let suppression = this.state.suppressions.find(
        (entry) => entry.canonicalKey === grant.canonicalKey && !entry.resumedAt,
      );
      const created = !suppression;
      if (!suppression) {
        suppression = {
          suppressionId: randomUUID(),
          scope: grant.scope,
          routeFingerprint: grant.routeFingerprint,
          destination: grant.destination,
          target: grant.target,
          canonicalKey: grant.canonicalKey,
          actorSessionId,
          createdAt: new Date(this.now()).toISOString(),
        };
        this.state.suppressions.push(suppression);
      } else if (suppression.actorSessionId !== actorSessionId) {
        throw new AutoPingError(
          "forbidden",
          403,
          "Auto-ping suppression belongs to another session",
        );
      }
      grant.state = "consumed";
      grant.suppressionId = suppression.suppressionId;
      this.persist();
      this.gc();
      return { record: view(suppression), created };
    });
  }

  list(actorSessionId: string): AutoPingSuppressionView[] {
    return this.state.suppressions
      .filter((entry) => entry.actorSessionId === actorSessionId && !entry.resumedAt)
      .sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.suppressionId.localeCompare(right.suppressionId),
      )
      .map(view);
  }

  async resume(
    actorSessionId: string,
    suppressionId: string,
  ): Promise<{ records: AutoPingSuppressionView[]; removed: boolean }> {
    const snapshot = this.state.suppressions.find((entry) => entry.suppressionId === suppressionId);
    if (!snapshot || (snapshot.resumedAt && this.isExpired(snapshot.resumedAt))) {
      throw new AutoPingError("suppression_not_found", 404, "Auto-ping suppression not found");
    }
    if (snapshot.actorSessionId !== actorSessionId) {
      throw new AutoPingError("forbidden", 403, "Auto-ping suppression belongs to another session");
    }
    return this.withRouteLock(snapshot.routeFingerprint, async () => {
      const suppression = this.state.suppressions.find(
        (entry) => entry.suppressionId === suppressionId,
      );
      if (!suppression) {
        throw new AutoPingError("suppression_not_found", 404, "Auto-ping suppression not found");
      }
      if (suppression.actorSessionId !== actorSessionId) {
        throw new AutoPingError(
          "forbidden",
          403,
          "Auto-ping suppression belongs to another session",
        );
      }
      const removed = !suppression.resumedAt;
      if (removed) {
        const resumedAt = new Date(this.now()).toISOString();
        suppression.resumedAt = resumedAt;
        for (const grant of this.state.grants) {
          if (grant.canonicalKey !== suppression.canonicalKey) continue;
          if (Date.parse(grant.createdAt) > this.now()) continue;
          grant.state = "consumed";
          grant.suppressionId = suppressionId;
          grant.invalidatedAt = resumedAt;
        }
        this.persist();
        this.gc();
      }
      return { records: this.list(actorSessionId), removed };
    });
  }

  isSuppressed(
    routeFingerprint: string,
    destination: AutoPingDestination,
    occurrenceId: string,
    threadTarget?: AutoPingTarget,
  ): boolean {
    return this.state.suppressions.some((entry) => {
      if (entry.resumedAt || entry.routeFingerprint !== routeFingerprint) return false;
      if (canonical(entry.destination) !== canonical(destination)) return false;
      if (entry.scope === "subscription") return true;
      if (entry.scope === "event") {
        return entry.target.kind === "occurrence" && entry.target.occurrenceId === occurrenceId;
      }
      return threadTarget !== undefined && canonical(entry.target) === canonical(threadTarget);
    });
  }

  addOccurrenceReference(routeFingerprint: string, occurrenceId: string): void {
    const key = `${routeFingerprint}:${occurrenceId}`;
    this.occurrenceReferences.set(key, (this.occurrenceReferences.get(key) ?? 0) + 1);
    for (const suppression of this.state.suppressions) {
      if (
        suppression.routeFingerprint === routeFingerprint &&
        suppression.target.kind === "occurrence" &&
        suppression.target.occurrenceId === occurrenceId
      ) {
        delete suppression.unreferencedAt;
      }
    }
    this.persist();
  }

  releaseOccurrenceReference(routeFingerprint: string, occurrenceId: string): void {
    const key = `${routeFingerprint}:${occurrenceId}`;
    const next = Math.max(0, (this.occurrenceReferences.get(key) ?? 0) - 1);
    if (next === 0) this.occurrenceReferences.delete(key);
    else this.occurrenceReferences.set(key, next);
    if (next === 0) {
      const at = new Date(this.now()).toISOString();
      for (const suppression of this.state.suppressions) {
        if (
          !suppression.unreferencedAt &&
          suppression.routeFingerprint === routeFingerprint &&
          suppression.target.kind === "occurrence" &&
          suppression.target.occurrenceId === occurrenceId
        ) {
          suppression.unreferencedAt = at;
        }
      }
      this.persist();
    }
  }

  gc(): void {
    const now = this.now();
    const liveRoute = (fingerprint: string): boolean =>
      this.configuredRoutes.has(fingerprint) ||
      [...this.leases.values()].some((lease) => lease.routeFingerprint === fingerprint) ||
      this.state.routes.some(
        (route) =>
          route.routeFingerprint === fingerprint &&
          this.configuredRouteAuthorities.has(routeAuthority(route.descriptor)),
      );
    this.state.grants = this.state.grants.filter((grant) => {
      if (!liveRoute(grant.routeFingerprint)) return false;
      const ageFrom = grant.invalidatedAt ?? grant.createdAt;
      return now - Date.parse(ageFrom) < CREDENTIAL_RETENTION_MS;
    });
    this.state.suppressions = this.state.suppressions.filter((suppression) => {
      if (!liveRoute(suppression.routeFingerprint)) return false;
      if (suppression.resumedAt)
        return now - Date.parse(suppression.resumedAt) < CREDENTIAL_RETENTION_MS;
      if (suppression.scope !== "event") return true;
      if (!suppression.unreferencedAt) return true;
      return now - Date.parse(suppression.unreferencedAt) < EVENT_GRACE_MS;
    });
    const liveFingerprints = new Set([
      ...this.state.grants.map((grant) => grant.routeFingerprint),
      ...this.state.suppressions.map((suppression) => suppression.routeFingerprint),
    ]);
    this.state.routes = this.state.routes.filter((route) =>
      liveFingerprints.has(route.routeFingerprint),
    );
    this.persist();
  }

  private isExpired(at: string): boolean {
    return this.now() - Date.parse(at) >= CREDENTIAL_RETENTION_MS;
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmpPath = `${this.path}.tmp.${String(process.pid)}.${randomUUID()}`;
    writeFileSync(tmpPath, `${JSON.stringify(this.state, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    chmodSync(tmpPath, 0o600);
    renameSync(tmpPath, this.path);
    chmodSync(this.path, 0o600);
  }
}

export function redactAutoPingHandles(value: string): string {
  return value.replace(/ap1_[A-Za-z0-9_-]{43}/g, "[auto-ping-handle]");
}
