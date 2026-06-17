import { describe, expect, it } from "vitest";
import { formatPipelineStepMessage } from "../../src/pipeline.js";

describe("formatPipelineStepMessage", () => {
  it("emits the [Spur step k/n: <label>] header", () => {
    const message = formatPipelineStepMessage("prompt", "design", 0, 3);
    expect(message.startsWith("[Spur step 1/3: design]\n")).toBe(true);
  });

  it("uses the non-final footer text on steps before the last", () => {
    const message = formatPipelineStepMessage("prompt", "design", 0, 3);
    expect(message).toContain(
      "Do only this step for the task below. When it is done, stop and wait for the next Spur message.",
    );
  });

  it("uses the final-step footer on the last step", () => {
    const message = formatPipelineStepMessage("prompt", "ship", 2, 3);
    expect(message).toContain("This is the final step for the task below.");
  });
});
