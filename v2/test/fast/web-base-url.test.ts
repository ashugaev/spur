import { describe, expect, it } from "vitest";
import { resolveWebBaseUrl } from "../../src/ports.js";

describe("resolveWebBaseUrl", () => {
  it("falls back to http://127.0.0.1:<uiPort> when SPUR_WEB_URL is unset", () => {
    expect(resolveWebBaseUrl(5555, {})).toBe("http://127.0.0.1:5555");
  });

  it("returns null when SPUR_WEB_URL is set and empty", () => {
    expect(resolveWebBaseUrl(5555, { SPUR_WEB_URL: "" })).toBeNull();
  });

  it("returns the override, trailing slash stripped, when SPUR_WEB_URL is set and non-empty", () => {
    expect(resolveWebBaseUrl(5555, { SPUR_WEB_URL: "https://example.com/" })).toBe(
      "https://example.com",
    );
  });
});
