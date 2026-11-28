import { renderShepherdPrompt } from "../../src/shepherd.js";

export const LEGACY_SHEPHERD_INITIAL_ACTION =
  "Initial action:\n1. Run `spur list --json` to inspect current sessions.\n" +
  "2. Decide whether to answer, spawn, send, schedule a wake, or wait.";

export function legacyShepherdPrompt(task: string): string {
  const current = renderShepherdPrompt(task);
  const initialAction = current.indexOf("\n\nInitial action:\n");
  const operatorRequest = current.indexOf("\n\nOperator request:\n");
  if (initialAction < 0 || operatorRequest < initialAction) {
    throw new Error("Generated Shepherd fixture envelope changed");
  }
  return `${current.slice(0, initialAction)}\n\n${LEGACY_SHEPHERD_INITIAL_ACTION}${current.slice(operatorRequest)}`;
}
