import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubSourceConfig } from "../../src/types.js";
import type { SourceStartDeps } from "../../src/event-sources/types.js";

const recordWorkItemMock = vi.fn();

vi.mock("../../src/metadata.js", () => ({
  recordWorkItem: recordWorkItemMock,
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
  };
  return { deps, emit };
}

describe("emitWorkItemBacklog", () => {
  beforeEach(() => {
    recordWorkItemMock.mockReset();
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
});
