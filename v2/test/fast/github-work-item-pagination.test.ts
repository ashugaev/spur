import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as GhModule from "../../src/gh.js";
import { githubSourceModule } from "../../src/event-sources/github.js";
import type { SourceHandle } from "../../src/event-sources/types.js";
import { readWorkItemRegistry, recordWorkItem } from "../../src/metadata.js";
import type { GitHubSourceConfig } from "../../src/types.js";

const ghMock = vi.hoisted(() => vi.fn());
vi.mock("../../src/gh.js", async (original) => ({
  ...(await original<typeof GhModule>()),
  gh: ghMock,
}));

const sourceId = "pr-watch";
const projectId = "api";
const handles: SourceHandle[] = [];
let pages: Array<string | Error>;
let meta: unknown;
let features: unknown;

function pr(number: number) {
  return {
    number,
    title: `PR ${number}`,
    html_url: `https://github.com/acme/api/pull/${number}`,
    repository_url: "https://api.github.com/repos/acme/api",
    pull_request: {},
  };
}

function page(items: ReturnType<typeof pr>[], total = items.length, incomplete = false): string {
  return JSON.stringify({ total_count: total, incomplete_results: incomplete, items });
}

function firstHundred(): ReturnType<typeof pr>[] {
  return Array.from({ length: 100 }, (_, index) => pr(index + 1));
}

async function startDiscovery(
  overrides: Partial<Pick<GitHubSourceConfig, "query" | "draft" | "emitExisting">> = {},
  dataDir?: string,
  signal = new AbortController().signal,
) {
  const dir = dataDir ?? (await mkdtemp(join(tmpdir(), "spur-pr-discovery-")));
  const emit = vi.fn();
  const warn = vi.fn();
  const handle = await githubSourceModule.start({
    projectId,
    sourceId,
    dataDir: dir,
    config: {
      type: "github",
      intervalMs: 60_000,
      runOnStart: false,
      emitExisting: false,
      query: "repo:acme/api",
      ...overrides,
    },
    signal,
    emit,
    logger: { warn },
    resolveWebBaseUrl: async () => null,
  });
  handles.push(handle);
  return { dataDir: dir, emit, warn, handle };
}

