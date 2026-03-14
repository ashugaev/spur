import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type {
  EventBus,
  PipelineConfig,
  PipelineEngine,
  PipelineSessionState,
  PipelineStep,
  PipelineStepState,
  SessionId,
  StepState,
  OnHandler,
} from "./types.js";

export interface PipelineEngineDeps {
  sessionsDir: string;
  eventBus: EventBus;
}

interface InternalState {
  config: PipelineConfig;
  session: PipelineSessionState;
}

function parseDuration(s: string): number {
  const m = /^(\d+)(s|m|h)$/.exec(s);
  if (!m) return 0;
  const n = Number(m[1]);
  switch (m[2]) {
    case "s":
      return n * 1_000;
    case "m":
      return n * 60_000;
    case "h":
      return n * 3_600_000;
    default:
      return 0;
  }
}

function interpolate(template: string, context: Record<string, unknown>): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (original, pathStr: string) => {
    const parts = pathStr.trim().split(".");
    let current: unknown = context;
    for (const part of parts) {
      if (current === null || current === undefined || typeof current !== "object") {
        return original;
      }
      current = (current as Record<string, unknown>)[part];
    }
    if (current === null || current === undefined) return original;
    return String(current);
  });
}

function isTruthy(value: string): boolean {
  const v = value.trim().toLowerCase();
  if (v.includes("{{")) return false;
  return v !== "" && v !== "false" && v !== "0" && v !== "undefined" && v !== "null";
}

function pipelinePath(sessionsDir: string, sessionId: SessionId): string {
  return join(sessionsDir, `${sessionId}.pipeline.json`);
}

function atomicWriteJson(filePath: string, data: unknown): void {
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
  renameSync(tmpPath, filePath);
}

