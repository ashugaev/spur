import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  actionStatusFromDoc,
  isAllowedSnippetStore,
  parseChatLayout,
  SNIPPET_CONFIRM_REASON_TEXT,
  SNIPPET_MAX_PAYLOAD_BYTES,
  SNIPPET_PROTOCOL_VERSION,
  SNIPPET_RESERVED_RE,
  SNIPPET_TEXT_RE,
  SNIPPET_THEME_TOKENS,
  snippetByteLength,
  snippetStateDocId,
  snippetStatusLabel,
  type SnippetActionStatus,
} from "@/lib/snippets/snippet-protocol";

describe("private chat placements", () => {
  const targets = new Set(["one", "two"]);
  const snapshot = () => ({
    sequence: 0,
    viewport: { width: 400, height: 300 },
    slots: [{ target: "one", rect: { x: 300, y: 100, width: 32, height: 108 } }],
  });
  it("accepts registered bounded geometry and marks out-of-bounds slots unavailable", () => {
    expect(parseChatLayout(snapshot(), targets, -1, 123)?.receivedAt).toBe(123);
    const data = snapshot();
    data.slots[0]!.rect.x = -1;
    expect(parseChatLayout(data, targets, -1, 123)?.slots[0]?.rect).toBeNull();
  });
  it("rejects stale, duplicate, unknown, nonfinite and oversized layouts", () => {
    const data = snapshot();
    expect(parseChatLayout(data, targets, 0, 0)).toBeNull();
    for (const bad of [
      { ...data, sequence: -1 },
      { ...data, sequence: 0.5 },
      { ...data, viewport: { width: Infinity, height: 300 } },
      { ...data, viewport: { width: 32769, height: 300 } },
      { ...data, slots: [...data.slots, ...data.slots] },
      { ...data, slots: [{ target: "unknown", rect: null }] },
      { ...data, slots: [{ target: "one", rect: { x: NaN, y: 0, width: 32, height: 108 } }] },
      { ...data, slots: Array.from({ length: 17 }, (_, i) => ({ target: String(i), rect: null })) },
    ])
      expect(parseChatLayout(bad, targets, -1, 0)).toBeNull();
  });
});
import {
  buildSnippetSrcdoc,
  SNIPPET_CSP,
  SNIPPET_FRAME_SANDBOX,
} from "@/lib/snippets/snippet-srcdoc";
import { DOC_ID_RE } from "@/lib/store-proxy";

describe("protocol version and removed prompt path", () => {
  it("speaks protocol 2 and carries no snippet prompt builder", async () => {
    expect(SNIPPET_PROTOCOL_VERSION).toBe(2);
    const exports = Object.keys(await import("@/lib/snippets/snippet-protocol"));
    for (const name of [
      "buildSnippetActionPrompt",
      "parseSnippetActionPrompt",
      "SNIPPET_PROMPT_OPEN",
      "SNIPPET_PROMPT_CLOSE",
      "deriveActionStatus",
      "classifySendOutcome",
    ]) {
      expect(exports).not.toContain(name);
    }
  });
});

describe("snippetByteLength and caps", () => {
  it("counts UTF-8 bytes of the JSON text", () => {
    expect(snippetByteLength("é")).toBe(4);
    expect(snippetByteLength("日本")).toBe(8);
    expect(snippetByteLength({ a: 1 })).toBe(7);
  });
  it("is infinite for unserializable values", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(snippetByteLength(cyclic)).toBe(Number.POSITIVE_INFINITY);
    expect(snippetByteLength(undefined)).toBe(Number.POSITIVE_INFINITY);
  });
  it("applies the 48 KiB payload cap in bytes, not UTF-16 units", () => {
    // 3 bytes per char: 16_400 chars fit as UTF-16 units but not within 48 KiB.
    const multibyte = { t: "日".repeat(16_400) };
    expect(JSON.stringify(multibyte).length).toBeLessThan(SNIPPET_MAX_PAYLOAD_BYTES);
    expect(snippetByteLength(multibyte)).toBeGreaterThan(SNIPPET_MAX_PAYLOAD_BYTES);
    const fits = { t: "日".repeat(16_300) };
    expect(snippetByteLength(fits)).toBeLessThanOrEqual(SNIPPET_MAX_PAYLOAD_BYTES);
  });
});

describe("SNIPPET_TEXT_RE and SNIPPET_RESERVED_RE", () => {
  it("rejects separators and bidi marks, accepts plain text", () => {
    for (const bad of ["؜", " ", " ", "\n", '"', "[", "]", "\\", "‮"]) {
      expect(SNIPPET_TEXT_RE.test(`a${bad}b`)).toBe(false);
    }
    expect(SNIPPET_TEXT_RE.test("Choose · selected 日本")).toBe(true);
  });
  it("reserves only session-id-shaped prefixes", () => {
    expect(SNIPPET_RESERVED_RE.test("snippet.sp-ab12.picker.html")).toBe(true);
    expect(SNIPPET_RESERVED_RE.test("snippet.png")).toBe(false);
    expect(SNIPPET_RESERVED_RE.test("snippet.notes.md")).toBe(false);
    expect(SNIPPET_RESERVED_RE.test("snippet.py")).toBe(false);
  });
});

