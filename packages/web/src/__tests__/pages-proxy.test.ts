// @vitest-environment node
import { describe, expect, it } from "vitest";
import { resolvePageProxyTarget } from "@/lib/pages-proxy";

describe("page proxy mapping", () => {
  it("serves index.html for the page root and files by path", () => {
    expect(resolvePageProxyTarget("films", [], "GET")).toEqual({
      kind: "file",
      daemonPath: "/pages/films/files/index.html",
    });
    expect(resolvePageProxyTarget("films", ["css", "a b.css"], "GET")).toEqual({
      kind: "file",
      daemonPath: "/pages/films/files/css/a%20b.css",
    });
    expect(resolvePageProxyTarget("films", ["index.html"], "POST")).toBeNull();
  });

  it("maps _spur/db, actions and agent onto the page's own store only", () => {
    expect(resolvePageProxyTarget("films", ["_spur", "db", "docs", "items"], "GET")).toEqual({
      kind: "store",
      daemonPath: "/stores/page%3Afilms/docs/items",
      forcePageSource: false,
    });
    expect(resolvePageProxyTarget("films", ["_spur", "db", "changes"], "GET")).toMatchObject({
      daemonPath: "/stores/page%3Afilms/changes",
    });
    expect(resolvePageProxyTarget("films", ["_spur", "actions"], "POST")).toEqual({
      kind: "store",
      daemonPath: "/stores/page%3Afilms/actions",
      forcePageSource: true,
    });
    expect(resolvePageProxyTarget("films", ["_spur", "agent", "send"], "POST")).toMatchObject({
      daemonPath: "/stores/page%3Afilms/agent/send",
      forcePageSource: false,
    });
    expect(resolvePageProxyTarget("films", ["_spur", "agent", "messages"], "GET")).toMatchObject({
      daemonPath: "/stores/page%3Afilms/agent/messages",
    });
  });

  it("maps _spur/events to the page stream, GET only", () => {
    expect(resolvePageProxyTarget("films", ["_spur", "events"], "GET")).toEqual({
      kind: "events",
      daemonPath: "/pages/films/events",
    });
    expect(resolvePageProxyTarget("films", ["_spur", "events"], "POST")).toBeNull();
  });

  it("rejects unknown _spur paths, completion, bad ids and unsafe segments", () => {
    for (const segments of [
      ["_spur"],
      ["_spur", "other"],
      ["_spur", "events", "x"],
      ["_spur", "actions", "act-1", "complete"],
      ["_spur", "db", "actions"],
      ["_spur", "db", "agent", "send"],
      ["..", "secret"],
      ["a", ""],
    ]) {
      expect(resolvePageProxyTarget("films", segments, "POST"), segments.join("/")).toBeNull();
      expect(resolvePageProxyTarget("films", segments, "GET"), segments.join("/")).toBeNull();
    }
    expect(resolvePageProxyTarget("Films", [], "GET")).toBeNull();
    expect(resolvePageProxyTarget("films", ["_spur", "db", "docs", "items"], "PUT")).toBeNull();
  });
});
