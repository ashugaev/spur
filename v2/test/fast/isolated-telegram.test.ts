import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isolatedTelegramFixturePath,
  isolatedTelegramLockPath,
  loadIsolatedTelegram,
} from "../../src/isolated-telegram.js";
import { loadProjectConfig } from "../../src/config.js";

const fields = {
  TELEGRAM_TEST_BOT_TOKEN: "123456:fake-test-token",
  TELEGRAM_TEST_CHAT_ID: "-100123",
  TELEGRAM_TEST_ALLOWED_USERS: "456",
  TELEGRAM_TEST_ALLOWED_CHATS: "-100123,456",
};
const paths: string[] = [];
function repo(): string {
  const path = mkdtempSync(join(tmpdir(), "spur-test-telegram-"));
  paths.push(path);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: path });
  return path;
}
afterEach(() => {
  vi.unstubAllEnvs();
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("private isolated Telegram fixture", () => {
  it("uses one private token-hashed lock across repositories without token filenames", () => {
    const path = repo();
    vi.stubEnv("TMPDIR", path);
    const credentials = loadIsolatedTelegram(path, JSON.stringify(fields));
    if (!credentials) throw new Error("Missing fixture");
    const lock = isolatedTelegramLockPath(credentials);
    expect(isolatedTelegramLockPath({ ...credentials })).toBe(lock);
    expect(lock).not.toContain(credentials.token);
    expect(lstatSync(lock).mode & 0o777).toBe(0o600);
    expect(lstatSync(join(lock, "..")).mode & 0o777).toBe(0o700);
    rmSync(lock);
    symlinkSync(join(path, "elsewhere"), lock);
    expect(() => isolatedTelegramLockPath(credentials)).toThrow();
  });
  it("retains TEST input privately without production fallback or overwrite", () => {
    const path = repo();
    expect(loadIsolatedTelegram(path)).toBeUndefined();
    const value = loadIsolatedTelegram(path, JSON.stringify(fields));
    expect(loadIsolatedTelegram(path)).toEqual(value);
    const fixture = isolatedTelegramFixturePath(path);
    expect(lstatSync(fixture).mode & 0o777).toBe(0o600);
    expect(lstatSync(join(fixture, "..")).mode & 0o777).toBe(0o700);
    expect(() =>
      loadIsolatedTelegram(
        path,
        JSON.stringify({ ...fields, TELEGRAM_TEST_BOT_TOKEN: "123456:different-secret" }),
      ),
    ).toThrow("different credentials");
    expect(loadIsolatedTelegram(path)).toEqual(value);
  });
  it.each([
    ["{", "Malformed"],
    [JSON.stringify({ TELEGRAM_TEST_BOT_TOKEN: "secret" }), "Missing TELEGRAM_TEST_CHAT_ID"],
    [
      JSON.stringify({ ...fields, TELEGRAM_TEST_BOT_TOKEN: `\${TELEGRAM_BOT_TOKEN}` }),
      "Invalid TELEGRAM_TEST_BOT_TOKEN",
    ],
    [
      JSON.stringify({ ...fields, TELEGRAM_TEST_CHAT_ID: "secret-id" }),
      "Invalid TELEGRAM_TEST_CHAT_ID",
    ],
    [JSON.stringify({ ...fields, TELEGRAM_BOT_TOKEN: "production-secret" }), "Unexpected"],
  ])("rejects incomplete or malformed seed with names only", (input, message) => {
    expect(() => loadIsolatedTelegram(repo(), input)).toThrow(message);
  });
  it("rejects unsafe modes and symlinks", () => {
    const path = repo();
    loadIsolatedTelegram(path, JSON.stringify(fields));
    const fixture = isolatedTelegramFixturePath(path);
    chmodSync(fixture, 0o644);
    expect(() => loadIsolatedTelegram(path)).toThrow("unsafe");
    rmSync(fixture);
    symlinkSync(join(path, "elsewhere"), fixture);
    expect(() => loadIsolatedTelegram(path)).toThrow("unsafe");
    rmSync(fixture);
    chmodSync(join(fixture, ".."), 0o755);
    expect(() => loadIsolatedTelegram(path)).toThrow("unsafe");
  });
  it("shares retained input across git worktrees", () => {
    const path = repo();
    writeFileSync(join(path, "README"), "test");
    execFileSync("git", ["add", "README"], { cwd: path });
    execFileSync(
      "git",
      ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "test"],
      { cwd: path },
    );
    const worktree = join(path, "checkout");
    execFileSync("git", ["worktree", "add", "-q", "-b", "feature/test", worktree], { cwd: path });
    loadIsolatedTelegram(path, JSON.stringify(fields));
    expect(isolatedTelegramFixturePath(worktree)).toBe(isolatedTelegramFixturePath(path));
    expect(loadIsolatedTelegram(worktree)).toEqual(loadIsolatedTelegram(path));
  });
  it("seeds through stdin, parses the overlay, then starts with TEST env absent", () => {
    const path = repo();
    const input = join(path, "spur.yaml");
    const output = join(path, "project.yaml");
    writeFileSync(
      input,
      "projects:\n  test:\n    path: ~/project\n    defaultAgent: claude\n    sources: {prod: {type: telegram, token: production-secret}}\n    triggers: {prod: {source: prod, event: 'telegram:message', send: {}}}\n",
    );
    const bin = resolve("bin/write-isolated-project-config.mjs");
    const args = [
      bin,
      "--input",
      input,
      "--output",
      output,
      "--worktree",
      path,
      "--project",
      "test",
      "--branch",
      "feature/test",
    ];
    const env = { PATH: process.env["PATH"], HOME: path, TELEGRAM_BOT_TOKEN: "production-secret" };
    const partial = spawnSync(process.execPath, [...args, "--telegram-env-stdin"], {
      input: JSON.stringify({ TELEGRAM_TEST_BOT_TOKEN: fields.TELEGRAM_TEST_BOT_TOKEN }),
      env,
      encoding: "utf8",
    });
    expect(partial.status).toBe(0);
    expect(partial.stderr).toContain("Missing TELEGRAM_TEST_CHAT_ID");
    expect(partial.stderr).not.toContain(fields.TELEGRAM_TEST_BOT_TOKEN);
    expect(partial.stdout).toContain("NOT_CONNECTED");
    expect(loadIsolatedTelegram(path)).toBeUndefined();
    const malformed = spawnSync(process.execPath, [...args, "--telegram-env-stdin"], {
      input: "{",
      env,
      encoding: "utf8",
    });
    expect(malformed.status).toBe(1);
    expect(malformed.stderr).toBe("Malformed Telegram TEST fixture JSON\n");
    const first = execFileSync(process.execPath, [...args, "--telegram-env-stdin"], {
      input: JSON.stringify(fields),
      env,
      encoding: "utf8",
    });
    expect(first).not.toContain(fields.TELEGRAM_TEST_BOT_TOKEN);
    expect(first).not.toContain(fields.TELEGRAM_TEST_CHAT_ID);
    expect(args.join(" ")).not.toContain(fields.TELEGRAM_TEST_BOT_TOKEN);
    execFileSync(process.execPath, args, { env });
    const config = loadProjectConfig(output);
    const project = config.projects["test"];
    if (!project) throw new Error("Missing test project");
    expect(project.path).toBe(path);
    expect(project.defaultBranch).toBe("feature/test");
    expect(Object.keys(project.sources)).toEqual(["tg-dev"]);
    expect(Object.keys(project.triggers)).toEqual(["tg-dev-message"]);
    expect(readFileSync(output, "utf8")).not.toContain("production-secret");
    expect(lstatSync(output).mode & 0o777).toBe(0o600);
    execFileSync(process.execPath, [...args, "--without-telegram"], { env });
    const disabled = loadProjectConfig(output).projects["test"];
    if (!disabled) throw new Error("Missing test project");
    expect(Object.keys(disabled.sources)).toEqual([]);
    expect(Object.keys(disabled.triggers)).toEqual([]);
  });
});