describe("GitHub complete work-item discovery", () => {
  beforeEach(() => {
    pages = [page([])];
    meta = {};
    features = { data: { __type: { enumValues: [{ name: "ISSUE_ADVANCED" }] } } };
    ghMock.mockReset().mockImplementation(async (_cwd: string, ...args: string[]) => {
      if (args[0] === "api" && args.includes("meta")) return JSON.stringify(meta);
      if (args[0] === "api" && args.includes("graphql")) return JSON.stringify(features);
      if (args[0] === "api" && args.includes("search/issues")) {
        const current = Number(args.find((arg) => arg.startsWith("page="))?.slice(5));
        const response = pages[current - 1];
        if (response instanceof Error) throw response;
        if (response === undefined) throw new Error(`Unexpected search page ${current}`);
        return response;
      }
      throw new Error(`Unexpected discovery command ${args.join(" ")}`);
    });
  });

  afterEach(async () => {
    for (const handle of handles.splice(0)) await handle.stop();
  });

  it("discovers PR101 on page two, buffers publication and deduplicates the next observation", async () => {
    const first = Array.from({ length: 100 }, (_, index) => pr(index + 1));
    pages = [page(first, 101), page([pr(101)], 101)];
    const dataDir = await mkdtemp(join(tmpdir(), "spur-pr-discovery-"));
    recordWorkItem(dataDir, projectId, sourceId, "acme/api#999");
    const initial = await startDiscovery({}, dataDir);
    expect(initial.warn).not.toHaveBeenCalled();
    expect(initial.emit).toHaveBeenCalledWith(
      "github:work_item.new",
      expect.objectContaining({ number: 101, externalId: "acme/api#101" }),
    );
    expect(initial.emit).toHaveBeenCalledTimes(101);
    expect(readWorkItemRegistry(dataDir, projectId, sourceId).size).toBe(102);
    expect(ghMock.mock.calls.filter((call) => call.includes("meta"))).toHaveLength(1);
    expect(ghMock.mock.calls.filter((call) => call.includes("graphql"))).toHaveLength(1);
    expect(ghMock.mock.calls.filter((call) => call.includes("search/issues"))).toHaveLength(2);
    await initial.handle.stop();
    const next = await startDiscovery({}, dataDir);
    expect(next.emit).not.toHaveBeenCalled();
  });

  it.each([
    ["second page failure", () => [page(firstHundred(), 101), new Error("offline")]],
    ["incomplete search", () => [page([pr(1)], 1, true)]],
    ["search ceiling", () => [page([], 1001)]],
    ["count drift", () => [page(firstHundred(), 101), page([pr(101)], 102)]],
    ["duplicate page", () => [page(firstHundred(), 101), page([pr(1)], 101)]],
    ["short page", () => [page([pr(1)], 101)]],
    [
      "malformed item",
      () => [JSON.stringify({ total_count: 1, incomplete_results: false, items: [{ number: 1 }] })],
    ],
  ])("records no partial baseline for %s", async (_name, responses) => {
    pages = responses();
    const result = await startDiscovery({ emitExisting: true });
    expect(result.emit).not.toHaveBeenCalled();
    expect(readWorkItemRegistry(result.dataDir, projectId, sourceId).size).toBe(0);
    expect(result.warn).toHaveBeenCalledWith(expect.stringContaining("work-item poll failed"));
  });

  it("preserves OR grouping, quoted labels and exclusion/sort qualifiers on every page", async () => {
    const query = 'repo:acme/one OR repo:acme/two label:"🌞 Front" -author:robot sort:updated-desc';
    pages = [page(firstHundred(), 101), page([pr(101)], 101)];
    const result = await startDiscovery({ query });
    expect(result.warn).not.toHaveBeenCalled();
    const calls = ghMock.mock.calls.filter((call) => call.includes("search/issues"));
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call).toContain(`q=( ${query} ) type:pr state:open draft:false`);
      expect(call).toContain("advanced_search=true");
      expect(call).not.toContain("sort=");
      expect(call).not.toContain("order=");
    }
  });

  it.each([
    ["hosted opt-in", {}, ["ISSUE_ADVANCED"], true, true],
    ["hosted after opt-in retirement", {}, ["ISSUE"], true, false],
    ["GHES legacy", { installed_version: "3.17.4" }, [], false, false],
    ["GHES advanced", { installed_version: "3.18.0" }, ["ISSUE_ADVANCED"], true, true],
  ])("preserves %s search compatibility", async (_name, metadata, names, grouped, optIn) => {
    meta = metadata;
    features = { data: { __type: { enumValues: names.map((name) => ({ name })) } } };
    const result = await startDiscovery({ draft: true });
    expect(result.warn).not.toHaveBeenCalled();
    const call = ghMock.mock.calls.find((args) => args.includes("search/issues"));
    expect(call).toContain(
      `q=${grouped ? "( repo:acme/api )" : "repo:acme/api"} type:pr state:open draft:true`,
    );
    expect(call?.includes("advanced_search=true")).toBe(optIn);
    expect(ghMock.mock.calls.filter((args) => args.includes("graphql"))).toHaveLength(
      grouped ? 1 : 0,
    );
  });

  it.each(["metadata", "introspection"])(
    "does not guess compatibility after invalid %s",
    async (kind) => {
      if (kind === "metadata") meta = { installed_version: "unrecognized" };
      else features = { data: { __type: null } };
      const result = await startDiscovery();
      expect(result.warn).toHaveBeenCalled();
      expect(result.emit).not.toHaveBeenCalled();
      expect(readWorkItemRegistry(result.dataDir, projectId, sourceId).size).toBe(0);
      expect(ghMock.mock.calls.some((call) => call.includes("search/issues"))).toBe(false);
    },
  );

  it("does not publish a buffered observation cancelled during the last page", async () => {
    const abort = new AbortController();
    const transport = ghMock.getMockImplementation();
    ghMock.mockImplementation(async (...args: [string, ...string[]]) => {
      const response = await transport?.(...args);
      if (args.includes("search/issues")) abort.abort();
      return response;
    });
    pages = [page([pr(1)])];
    const result = await startDiscovery({ emitExisting: true }, undefined, abort.signal);
    expect(result.emit).not.toHaveBeenCalled();
    expect(readWorkItemRegistry(result.dataDir, projectId, sourceId).size).toBe(0);
  });

  it.each([false, true])(
    "retains initial suppression and cap when emitExisting=%s",
    async (emitExisting) => {
      pages = [page(Array.from({ length: 13 }, (_, i) => pr(i + 1)))];
      const result = await startDiscovery({ emitExisting });
      expect(readWorkItemRegistry(result.dataDir, projectId, sourceId).size).toBe(13);
      expect(result.emit).toHaveBeenCalledTimes(emitExisting ? 10 : 0);
    },
  );
});
