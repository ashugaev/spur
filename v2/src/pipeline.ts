import type { SessionPipelineState } from "./types.js";

export const PIPELINE_STEP_TIMEOUT_MS = 60 * 60 * 1000;

export function createSessionPipeline(steps?: string[]): SessionPipelineState | undefined {
  if (!steps || steps.length === 0) {
    return undefined;
  }

  return {
    steps,
    nextStepIndex: 0,
    status: "running",
  };
}

export function formatPipelineStepMessage(
  prompt: string,
  step: string,
  stepIndex: number,
  totalSteps: number,
): string {
  const header = `[Spur step ${stepIndex + 1}/${totalSteps}: ${step}]`;
  const footer =
    stepIndex + 1 < totalSteps
      ? "Do only this step for the task below. When it is done, stop and wait for the next Spur message."
      : "This is the final step for the task below.";
  return `${header}\n${footer}\n\nTask:\n${prompt}`;
}
