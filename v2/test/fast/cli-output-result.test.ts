import { afterEach, describe, expect, it } from "vitest";
import { outputResult } from "../../src/cli.js";

// `outputResult`'s `exitCode` callback is the only wiring between a command's
// returned value and `process.exitCode` — `doctor` is the sole caller today
// (via `hasErrorSeverity`), but the wiring itself had no direct test.
describe("outputResult exit-code wiring", () => {
  const originalExitCode = process.exitCode;

  afterEach(() => {
    process.exitCode = originalExitCode;
  });

  it("sets process.exitCode when the exitCode callback returns a number", async () => {
    process.exitCode = undefined;
    await outputResult({
      json: true,
      label: "test",
      action: async () => ({ ok: false }),
      render: () => "",
      exitCode: (value) => (value.ok ? undefined : 1),
    });
    expect(process.exitCode).toBe(1);
  });

  it("leaves process.exitCode untouched when the exitCode callback returns undefined", async () => {
    process.exitCode = undefined;
    await outputResult({
      json: true,
      label: "test",
      action: async () => ({ ok: true }),
      render: () => "",
      exitCode: (value) => (value.ok ? undefined : 1),
    });
    expect(process.exitCode).toBeUndefined();
  });

  it("never touches process.exitCode when no exitCode callback is provided", async () => {
    process.exitCode = undefined;
    await outputResult({
      json: true,
      label: "test",
      action: async () => ({ ok: true }),
      render: () => "",
    });
    expect(process.exitCode).toBeUndefined();
  });
});
