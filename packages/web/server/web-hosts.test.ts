import { describe, expect, it } from "vitest";
import { parseWebHosts } from "./web-hosts.js";

describe("parseWebHosts", () => {
  it("falls back to the default host when unset", () => {
    expect(parseWebHosts(undefined, "127.0.0.1")).toEqual(["127.0.0.1"]);
  });

  it("falls back to the default host when empty", () => {
    expect(parseWebHosts("", "127.0.0.1")).toEqual(["127.0.0.1"]);
  });

  it("splits a comma-separated list of hosts", () => {
    expect(parseWebHosts("127.0.0.1,100.64.0.1", "127.0.0.1")).toEqual(["127.0.0.1", "100.64.0.1"]);
  });

  it("collapses to the wildcard bind when 0.0.0.0 is present", () => {
    expect(parseWebHosts("0.0.0.0", "127.0.0.1")).toEqual(["0.0.0.0"]);
  });

  it("collapses to the wildcard bind even mixed with specific hosts", () => {
    expect(parseWebHosts("127.0.0.1,0.0.0.0", "127.0.0.1")).toEqual(["0.0.0.0"]);
  });

  it("trims whitespace and dedupes while preserving order", () => {
    expect(parseWebHosts(" 127.0.0.1 , 100.64.0.1 , 127.0.0.1 ", "127.0.0.1")).toEqual([
      "127.0.0.1",
      "100.64.0.1",
    ]);
  });

  it("drops empty entries from stray commas", () => {
    expect(parseWebHosts("127.0.0.1,,100.64.0.1,", "127.0.0.1")).toEqual([
      "127.0.0.1",
      "100.64.0.1",
    ]);
  });
});
