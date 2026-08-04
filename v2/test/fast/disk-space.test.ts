import type * as ChildProcess from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof ChildProcess>("node:child_process");
  return { ...actual, execFile: execFileMock };
});

const { parseDfField, readFreeKb } = await import("../../src/disk-space.js");

describe("parseDfField", () => {
  it("returns undefined for empty output", () => {
    expect(parseDfField(undefined, 3)).toBeUndefined();
    expect(parseDfField("", 3)).toBeUndefined();
  });

  it("returns undefined for output with no data line", () => {
    expect(
      parseDfField("Filesystem 1024-blocks Used Available Capacity Mounted\n", 3),
    ).toBeUndefined();
  });

  it("returns undefined for a non-numeric field", () => {
    expect(parseDfField("header\n/dev/root 100 50 - 50% /\n", 3)).toBeUndefined();
  });

  it("returns field 3 of line 2", () => {
    expect(parseDfField("header\n/dev/root 100 50 12345 50% /\n", 3)).toBe(12345);
  });
});

describe("readFreeKb", () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the parsed available-KB field on success", async () => {
    execFileMock.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        callback: (error: Error | null, result: { stdout: string; stderr: string }) => void,
      ) => {
        callback(null, { stdout: "header\n/dev/root 100 50 54321 50% /\n", stderr: "" });
        return {} as ChildProcess.ChildProcess;
      },
    );
    await expect(readFreeKb("/home/user")).resolves.toBe(54321);
  });

  it("returns undefined when execFile rejects", async () => {
    execFileMock.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        callback: (error: Error | null, result?: { stdout: string; stderr: string }) => void,
      ) => {
        callback(new Error("ETIMEDOUT"));
        return {} as ChildProcess.ChildProcess;
      },
    );
    await expect(readFreeKb("/home/user", 10)).resolves.toBeUndefined();
  });
});