function readJson(filePath: string): unknown {
  if (!existsSync(filePath)) return null;
  const raw = readFileSync(filePath, "utf-8");
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function now(): string {
  return new Date().toISOString();
}

export function createPipelineEngine(deps: PipelineEngineDeps): PipelineEngine {
  const { sessionsDir, eventBus } = deps;
  const states = new Map<SessionId, InternalState>();

  function persist(sessionId: SessionId): void {
    const internal = states.get(sessionId);
    if (!internal) return;
    internal.session.updatedAt = now();
    atomicWriteJson(pipelinePath(sessionsDir, sessionId), internal.session);
  }

  function buildContext(
    sessionId: SessionId,
    events: Record<string, unknown>,
  ): Record<string, unknown> {
    const internal = states.get(sessionId);
    const stepsMap: Record<string, unknown> = {};
    if (internal) {
      for (const s of internal.session.steps) {
        stepsMap[s.id] = { output: s.output ?? {} };
      }
    }
    return { session: events, event: events, steps: stepsMap };
  }

  function evaluateWhen(
    when: string | undefined,
    context: Record<string, unknown>,
  ): boolean {
    if (!when) return true;
    const result = interpolate(when, context);
    return isTruthy(result);
  }

  function currentStep(internal: InternalState): PipelineStepState | undefined {
    return internal.session.steps[internal.session.currentStepIndex];
  }

  function currentStepConfig(internal: InternalState): PipelineStep | undefined {
    return internal.config.steps[internal.session.currentStepIndex];
  }

  function markRunning(stepState: PipelineStepState): void {
    stepState.state = "running";
    stepState.iterations += 1;
    stepState.startedAt = now();
    delete stepState.output;
    delete stepState.completedAt;
    delete stepState.failReason;
    delete stepState.satisfiedConditions;
  }

  function advanceToNext(
    sessionId: SessionId,
    internal: InternalState,
    context: Record<string, unknown>,
  ): void {
    const stepCfg = currentStepConfig(internal);
    let nextIndex: number;

    if (stepCfg?.goto) {
      const targetIdx = internal.config.steps.findIndex((s) => s.id === stepCfg.goto);
      nextIndex = targetIdx >= 0 ? targetIdx : internal.session.currentStepIndex + 1;
    } else {
      nextIndex = internal.session.currentStepIndex + 1;
    }

    while (nextIndex < internal.session.steps.length) {
      const nextCfg = internal.config.steps[nextIndex];
      if (nextCfg && evaluateWhen(nextCfg.when, context)) {
        break;
      }
      internal.session.steps[nextIndex].state = "skipped";
      nextIndex++;
    }

    if (nextIndex >= internal.session.steps.length) {
      internal.session.state = "completed";
      internal.session.currentStepIndex = internal.session.steps.length - 1;
      persist(sessionId);
      eventBus.emit("pipeline.completed", { sessionId });
      return;
    }

    internal.session.currentStepIndex = nextIndex;
    const nextStepState = internal.session.steps[nextIndex];
    if (!nextStepState) return;

    const maxIter = internal.config.steps[nextIndex]?.maxIterations ?? internal.config.maxIterations;
    if (maxIter && nextStepState.iterations >= maxIter) {
      nextStepState.state = "failed";
      nextStepState.failReason = "max iterations exceeded";
      internal.session.state = "failed";
      persist(sessionId);
      return;
    }

    markRunning(nextStepState);
    persist(sessionId);
    eventBus.emit("pipeline.step.started", {
      sessionId,
      stepId: nextStepState.id,
    });
  }

  function handleOnAction(
    sessionId: SessionId,
    handler: OnHandler,
    internal: InternalState,
    stepState: PipelineStepState,
    stepCfg: PipelineStep,
  ): void {
    if (handler === "done") {
      engine.done(sessionId);
      return;
    }
    if (handler === "fail") {
      engine.fail(sessionId, "on:fail triggered");
      return;
    }
    if (handler === "pause") {
      internal.session.state = "paused";
      persist(sessionId);
      return;
    }
    if (handler === "send") {
      eventBus.emit("pipeline.send", { sessionId, message: stepCfg.message });
      return;
    }
    if (typeof handler === "string") {
      if (handler.startsWith("goto ")) {
        const targetId = handler.slice(5).trim();
        engine.goto(sessionId, targetId);
        return;
      }
      eventBus.emit("pipeline.send", { sessionId, message: handler });
      return;
    }
    if (typeof handler === "object" && handler !== null) {
      if (handler.send) {
        eventBus.emit("pipeline.send", { sessionId, message: handler.send });
      }
      if (handler.retries !== undefined) {
        if (stepState.iterations >= handler.retries && handler.goto) {
          engine.goto(sessionId, handler.goto);
        }
      }
    }
  }

  const engine: PipelineEngine = {
    initialize(sessionId: SessionId, config: PipelineConfig): void {
      const timestamp = now();
      const steps: PipelineStepState[] = config.steps.map((s) => ({
        id: s.id,
        state: "pending" as StepState,
        iterations: 0,
      }));

      const session: PipelineSessionState = {
        state: "running",
        currentStepIndex: 0,
        steps,
        totalIterations: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      states.set(sessionId, { config, session });

      const context = buildContext(sessionId, {});
      let startIdx = 0;
      while (startIdx < config.steps.length) {
        const stepCfg = config.steps[startIdx];
        if (stepCfg && evaluateWhen(stepCfg.when, context)) break;
        steps[startIdx].state = "skipped";
        startIdx++;
      }

      if (startIdx >= config.steps.length) {
        session.state = "completed";
        session.currentStepIndex = steps.length - 1;
        persist(sessionId);
        eventBus.emit("pipeline.completed", { sessionId });
        return;
      }

      session.currentStepIndex = startIdx;
      const firstStep = steps[startIdx];
      if (firstStep) {
        markRunning(firstStep);
      }
      persist(sessionId);
      eventBus.emit("pipeline.step.started", {
        sessionId,
        stepId: config.steps[startIdx]?.id,
      });
    },

    load(sessionId: SessionId, config?: PipelineConfig): PipelineSessionState | null {
      const filePath = pipelinePath(sessionsDir, sessionId);
      const data = readJson(filePath);
      if (!data || typeof data !== "object") return null;
      const record = data as Record<string, unknown>;
      if (
        typeof record.state !== "string" ||
        !Array.isArray(record.steps) ||
        typeof record.currentStepIndex !== "number"
      ) {
        return null;
      }
      const session = data as PipelineSessionState;
      const existing = states.get(sessionId);
      if (existing) {
        existing.session = session;
        if (config) existing.config = config;
      } else {
        const resolvedConfig = config ?? { steps: session.steps.map((s) => ({ id: s.id })) };
        states.set(sessionId, { config: resolvedConfig, session });
      }
      return session;
    },

    getState(sessionId: SessionId): PipelineSessionState | null {
      return states.get(sessionId)?.session ?? null;
    },

    done(sessionId: SessionId, output?: Record<string, unknown>): void {
      const internal = states.get(sessionId);
      if (!internal || internal.session.state !== "running") return;
      const step = currentStep(internal);
      if (!step) return;

      step.state = "completed";
      step.completedAt = now();
      if (output) step.output = output;

      const context = buildContext(sessionId, {});
      advanceToNext(sessionId, internal, context);
    },

    fail(sessionId: SessionId, reason: string): void {
      const internal = states.get(sessionId);
      if (!internal || internal.session.state !== "running") return;
      const step = currentStep(internal);
      if (!step) return;

      const stepCfg = currentStepConfig(internal);
      const recovery = stepCfg?.recovery ?? internal.config.recovery ?? "fail";

      if (recovery === "skip") {
        step.state = "skipped";
        step.failReason = reason;
        const context = buildContext(sessionId, {});
        advanceToNext(sessionId, internal, context);
        return;
      }

      if (recovery === "pause") {
        step.state = "failed";
        step.failReason = reason;
        internal.session.state = "paused";
        persist(sessionId);
        return;
      }

      step.state = "failed";
      step.failReason = reason;
      internal.session.state = "failed";
      persist(sessionId);
    },

    goto(sessionId: SessionId, stepId: string): void {
      const internal = states.get(sessionId);
      if (!internal) return;

      const targetIdx = internal.config.steps.findIndex((s) => s.id === stepId);
      if (targetIdx < 0) return;

      const curIdx = internal.session.currentStepIndex;
      const start = Math.min(curIdx, targetIdx);
      const end = Math.max(curIdx, targetIdx);
      for (let i = start; i <= end; i++) {
        if (i !== targetIdx) {
          internal.session.steps[i].state = "rewound";
        }
      }

      const targetStep = internal.session.steps[targetIdx];
      if (!targetStep) return;

      const maxIter =
        internal.config.steps[targetIdx]?.maxIterations ?? internal.config.maxIterations;
      if (maxIter && targetStep.iterations >= maxIter) {
        targetStep.state = "failed";
        targetStep.failReason = "max iterations exceeded";
        internal.session.state = "failed";
        persist(sessionId);
        return;
      }

      internal.session.currentStepIndex = targetIdx;
      internal.session.state = "running";
      markRunning(targetStep);
      persist(sessionId);
      eventBus.emit("pipeline.step.started", { sessionId, stepId });
    },

    respond(sessionId: SessionId, response: string): void {
      const internal = states.get(sessionId);
      if (!internal || internal.session.state !== "running") return;
      const step = currentStep(internal);
      const stepCfg = currentStepConfig(internal);
      if (!step || !stepCfg?.channel) return;

      step.state = "completed";
      step.completedAt = now();
      step.output = { response };

      const context = buildContext(sessionId, {});
      advanceToNext(sessionId, internal, context);
    },

    tick(sessionId: SessionId, events: Record<string, unknown>): void {
      const internal = states.get(sessionId);
      if (!internal || internal.session.state !== "running") return;
      const step = currentStep(internal);
      const stepCfg = currentStepConfig(internal);
      if (!step || !stepCfg || step.state !== "running") return;

      internal.session.totalIterations++;
      let changed = false;

      const stepTimeout = stepCfg.timeout ?? "1h";
      if (step.startedAt) {
        const elapsed = Date.now() - new Date(step.startedAt).getTime();
        if (elapsed >= parseDuration(stepTimeout)) {
          engine.fail(sessionId, "timeout");
          return;
        }
      }

      if (stepCfg.on) {
        for (const [key, handler] of Object.entries(stepCfg.on)) {
          if (events[key]) {
            handleOnAction(sessionId, handler, internal, step, stepCfg);
            return;
          }
        }
      }

      if (stepCfg.all) {
        const currentlySatisfied: string[] = [];
        for (const eventName of stepCfg.all) {
          if (events[eventName]) {
            currentlySatisfied.push(eventName);
          }
        }
        const prevLen = step.satisfiedConditions?.length ?? 0;
        step.satisfiedConditions = currentlySatisfied;
        if (currentlySatisfied.length !== prevLen) {
          changed = true;
        }
        if (currentlySatisfied.length === stepCfg.all.length) {
          engine.done(sessionId);
          return;
        }
      }

      if (changed) {
        persist(sessionId);
      }
    },
  };

  return engine;
}
