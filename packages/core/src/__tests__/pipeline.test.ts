import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createPipelineEngine } from "../pipeline.js";
import type {
  EventBus,
  PipelineConfig,
  PipelineEngine,
  SessionId,
} from "../types.js";

function makeSessionId(): SessionId {
  return `test-${randomUUID().slice(0, 8)}` as SessionId;
}

function makeEventBus(): EventBus & { events: Array<{ event: string; data: unknown }> } {
  const events: Array<{ event: string; data: unknown }> = [];
  return {
    events,
    emit(event: string, data?: unknown) {
      events.push({ event, data });
    },
    on: vi.fn(),
    off: vi.fn(),
  };
}

describe("PipelineEngine", () => {
  let sessionsDir: string;
  let eventBus: ReturnType<typeof makeEventBus>;
  let engine: PipelineEngine;

  beforeEach(() => {
    sessionsDir = join(tmpdir(), `ao-pipeline-test-${randomUUID()}`);
    mkdirSync(sessionsDir, { recursive: true });
    eventBus = makeEventBus();
    engine = createPipelineEngine({ sessionsDir, eventBus });
  });

  afterEach(() => {
    rmSync(sessionsDir, { recursive: true, force: true });
  });

  // ── initialize ──

  describe("initialize", () => {
    it("creates state and starts first step", () => {
      const sid = makeSessionId();
      engine.initialize(sid, {
        steps: [{ id: "a" }, { id: "b" }],
      });
      const state = engine.getState(sid);
      expect(state).not.toBeNull();
      expect(state!.state).toBe("running");
      expect(state!.currentStepIndex).toBe(0);
      expect(state!.steps[0].state).toBe("running");
      expect(state!.steps[0].iterations).toBe(1);
      expect(state!.steps[1].state).toBe("pending");
      expect(eventBus.events).toContainEqual(
        expect.objectContaining({ event: "pipeline.step.started" }),
      );
    });

    it("skips steps with failing when: condition", () => {
      const sid = makeSessionId();
      engine.initialize(sid, {
        steps: [
          { id: "a", when: "{{steps.x.output.flag}}" },
          { id: "b" },
        ],
      });
      const state = engine.getState(sid)!;
      expect(state.currentStepIndex).toBe(1);
      expect(state.steps[0].state).toBe("skipped");
      expect(state.steps[1].state).toBe("running");
    });

    it("completes immediately when all steps are skipped", () => {
      const sid = makeSessionId();
      engine.initialize(sid, {
        steps: [
          { id: "a", when: "false" },
          { id: "b", when: "0" },
        ],
      });
      const state = engine.getState(sid)!;
      expect(state.state).toBe("completed");
      expect(eventBus.events).toContainEqual(
        expect.objectContaining({ event: "pipeline.completed" }),
      );
    });

    it("handles empty steps array", () => {
      const sid = makeSessionId();
      engine.initialize(sid, { steps: [] });
      const state = engine.getState(sid)!;
      expect(state.state).toBe("completed");
      expect(state.currentStepIndex).toBe(0);
      expect(state.steps).toHaveLength(0);
    });
  });

  // ── done ──

  describe("done", () => {
    it("advances to next step", () => {
      const sid = makeSessionId();
      engine.initialize(sid, {
        steps: [{ id: "a" }, { id: "b" }],
      });
      engine.done(sid);
      const state = engine.getState(sid)!;
      expect(state.currentStepIndex).toBe(1);
      expect(state.steps[0].state).toBe("completed");
      expect(state.steps[1].state).toBe("running");
    });

    it("stores output on step", () => {
      const sid = makeSessionId();
      engine.initialize(sid, {
        steps: [{ id: "a" }, { id: "b" }],
      });
      engine.done(sid, { pr: 123 });
      const state = engine.getState(sid)!;
      expect(state.steps[0].output).toEqual({ pr: 123 });
    });

    it("completes pipeline on last step", () => {
      const sid = makeSessionId();
      engine.initialize(sid, { steps: [{ id: "a" }] });
      engine.done(sid);
      const state = engine.getState(sid)!;
      expect(state.state).toBe("completed");
      expect(eventBus.events).toContainEqual(
        expect.objectContaining({ event: "pipeline.completed" }),
      );
    });

    it("no-op when pipeline is not running", () => {
      const sid = makeSessionId();
      engine.initialize(sid, { steps: [{ id: "a" }] });
      engine.done(sid); // completes pipeline
      const state1 = engine.getState(sid)!;
      engine.done(sid); // no-op
      const state2 = engine.getState(sid)!;
      expect(state1.updatedAt).toBe(state2.updatedAt);
    });

    it("follows step-level goto after completion", () => {
      const sid = makeSessionId();
      engine.initialize(sid, {
        steps: [
          { id: "a", goto: "c" },
          { id: "b" },
          { id: "c" },
        ],
      });
      engine.done(sid);
      const state = engine.getState(sid)!;
      expect(state.currentStepIndex).toBe(2);
      expect(state.steps[1].state).toBe("pending"); // not visited, stays pending
      expect(state.steps[2].state).toBe("running");
    });

    it("skips conditional steps during advancement", () => {
      const sid = makeSessionId();
      engine.initialize(sid, {
        steps: [
          { id: "a" },
          { id: "b", when: "{{steps.a.output.flag}}" },
          { id: "c" },
        ],
      });
      engine.done(sid); // a done without flag output
      const state = engine.getState(sid)!;
      expect(state.currentStepIndex).toBe(2);
      expect(state.steps[1].state).toBe("skipped");
    });
  });

  // ── fail ──

  describe("fail", () => {
    it("default recovery: marks pipeline failed", () => {
      const sid = makeSessionId();
      engine.initialize(sid, { steps: [{ id: "a" }] });
      engine.fail(sid, "broken");
      const state = engine.getState(sid)!;
      expect(state.state).toBe("failed");
      expect(state.steps[0].state).toBe("failed");
      expect(state.steps[0].failReason).toBe("broken");
    });

    it("recovery skip: advances to next step", () => {
      const sid = makeSessionId();
      engine.initialize(sid, {
        steps: [{ id: "a", recovery: "skip" }, { id: "b" }],
      });
      engine.fail(sid, "skip me");
      const state = engine.getState(sid)!;
      expect(state.state).toBe("running");
      expect(state.steps[0].state).toBe("skipped");
      expect(state.steps[1].state).toBe("running");
    });

    it("recovery pause: pauses pipeline", () => {
      const sid = makeSessionId();
      engine.initialize(sid, {
        steps: [{ id: "a", recovery: "pause" }],
      });
      engine.fail(sid, "need help");
      const state = engine.getState(sid)!;
      expect(state.state).toBe("paused");
      expect(state.steps[0].state).toBe("failed");
    });

    it("step-level recovery overrides pipeline-level", () => {
      const sid = makeSessionId();
      engine.initialize(sid, {
        recovery: "fail",
        steps: [{ id: "a", recovery: "skip" }, { id: "b" }],
      });
      engine.fail(sid, "oops");
      const state = engine.getState(sid)!;
      expect(state.state).toBe("running");
      expect(state.steps[0].state).toBe("skipped");
    });
  });

  // ── goto ──

  describe("goto", () => {
    it("jumps forward, marks intermediate as rewound", () => {
      const sid = makeSessionId();
      engine.initialize(sid, {
        steps: [{ id: "a" }, { id: "b" }, { id: "c" }],
      });
      engine.goto(sid, "c");
      const state = engine.getState(sid)!;
      expect(state.currentStepIndex).toBe(2);
      expect(state.steps[0].state).toBe("rewound");
      expect(state.steps[1].state).toBe("rewound");
      expect(state.steps[2].state).toBe("running");
    });

    it("jumps backward, restarts target, increments iterations", () => {
      const sid = makeSessionId();
      engine.initialize(sid, {
        steps: [{ id: "a" }, { id: "b" }],
      });
      engine.done(sid); // advance to b
      engine.goto(sid, "a"); // back to a
      const state = engine.getState(sid)!;
      expect(state.currentStepIndex).toBe(0);
      expect(state.steps[0].state).toBe("running");
      expect(state.steps[0].iterations).toBe(2);
    });

    it("fails pipeline when target not found", () => {
      const sid = makeSessionId();
      engine.initialize(sid, { steps: [{ id: "a" }] });
      engine.goto(sid, "nonexistent");
      const state = engine.getState(sid)!;
      expect(state.state).toBe("failed");
      expect(state.steps[0].failReason).toContain("not found");
    });

    it("respects maxIterations", () => {
      const sid = makeSessionId();
      engine.initialize(sid, {
        steps: [{ id: "a", maxIterations: 2 }, { id: "b" }],
      });
      // iteration 1 from initialize
      engine.done(sid); // advance to b
      engine.goto(sid, "a"); // iteration 2
      engine.done(sid); // advance to b again
      engine.goto(sid, "a"); // iteration 3 — exceeds maxIterations
      const state = engine.getState(sid)!;
      expect(state.steps[0].state).toBe("failed");
      expect(state.steps[0].failReason).toBe("max iterations exceeded");
    });

    it("resets firedOn when restarting a step", () => {
      const sid = makeSessionId();
      engine.initialize(sid, {
        steps: [
          { id: "a", on: { "ci:failed": "goto a" } },
          { id: "b" },
        ],
      });
      engine.tick(sid, { "ci:failed": true }); // fires, adds to firedOn, goto a
      const state = engine.getState(sid)!;
      // firedOn should be reset after goto restarts the step
      expect(state.steps[0].firedOn).toBeUndefined();
    });
  });

  // ── respond ──

  describe("respond", () => {
    it("completes channel step and advances", () => {
      const sid = makeSessionId();
      engine.initialize(sid, {
        steps: [{ id: "a", channel: "telegram" }, { id: "b" }],
      });
      engine.respond(sid, "APPROVE");
      const state = engine.getState(sid)!;
      expect(state.steps[0].state).toBe("completed");
      expect(state.steps[0].output).toEqual({ response: "APPROVE" });
      expect(state.currentStepIndex).toBe(1);
    });

    it("no-op without channel on current step", () => {
      const sid = makeSessionId();
      engine.initialize(sid, {
        steps: [{ id: "a", prompt: "do stuff" }],
      });
      engine.respond(sid, "APPROVE");
      const state = engine.getState(sid)!;
      expect(state.steps[0].state).toBe("running"); // unchanged
    });
  });

  // ── tick ──

  describe("tick", () => {
    it("fires on: handler on matching event", () => {
      const sid = makeSessionId();
      engine.initialize(sid, {
        steps: [
          {
            id: "a",
            on: { "ci:failed": "goto a" },
          },
        ],
      });
      eventBus.events.length = 0;
      engine.tick(sid, { "ci:failed": true });
      expect(eventBus.events).toContainEqual(
        expect.objectContaining({ event: "pipeline.step.started" }),
      );
    });

    it("firedOn prevents duplicate handler fires", () => {
      const sid = makeSessionId();
      engine.initialize(sid, {
        steps: [
          {
            id: "a",
            on: { "ci:failed": "Fix the CI" },
          },
          { id: "b" },
        ],
      });
      eventBus.events.length = 0;
      engine.tick(sid, { "ci:failed": true });
      const sendCount1 = eventBus.events.filter((e) => e.event === "pipeline.send").length;
      expect(sendCount1).toBe(1);

      engine.tick(sid, { "ci:failed": true }); // same event, should not re-fire
      const sendCount2 = eventBus.events.filter((e) => e.event === "pipeline.send").length;
      expect(sendCount2).toBe(1); // still 1
    });

    it("on: handler 'done' completes step", () => {
      const sid = makeSessionId();
      engine.initialize(sid, {
        steps: [
          { id: "a", on: { "ci:passed": "done" } },
          { id: "b" },
        ],
      });
      engine.tick(sid, { "ci:passed": true });
      const state = engine.getState(sid)!;
      expect(state.steps[0].state).toBe("completed");
      expect(state.currentStepIndex).toBe(1);
    });

    it("on: handler 'fail' fails step", () => {
      const sid = makeSessionId();
      engine.initialize(sid, {
        steps: [{ id: "a", on: { "ci:failed": "fail" } }],
      });
      engine.tick(sid, { "ci:failed": true });
      const state = engine.getState(sid)!;
      expect(state.state).toBe("failed");
    });

    it("on: handler 'pause' pauses pipeline", () => {
      const sid = makeSessionId();
      engine.initialize(sid, {
        steps: [{ id: "a", on: { "ci:failed": "pause" } }],
      });
      engine.tick(sid, { "ci:failed": true });
      const state = engine.getState(sid)!;
      expect(state.state).toBe("paused");
    });

    it("on: handler 'send' sends step message", () => {
      const sid = makeSessionId();
      engine.initialize(sid, {
        steps: [
          { id: "a", on: { "ci:failed": "send" }, message: "CI broke" },
        ],
      });
      eventBus.events.length = 0;
      engine.tick(sid, { "ci:failed": true });
      const sends = eventBus.events.filter((e) => e.event === "pipeline.send");
      expect(sends).toHaveLength(1);
      expect((sends[0].data as Record<string, unknown>).message).toBe("CI broke");
    });

    it("on: handler string sends as message with interpolation", () => {
      const sid = makeSessionId();
      engine.initialize(sid, {
        steps: [{ id: "a" }, { id: "b", on: { "ci:failed": "PR was {{steps.a.output.pr}}" } }],
      });
      engine.done(sid, { pr: "https://example.com/1" }); // complete a
      eventBus.events.length = 0;
      engine.tick(sid, { "ci:failed": true });
      const sends = eventBus.events.filter((e) => e.event === "pipeline.send");
      expect((sends[0].data as Record<string, unknown>).message).toBe(
        "PR was https://example.com/1",
      );
    });

    it("on: handler object with send + retries + goto", () => {
      const sid = makeSessionId();
      engine.initialize(sid, {
        steps: [
          {
            id: "a",
            on: {
              "ci:failed": { send: "Fixing...", retries: 2, goto: "b" },
            },
          },
          { id: "b" },
        ],
      });
      // iteration 1 (from initialize) — retries=2, iterations=1 < 2, so send
      engine.tick(sid, { "ci:failed": true });
      let sends = eventBus.events.filter((e) => e.event === "pipeline.send");
      expect(sends).toHaveLength(1);

      // goto a to restart (iteration 2)
      engine.goto(sid, "a");
      eventBus.events.length = 0;
      engine.tick(sid, { "ci:failed": true });
      // iteration 2 >= retries 2, should goto b instead of sending
      const state = engine.getState(sid)!;
      expect(state.currentStepIndex).toBe(1);
      sends = eventBus.events.filter((e) => e.event === "pipeline.send");
      expect(sends).toHaveLength(0); // no send, went straight to goto
    });

    it("timeout fires on: timeout handler if configured", () => {
      const sid = makeSessionId();
      engine.initialize(sid, {
        steps: [
          {
            id: "a",
            timeout: "1s",
            on: { timeout: "goto b" },
          },
          { id: "b" },
        ],
      });
      // Manually set startedAt to past
      const state = engine.getState(sid)!;
      state.steps[0].startedAt = new Date(Date.now() - 2000).toISOString();
      engine.tick(sid, {});
      const updated = engine.getState(sid)!;
      expect(updated.currentStepIndex).toBe(1);
      expect(updated.steps[1].state).toBe("running");
    });

    it("timeout defaults to fail when no on: timeout handler", () => {
      const sid = makeSessionId();
      engine.initialize(sid, {
        steps: [{ id: "a", timeout: "1s" }],
      });
      const state = engine.getState(sid)!;
      state.steps[0].startedAt = new Date(Date.now() - 2000).toISOString();
      engine.tick(sid, {});
      const updated = engine.getState(sid)!;
      expect(updated.state).toBe("failed");
      expect(updated.steps[0].failReason).toBe("timeout");
    });

    it("all: completes when all conditions met", () => {
      const sid = makeSessionId();
      engine.initialize(sid, {
        steps: [
          { id: "a", all: ["ci:passed", "review:approved"] },
          { id: "b" },
        ],
      });
      engine.tick(sid, { "ci:passed": true }); // partial
      let state = engine.getState(sid)!;
      expect(state.steps[0].state).toBe("running");

      engine.tick(sid, { "ci:passed": true, "review:approved": true }); // all met
      state = engine.getState(sid)!;
      expect(state.steps[0].state).toBe("completed");
      expect(state.currentStepIndex).toBe(1);
    });

    it("all: does not complete when conditions disappear", () => {
      const sid = makeSessionId();
      engine.initialize(sid, {
        steps: [
          { id: "a", all: ["ci:passed", "review:approved"] },
        ],
      });
      engine.tick(sid, { "ci:passed": true, "review:approved": true }); // all met
      const state = engine.getState(sid)!;
      expect(state.steps[0].state).toBe("completed");
    });

    it("no-op when pipeline not running", () => {
      const sid = makeSessionId();
      engine.initialize(sid, { steps: [{ id: "a" }] });
      engine.fail(sid, "done");
      eventBus.events.length = 0;
      engine.tick(sid, { "ci:failed": true });
      expect(eventBus.events).toHaveLength(0);
    });
  });

  // ── persistence ──

  describe("persistence", () => {
    it("persists state to disk and loads it back", () => {
      const sid = makeSessionId();
      const config: PipelineConfig = {
        steps: [{ id: "a" }, { id: "b" }],
      };
      engine.initialize(sid, config);
      engine.done(sid, { result: "ok" });

      // Create new engine, load from disk
      const engine2 = createPipelineEngine({ sessionsDir, eventBus });
      const loaded = engine2.load(sid, config);
      expect(loaded).not.toBeNull();
      expect(loaded!.currentStepIndex).toBe(1);
      expect(loaded!.steps[0].output).toEqual({ result: "ok" });
    });

    it("returns null for missing file", () => {
      const engine2 = createPipelineEngine({ sessionsDir, eventBus });
      const loaded = engine2.load("nonexistent" as SessionId);
      expect(loaded).toBeNull();
    });

    it("returns null for corrupted JSON", () => {
      const sid = makeSessionId();
      const filePath = join(sessionsDir, `${sid}.pipeline.json`);
      writeFileSync(filePath, "not json{{{", "utf-8");
      const loaded = engine.load(sid);
      expect(loaded).toBeNull();
    });

    it("returns null for invalid shape", () => {
      const sid = makeSessionId();
      const filePath = join(sessionsDir, `${sid}.pipeline.json`);
      writeFileSync(filePath, JSON.stringify({ foo: "bar" }), "utf-8");
      const loaded = engine.load(sid);
      expect(loaded).toBeNull();
    });

    it("loaded engine supports tick/done/fail", () => {
      const sid = makeSessionId();
      const config: PipelineConfig = {
        steps: [{ id: "a" }, { id: "b" }],
      };
      engine.initialize(sid, config);

      const engine2 = createPipelineEngine({ sessionsDir, eventBus });
      engine2.load(sid, config);
      engine2.done(sid);
      const state = engine2.getState(sid)!;
      expect(state.currentStepIndex).toBe(1);
      expect(state.steps[1].state).toBe("running");
    });
  });

  // ── maxIterations ──

  describe("maxIterations", () => {
    it("pipeline-level maxIterations is per-step default", () => {
      const sid = makeSessionId();
      engine.initialize(sid, {
        maxIterations: 2,
        steps: [{ id: "a" }, { id: "b" }],
      });
      engine.done(sid); // advance to b
      engine.goto(sid, "a"); // iteration 2
      engine.done(sid); // advance to b
      engine.goto(sid, "a"); // iteration 3 > maxIterations 2
      const state = engine.getState(sid)!;
      expect(state.steps[0].state).toBe("failed");
    });

    it("step maxIterations overrides pipeline default", () => {
      const sid = makeSessionId();
      engine.initialize(sid, {
        maxIterations: 1,
        steps: [{ id: "a", maxIterations: 3 }, { id: "b" }],
      });
      engine.done(sid);
      engine.goto(sid, "a"); // iteration 2
      expect(engine.getState(sid)!.steps[0].state).toBe("running");
      engine.done(sid);
      engine.goto(sid, "a"); // iteration 3
      expect(engine.getState(sid)!.steps[0].state).toBe("running");
      engine.done(sid);
      engine.goto(sid, "a"); // iteration 4 > maxIterations 3
      expect(engine.getState(sid)!.steps[0].state).toBe("failed");
    });

    it("advanceToNext fails if next step already at max", () => {
      const sid = makeSessionId();
      engine.initialize(sid, {
        steps: [{ id: "a" }, { id: "b", maxIterations: 1 }, { id: "c" }],
      });
      engine.done(sid); // advance to b (iteration 1)
      engine.goto(sid, "a"); // back to a
      engine.done(sid); // try to advance to b again — iteration 1 >= maxIterations 1
      const state = engine.getState(sid)!;
      expect(state.steps[1].state).toBe("failed");
      expect(state.state).toBe("failed");
    });
  });
});
