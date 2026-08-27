// Drives the real xterm 5.3 runtime dependency (no vi.mock("xterm")) under
// jsdom, replaying committed raw byte captures with a real term.resize().
// A one-shot jsdom stderr line about HTMLCanvasElement.prototype.getContext
// is expected noise from xterm's Color.ts module init; it does not throw.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Terminal as TerminalType } from "xterm";
import {
  composeTerminalLinkDisplay,
  extractTerminalLinks,
  mergeTerminalLinkDiscoveries,
  TERMINAL_LINK_DISCOVERY_LIMIT,
  type TerminalBufferRow,
  type TerminalLink,
} from "@/lib/terminal-links";

const fixturesDir = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/terminal-reflow");

function loadFixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(resolve(fixturesDir, name)));
}

async function createTerminal(cols: number, rows: number): Promise<TerminalType> {
  const { Terminal } = await import("xterm");
  return new Terminal({
    cols,
    rows,
    scrollback: 10_000,
    allowProposedApi: true,
  });
}

async function writeBytes(terminal: TerminalType, bytes: Uint8Array): Promise<void> {
  await new Promise<void>((resolvePromise) => terminal.write(bytes, resolvePromise));
}

function scanRows(terminal: TerminalType): TerminalLink[] {
  const active = terminal.buffer.active;
  const startIndex = Math.max(0, active.length - 100);
  const rows: Array<TerminalBufferRow | undefined> = [];
  for (let index = startIndex; index < active.length; index += 1) {
    const line = active.getLine(index);
    rows.push(
      line
        ? { text: line.translateToString(false, 0, terminal.cols), isWrapped: line.isWrapped }
        : undefined,
    );
  }
  return extractTerminalLinks(rows, terminal.cols);
}

describe("terminal link discovery over real xterm", () => {
  it("joins a URL that a TUI absolute-CUP redraw split when the head row stops short of the wrap column", async () => {
    const terminal = await createTerminal(120, 41);
    await writeBytes(terminal, loadFixture("tui-cup-118-stage1-120x41.raw"));

    const links = scanRows(terminal);

    expect(links.map((link) => link.url)).toContain("https://alt.example.com/path/x");

    terminal.dispose();
  });

  it("keeps every discovered link across a real resize and reflow", async () => {
    const terminal = await createTerminal(120, 41);
    let discovered: TerminalLink[] = [];

    await writeBytes(terminal, loadFixture("reflow-overflow-stage1-120x41.raw"));
    let scanned = scanRows(terminal);
    discovered = mergeTerminalLinkDiscoveries(discovered, scanned, TERMINAL_LINK_DISCOVERY_LIMIT);
    let composed = composeTerminalLinkDisplay(scanned, discovered);
    expect(composed.map((link) => link.url)).toEqual([
      "https://eee.example.com/e1",
      "https://ddd.example.com/d1",
      "https://ccc.example.com/c1",
      "https://alt.example.com/path/x",
      "https://early.example.com/a1",
    ]);

    terminal.resize(40, 41);
    scanned = scanRows(terminal);
    // Resize mode is "keep": the accumulator is left untouched, only compose runs.
    composed = composeTerminalLinkDisplay(scanned, discovered);
    expect(composed).toHaveLength(5);
    expect(composed.map((link) => link.url)).toContain("https://alt.example.com/path/x");

    await writeBytes(terminal, loadFixture("reflow-overflow-stage2-redraw-40x41.raw"));
    scanned = scanRows(terminal);

    // Raw baseline: a plain rescan with no accumulator loses the row that
    // scrolled into tmux's own scrollback during the reflow.
    expect(scanned).toHaveLength(4);
    expect(scanned.map((link) => link.url)).not.toContain("https://early.example.com/a1");

    discovered = mergeTerminalLinkDiscoveries(discovered, scanned, TERMINAL_LINK_DISCOVERY_LIMIT);
    composed = composeTerminalLinkDisplay(scanned, discovered);
    expect(composed).toHaveLength(5);
    expect(composed.map((link) => link.url)).toContain("https://early.example.com/a1");

    terminal.dispose();
  });

  it("records the measured buffer regime", async () => {
    const terminal = await createTerminal(120, 41);
    await writeBytes(terminal, loadFixture("reflow-overflow-stage1-120x41.raw"));

    const active = terminal.buffer.active;
    expect(active.type).toBe("alternate");
    expect(active.length).toBe(41);
    expect(active.baseY).toBe(0);

    terminal.dispose();
  });
});
