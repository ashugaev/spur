import type * as ChildProcess from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface ExecFileSyncCall {
  command: string;
  args: ReadonlyArray<string>;
}

const execFileSyncCalls: ExecFileSyncCall[] = [];

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof ChildProcess>("node:child_process");
  return {
    ...actual,
    execFileSync: (command: string, args: ReadonlyArray<string>) => {
      execFileSyncCalls.push({ command, args: [...args] });
      return "";
    },
  };
});

const { runNpmInit } = await import("../../src/host-install.js");

describe("runNpmInit --tailscale forwarding", () => {
  let cliEntrypoint: string;

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), "spur-host-install-tailscale-"));
    await mkdir(join(dir, "dist"), { recursive: true });
    await mkdir(join(dir, "scripts"), { recursive: true });
    cliEntrypoint = join(dir, "dist", "cli.js");
    await writeFile(cliEntrypoint, "");
    await writeFile(join(dir, "scripts", "npm-init.sh"), "");
  });

  afterEach(() => {
    execFileSyncCalls.length = 0;
  });

  it("forwards --tailscale by default (tailscale unset)", () => {
    runNpmInit(cliEntrypoint, {});
    expect(execFileSyncCalls).toHaveLength(1);
    expect(execFileSyncCalls[0]?.args).toContain("--tailscale");
    expect(execFileSyncCalls[0]?.args).not.toContain("--no-tailscale");
  });

  it("forwards --tailscale when explicitly true", () => {
    runNpmInit(cliEntrypoint, { tailscale: true });
    expect(execFileSyncCalls[0]?.args).toContain("--tailscale");
  });

  it("forwards --no-tailscale when explicitly false", () => {
    runNpmInit(cliEntrypoint, { tailscale: false });
    expect(execFileSyncCalls[0]?.args).toContain("--no-tailscale");
    expect(execFileSyncCalls[0]?.args).not.toContain("--tailscale");
  });
});