describe("stores", () => {
  it("allows page stores and the owner's session store only", () => {
    expect(isAllowedSnippetStore("page:films", "sp-ab12")).toBe(true);
    expect(isAllowedSnippetStore("session:sp-ab12", "sp-ab12")).toBe(true);
    expect(isAllowedSnippetStore("session:sp-other", "sp-ab12")).toBe(false);
    expect(isAllowedSnippetStore("page:Films", "sp-ab12")).toBe(false);
    expect(isAllowedSnippetStore("page:", "sp-ab12")).toBe(false);
  });
  it("hashes the owner into the state doc id: 85 chars at most, distinct per owner", async () => {
    const longId = `a${"b".repeat(62)}c`;
    const key = await snippetStateDocId("sp-ab12", longId);
    expect(key).toMatch(/^snippet-[0-9a-f]{12}-a/);
    expect(key).toHaveLength(85);
    expect(DOC_ID_RE.test(key)).toBe(true);
    const other = await snippetStateDocId("sp-cd34", longId);
    expect(other).not.toBe(key);
    expect(await snippetStateDocId("sp-ab12", longId)).toBe(key);
  });
});

describe("status table", () => {
  it("labels every status", () => {
    const labels: Array<[SnippetActionStatus, string]> = [
      ["awaiting_confirm", "Confirm to send"],
      ["submitting", "Sent"],
      ["queued", "Queued"],
      ["processing", "Agent working"],
      ["completed", "Done"],
      ["timeout", "No reply in 15 min"],
    ];
    for (const [status, label] of labels) expect(snippetStatusLabel({ status })).toBe(label);
    expect(snippetStatusLabel({ status: "error", httpStatus: 409 })).toBe("Send failed · HTTP 409");
    expect(snippetStatusLabel({ status: "error" })).toBe("Failed");
  });
  it("carries the confirm reason texts", () => {
    expect(SNIPPET_CONFIRM_REASON_TEXT).toEqual({
      declared: "This action always asks before sending.",
      no_focus: "Snippet started this without a click inside it.",
      repeat_in_revision: "Second action on this revision. Confirm it is yours.",
      budget: "10 sends without a confirm. Confirm this one.",
      storage_unavailable: "Browser storage unavailable. Each send needs a confirm.",
    });
  });
  it("maps _actions doc status to the panel status", () => {
    expect(actionStatusFromDoc({ status: "pending" }, false)).toBe("queued");
    expect(actionStatusFromDoc({ status: "pending" }, true)).toBe("processing");
    expect(actionStatusFromDoc({ status: "done" }, true)).toBe("completed");
    expect(actionStatusFromDoc({ status: "failed", error: "boom" }, false)).toBe("error");
    expect(actionStatusFromDoc({ status: "failed", error: "timeout" }, false)).toBe("timeout");
  });
});

describe("snippet-srcdoc", () => {
  it("allows scripts only in the sandbox", () => {
    expect(SNIPPET_FRAME_SANDBOX).toBe("allow-scripts");
    for (const flag of [
      "allow-same-origin",
      "allow-forms",
      "allow-popups",
      "allow-modals",
      "top-navigation",
    ]) {
      expect(SNIPPET_FRAME_SANDBOX).not.toContain(flag);
    }
  });
  it("places the CSP meta before boot script, SDK and agent markup", () => {
    const html = buildSnippetSrcdoc(
      "<p id=agent>hi</p><script>agent()</script>",
      "sdk();",
      "abc123",
      "dark",
    );
    const csp = html.indexOf("Content-Security-Policy");
    expect(csp).toBeGreaterThan(-1);
    expect(csp).toBeLessThan(html.indexOf("__SPUR_SNIPPET_BOOT__"));
    expect(csp).toBeLessThan(html.indexOf("sdk();"));
    expect(csp).toBeLessThan(html.indexOf("<p id=agent>"));
    expect(html).toContain(SNIPPET_CSP);
    expect(html).toContain('nonce:"abc123"');
    expect(html.endsWith("<script>agent()</script>")).toBe(true);
  });
  it("emits the host's color-scheme before the SDK, never both schemes", () => {
    for (const mode of ["dark", "light"] as const) {
      const html = buildSnippetSrcdoc("<p>x</p>", "sdk();", "n", mode);
      const meta = html.indexOf(`<meta name="color-scheme" content="${mode}">`);
      expect(meta).toBeGreaterThan(html.indexOf("Content-Security-Policy"));
      expect(meta).toBeLessThan(html.indexOf("sdk();"));
      expect(html).not.toContain("light dark");
    }
  });
  it("keeps the SDK from closing its own script element", () => {
    const html = buildSnippetSrcdoc("", 'var s="</script><b>";', "n", "dark");
    expect(html.match(/<\/script>/g)).toHaveLength(2);
  });
});

describe("theme token parity", () => {
  const css = readFileSync(resolve(__dirname, "../app/globals.css"), "utf8");
  const darkStart = css.indexOf("@theme");
  const lightStart = css.indexOf(':root[data-theme="light"]');
  const dark = css.slice(darkStart, lightStart);
  const light = css.slice(lightStart);
  it.each([...SNIPPET_THEME_TOKENS])("defines --color-%s in both theme blocks", (token) => {
    expect(dark).toContain(`--color-${token}:`);
    expect(light).toContain(`--color-${token}:`);
  });
});
