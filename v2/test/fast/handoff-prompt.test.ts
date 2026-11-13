import { describe, expect, it } from "vitest";
import { extractBareUserTask, renderHandoffPrompt } from "../../src/handoff-prompt.js";
import { withSelfDestructInstructions } from "../../src/self-destruct.js";
import { withSharedMemoryInstructions } from "../../src/shared-memory.js";
import { refreshShepherdPrompt, renderShepherdPrompt } from "../../src/shepherd.js";
import { legacyShepherdPrompt, LEGACY_SHEPHERD_INITIAL_ACTION } from "../helpers/shepherd.js";

describe("bounded INT Shepherd startup", () => {
  it("keeps bounded INT guidance conditional and preserves operator payload", () => {
    const task = "  Follow the bounded INT protocol.\nKeep this operator request exact.  ";
    const prompt = renderShepherdPrompt(task);
    expect(prompt).toContain("complete fresh relevant project registry census");
    expect(prompt).toContain("Otherwise, run `spur list --json`");
    expect(prompt).not.toContain("1. Run `spur list --json`");
    expect(prompt.endsWith(`Operator request:\n${task.trim()}`)).toBe(true);
    const generic = renderShepherdPrompt("Inspect an unrelated project");
    expect(generic).toContain("Otherwise, run `spur list --json`");
    const fleetTask = "Run whole-fleet diagnostics with spur list --json";
    expect(renderShepherdPrompt(fleetTask)).toContain(
      "explicit operator request for whole-fleet diagnostics",
    );
    expect(renderShepherdPrompt(fleetTask).endsWith(fleetTask)).toBe(true);
  });

  it("refreshes only the generated action and preserves adversarial operator text", () => {
    const task =
      "Quoted INT and int-review instructions:\n" +
      LEGACY_SHEPHERD_INITIAL_ACTION +
      "\n\nOperator request:\nThis marker belongs to the operator payload.";
    const legacy = legacyShepherdPrompt(task);
    const refreshed = refreshShepherdPrompt(legacy, {
      project: "spur-shepherd",
      originalTaskPrompt: `  ${task}\n`,
    });
    expect(refreshed).toBe(renderShepherdPrompt(task));
    expect(refreshed.endsWith(task)).toBe(true);
    expect(refreshed.split(LEGACY_SHEPHERD_INITIAL_ACTION)).toHaveLength(2);
    expect(
      refreshShepherdPrompt(refreshed, { project: "spur-shepherd", originalTaskPrompt: task }),
    ).toBe(refreshed);
  });

  it.each([
    ["non-Shepherd project", "int-review", "task", "legacy"],
    ["missing canonical task", "spur-shepherd", undefined, "legacy"],
    ["mismatched canonical task", "spur-shepherd", "different task", "legacy"],
    ["bare task", "spur-shepherd", "task", "task"],
    ["custom header mention", "spur-shepherd", "task", "custom"],
    ["modified rules", "spur-shepherd", "task", "modified"],
  ])("does not guess generated provenance for %s", (_name, project, task, shape) => {
    const legacy = legacyShepherdPrompt("task");
    const prompt =
      shape === "legacy"
        ? legacy
        : shape === "custom"
          ? `Custom instruction mentioning You are Spur Shepherd:\n${legacy}`
          : shape === "modified"
            ? legacy.replace("Rules:", "Custom rules:")
            : "task";
    expect(
      refreshShepherdPrompt(prompt, {
        project,
        ...(task === undefined ? {} : { originalTaskPrompt: task }),
      }),
    ).toBe(prompt);
  });
});

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
