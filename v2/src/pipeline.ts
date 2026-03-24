import type { SessionPipelineState } from "./types.js";

export const PIPELINE_STEP_TIMEOUT_MS = 60 * 60 * 1000;

export function createSessionPipeline(steps: string[]): SessionPipelineState | undefined {
  if (steps.length <= 1) {
    return undefined;
  }

  return {
    steps,
    nextStepIndex: 0,
    status: "running",
  };
}

export function formatPipelineStepMessage(
  step: string,
  stepIndex: number,
  totalSteps: number,
): string {
  const header = `[Spur pipeline step ${stepIndex + 1}/${totalSteps}]`;
  const footer =
    stepIndex + 1 < totalSteps
      ? "Do only this step. When it is done, stop and wait for the next Spur message."
      : "This is the final step.";
  return `${header}\n${footer}\n\n${step}`;
}
