import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubSourceConfig } from "../../src/types.js";
import type { SourceStartDeps } from "../../src/event-sources/types.js";

const recordWorkItemMock = vi.fn();
const readWorkItemLifecyclesMock = vi.fn();
const markWorkItemRetriesEmittedMock = vi.fn();

vi.mock("../../src/metadata.js", () => ({
  recordWorkItem: recordWorkItemMock,
  readWorkItemLifecycles: readWorkItemLifecyclesMock,
  markWorkItemRetriesEmitted: markWorkItemRetriesEmittedMock,
}));

const { emitWorkItemBacklog, WORK_ITEM_FIRST_POLL_EMIT_CAP } =
  await import("../../src/event-sources/work-item-backlog.js");

interface Candidate {
  repo: string;
  externalId: string;
  data: { id: string };
}

function makeCandidate(repo: string, n: number): Candidate {
  const externalId = `${repo}#${n}`;
  return { repo, externalId, data: { id: externalId } };
}

function makeDeps(emitExisting: boolean): {
  deps: SourceStartDeps<GitHubSourceConfig>;
  emit: ReturnType<typeof vi.fn>;
} {
  const emit = vi.fn();
  const config: GitHubSourceConfig = {
    type: "github",
    intervalMs: 1000,
    emitExisting,
    runOnStart: false,
  };
  const deps: SourceStartDeps<GitHubSourceConfig> = {
    sourceId: "src-id",
    projectId: "proj-id",
    dataDir: "/tmp/data",
    config,
    emit,
    signal: new AbortController().signal,
    logger: {},
    resolveWebBaseUrl: () => Promise.resolve("http://127.0.0.1:5555"),
  };
  return { deps, emit };
}

