import { describe, expect, it } from "vitest";
import {
  extractBareUserTask,
  HANDOFF_SNAPSHOT_INLINE_MAX_BYTES,
  renderHandoffPrompt,
} from "../../src/handoff-prompt.js";
import { withSelfDestructInstructions } from "../../src/self-destruct.js";
import { withSharedMemoryInstructions } from "../../src/shared-memory.js";
import { renderShepherdPrompt } from "../../src/shepherd.js";

describe("extractBareUserTask", () => {
  it("extracts the task from a manager step wrapper", () => {
    const bare = extractBareUserTask(
      "[Spur step 1/1: run $manager]\nThis is the final step for the task below.\n\nTask:\nAdd agent handoff button\n\nSession metadata:\n- Set the session title",
    );
    expect(bare).toBe("Add agent handoff button");
  });

  it("extracts the task from a restore prompt", () => {
    const bare = extractBareUserTask(
      'This session was restored after the agent exited. You are back in the same worktree and branch. Pull the latest main first, then check whether the original task is still needed — another agent may have already done it. If it is already done, run `"$SPUR_SESSION_TOOL_DIR/spur-self-destruct"` and close this session\'s pull request if it duplicates that work; if it is not a duplicate but only extends or overlaps work already merged, trim this PR down to the remaining necessary changes. Otherwise continue the original task. Original task:\n\nShip CSV export\n\nSession metadata:\n- Set the session title',
    );
    expect(bare).toBe("Ship CSV export");
  });

  it("extracts the task from a prior handoff prompt", () => {
    const prior = renderHandoffPrompt({
      sourceSessionId: "api-1",
      sourceAgent: "codex",
      branch: "api-1",
      worktreePath: "/tmp/worktrees/api/api-1",
      originalPrompt: "Implement CSV export",
      links: [],
    });
    expect(extractBareUserTask(prior)).toBe("Implement CSV export");
  });

  it("extracts the operator request from a shepherd prompt", () => {
    const shepherd = renderShepherdPrompt("ping");
    expect(extractBareUserTask(shepherd)).toBe("ping");
  });

  it("unwraps chained handoffs without accumulating screenshot boilerplate", () => {
    const first = withSelfDestructInstructions(
      renderHandoffPrompt({
        sourceSessionId: "shp-1",
        sourceAgent: "cursor",
        branch: "shp-1",
        worktreePath: "/tmp/data/shepherd",
        originalPrompt: "ping",
        links: [],
        terminalScreenshot: true,
      }),
      { enabled: true },
    );
    const second = renderHandoffPrompt({
      sourceSessionId: "shp-2",
      sourceAgent: "claude",
      branch: "shp-1",
      worktreePath: "/tmp/data/shepherd",
      originalPrompt: extractBareUserTask(first),
      links: [],
      terminalScreenshot: true,
      notes: "tst",
    });

    expect(extractBareUserTask(second)).toBe("ping");
    expect(second.split("handoff-screenshot.txt").length - 1).toBe(1);
    expect(second).not.toContain("You are Spur Shepherd");
    expect(second).not.toContain("Self-destruct:");
  });

  it("strips a trailing self-destruct section from a plain wrapped prompt", () => {
    const prompt = withSelfDestructInstructions(
      "Add agent handoff button" +
        "\n\nSession metadata:\n- Set the session title" +
        "\n\nSession artifacts:\n- Use $SPUR_SESSION_ARTIFACTS_DIR for scratch files.",
      { enabled: true },
    );

    expect(extractBareUserTask(prompt)).toBe("Add agent handoff button");
  });

  it("strips a trailing shared memory section from a plain wrapped prompt", () => {
    // Production order: slot/artifacts blocks are suppressed via idempotency
    // markers, then shared memory is appended, then branch naming is
    // appended last (session-service.ts composes shared memory before
    // branch naming). Shared memory must precede branch naming here so the
    // marker at handoff-prompt.ts's shared-memory section is what strips it.
    const prompt =
      withSharedMemoryInstructions(
        "Add agent handoff button" +
          "\n\nUses $SPUR_SLOT_COMMAND and SPUR_SESSION_ARTIFACTS_DIR already.",
      ) + "\n\nBranch naming:\n- Use `spur-branch create <name>`.";

    expect(extractBareUserTask(prompt)).toBe(
      "Add agent handoff button" +
        "\n\nUses $SPUR_SLOT_COMMAND and SPUR_SESSION_ARTIFACTS_DIR already.",
    );
  });

  it("unwraps shepherd prompts nested inside handoff original tasks", () => {
    const handoff = renderHandoffPrompt({
      sourceSessionId: "shp-872c",
      sourceAgent: "claude",
      branch: "shp-312c",
      worktreePath: "/tmp/data/shepherd",
      originalPrompt: renderShepherdPrompt("ping"),
      links: [],
      terminalScreenshot: true,
      notes: "tst",
    });

    expect(extractBareUserTask(handoff)).toBe("ping");
  });
});

