import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { appendMuteHistory, readMuteHistory } from "./auto-ping-history.js";
import type {
  AutoPingDestination,
  AutoPingMuteEndReason,
  AutoPingMuteItem,
  AutoPingMuteMode,
  AutoPingMuteRequest,
  AutoPingMuteView,
  AutoPingResumeRequest,
  AutoPingRouteDescriptor,
} from "./types.js";

const STATE_VERSION = 2;
const CREDENTIAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const GC_INTERVAL_MS = 60 * 60 * 1_000;
const HANDLE_PATTERN = /^ap1_[A-Za-z0-9_-]{43}$/;
const MERGE_CONFLICT_MAX_ATTEMPTS = 3;
const DELIVERED_KEYS_MAX = 16;
const MUTE_FOR_MIN_MS = 60_000;
export const AUTO_PING_MUTE_FOR_MAX_MS = 24 * 60 * 60 * 1_000;
const REASON_MAX_LENGTH = 500;

interface PersistedGrant {
  handleHash: string;
  routeFingerprint: string;
  destination: AutoPingDestination;
  createdAt: string;
  actorSessionId: string;
  items: AutoPingMuteItem[];
  untilChange: boolean;
}

interface PersistedSuppression extends AutoPingMuteView {
  handleHash: string;
}

interface PersistedMergeConflict {
  routeFingerprint: string;
  prNumber: number;
  fingerprint: string;
  attempts: number;
  deliveredKeys: string[];
}

interface PersistedCiSeen {
  routeFingerprint: string;
  head: string;
  runIds: string[];
}

interface AutoPingState {
  version: typeof STATE_VERSION;
  routes: PersistedRoute[];
  grants: PersistedGrant[];
  suppressions: PersistedSuppression[];
  mergeConflicts: PersistedMergeConflict[];
  ciSeen: PersistedCiSeen[];
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
      | "suppression_not_found",
    readonly status: 400 | 403 | 404,
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
  log?: (event: string, sessionId: string | undefined, details: Record<string, unknown>) => void;
}

export interface CreatedAutoPingGrant {
  handle: string;
  handleHash: string;
}

export interface AutoPingMuteMatch {
  mode: AutoPingMuteMode;
  suppressionId: string;
}

export type MergeConflictClaim = "accepted" | "exhausted" | "already_delivered";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDestination(value: unknown): value is AutoPingDestination {
  return isRecord(value) && value.kind === "session" && typeof value.sessionId === "string";
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
    value.actionKind === "send" &&
    isDestination(value.destination) &&
    typeof value.spawnDeskGroup === "boolean"
  );
}

function isDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isMuteItem(value: unknown): value is AutoPingMuteItem {
  return (
    isRecord(value) &&
    typeof value.subject === "string" &&
    typeof value.kind === "string" &&
    typeof value.label === "string" &&
    (value.changeKey === undefined || typeof value.changeKey === "string")
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

interface ParsedState {
  state: AutoPingState;
  migration?: { grants: number; suppressions: number };
}

// Routes of daemons that ran an earlier version can carry `actionKind: "spawn"`;
// filtering them keeps the narrowed route guard from throwing on a live file.
function parseRoutes(raw: unknown): PersistedRoute[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error("Invalid auto-ping policy state");
  return raw
    .filter((value) => !(isRecord(value) && isRecord(value.descriptor) && value.descriptor.actionKind === "spawn"))
    .map((value) => {
      if (
        !isRecord(value) ||
        typeof value.routeFingerprint !== "string" ||
        !isRouteDescriptor(value.descriptor)
      ) {
        throw new Error("Invalid auto-ping route state");
      }
      return value as unknown as PersistedRoute;
    });
}

function parseState(raw: unknown): ParsedState {
  if (
    !isRecord(raw) ||
    (raw.version !== 1 && raw.version !== STATE_VERSION) ||
    !Array.isArray(raw.grants) ||
    !Array.isArray(raw.suppressions)
  ) {
    throw new Error("Invalid auto-ping policy state");
  }
  const routes = parseRoutes(raw.routes);
  if (raw.version === 1) {
    // v1 scopes (event/thread/subscription) have no v2 equivalent: nothing a
    // user could see survives, and an in-flight event mute costs at most one
    // repeat delivery.
    return {
      state: {
        version: STATE_VERSION,
        routes,
        grants: [],
        suppressions: [],
        mergeConflicts: [],
        ciSeen: [],
      },
      migration: { grants: raw.grants.length, suppressions: raw.suppressions.length },
    };
  }
  const grants = raw.grants.map((value: unknown) => {
    if (
      !isRecord(value) ||
      typeof value.handleHash !== "string" ||
      typeof value.routeFingerprint !== "string" ||
      !isDestination(value.destination) ||
      !isDate(value.createdAt) ||
      typeof value.actorSessionId !== "string" ||
      !Array.isArray(value.items) ||
      !value.items.every(isMuteItem) ||
      typeof value.untilChange !== "boolean"
    ) {
      throw new Error("Invalid auto-ping grant state");
    }
    return value as unknown as PersistedGrant;
  });
  const suppressions = raw.suppressions.map((value: unknown) => {
    if (
      !isRecord(value) ||
      typeof value.suppressionId !== "string" ||
      typeof value.handleHash !== "string" ||
      !["until_change", "for", "forever"].includes(String(value.mode)) ||
      typeof value.routeFingerprint !== "string" ||
      !isDestination(value.destination) ||
      typeof value.actorSessionId !== "string" ||
      !Array.isArray(value.items) ||
      !value.items.every(isMuteItem) ||
      !isDate(value.createdAt) ||
      (value.expiresAt !== undefined && !isDate(value.expiresAt)) ||
      (value.endedAt !== undefined && !isDate(value.endedAt)) ||
      (value.reason !== undefined && typeof value.reason !== "string")
    ) {
      throw new Error("Invalid auto-ping suppression state");
    }
    return value as unknown as PersistedSuppression;
  });
  const mergeConflicts = (Array.isArray(raw.mergeConflicts) ? raw.mergeConflicts : []).map(
    (value: unknown) => {
      if (
        !isRecord(value) ||
        typeof value.routeFingerprint !== "string" ||
        !Number.isInteger(value.prNumber) ||
        typeof value.fingerprint !== "string" ||
        !Number.isInteger(value.attempts) ||
        Number(value.attempts) < 0 ||
        Number(value.attempts) > MERGE_CONFLICT_MAX_ATTEMPTS ||
        !isStringArray(value.deliveredKeys)
      )
        throw new Error("Invalid auto-ping conflict state");
      return value as unknown as PersistedMergeConflict;
    },
  );
  const ciSeen = (Array.isArray(raw.ciSeen) ? raw.ciSeen : []).map((value: unknown) => {
    if (
      !isRecord(value) ||
      typeof value.routeFingerprint !== "string" ||
      typeof value.head !== "string" ||
      !isStringArray(value.runIds)
    )
      throw new Error("Invalid auto-ping ci state");
    return value as unknown as PersistedCiSeen;
  });
  return {
    state: { version: STATE_VERSION, routes, grants, suppressions, mergeConflicts, ciSeen },
  };
}

function view(record: PersistedSuppression): AutoPingMuteView {
  const { handleHash: _handleHash, ...rest } = record;
  void _handleHash;
  return { ...rest, items: rest.items.map((item) => ({ ...item })) };
}

export class AutoPingService {
  private readonly path: string;
  private readonly now: () => number;
  private readonly clearIntervalFn: typeof globalThis.clearInterval;
  private readonly log: NonNullable<AutoPingServiceOptions["log"]>;
  private state: AutoPingState;
  private readonly routeTails = new Map<string, Promise<void>>();
  private readonly leases = new Map<string, RouteLease>();
  private readonly configuredRoutes = new Set<string>();
  private readonly configuredRouteAuthorities = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null;
  private disposed = false;

  constructor(
    private readonly dataDir: string,
    options: AutoPingServiceOptions = {},
  ) {
    this.path = join(dataDir, "auto-ping.json");
    this.now = options.now ?? Date.now;
    this.clearIntervalFn = options.clearInterval ?? globalThis.clearInterval;
    this.log = options.log ?? (() => undefined);
    if (existsSync(this.path)) {
      const { state, migration } = parseState(
        JSON.parse(readFileSync(this.path, "utf8")) as unknown,
      );
      this.state = state;
      if (migration) {
        this.persist();
        this.log("auto-ping.migrated", undefined, {
          droppedGrants: migration.grants,
          droppedSuppressions: migration.suppressions,
        });
      }
    } else {
      this.state = {
        version: STATE_VERSION,
        routes: [],
        grants: [],
        suppressions: [],
        mergeConflicts: [],
        ciSeen: [],
      };
    }
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

  // One grant per delivered ping. `items` are the mute subjects of that ping;
  // `untilChange` is false when any item lacks a change key or the source
  // offers no until-change mute.
  createGrant(input: {
    routeFingerprint: string;
    destination: AutoPingDestination;
    actorSessionId: string;
    items: AutoPingMuteItem[];
    untilChange: boolean;
  }): CreatedAutoPingGrant {
    const handle = `ap1_${randomBytes(32).toString("base64url")}`;
    const handleHash = sha256(handle);
    this.state.grants.push({
      handleHash,
      routeFingerprint: input.routeFingerprint,
      destination: input.destination,
      createdAt: new Date(this.now()).toISOString(),
      actorSessionId: input.actorSessionId,
      items: input.items,
      untilChange: input.untilChange,
    });
    this.persist();
    return { handle, handleHash };
  }

  private findGrant(actorSessionId: string, handle: string): PersistedGrant {
    if (!HANDLE_PATTERN.test(handle)) {
      throw new AutoPingError("invalid_request", 400, "Invalid auto-ping handle");
    }
    const handleHash = sha256(handle);
    const grant = this.state.grants.find((entry) => entry.handleHash === handleHash);
    if (!grant || this.isExpired(grant.createdAt)) {
      throw new AutoPingError("grant_not_found", 404, "Auto-ping grant not found");
    }
    if (grant.actorSessionId !== actorSessionId) {
      throw new AutoPingError("forbidden", 403, "Auto-ping grant belongs to another session");
    }
    return grant;
  }

  async mute(
    actorSessionId: string,
    input: AutoPingMuteRequest,
  ): Promise<{ record: AutoPingMuteView; created: boolean }> {
    const { mode } = input;
    if (mode !== "until_change" && mode !== "for" && mode !== "forever") {
      throw new AutoPingError("invalid_request", 400, "Auto-ping mute mode is invalid");
    }
    const reason = input.reason?.trim();
    if (mode !== "until_change" && !reason) {
      throw new AutoPingError("invalid_request", 400, "Auto-ping mute reason is required");
    }
    if (reason && reason.length > REASON_MAX_LENGTH) {
      throw new AutoPingError("invalid_request", 400, "Auto-ping mute reason is too long");
    }
    if (mode === "for") {
      const duration = input.durationMs;
      if (!Number.isInteger(duration) || duration === undefined || duration < MUTE_FOR_MIN_MS) {
        throw new AutoPingError("invalid_request", 400, "Auto-ping mute duration is invalid");
      }
      if (duration > AUTO_PING_MUTE_FOR_MAX_MS) {
        throw new AutoPingError("invalid_request", 400, "Auto-ping mute duration max is 24h");
      }
    } else if (input.durationMs !== undefined) {
      throw new AutoPingError("invalid_request", 400, "Auto-ping duration applies to mode for");
    }
    const snapshot = this.findGrant(actorSessionId, input.handle);
    return this.withRouteLock(snapshot.routeFingerprint, async () => {
      const grant = this.findGrant(actorSessionId, input.handle);
      if (mode === "until_change" && !grant.untilChange) {
        throw new AutoPingError(
          "invalid_request",
          400,
          "Auto-ping until-change mute is not offered for this ping",
        );
      }
      this.sweep();
      const existing = this.state.suppressions.find(
        (entry) => entry.handleHash === grant.handleHash && !entry.endedAt,
      );
      if (existing?.mode === mode) return { record: view(existing), created: false };
      if (existing) this.endMute(existing, "resumed");
      const nowMs = this.now();
      const record: PersistedSuppression = {
        suppressionId: randomUUID(),
        handleHash: grant.handleHash,
        mode,
        routeFingerprint: grant.routeFingerprint,
        destination: grant.destination,
        actorSessionId,
        items: grant.items.map((item) => ({ ...item })),
        ...(reason ? { reason } : {}),
        createdAt: new Date(nowMs).toISOString(),
        ...(mode === "for" && input.durationMs !== undefined
          ? { expiresAt: new Date(nowMs + input.durationMs).toISOString() }
          : {}),
      };
      appendMuteHistory(this.dataDir, actorSessionId, "muted", view(record));
      this.state.suppressions.push(record);
      this.persist();
      this.log("auto-ping.muted", actorSessionId, {
        suppressionId: record.suppressionId,
        mode,
        reason,
        expiresAt: record.expiresAt,
        items: record.items.map((item) => ({ subject: item.subject, kind: item.kind })),
      });
      return { record: view(record), created: true };
    });
  }

  list(actorSessionId: string): AutoPingMuteView[] {
    this.sweep();
    return this.state.suppressions
      .filter((entry) => entry.actorSessionId === actorSessionId && !entry.endedAt)
      .sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.suppressionId.localeCompare(right.suppressionId),
      )
      .map(view);
  }

  history(actorSessionId: string): AutoPingMuteView[] {
    this.sweep();
    return readMuteHistory(this.dataDir, actorSessionId);
  }

  async resume(
    actorSessionId: string,
    target: AutoPingResumeRequest,
  ): Promise<{ records: AutoPingMuteView[]; removed: boolean }> {
    if ((target.handle === undefined) === (target.suppressionId === undefined)) {
      throw new AutoPingError(
        "invalid_request",
        400,
        "Auto-ping resume needs exactly one of handle or suppressionId",
      );
    }
    const locate = (): { routeFingerprint: string; match: (entry: PersistedSuppression) => boolean } => {
      if (target.handle !== undefined) {
        const grant = this.findGrant(actorSessionId, target.handle);
        return {
          routeFingerprint: grant.routeFingerprint,
          match: (entry) => entry.handleHash === grant.handleHash,
        };
      }
      const suppression = this.state.suppressions.find(
        (entry) => entry.suppressionId === target.suppressionId,
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
      return {
        routeFingerprint: suppression.routeFingerprint,
        match: (entry) => entry.suppressionId === target.suppressionId,
      };
    };
    return this.withRouteLock(locate().routeFingerprint, async () => {
      const { match } = locate();
      this.sweep();
      let removed = false;
      for (const entry of this.state.suppressions) {
        if (!match(entry) || entry.endedAt) continue;
        this.endMute(entry, "resumed");
        removed = true;
      }
      if (removed) this.persist();
      return { records: this.list(actorSessionId), removed };
    });
  }

  // Returns the active mute covering `item`, if any. An until-change mute whose
  // change key moved drops that item (and ends once empty) as a side effect.
  matchMute(
    routeFingerprint: string,
    destination: AutoPingDestination,
    item: AutoPingMuteItem,
  ): AutoPingMuteMatch | null {
    this.sweep();
    let result: AutoPingMuteMatch | null = null;
    let dirty = false;
    for (const entry of this.state.suppressions) {
      if (entry.endedAt || entry.routeFingerprint !== routeFingerprint) continue;
      if (canonical(entry.destination) !== canonical(destination)) continue;
      if (entry.mode === "forever") {
        result ??= { mode: entry.mode, suppressionId: entry.suppressionId };
        continue;
      }
      const covered = entry.items.find(
        (candidate) => candidate.subject === item.subject && candidate.kind === item.kind,
      );
      if (!covered) continue;
      if (entry.mode === "for") {
        result ??= { mode: entry.mode, suppressionId: entry.suppressionId };
        continue;
      }
      if (covered.changeKey !== undefined && covered.changeKey === item.changeKey) {
        result ??= { mode: entry.mode, suppressionId: entry.suppressionId };
        continue;
      }
      entry.items = entry.items.filter((candidate) => candidate !== covered);
      dirty = true;
      if (entry.items.length === 0) this.endMute(entry, "changed");
    }
    if (dirty) this.persist();
    return result;
  }

  claimMergeConflict(
    routeFingerprint: string,
    prNumber: number,
    fingerprint: string,
  ): MergeConflictClaim {
    let budget = this.state.mergeConflicts.find(
      (entry) => entry.routeFingerprint === routeFingerprint,
    );
    if (!budget) {
      budget = { routeFingerprint, prNumber, fingerprint, attempts: 0, deliveredKeys: [] };
      this.state.mergeConflicts.push(budget);
    }
    if (budget.prNumber !== prNumber || budget.fingerprint !== fingerprint) {
      budget.attempts = 0;
      budget.prNumber = prNumber;
      budget.fingerprint = fingerprint;
    }
    if (budget.deliveredKeys.includes(fingerprint)) return "already_delivered";
    if (budget.attempts >= MERGE_CONFLICT_MAX_ATTEMPTS) return "exhausted";
    budget.attempts += 1;
    this.persist();
    return "accepted";
  }

  refundMergeConflict(routeFingerprint: string): void {
    const budget = this.state.mergeConflicts.find(
      (entry) => entry.routeFingerprint === routeFingerprint,
    );
    if (!budget || budget.attempts === 0) return;
    budget.attempts -= 1;
    this.persist();
  }

  markMergeConflictDelivered(routeFingerprint: string, fingerprint: string): void {
    const budget = this.state.mergeConflicts.find(
      (entry) => entry.routeFingerprint === routeFingerprint,
    );
    if (!budget || budget.deliveredKeys.includes(fingerprint)) return;
    budget.deliveredKeys = [...budget.deliveredKeys, fingerprint].slice(-DELIVERED_KEYS_MAX);
    this.persist();
  }

  // True when `head` is new for the route or any run id was never delivered.
  isCiRunNew(routeFingerprint: string, head: string, runIds: readonly string[]): boolean {
    const seen = this.state.ciSeen.find((entry) => entry.routeFingerprint === routeFingerprint);
    if (!seen || seen.head !== head) return true;
    return runIds.some((id) => !seen.runIds.includes(id));
  }

  markCiDelivered(routeFingerprint: string, head: string, runIds: readonly string[]): void {
    const seen = this.state.ciSeen.find((entry) => entry.routeFingerprint === routeFingerprint);
    if (!seen) {
      this.state.ciSeen.push({ routeFingerprint, head, runIds: [...new Set(runIds)] });
    } else if (seen.head !== head) {
      seen.head = head;
      seen.runIds = [...new Set(runIds)];
    } else {
      seen.runIds = [...new Set([...seen.runIds, ...runIds])];
    }
    this.persist();
  }

  gc(): void {
    const now = this.now();
    this.sweep();
    const liveRoute = (fingerprint: string): boolean =>
      this.configuredRoutes.has(fingerprint) ||
      [...this.leases.values()].some((lease) => lease.routeFingerprint === fingerprint) ||
      this.state.routes.some(
        (route) =>
          route.routeFingerprint === fingerprint &&
          this.configuredRouteAuthorities.has(routeAuthority(route.descriptor)),
      );
    this.state.grants = this.state.grants.filter(
      (grant) =>
        liveRoute(grant.routeFingerprint) && now - Date.parse(grant.createdAt) < CREDENTIAL_RETENTION_MS,
    );
    this.state.suppressions = this.state.suppressions.filter((suppression) => {
      if (!liveRoute(suppression.routeFingerprint)) return false;
      if (suppression.endedAt) return now - Date.parse(suppression.endedAt) < CREDENTIAL_RETENTION_MS;
      return true;
    });
    this.state.mergeConflicts = this.state.mergeConflicts.filter((entry) =>
      liveRoute(entry.routeFingerprint),
    );
    this.state.ciSeen = this.state.ciSeen.filter((entry) => liveRoute(entry.routeFingerprint));
    const liveFingerprints = new Set([
      ...this.configuredRoutes,
      ...[...this.leases.values()].map((lease) => lease.routeFingerprint),
      ...this.state.grants.map((grant) => grant.routeFingerprint),
      ...this.state.suppressions.map((suppression) => suppression.routeFingerprint),
      ...this.state.mergeConflicts.map((entry) => entry.routeFingerprint),
      ...this.state.ciSeen.map((entry) => entry.routeFingerprint),
    ]);
    this.state.routes = this.state.routes.filter((route) =>
      liveFingerprints.has(route.routeFingerprint),
    );
    this.persist();
  }

  // Ends every `for` mute past its expiry.
  private sweep(): void {
    const now = this.now();
    let ended = false;
    for (const entry of this.state.suppressions) {
      if (entry.endedAt || entry.mode !== "for" || entry.expiresAt === undefined) continue;
      if (Date.parse(entry.expiresAt) > now) continue;
      this.endMute(entry, "expired");
      ended = true;
    }
    if (ended) this.persist();
  }

  private endMute(entry: PersistedSuppression, endReason: AutoPingMuteEndReason): void {
    entry.endedAt =
      endReason === "expired" && entry.expiresAt !== undefined
        ? entry.expiresAt
        : new Date(this.now()).toISOString();
    entry.endReason = endReason;
    appendMuteHistory(this.dataDir, entry.actorSessionId, "ended", view(entry));
    this.log("auto-ping.unmuted", entry.actorSessionId, {
      suppressionId: entry.suppressionId,
      mode: entry.mode,
      endReason,
    });
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
