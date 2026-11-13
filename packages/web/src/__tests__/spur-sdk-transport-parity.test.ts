// @vitest-environment node
import { describe, expect, it } from "vitest";
import { flush, pageRig, portRig, type Win } from "./fixtures/spur-sdk-rig";

// Both boots expose the same window.spur and the same components, and resolve the
// same scripted calls to the same shapes.

function shape(value: unknown, depth = 0): unknown {
  if (typeof value === "function") return "function";
  if (value === null || typeof value !== "object" || depth > 3) return typeof value;
  return Object.fromEntries(
    Object.keys(value as object)
      .sort()
      .map((key) => [key, shape((value as Record<string, unknown>)[key], depth + 1)]),
  );
}

const TAGS = [
  "spur-text-input",
  "spur-textarea",
  "spur-choice",
  "spur-choice-list",
  "spur-selectable-text",
  "spur-selection-toolbar",
  "spur-button",
  "spur-form",
  "spur-status",
  "spur-chat",
  "spur-loader",
  "spur-empty",
  "spur-error",
];

function registry(win: Win): boolean[] {
  return TAGS.map((tag) => win.customElements.get(tag) !== undefined);
}

describe("transport parity", () => {
  it("exposes identical window.spur trees and component registries", async () => {
    const port = await portRig("");
    const page = await pageRig("");
    expect(shape(page.win.spur)).toEqual(shape(port.win.spur));
    expect(shape(page.win.spur.db.collection("x"))).toEqual(
      shape(port.win.spur.db.collection("x")),
    );
    expect(registry(page.win)).toEqual(TAGS.map(() => true));
    expect(registry(port.win)).toEqual(registry(page.win));
    expect(page.win.spur.protocolVersion).toBe(port.win.spur.protocolVersion);
  });

  it("resolves invoke outcomes to the same shapes on both transports", async () => {
    const outcomes = [
      { doc: { status: "done", result: { n: 1 } }, expected: { ok: true, result: { n: 1 } } },
      {
        doc: { status: "failed", error: "no" },
        expected: { ok: false, reason: "failed", error: "no" },
      },
      { doc: { status: "failed", error: "timeout" }, expected: { ok: false, reason: "timeout" } },
    ];
    for (const { doc, expected } of outcomes) {
      const page = await pageRig("");
      page.respond((method, url, body) => {
        if (method === "POST" && url === "/p/films/_spur/actions") {
          return [200, { id: (body as { id: string }).id, rev: 1, data: { status: "pending" } }];
        }
        if (method === "GET" && url.startsWith("/p/films/_spur/db/docs/_actions/")) {
          return [200, { id: url.split("/").at(-1), rev: 2, data: doc }];
        }
        return undefined;
      });
      const pagePending = page.win.spur.agent.invoke("pick", {});
      await flush();
      const id = (
        page.requests.find((r) => r.url === "/p/films/_spur/actions")?.body as { id: string }
      ).id;
      page.sources[0]?.emit("change", { seq: 1, collection: "_actions", id, op: "set" }, "1");
      const pageResult = await pagePending;

      const port = await portRig("");
      const portPending = port.win.spur.agent.invoke("pick", {});
      port.reply("invoke-result", { id: "act-1", ...expected });
      const portResult = await portPending;

      expect(pageResult).toEqual({ ...expected, id });
      expect(portResult).toEqual({ ...expected, id: "act-1" });
      expect(Object.keys(pageResult).sort()).toEqual(Object.keys(portResult).sort());
    }
  });

  it("returns the same pre-delivery rejection before connect", async () => {
    const port = await portRig("", { booted: false });
    await expect(port.win.spur.agent.invoke("pick", {})).resolves.toEqual({
      ok: false,
      reason: "not_connected",
    });
  });
});
