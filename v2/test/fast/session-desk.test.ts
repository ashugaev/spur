import { describe, expect, it } from "vitest";
import { deskAnchorId, sidecarOwnerId } from "../../src/session-desk.js";

describe("deskAnchorId", () => {
  it("returns the session's own id when it has no deskId", () => {
    expect(deskAnchorId({ id: "api-1" })).toBe("api-1");
  });

  it("returns the deskId when the session is a desk sibling", () => {
    expect(deskAnchorId({ id: "api-2", deskId: "api-1" })).toBe("api-1");
  });

  it("returns its own id for the anchor session itself (deskId === id)", () => {
    expect(deskAnchorId({ id: "api-1", deskId: "api-1" })).toBe("api-1");
  });
});

describe("sidecarOwnerId", () => {
  it("owns an mcp sidecar on the session itself, even inside a desk", () => {
    expect(
      sidecarOwnerId(
        { id: "api-2", deskId: "api-1" },
        { mcp: { server: "playwright", portId: "http", path: "/mcp" } },
      ),
    ).toBe("api-2");
  });

  it("owns a non-mcp sidecar on the desk anchor", () => {
    expect(sidecarOwnerId({ id: "api-2", deskId: "api-1" }, {})).toBe("api-1");
  });

  it("owns a non-mcp sidecar on itself when there is no desk", () => {
    expect(sidecarOwnerId({ id: "api-1" }, {})).toBe("api-1");
  });
});
