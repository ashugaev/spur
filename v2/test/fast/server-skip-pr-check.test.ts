import { describe, expect, it } from "vitest";

import { parseCompleteSessionRequest, parseKillSessionRequest } from "../../src/server.js";

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
});