describe("renderHandoffPrompt", () => {
  it("includes source session, task, and production guidance", () => {
    const prompt = renderHandoffPrompt({
      sourceSessionId: "spur-442a",
      sourceAgent: "codex",
      branch: "feature/agent-handoff",
      worktreePath: "/tmp/worktrees/sp/spur-442a",
      originalPrompt: "Add agent handoff button",
      title: "Agent handoff",
      links: [{ label: "pr", url: "https://github.com/org/repo/pull/442" }],
      tags: ["feature"],
      notes: "Prefer cursor for UI work",
    });

    expect(prompt).toContain("Task handoff from session spur-442a (codex).");
    expect(prompt).toContain("Branch: feature/agent-handoff");
    expect(prompt).toContain("Add agent handoff button");
    expect(prompt).toContain("Session title: Agent handoff");
    expect(prompt).toContain("Tags: feature");
    expect(prompt).toContain("https://github.com/org/repo/pull/442");
    expect(prompt).toContain("Additional handoff notes:");
    expect(prompt).toContain("Prefer cursor for UI work");
    expect(prompt).toContain("pull request already exists");
  });

  it("lists remaining pipeline steps when provided", () => {
    const prompt = renderHandoffPrompt({
      sourceSessionId: "api-1",
      sourceAgent: "claude",
      branch: "api-1",
      worktreePath: "/tmp/worktrees/api/api-1",
      originalPrompt: "Ship feature",
      links: [],
      remainingPipelineSteps: ["run tests", "open PR"],
    });

    expect(prompt).toContain("Remaining pipeline steps:");
    expect(prompt).toContain("1. run tests");
    expect(prompt).toContain("2. open PR");
  });

  it("mentions the terminal screenshot attachment when provided", () => {
    const prompt = renderHandoffPrompt({
      sourceSessionId: "api-1",
      sourceAgent: "codex",
      branch: "api-1",
      worktreePath: "/tmp/worktrees/api/api-1",
      originalPrompt: "Ship feature",
      links: [],
      terminalScreenshot: true,
    });

    expect(prompt).toContain("handoff-screenshot.txt");
  });

  it("includes a plain task exactly once and frames it as a handoff continuation", () => {
    const task = "Implement the CSV export endpoint";
    const prompt = renderHandoffPrompt({
      sourceSessionId: "csv-1",
      sourceAgent: "claude",
      branch: "csv-1",
      worktreePath: "/tmp/worktrees/csv/csv-1",
      originalPrompt: task,
      links: [],
    });

    const occurrences = prompt.split(task).length - 1;
    expect(occurrences).toBe(1);
    expect(prompt).toContain("This is not a new task.");
    expect(prompt).toContain("Original task (as originally requested):");
    expect(prompt.split("You continue in the same workspace").length - 1).toBe(1);
  });
});

