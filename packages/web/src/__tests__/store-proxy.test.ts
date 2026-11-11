// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SNIPPET_TEXT_RE } from "@/lib/snippets/snippet-protocol";
import {
  COLLECTION_RE,
  DOC_ID_RE,
  PAGE_ID_RE,
  STORE_ID_RE,
  resolveStoreProxyTarget,
} from "@/lib/store-proxy";

const daemonSource = (name: string) =>
  readFileSync(resolve(__dirname, "../../../../v2/src", name), "utf8");

describe("store proxy mapping", () => {
  it("maps every allowed store route and method", () => {
    const cases: Array<[string, string[], string, string]> = [
      ["page:films", ["docs", "items"], "GET", "/stores/page%3Afilms/docs/items"],
      ["page:films", ["docs", "items"], "POST", "/stores/page%3Afilms/docs/items"],
      ["page:films", ["docs", "items", "d1"], "GET", "/stores/page%3Afilms/docs/items/d1"],
      ["page:films", ["docs", "items", "d1"], "POST", "/stores/page%3Afilms/docs/items/d1"],
      ["page:films", ["docs", "items", "d1"], "PATCH", "/stores/page%3Afilms/docs/items/d1"],
      ["page:films", ["docs", "items", "d1"], "DELETE", "/stores/page%3Afilms/docs/items/d1"],
      ["page:films", ["query", "items"], "POST", "/stores/page%3Afilms/query/items"],
      ["session:sp-1", ["changes"], "GET", "/stores/session%3Asp-1/changes"],
      ["session:sp-1", ["actions"], "POST", "/stores/session%3Asp-1/actions"],
      ["session:sp-1", ["agent", "send"], "POST", "/stores/session%3Asp-1/agent/send"],
      ["session:sp-1", ["agent", "messages"], "GET", "/stores/session%3Asp-1/agent/messages"],
      ["session:sp-1", ["agent", "status"], "GET", "/stores/session%3Asp-1/agent/status"],
    ];
    for (const [store, segments, method, expected] of cases) {
      expect(
        resolveStoreProxyTarget(store, segments, method),
        `${method} ${segments.join("/")}`,
      ).toBe(expected);
    }
  });

  it("never exposes action completion", () => {
    for (const method of ["GET", "POST", "PATCH", "DELETE"]) {
      expect(
        resolveStoreProxyTarget("session:sp-1", ["actions", "act-1", "complete"], method),
      ).toBeNull();
      expect(resolveStoreProxyTarget("session:sp-1", ["actions", "act-1"], method)).toBeNull();
    }
  });

  it("rejects bad stores, unsafe segments, invalid ids and wrong methods", () => {
    const rejected: Array<[string, string[], string]> = [
      ["films", ["docs", "items"], "GET"],
      ["page:Films", ["docs", "items"], "GET"],
      ["page:films/../x", ["docs", "items"], "GET"],
      ["page:films", ["docs", ""], "GET"],
      ["page:films", ["docs", "."], "GET"],
      ["page:films", ["docs", ".."], "GET"],
      ["page:films", ["docs", "a/b"], "GET"],
      ["page:films", ["docs", "a\\b"], "GET"],
      ["page:films", ["docs", "bad name"], "GET"],
      ["page:films", ["docs", "items", "bad.id"], "GET"],
      ["page:films", ["docs", "items", "d1", "x"], "GET"],
      ["page:films", ["docs", "items"], "PATCH"],
      ["page:films", ["query", "items"], "GET"],
      ["page:films", ["changes"], "POST"],
      ["page:films", ["actions"], "GET"],
      ["page:films", ["agent", "send"], "GET"],
      ["page:films", ["agent", "kill"], "POST"],
      ["page:films", ["meta"], "GET"],
      ["page:films", [], "GET"],
    ];
    for (const [store, segments, method] of rejected) {
      expect(
        resolveStoreProxyTarget(store, segments, method),
        `${store} ${segments.join("/")}`,
      ).toBeNull();
    }
  });
});

describe("pinned daemon patterns", () => {
  it("keeps the web id patterns equal to the daemon's", () => {
    const stores = daemonSource("stores.ts");
    for (const pattern of [STORE_ID_RE, PAGE_ID_RE, COLLECTION_RE, DOC_ID_RE]) {
      expect(stores).toContain(`/${pattern.source}/`);
    }
  });

  it("keeps the daemon action label charset equal to SNIPPET_TEXT_RE", () => {
    expect(daemonSource("store-actions.ts")).toContain(`/${SNIPPET_TEXT_RE.source}/u`);
  });
});
