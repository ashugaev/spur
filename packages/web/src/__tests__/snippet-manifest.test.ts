import { describe, expect, it } from "vitest";
import { parseSnippetManifest, partitionSnippetArtifacts } from "@/lib/snippets/snippet-manifest";
import type { SpurSessionArtifact } from "@/lib/types";

const SID = "sp-ab12";

function artifact(
  name: string,
  updatedAt = "2026-01-01T00:00:00.000Z",
  id = name,
): SpurSessionArtifact {
  return {
    id,
    name,
    size: 10,
    mimeType: "text/html",
    kind: "html",
    origin: "agent",
    createdAt: updatedAt,
    updatedAt,
  } as SpurSessionArtifact;
}

describe("partitionSnippetArtifacts", () => {
  it("splits owned, foreign, tmp and generic", () => {
    const { generic, owned } = partitionSnippetArtifacts(
      [
        artifact(`snippet.${SID}.picker.html`),
        artifact("snippet.sp-cd34.other.html"),
        artifact(`snippet.${SID}.picker.html.tmp`),
        artifact("report.html"),
        artifact("snippet.png"),
        artifact("snippet.notes.md"),
        artifact(`snippet.${SID}.Bad_Slug.html`),
        artifact(
          `snippet.${SID}.nested.html`,
          "2026-01-01T00:00:00.000Z",
          `dir/snippet.${SID}.nested.html`,
        ),
      ],
      SID,
    );
    expect(owned.map((o) => o.snippetId)).toEqual(["picker"]);
    expect(generic.map((a) => a.name)).toEqual([
      "report.html",
      "snippet.png",
      "snippet.notes.md",
      `snippet.${SID}.nested.html`,
    ]);
  });

  it("orders owned newest first then by id", () => {
    const { owned } = partitionSnippetArtifacts(
      [
        artifact(`snippet.${SID}.b.html`, "2026-01-01T00:00:00.000Z"),
        artifact(`snippet.${SID}.a.html`, "2026-01-01T00:00:00.000Z"),
        artifact(`snippet.${SID}.c.html`, "2026-02-01T00:00:00.000Z"),
      ],
      SID,
    );
    expect(owned.map((o) => o.snippetId)).toEqual(["c", "a", "b"]);
  });
});

const actionSchema = { type: "object", properties: { note: { type: "string", maxLength: 10 } } };
function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocolVersion: 1,
    snippetId: "picker",
    ownerSessionId: SID,
    instanceId: "inst-00000001",
    revision: 1,
    title: "Picker",
    actions: [{ id: "go", label: "Go", payload: actionSchema }],
    ...overrides,
  };
}
function html(m: unknown): string {
  return `<!doctype html><body><script type="application/spur-snippet+json">${JSON.stringify(m)}</script><p>x</p>`;
}
function parse(m: unknown) {
  return parseSnippetManifest(html(m), { sessionId: SID, snippetId: "picker" });
}

describe("parseSnippetManifest", () => {
  it("accepts a valid manifest", () => {
    const result = parse(manifest({ respondsToRequestId: "req-00000001" }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.manifest.actions[0]?.id).toBe("go");
  });

  it("requires the manifest script and valid JSON", () => {
    expect(parseSnippetManifest("<p>none</p>", { sessionId: SID, snippetId: "picker" }).ok).toBe(
      false,
    );
    expect(
      parseSnippetManifest('<script type="application/spur-snippet+json">{</script>', {
        sessionId: SID,
        snippetId: "picker",
      }).ok,
    ).toBe(false);
  });

  it("rejects unknown keys at every level", () => {
    expect(parse(manifest({ extra: 1 }))).toMatchObject({ ok: false, error: { path: "/extra" } });
    expect(
      parse(manifest({ actions: [{ id: "go", label: "Go", payload: actionSchema, extra: 1 }] })),
    ).toMatchObject({ ok: false, error: { path: "/actions/0/extra" } });
    expect(
      parse(
        manifest({
          actions: [{ id: "go", label: "Go", payload: { ...actionSchema, extra: 1 } }],
        }),
      ),
    ).toMatchObject({ ok: false, error: { path: "/actions/0/payload/extra" } });
  });

  it("rejects slug and owner mismatch with distinct codes", () => {
    expect(parse(manifest({ snippetId: "other" }))).toMatchObject({
      ok: false,
      error: { code: "manifest_invalid" },
    });
    expect(parse(manifest({ ownerSessionId: "sp-ffff" }))).toMatchObject({
      ok: false,
      error: { code: "owner_mismatch" },
    });
  });

  it.each([0, -1, 1.5, 2 ** 31, "1"])("rejects revision %s", (revision) => {
    expect(parse(manifest({ revision })).ok).toBe(false);
  });
  it("accepts revision bounds", () => {
    expect(parse(manifest({ revision: 1 })).ok).toBe(true);
    expect(parse(manifest({ revision: 2 ** 31 - 1 })).ok).toBe(true);
  });

  it.each([
    ["newline", "a\nb"],
    ["quote", 'a"b'],
    ["left bracket", "a[b"],
    ["right bracket", "a]b"],
    ["closing marker", "[/spur-snippet-action]"],
    ["backslash", "a\\b"],
    ["bidi override", "a\u202Eb"],
    ["bidi isolate", "a⁦b"],
    ["arabic letter mark", "a\u061Cb"],
    ["line separator", "a\u2028b"],
    ["paragraph separator", "a\u2029b"],
    ["empty", ""],
  ])("rejects %s in label and title", (_name, text) => {
    expect(parse(manifest({ title: text })).ok).toBe(false);
    expect(
      parse(manifest({ actions: [{ id: "go", label: text, payload: actionSchema }] })).ok,
    ).toBe(false);
  });

  it("rejects duplicate and invalid action ids, bad confirm and empty action list", () => {
    const action = { id: "go", label: "Go", payload: actionSchema };
    expect(parse(manifest({ actions: [action, action] })).ok).toBe(false);
    expect(parse(manifest({ actions: [{ ...action, id: "Go" }] })).ok).toBe(false);
    expect(parse(manifest({ actions: [{ ...action, confirm: "never" }] })).ok).toBe(false);
    expect(parse(manifest({ actions: [] })).ok).toBe(false);
    expect(parse(manifest({ actions: [{ ...action, confirm: "always" }] })).ok).toBe(true);
  });

  it("does not execute scripts while parsing", () => {
    const flag = globalThis as { __ran?: boolean };
    parseSnippetManifest(`<script>globalThis.__ran = true</script>${html(manifest())}`, {
      sessionId: SID,
      snippetId: "picker",
    });
    expect(flag.__ran).toBeUndefined();
  });
});