describe("emitWorkItemBacklog", () => {
  beforeEach(() => {
    recordWorkItemMock.mockReset();
    readWorkItemLifecyclesMock.mockReset().mockReturnValue(new Map());
    markWorkItemRetriesEmittedMock.mockReset();
  });

  it("skips items already in seen on subsequent polls", () => {
    const { deps, emit } = makeDeps(true);
    const seen = new Set<string>(["acme/api#1", "acme/api#2"]);
    const candidates = [makeCandidate("acme/api", 1), makeCandidate("acme/api", 3)];

    emitWorkItemBacklog(deps, "work-item:new", seen, candidates);

    expect(recordWorkItemMock).toHaveBeenCalledTimes(1);
    expect(recordWorkItemMock).toHaveBeenCalledWith("/tmp/data", "proj-id", "src-id", "acme/api#3");
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith("work-item:new", { id: "acme/api#3" });
  });

  it("suppresses every candidate on first poll when emitExisting is false", () => {
    const { deps, emit } = makeDeps(false);
    const seen = new Set<string>();
    const candidates = [
      makeCandidate("acme/api", 1),
      makeCandidate("acme/api", 2),
      makeCandidate("acme/api", 3),
    ];

    emitWorkItemBacklog(deps, "work-item:new", seen, candidates);

    expect(recordWorkItemMock).toHaveBeenCalledTimes(3);
    expect(emit).not.toHaveBeenCalled();
    expect(seen.size).toBe(3);
  });

  it("emits up to WORK_ITEM_FIRST_POLL_EMIT_CAP per repo on first poll when emitExisting", () => {
    expect(WORK_ITEM_FIRST_POLL_EMIT_CAP).toBe(10);
    const { deps, emit } = makeDeps(true);
    const seen = new Set<string>();
    const candidates = Array.from({ length: 12 }, (_, i) => makeCandidate("acme/api", i));

    emitWorkItemBacklog(deps, "work-item:new", seen, candidates);

    expect(recordWorkItemMock).toHaveBeenCalledTimes(12);
    expect(emit).toHaveBeenCalledTimes(WORK_ITEM_FIRST_POLL_EMIT_CAP);
  });

  it("tracks the cap per repo independently", () => {
    const { deps, emit } = makeDeps(true);
    const seen = new Set<string>();
    const candidates = [
      ...Array.from({ length: 7 }, (_, i) => makeCandidate("acme/api", i)),
      ...Array.from({ length: 5 }, (_, i) => makeCandidate("acme/web", i)),
    ];

    emitWorkItemBacklog(deps, "work-item:new", seen, candidates);

    expect(emit).toHaveBeenCalledTimes(12);
    const repos = emit.mock.calls.map(([, d]) => (d as Candidate["data"]).id.split("#")[0]);
    expect(repos.filter((r) => r === "acme/api")).toHaveLength(7);
    expect(repos.filter((r) => r === "acme/web")).toHaveLength(5);
  });

  it("does not leak seen state across repos", () => {
    const { deps, emit } = makeDeps(false);
    const seen = new Set<string>(["acme/api#1"]);
    const candidates = [makeCandidate("acme/api", 2), makeCandidate("acme/web", 1)];

    emitWorkItemBacklog(deps, "work-item:new", seen, candidates);

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith("work-item:new", { id: "acme/api#2" });
    expect(seen.has("acme/web#1")).toBe(true);
  });

  it("records suppressed first-poll items so later polls do not re-emit them", () => {
    const { deps, emit } = makeDeps(false);
    const seen = new Set<string>();
    const firstBatch = [makeCandidate("acme/api", 1), makeCandidate("acme/api", 2)];

    emitWorkItemBacklog(deps, "work-item:new", seen, firstBatch);
    expect(emit).not.toHaveBeenCalled();
    expect(seen.has("acme/api#1")).toBe(true);
    expect(seen.has("acme/api#2")).toBe(true);

    emit.mockClear();
    recordWorkItemMock.mockClear();
    const secondBatch = [makeCandidate("acme/api", 1), makeCandidate("acme/api", 3)];
    emitWorkItemBacklog(deps, "work-item:new", seen, secondBatch);

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith("work-item:new", { id: "acme/api#3" });
    expect(recordWorkItemMock).toHaveBeenCalledTimes(1);
    expect(recordWorkItemMock).toHaveBeenCalledWith("/tmp/data", "proj-id", "src-id", "acme/api#3");
  });

  describe("retries", () => {
    const NOW = Date.parse("2026-06-01T12:00:00.000Z");
    const MINUTE = 60_000;

    interface FakeRecord {
      externalId: string;
      lastRetryEmitAt?: string;
      members: Array<Record<string, unknown>>;
    }

    function failedMember(nextRetryAt: string | undefined, extra?: Record<string, unknown>) {
      return {
        triggerId: "review",
        blockIndex: 0,
        state: "failed",
        claimedAt: "2026-06-01T09:00:00.000Z",
        attempts: 1,
        deferrals: 0,
        ...(nextRetryAt !== undefined ? { nextRetryAt } : {}),
        ...extra,
      };
    }

    function useLifecycles(records: FakeRecord[]): Map<string, FakeRecord> {
      const store = new Map(records.map((record) => [record.externalId, record]));
      readWorkItemLifecyclesMock.mockImplementation(() => new Map(store));
      markWorkItemRetriesEmittedMock.mockImplementation(
        (_dir: string, _project: string, _source: string, ids: string[], nowIso: string) => {
          for (const id of ids) {
            const record = store.get(id);
            if (record) store.set(id, { ...record, lastRetryEmitAt: nowIso });
          }
        },
      );
      return store;
    }

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    function emittedIds(emit: ReturnType<typeof vi.fn>): string[] {
      return emit.mock.calls.map(([, data]) => (data as Candidate["data"]).id);
    }

    it("re-emits due retries for eligible items only, capped per poll", () => {
      const { deps, emit } = makeDeps(true);
      const iso = (offsetMin: number) => new Date(NOW + offsetMin * MINUTE).toISOString();
      useLifecycles([
        { externalId: "acme/api#1", members: [failedMember(iso(-50))] },
        { externalId: "acme/api#2", members: [failedMember(iso(-40))] },
        { externalId: "acme/api#3", members: [failedMember(iso(-30))] },
        { externalId: "acme/api#4", members: [failedMember(iso(10))] },
        { externalId: "acme/api#9", members: [failedMember(iso(-90))] },
      ]);
      const seen = new Set(["acme/api#1", "acme/api#2", "acme/api#3", "acme/api#4", "acme/api#9"]);
      // #9 is due but absent from the poll result (closed); #4 is not due yet.
      const candidates = [1, 2, 3, 4].map((n) => makeCandidate("acme/api", n));

      emitWorkItemBacklog(deps, "work-item:new", seen, candidates);

      expect(emittedIds(emit)).toEqual(["acme/api#1", "acme/api#2"]);
      expect(markWorkItemRetriesEmittedMock).toHaveBeenCalledTimes(1);
      expect(markWorkItemRetriesEmittedMock).toHaveBeenCalledWith(
        "/tmp/data",
        "proj-id",
        "src-id",
        ["acme/api#1", "acme/api#2"],
        new Date(NOW).toISOString(),
      );
    });

    it("stamps the emit time before emitting", () => {
      const { deps, emit } = makeDeps(true);
      useLifecycles([{ externalId: "acme/api#1", members: [failedMember(undefined)] }]);
      emit.mockImplementation(() => {
        expect(markWorkItemRetriesEmittedMock).toHaveBeenCalledTimes(1);
      });

      emitWorkItemBacklog(deps, "work-item:new", new Set(["acme/api#1"]), [
        makeCandidate("acme/api", 1),
      ]);

      expect(emit).toHaveBeenCalledTimes(1);
    });

    it("stops retrying when the item leaves the poll", () => {
      const { deps, emit } = makeDeps(true);
      useLifecycles([{ externalId: "acme/api#1", members: [failedMember(undefined)] }]);
      const seen = new Set(["acme/api#1", "acme/api#2"]);
      const others = [makeCandidate("acme/api", 2)];

      emitWorkItemBacklog(deps, "work-item:new", seen, others);
      vi.setSystemTime(NOW + 45 * MINUTE);
      emitWorkItemBacklog(deps, "work-item:new", seen, others);
      vi.setSystemTime(NOW + 90 * MINUTE);
      emitWorkItemBacklog(deps, "work-item:new", seen, others);
      expect(emit).not.toHaveBeenCalled();

      emitWorkItemBacklog(deps, "work-item:new", seen, [makeCandidate("acme/api", 1), ...others]);
      expect(emittedIds(emit)).toEqual(["acme/api#1"]);
    });

    it("throttles unclaimed retry emits to one per 45 minutes and rotates slots", () => {
      const { deps, emit } = makeDeps(true);
      useLifecycles(
        [1, 2, 3, 4].map((n) => ({
          externalId: `acme/api#${n}`,
          members: [failedMember(new Date(NOW - (60 - n) * MINUTE).toISOString())],
        })),
      );
      const seen = new Set([1, 2, 3, 4].map((n) => `acme/api#${n}`));
      const candidates = [1, 2, 3, 4].map((n) => makeCandidate("acme/api", n));

      emitWorkItemBacklog(deps, "work-item:new", seen, candidates);
      expect(emittedIds(emit)).toEqual(["acme/api#1", "acme/api#2"]);

      // No trigger claimed #1 or #2; ten minutes later they hold no slot.
      emit.mockClear();
      vi.setSystemTime(NOW + 10 * MINUTE);
      emitWorkItemBacklog(deps, "work-item:new", seen, candidates);
      expect(emittedIds(emit)).toEqual(["acme/api#3", "acme/api#4"]);

      emit.mockClear();
      vi.setSystemTime(NOW + 20 * MINUTE);
      emitWorkItemBacklog(deps, "work-item:new", seen, candidates);
      expect(emit).not.toHaveBeenCalled();

      emit.mockClear();
      vi.setSystemTime(NOW + 45 * MINUTE);
      emitWorkItemBacklog(deps, "work-item:new", seen, candidates);
      expect(emittedIds(emit)).toEqual(["acme/api#1", "acme/api#2"]);
    });

    it("legacy failed record retries only while eligible", () => {
      const { deps, emit } = makeDeps(true);
      const legacyMember = {
        blockIndex: 0,
        state: "failed",
        claimedAt: "2026-05-01T00:00:00.000Z",
        attempts: 0,
        deferrals: 0,
        error: "boom",
      };
      useLifecycles([{ externalId: "acme/api#1", members: [legacyMember] }]);
      const seen = new Set(["acme/api#1"]);

      emitWorkItemBacklog(deps, "work-item:new", seen, [makeCandidate("acme/api", 2)]);
      expect(emittedIds(emit).filter((id) => id === "acme/api#1")).toEqual([]);

      emit.mockClear();
      emitWorkItemBacklog(deps, "work-item:new", seen, [makeCandidate("acme/api", 1)]);
      expect(emittedIds(emit)).toEqual(["acme/api#1"]);
    });

    it("does not retry-emit an item that is new this poll", () => {
      const { deps, emit } = makeDeps(true);
      useLifecycles([{ externalId: "acme/api#1", members: [failedMember(undefined)] }]);

      emitWorkItemBacklog(deps, "work-item:new", new Set(["acme/api#5"]), [
        makeCandidate("acme/api", 1),
      ]);

      expect(emittedIds(emit)).toEqual(["acme/api#1"]);
      expect(markWorkItemRetriesEmittedMock).not.toHaveBeenCalled();
    });
  });
});
