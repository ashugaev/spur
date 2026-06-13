import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse as parseYaml } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildIsolatedInstanceConfig,
  writeIsolatedInstanceConfig,
} from "../../src/isolated-instance-config.js";

const baseYaml = `server:
  host: 127.0.0.1
  port: 4321
dataDir: "/tmp/spur-iso/data"
worktreeDir: "/tmp/spur-iso/worktrees"
tmux:
  socketName: "spur-4321"
`;

const cleanupPaths: string[] = [];

afterEach(() => {
  for (const path of cleanupPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function parsedMap(yaml: string): Record<string, unknown> {
  const parsed = parseYaml(yaml) as unknown;
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("expected parsed object");
  }
  return parsed as Record<string, unknown>;
}

describe("isolated instance config", () => {
  it("returns base unchanged when user config absent", () => {
    const tmp = mkdtempSync(join(tmpdir(), "spur-iso-instance-"));
    cleanupPaths.push(tmp);

    const basePath = join(tmp, "config.yaml");
    const outputPath = join(tmp, "out.yaml");
    writeFileSync(basePath, baseYaml, "utf8");

    writeIsolatedInstanceConfig({
      userConfigPath: join(tmp, "does-not-exist.yaml"),
      basePath,
      outputPath,
    });

    const parsed = parsedMap(readFileSync(outputPath, "utf8"));
    expect(parsed.server).toEqual({ host: "127.0.0.1", port: 4321 });
    expect(parsed.dataDir).toBe("/tmp/spur-iso/data");
    expect(parsed.voice).toBeUndefined();
  });

  it("merges voice block when user config has it", () => {
    const userYaml = `voice:
  provider: whisper_cpp
  language: auto
  model: base
`;
    const output = buildIsolatedInstanceConfig({
      baseYaml,
      userYaml,
      userConfigDir: "/home/user/.spur",
      userConfigPath: "/home/user/.spur/config.yaml",
    });
    const parsed = parsedMap(output);
    expect(parsed.voice).toEqual({
      provider: "whisper_cpp",
      language: "auto",
      model: "base",
    });
    expect(parsed.server).toEqual({ host: "127.0.0.1", port: 4321 });
  });

  it("resolves relative voice.modelPath against userConfigDir", () => {
    const userYaml = `voice:
  modelPath: models/ggml-base.bin
`;
    const output = buildIsolatedInstanceConfig({
      baseYaml,
      userYaml,
      userConfigDir: "/home/user/.spur",
      userConfigPath: "/home/user/.spur/config.yaml",
    });
    const parsed = parsedMap(output);
    expect(parsed.voice).toEqual({ modelPath: "/home/user/.spur/models/ggml-base.bin" });
  });

  it("preserves absolute voice.modelPath", () => {
    const userYaml = `voice:
  modelPath: /opt/models/ggml-base.bin
`;
    const output = buildIsolatedInstanceConfig({
      baseYaml,
      userYaml,
      userConfigDir: "/home/user/.spur",
      userConfigPath: "/home/user/.spur/config.yaml",
    });
    const parsed = parsedMap(output);
    expect(parsed.voice).toEqual({ modelPath: "/opt/models/ggml-base.bin" });
  });

  it("drops user-provided server/dataDir/worktreeDir/tmux", () => {
    const userYaml = `server:
  port: 9999
dataDir: /home/user/.spur
worktreeDir: /home/user/.spur/worktrees
tmux:
  socketName: spur-9999
voice:
  provider: faster_whisper
`;
    const output = buildIsolatedInstanceConfig({
      baseYaml,
      userYaml,
      userConfigDir: "/home/user/.spur",
      userConfigPath: "/home/user/.spur/config.yaml",
    });
    const parsed = parsedMap(output);
    expect(parsed.server).toEqual({ host: "127.0.0.1", port: 4321 });
    expect(parsed.dataDir).toBe("/tmp/spur-iso/data");
    expect(parsed.worktreeDir).toBe("/tmp/spur-iso/worktrees");
    expect(parsed.tmux).toEqual({ socketName: "spur-4321" });
    expect(parsed.voice).toEqual({ provider: "faster_whisper" });
  });

  it("ignores unknown top-level keys", () => {
    const userYaml = `ui:
  port: 5555
defaultAgent: claude
voice:
  provider: whisper_cpp
`;
    const output = buildIsolatedInstanceConfig({
      baseYaml,
      userYaml,
      userConfigDir: "/home/user/.spur",
      userConfigPath: "/home/user/.spur/config.yaml",
    });
    const parsed = parsedMap(output);
    expect(parsed.ui).toBeUndefined();
    expect(parsed.defaultAgent).toBeUndefined();
    expect(parsed.voice).toEqual({ provider: "whisper_cpp" });
  });

  it("throws clear error on malformed user YAML", () => {
    const userYaml = "voice:\n  provider: : invalid\n  - broken";
    expect(() =>
      buildIsolatedInstanceConfig({
        baseYaml,
        userYaml,
        userConfigDir: "/home/user/.spur",
        userConfigPath: "/home/user/.spur/config.yaml",
      }),
    ).toThrow(/Failed to parse user config at \/home\/user\/\.spur\/config\.yaml:/);
  });

  it("throws on non-mapping user root", () => {
    const userYaml = "- one\n- two\n";
    expect(() =>
      buildIsolatedInstanceConfig({
        baseYaml,
        userYaml,
        userConfigDir: "/home/user/.spur",
        userConfigPath: "/home/user/.spur/config.yaml",
      }),
    ).toThrow("User config root must be a mapping at /home/user/.spur/config.yaml");
  });
});
