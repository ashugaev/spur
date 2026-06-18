import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { claudePaneShowsQuestionChooser } from "../../src/claude-pane-state.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("claudePaneShowsQuestionChooser", () => {
  it("detects the captured spur-b761 question chooser", async () => {
    const pane = await readFile(
      join(
        __dirname,
        "../fixtures/agent-history/claude/question-chooser-spur-b761-pane.txt",
      ),
      "utf8",
    );

    expect(claudePaneShowsQuestionChooser(pane)).toBe(true);
  });

  it("ignores normal Claude prompt panes", () => {
    const pane = [
      "● Done.",
      "",
      "╭────────────────────────────────────────────────────────────────╮",
      "│ >                                                              │",
      "╰────────────────────────────────────────────────────────────────╯",
    ].join("\n");

    expect(claudePaneShowsQuestionChooser(pane)).toBe(false);
  });
});
