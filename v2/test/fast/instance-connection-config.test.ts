import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type * as FileSystem from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  loadInstanceConfigReadOnly,
  loadInstanceConnectionConfigReadOnly,
  loadProjectConfig,
} from "../../src/config.js";
import {
  writeInstalledInstance,
  installedInstanceReceiptPath,
} from "../../src/installed-instance.js";
import { createTempDir } from "../helpers/common.js";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof FileSystem>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

async function fixture(content: string) {
  const root = await createTempDir("spur-connection-config-");
  vi.stubEnv("HOME", root);
  vi.stubEnv("SPUR_CONFIG", undefined);
  const path = join(root, "instance.yaml");
  writeFileSync(path, content);
  return { root, path };
}

it.each([
  "{}",
  "server:\n  host: '::'\n  port: 4311\nui:\n  port: 4312\ndataDir: ./data\n",
  "server:\n  port: 43218\nui:\n  port: 43219\nmcp:\n  port: 43220\ndataDir: ~/private-data\n",
])("shares full parser connection defaults and paths for %s", async (content) => {
  const { path } = await fixture(content);
  const full = loadInstanceConfigReadOnly(path);
  const narrow = loadInstanceConnectionConfigReadOnly(path);
  expect(full.status).toBe("ok");
  expect(narrow.status).toBe("ok");
  if (full.status !== "ok" || narrow.status !== "ok") throw new Error("Expected valid config");
  const { configPath, server, ui, mcp, dataDir } = full.config;
  expect(narrow.config).toEqual({ configPath, server, ui, mcp, dataDir });
  // Project config ignores global overrides and inherits the same instance values.
  const projectPath = join(full.config.dataDir, "project.yaml");
  mkdirSync(full.config.dataDir, { recursive: true });
  writeFileSync(
    projectPath,
    "server:\n  port: 1\nui:\n  port: 2\nmcp:\n  port: 3\ndataDir: ignored\nprojects: {}\n",
  );
  const project = loadProjectConfig(projectPath, full.config);
  expect({
    server: project.server,
    ui: project.ui,
    mcp: project.mcp,
    dataDir: project.dataDir,
  }).toEqual({ server, ui, mcp, dataDir });
});

it("reads connection fields with daemon-only Telegram secrets absent without reading either env file", async () => {
  const { root, path } = await fixture(
    "server:\n  port: 43218\ndataDir: ./data\nprojects:\n  test:\n    path: .\n    sources:\n      telegram:\n        type: telegram\n        token: ${TELEGRAM_BOT_TOKEN}\n        allowedUsers: [123]\nvoice:\n  provider: openai_realtime\n  apiKey: PRIVATE_VOICE_KEY\n",
  );
  writeFileSync(join(root, ".env"), "PRIVATE_PROJECT_SENTINEL=do-not-import\n");
  mkdirSync(join(root, ".spur"));
  writeFileSync(join(root, ".spur", "daemon.env"), "TELEGRAM_BOT_TOKEN=do-not-import\n");
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "fixture-token");
  const full = loadInstanceConfigReadOnly(path);
  expect(full.status).toBe("ok");
  vi.stubEnv("TELEGRAM_BOT_TOKEN", undefined);
  expect(loadInstanceConfigReadOnly(path)).toMatchObject({
    status: "invalid",
    error: expect.stringContaining("token"),
  });
  vi.mocked(readFileSync).mockClear();
  const narrow = loadInstanceConnectionConfigReadOnly(path);
  expect(narrow).toMatchObject({
    status: "ok",
    config: { configPath: path, server: { port: 43218 }, dataDir: join(root, "data") },
  });
  expect(vi.mocked(readFileSync).mock.calls.map(([file]) => String(file))).toEqual([path]);
  expect(process.env["TELEGRAM_BOT_TOKEN"]).toBeUndefined();
  expect(process.env["PRIVATE_PROJECT_SENTINEL"]).toBeUndefined();
});

it("preserves explicit, environment and installed receipt precedence without rewriting invalid selection", async () => {
  const { root, path } = await fixture("server:\n  port: 43218\n");
  const second = join(root, "second.yaml");
  writeFileSync(second, "server:\n  port: 43219\n");
  writeInstalledInstance(path, root);
  expect(loadInstanceConnectionConfigReadOnly()).toMatchObject({
    status: "ok",
    config: { configPath: path },
  });
  vi.stubEnv("SPUR_CONFIG", second);
  expect(loadInstanceConnectionConfigReadOnly()).toMatchObject({
    status: "ok",
    config: { configPath: second },
  });
  expect(loadInstanceConnectionConfigReadOnly(path)).toMatchObject({
    status: "ok",
    config: { configPath: path },
  });
  vi.stubEnv("SPUR_CONFIG", undefined);
  const receipt = installedInstanceReceiptPath(root);
  writeFileSync(receipt, '{"configPath":"relative.yaml"}', { mode: 0o600 });
  expect(loadInstanceConnectionConfigReadOnly()).toMatchObject({
    status: "invalid",
    error: expect.stringContaining("absolute"),
  });
  expect(readFileSync(receipt, "utf8")).toBe('{"configPath":"relative.yaml"}');
  expect(loadInstanceConnectionConfigReadOnly(second).status).toBe("ok");
});

it.each([
  ["server:\n  port: wrong\n", "server.port"],
  ["server:\n  host: 12\n", "server.host"],
  ["ui:\n  port: -1\n", "ui.port"],
  ["mcp:\n  port: 4310\n", "mcp.port must differ"],
  ["mcp:\n  port: 65536\n", "mcp.port must be an integer"],
  ["dataDir: 12\n", "dataDir"],
  ["- list\n", "config must be an object"],
])("rejects invalid selected fields without writes: %s", async (content, error) => {
  const { path } = await fixture(content);
  expect(loadInstanceConnectionConfigReadOnly(path)).toMatchObject({
    status: "invalid",
    error: expect.stringContaining(error),
  });
  expect(readFileSync(path, "utf8")).toBe(content);
});

it("keeps syntax diagnostics free of source excerpts and ignores unrelated semantic sections", async () => {
  const { path } = await fixture('projects: [private-secret: "unterminated\n');
  expect(loadInstanceConnectionConfigReadOnly(path)).toEqual({
    status: "invalid",
    error: "Instance configuration YAML is invalid",
  });
  writeFileSync(path, "projects: wrong\nvoice: wrong\nmodels: wrong\n");
  expect(loadInstanceConnectionConfigReadOnly(path).status).toBe("ok");
  expect(loadInstanceConfigReadOnly(path).status).toBe("invalid");
});