describe("renderHandoffPrompt snapshot and inherited ToDo", () => {
  const base = {
    sourceSessionId: "api-1",
    sourceAgent: "codex" as const,
    branch: "api-1",
    worktreePath: "/tmp/worktrees/api/api-1",
    originalPrompt: "Ship feature",
    links: [],
  };
  const snapshot = {
    version: 3,
    at: "2026-11-01T10:00:00.000Z",
    ageMinutes: 42,
    commitsSince: 2,
    stale: true,
    content: "Done: parser. Next: wire CLI.",
    headSha: "abc1234",
  };

  it("renders inherited ToDo, snapshot freshness and delta pointers", () => {
    const prompt = renderHandoffPrompt({
      ...base,
      inheritedTodo: [
        {
          itemId: "new-1",
          text: "Wire CLI",
          addedReason: "r",
          from: { sessionId: "api-1", itemId: "old-1" },
        },
        {
          itemId: "new-2",
          text: "Get approval",
          addedReason: "r",
          from: { sessionId: "api-1", itemId: "old-2" },
          hold: { reason: "wait", blocker: { kind: "human", requiredAction: "Approve" } },
        },
        {
          itemId: "new-3",
          text: "Wait CI",
          addedReason: "r",
          from: { sessionId: "api-1", itemId: "old-3" },
          hold: { reason: "wait", blocker: { kind: "external" } },
        },
      ],
      snapshot,
    });
    expect(prompt).toContain("Inherited ToDo (moved from api-1; use these ids):");
    expect(prompt).toContain("- new-1 open: Wire CLI");
    expect(prompt).toContain("- new-2 held (human: Approve): Get approval");
    expect(prompt).toContain("- new-3 held (external): Wait CI");
    expect(prompt).toContain(
      "Latest snapshot v3 at 2026-11-01T10:00:00.000Z (age 42 min, 2 commits since, stale yes):",
    );
    expect(prompt).toContain("Done: parser. Next: wire CLI.");
    expect(prompt).toContain("- git log --oneline abc1234..HEAD");
    expect(prompt).toContain("- git diff abc1234");
    expect(prompt).toContain("agent-history-api-1-*.jsonl at or after 2026-11-01T10:00:00.000Z");
    expect(prompt.indexOf("Inherited ToDo")).toBeLessThan(prompt.indexOf("Bring the work"));
  });

  it("uses the singular for one commit since the snapshot", () => {
    const prompt = renderHandoffPrompt({ ...base, snapshot: { ...snapshot, commitsSince: 1 } });
    expect(prompt).toContain("1 commit since, stale yes");
  });

  it("omits git pointers without a head sha and reports unknown commit counts", () => {
    const prompt = renderHandoffPrompt({
      ...base,
      snapshot: { ...snapshot, headSha: null, commitsSince: null, stale: false },
    });
    expect(prompt).toContain("unknown commits since, stale no");
    expect(prompt).not.toContain("git log --oneline");
    expect(prompt).not.toContain("git diff");
  });

  it("points to spur snapshot show for a snapshot over the inline cap", () => {
    const content = "x".repeat(HANDOFF_SNAPSHOT_INLINE_MAX_BYTES + 1);
    const prompt = renderHandoffPrompt({ ...base, snapshot: { ...snapshot, content } });
    expect(prompt).not.toContain(content);
    expect(prompt).toContain("Read it: spur snapshot show api-1 3");
  });

  it("renders the no-snapshot line", () => {
    const prompt = renderHandoffPrompt(base);
    expect(prompt).toContain(
      "No work snapshot: reconstruct state from git log, git diff and agent-history-api-1-*.jsonl",
    );
    expect(prompt).not.toContain("Inherited ToDo");
  });

  it("renders the unreadable-snapshot note", () => {
    const prompt = renderHandoffPrompt({ ...base, snapshotUnreadable: "bad checksum" });
    expect(prompt).toContain("No work snapshot (latest snapshot unreadable: bad checksum):");
  });

  it.each([
    [
      "Inherited ToDo",
      {
        inheritedTodo: [
          { itemId: "n", text: "t", addedReason: "r", from: { sessionId: "api-1", itemId: "o" } },
        ],
      },
    ],
    ["Latest snapshot v", { snapshot }],
    ["Since snapshot:", { snapshot }],
    ["No work snapshot", {}],
  ])("extractBareUserTask stops at the %s header", (_header, extra) => {
    const prompt = renderHandoffPrompt({ ...base, ...extra });
    expect(prompt).toContain(_header);
    expect(extractBareUserTask(prompt)).toBe("Ship feature");
  });
});
