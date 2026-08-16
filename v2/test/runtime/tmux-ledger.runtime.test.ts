// Real-tmux coverage for the per-run armed-socket ledger (test/setup/
// tmux-ledger.ts) and for killTmuxSessionsByPrefix's explicit-socket
// contract (test/helpers/runtime.ts). Runtime tier because both need a real
// tmux binary — a fast-tier mock can't prove a live server actually dies or
// survives.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  setup as ledgerSetup,
  sweepTmuxLedger,
  teardown as ledgerTeardown,
} from "../setup/tmux-ledger.js";
import {
  buildTmuxSocketArgs,
  isTmuxAvailable,
  killTmuxSessionsByPrefix,
  setActiveTmuxSocketName,
} from "../helpers/runtime.js";

const execFileAsync = promisify(execFile);
const tmuxOk = await isTmuxAvailable();

const liveSockets: string[] = [];

afterEach(async () => {
  while (liveSockets.length > 0) {
    const socket = liveSockets.pop();
    if (!socket) continue;
    try {
      await execFileAsync("tmux", ["-L", socket, "kill-server"]);
    } catch {
      // Already gone.
    }
  }
  setActiveTmuxSocketName(null);
});

async function startBareTmuxServer(socketName: string, sessionName: string): Promise<string> {
  liveSockets.push(socketName);
  await execFileAsync("tmux", [
    "-L",
    socketName,
    "new-session",
    "-d",
    "-s",
    sessionName,
    "-x",
    "1",
    "-y",
    "1",
    "sleep 3600",
  ]);
  const { stdout } = await execFileAsync("tmux", [
    "-L",
    socketName,
    "display-message",
    "-p",
    "#{pid}",
  ]);
  return stdout.trim();
}

async function tmuxHasSession(socketName: string): Promise<boolean> {
  try {
    await execFileAsync("tmux", ["-L", socketName, "has-session"]);
    return true;
  } catch {
    return false;
  }
}

async function writeLedger(entries: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "spur-tmux-ledger-test-"));
  const path = join(dir, "ledger.jsonl");
  await writeFile(path, entries.join("\n") + (entries.length > 0 ? "\n" : ""), "utf8");
  return path;
}

describe.skipIf(!tmuxOk)("sweepTmuxLedger (real tmux)", () => {
  it("kills a server whose recorded pid matches the live server pid", async () => {
    const socket = `spur-ledger-match-${process.pid}`;
    const serverPid = await startBareTmuxServer(socket, "s");
    const ledgerPath = await writeLedger([JSON.stringify({ socketName: socket, serverPid })]);

    const killed = await sweepTmuxLedger(ledgerPath);

    expect(killed).toEqual([socket]);
    expect(await tmuxHasSession(socket)).toBe(false);
    await rm(join(ledgerPath, ".."), { recursive: true, force: true });
  });

  it("leaves a server alive when the recorded pid does not match", async () => {
    const socket = `spur-ledger-mismatch-${process.pid}`;
    await startBareTmuxServer(socket, "s");
    const ledgerPath = await writeLedger([
      JSON.stringify({ socketName: socket, serverPid: "999999999" }),
    ]);

    const killed = await sweepTmuxLedger(ledgerPath);

    expect(killed).toEqual([]);
    expect(await tmuxHasSession(socket)).toBe(true);
    await rm(join(ledgerPath, ".."), { recursive: true, force: true });
  });

  it("skips a malformed ledger line without throwing", async () => {
    const socket = `spur-ledger-malformed-${process.pid}`;
    const serverPid = await startBareTmuxServer(socket, "s");
    const ledgerPath = await writeLedger([
      "not json at all",
      JSON.stringify({ socketName: socket, serverPid }),
    ]);

    await expect(sweepTmuxLedger(ledgerPath)).resolves.toEqual([socket]);
    expect(await tmuxHasSession(socket)).toBe(false);
    await rm(join(ledgerPath, ".."), { recursive: true, force: true });
  });

  it("returns [] and never throws on a missing ledger file (TMPDIR wiped before teardown)", async () => {
    const missingPath = join(tmpdir(), `spur-ledger-missing-${process.pid}-${Date.now()}.jsonl`);
    await expect(sweepTmuxLedger(missingPath)).resolves.toEqual([]);
  });
});

describe.skipIf(!tmuxOk)("tmux-ledger setup()/teardown() (end to end)", () => {
  it("teardown() kills a recorded server with a matching pid and removes the ledger file", async () => {
    await ledgerSetup();
    const ledgerPath = process.env["SPUR_TEST_TMUX_LEDGER"];
    expect(ledgerPath).toBeTruthy();
    if (!ledgerPath) throw new Error("unreachable");

    const socket = `spur-ledger-e2e-${process.pid}`;
    const serverPid = await startBareTmuxServer(socket, "e2e");
    await appendFile(ledgerPath, `${JSON.stringify({ socketName: socket, serverPid })}\n`, "utf8");

    await ledgerTeardown();

    expect(await tmuxHasSession(socket)).toBe(false);
    expect(existsSync(ledgerPath)).toBe(false);
  });
});

describe.skipIf(!tmuxOk)("killTmuxSessionsByPrefix (real tmux, explicit socket)", () => {
  it("kills a real session on socket B while socket A is the armed global", async () => {
    const socketA = `spur-prefix-a-${process.pid}`;
    const socketB = `spur-prefix-b-${process.pid}`;
    await startBareTmuxServer(socketA, "prefix-keep");
    await startBareTmuxServer(socketB, "prefix-die");
    setActiveTmuxSocketName(socketA);

    await killTmuxSessionsByPrefix("prefix-die", socketB);

    // Socket B's session is gone; socket A (the armed global, untouched by
    // this call) is unaffected.
    const { stdout } = await execFileAsync("tmux", [
      ...buildTmuxSocketArgs(socketB, ["list-sessions", "-F", "#{session_name}"]),
    ]).catch(() => ({ stdout: "" }));
    expect(stdout.trim()).toBe("");
    expect(await tmuxHasSession(socketA)).toBe(true);
  });
});
