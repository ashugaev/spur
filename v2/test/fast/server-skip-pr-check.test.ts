import { describe, expect, it } from "vitest";

import {
  parseCompleteSessionRequest,
  parseKillSessionRequest,
  resolveTodoMutationActor,
} from "../../src/server.js";

describe("server request parsers thread skipPrCheck", () => {
  it("keeps skipPrCheck on the complete request", () => {
    expect(parseCompleteSessionRequest({ skipPrCheck: true })).toEqual({ skipPrCheck: true });
  });

  it("omits skipPrCheck from the complete request by default", () => {
    expect(parseCompleteSessionRequest({})).toEqual({});
    expect(parseCompleteSessionRequest({ skipPrCheck: false })).toEqual({});
  });

  it("keeps skipPrCheck on the kill request alongside force", () => {
    expect(parseKillSessionRequest({ force: true, skipPrCheck: true })).toEqual({
      force: true,
      skipPrCheck: true,
    });
  });

  it("omits skipPrCheck from the kill request by default", () => {
    expect(parseKillSessionRequest({ force: true })).toEqual({ force: true });
  });

  it("derives agent provenance only from matching CLI caller metadata", async () => {
    const lookup = async () => ({ id: "api-1", agent: "codex" as const });
    await expect(
      resolveTodoMutationActor({
        origin: "cli",
        callerHeader: "api-1",
        targetSessionId: "api-1",
        lookup,
      }),
    ).resolves.toEqual({ kind: "agent", agent: "codex", sessionId: "api-1" });
    await expect(
      resolveTodoMutationActor({
        origin: "unknown",
        callerHeader: "api-1",
        targetSessionId: "api-1",
        lookup,
      }),
    ).rejects.toThrow("requires CLI origin");
    await expect(
      resolveTodoMutationActor({
        origin: "cli",
        callerHeader: "api-2",
        targetSessionId: "api-1",
        lookup,
      }),
    ).rejects.toThrow("does not match");
  });

  it("keeps validated caller-free requests human and rejects unknown origin", async () => {
    const lookup = async () => ({ id: "api-1", agent: "codex" as const });
    await expect(
      resolveTodoMutationActor({
        origin: "ui",
        callerHeader: undefined,
        targetSessionId: "api-1",
        lookup,
      }),
    ).resolves.toEqual({ kind: "human", origin: "ui" });
    await expect(
      resolveTodoMutationActor({
        origin: "unknown",
        callerHeader: undefined,
        targetSessionId: "api-1",
        lookup,
      }),
    ).rejects.toThrow("origin is invalid");
  });
});
