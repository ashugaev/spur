import { describe, expect, it } from "vitest";
import { sidecarOwnerId, workspaceIdOf } from "../../src/session-desk.js";

describe("workspaceIdOf", () => {
  it("returns the session's own id when it owns its workspace", () => {
    expect(workspaceIdOf({ id: "api-1", workspaceId: "api-1" })).toBe("api-1");
  });

  it("returns the workspace id when the session joined someone else's", () => {
    expect(workspaceIdOf({ id: "api-2", workspaceId: "api-1" })).toBe("api-1");
  });

  it("falls back to the legacy deskId for a record written before the field existed", () => {
    expect(workspaceIdOf({ id: "api-2", deskId: "api-1" })).toBe("api-1");
  });

  it("falls back to the session's own id for a legacy record carrying neither field", () => {
    expect(workspaceIdOf({ id: "api-1" })).toBe("api-1");
  });

  it("prefers workspaceId over a stale legacy deskId", () => {
    expect(workspaceIdOf({ id: "api-2", workspaceId: "api-9", deskId: "api-1" })).toBe("api-9");
  });
});

describe("sidecarOwnerId", () => {
  it("owns an mcp sidecar on the session itself, even inside a shared workspace", () => {
    expect(
      sidecarOwnerId(
        { id: "api-2", workspaceId: "api-1" },
        { mcp: { server: "playwright", portId: "http", path: "/mcp" } },
      ),
    ).toBe("api-2");
  });

  it("owns a non-mcp sidecar on the workspace", () => {
    expect(sidecarOwnerId({ id: "api-2", workspaceId: "api-1" }, {})).toBe("api-1");
  });

  it("owns a non-mcp sidecar on itself when the workspace is its own", () => {
    expect(sidecarOwnerId({ id: "api-1", workspaceId: "api-1" }, {})).toBe("api-1");
  });

  it("resolves a non-mcp sidecar through the legacy deskId", () => {
    expect(sidecarOwnerId({ id: "api-2", deskId: "api-1" }, {})).toBe("api-1");
  });
});
