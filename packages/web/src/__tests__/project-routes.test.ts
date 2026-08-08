import { describe, expect, it } from "vitest";
import {
  buildDashboardPath,
  buildSessionPath,
  decodeRouteParam,
  getTerminalQuerySessionId,
  withTerminalQuery,
} from "@/lib/project-routes";

describe("buildDashboardPath", () => {
  it("returns '/' when projectId is null", () => {
    expect(buildDashboardPath(null)).toBe("/");
  });

  it("returns '/' when projectId is undefined", () => {
    expect(buildDashboardPath()).toBe("/");
  });

  it("encodes the projectId in the query", () => {
    expect(buildDashboardPath("a/b")).toBe("/?project=a%2Fb");
  });
});

describe("buildSessionPath", () => {
  it("returns the bare session path when no project is provided", () => {
    expect(buildSessionPath("sess-1")).toBe("/sessions/sess-1");
  });

  it("appends the encoded project query when present", () => {
    expect(buildSessionPath("sess-1", "p 1")).toBe("/sessions/sess-1?project=p%201");
  });
});

describe("withTerminalQuery", () => {
  it("sets the terminal query parameter", () => {
    expect(withTerminalQuery("", "sess-1")).toBe("?terminal=sess-1");
  });

  it("clears the terminal query parameter when null", () => {
    expect(withTerminalQuery("?terminal=sess-1", null)).toBe("");
  });
});

describe("getTerminalQuerySessionId", () => {
  it("returns null when the param is missing", () => {
    expect(getTerminalQuerySessionId(new URLSearchParams(""))).toBeNull();
  });

  it("returns the trimmed param when present", () => {
    expect(getTerminalQuerySessionId(new URLSearchParams("terminal=sess-1"))).toBe("sess-1");
  });
});

describe("decodeRouteParam", () => {
  it("decodes percent-encoded characters", () => {
    expect(decodeRouteParam("a%2Fb")).toBe("a/b");
  });

  it("returns the original value on malformed input", () => {
    expect(decodeRouteParam("%E0%A4%A")).toBe("%E0%A4%A");
  });
});
