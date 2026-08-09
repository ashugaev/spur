import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as ClientModule from "../../src/client.js";
import type * as ConfigModule from "../../src/config.js";
import type { AppConfig, ProjectConfigMutationResponse } from "../../src/types.js";

const findProjectConfigPathMock = vi.fn<() => string | undefined>();
const loadConfigMock = vi.fn<(input?: string) => AppConfig>();
const connectProjectConfigMock =
  vi.fn<
    (
      cliEntrypoint: string,
      projectConfigPath: string,
      configPath?: string,
    ) => Promise<ProjectConfigMutationResponse>
  >();

vi.mock("../../src/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ConfigModule>();
  return {
    ...actual,
    findProjectConfigPath: findProjectConfigPathMock,
    loadConfig: loadConfigMock,
  };
});

vi.mock("../../src/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ClientModule>();
  return {
    ...actual,
    connectProjectConfig: connectProjectConfigMock,
  };
});

function fakeConfig(worktreeDir: string): AppConfig {
  return { worktreeDir } as unknown as AppConfig;
}

describe("cli.maybeAutoConnectProject", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("skips auto-connect for a project config discovered inside worktreeDir", async () => {
    const { maybeAutoConnectProject } = await import("../../src/cli.js");
    const worktreeDir = "/data/worktrees";
    const discovered = join(worktreeDir, "backend-api", "sess-1", "spur.yaml");
    findProjectConfigPathMock.mockReturnValue(discovered);
    loadConfigMock.mockReturnValue(fakeConfig(worktreeDir));

    const result = await maybeAutoConnectProject("/tmp/dist/cli.js", "/tmp/spur.yaml");

    expect(result).toEqual({});
    expect(connectProjectConfigMock).not.toHaveBeenCalled();
  });

  it("auto-connects a project config discovered outside worktreeDir", async () => {
    const { maybeAutoConnectProject } = await import("../../src/cli.js");
    const worktreeDir = "/data/worktrees";
    const discovered = "/repo/backend-api/spur.yaml";
    findProjectConfigPathMock.mockReturnValue(discovered);
    loadConfigMock.mockReturnValue(fakeConfig(worktreeDir));
    connectProjectConfigMock.mockResolvedValue({
      ok: true,
      changed: true,
      configPath: discovered,
      projects: [],
    });

    const result = await maybeAutoConnectProject("/tmp/dist/cli.js", "/tmp/spur.yaml");

    expect(connectProjectConfigMock).toHaveBeenCalledWith(
      "/tmp/dist/cli.js",
      discovered,
      "/tmp/spur.yaml",
    );
    expect(result).toEqual({ notice: `Connected project config from ${discovered}.` });
  });
});
