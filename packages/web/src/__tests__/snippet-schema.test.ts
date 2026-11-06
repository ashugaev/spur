import { describe, expect, it } from "vitest";
import {
  parseSnippetSchema,
  validateSnippetPayload,
  type SnippetObjectSchema,
} from "@/lib/snippets/snippet-schema";

function parse(schema: unknown): SnippetObjectSchema {
  const result = parseSnippetSchema(schema);
  if (!result.ok) throw new Error(`${result.path}: ${result.message}`);
  return result.schema;
}

const str = { type: "string", maxLength: 10 };

describe("parseSnippetSchema", () => {
  it("accepts every supported type", () => {
    const schema = parse({
      type: "object",
      required: ["a"],
      properties: {
        a: { type: "string", maxLength: 5, minLength: 1, enum: ["x", "y"] },
        b: { type: "number", minimum: 0, maximum: 5, integer: true },
        c: { type: "boolean" },
        d: { type: "array", items: str, maxItems: 3, minItems: 1 },
        e: { type: "selection", maxLength: 100 },
      },
    });
    expect(Object.keys(schema.properties)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it.each([
    ["missing maxLength", { type: "object", properties: { a: { type: "string" } } }],
    ["missing maxItems", { type: "object", properties: { a: { type: "array", items: str } } }],
    [
      "maxLength over cap",
      { type: "object", properties: { a: { type: "string", maxLength: 20001 } } },
    ],
    [
      "maxItems over cap",
      { type: "object", properties: { a: { type: "array", items: str, maxItems: 101 } } },
    ],
    ["unknown keyword", { type: "object", properties: { a: { ...str, pattern: "x" } } }],
    ["unknown root key", { type: "object", properties: { a: str }, additionalProperties: true }],
    ["unsupported type", { type: "object", properties: { a: { type: "null" } } }],
    ["empty properties", { type: "object", properties: {} }],
    ["bad property name", { type: "object", properties: { "1a": str } }],
    ["required not declared", { type: "object", properties: { a: str }, required: ["b"] }],
    [
      "enum value over maxLength",
      { type: "object", properties: { a: { type: "string", maxLength: 2, enum: ["abc"] } } },
    ],
    [
      "min above max",
      { type: "object", properties: { a: { type: "number", minimum: 2, maximum: 1 } } },
    ],
    [
      "non-finite bound",
      { type: "object", properties: { a: { type: "number", minimum: Infinity } } },
    ],
    ["root not object", str],
  ])("rejects %s", (_name, schema) => {
    expect(parseSnippetSchema(schema).ok).toBe(false);
  });

  it("allows depth 4 and rejects depth 5", () => {
    const four = {
      type: "object",
      properties: {
        a: {
          type: "array",
          maxItems: 2,
          items: { type: "object", properties: { b: { type: "array", maxItems: 2, items: str } } },
        },
      },
    };
    expect(parseSnippetSchema(four).ok).toBe(true);
    const five = JSON.parse(JSON.stringify(four));
    five.properties.a.items.properties.b.items = {
      type: "object",
      properties: { c: str },
    };
    expect(parseSnippetSchema(five).ok).toBe(false);
  });
});

describe("validateSnippetPayload", () => {
  const schema = parse({
    type: "object",
    required: ["name"],
    properties: {
      name: { type: "string", maxLength: 5, minLength: 2 },
      kind: { type: "string", maxLength: 5, enum: ["a", "b"] },
      count: { type: "number", minimum: 1, maximum: 3, integer: true },
      flag: { type: "boolean" },
      tags: { type: "array", items: { type: "string", maxLength: 3 }, maxItems: 2, minItems: 1 },
      pick: { type: "selection", maxLength: 20 },
    },
  });

  it("rebuilds the payload in schema property order", () => {
    const result = validateSnippetPayload(schema, { flag: true, name: "ab", count: 2 });
    expect(result).toEqual({ ok: true, payload: { name: "ab", count: 2, flag: true } });
    if (result.ok) expect(Object.keys(result.payload)).toEqual(["name", "count", "flag"]);
  });

  it.each([
    ["required", {}, { path: "/name", code: "required" }],
    ["unknown_property", { name: "ab", x: 1 }, { path: "/x", code: "unknown_property" }],
    ["type", { name: 5 }, { path: "/name", code: "type" }],
    ["min_length", { name: "a" }, { path: "/name", code: "min_length" }],
    ["max_length", { name: "abcdef" }, { path: "/name", code: "max_length" }],
    ["enum", { name: "ab", kind: "z" }, { path: "/kind", code: "enum" }],
    ["minimum", { name: "ab", count: 0 }, { path: "/count", code: "minimum" }],
    ["maximum", { name: "ab", count: 4 }, { path: "/count", code: "maximum" }],
    ["integer", { name: "ab", count: 1.5 }, { path: "/count", code: "integer" }],
    ["min_items", { name: "ab", tags: [] }, { path: "/tags", code: "min_items" }],
    ["max_items", { name: "ab", tags: ["a", "b", "c"] }, { path: "/tags", code: "max_items" }],
    ["nested item", { name: "ab", tags: ["abcd"] }, { path: "/tags/0", code: "max_length" }],
  ])("reports %s with a JSON Pointer", (_name, payload, issue) => {
    const result = validateSnippetPayload(schema, payload);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues).toContainEqual(issue);
  });

  it("rejects a non-object payload", () => {
    expect(validateSnippetPayload(schema, [1])).toMatchObject({ ok: false });
    expect(validateSnippetPayload(schema, null)).toMatchObject({ ok: false });
  });

  it("checks selection offsets and quote", () => {
    const good = { sourceId: "s1", text: "hello world", start: 6, end: 11, quote: "world" };
    expect(validateSnippetPayload(schema, { name: "ab", pick: good })).toMatchObject({ ok: true });
    for (const bad of [
      { ...good, quote: "wor" },
      { ...good, start: 11, end: 11, quote: "" },
      { ...good, end: 99 },
      { ...good, start: -1 },
    ]) {
      const result = validateSnippetPayload(schema, { name: "ab", pick: bad });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.issues.map((i) => i.code)).toContain("selection_mismatch");
    }
    const tooLong = validateSnippetPayload(schema, {
      name: "ab",
      pick: { ...good, text: "x".repeat(21), start: 0, end: 1, quote: "x" },
    });
    expect(tooLong).toMatchObject({ ok: false });
  });

  it("measures offsets in UTF-16 units", () => {
    const text = "a😀b";
    const result = validateSnippetPayload(schema, {
      name: "ab",
      pick: { sourceId: "s", text, start: 1, end: 3, quote: "😀" },
    });
    expect(result.ok).toBe(true);
  });

  it("caps issues at 20", () => {
    const payload: Record<string, number> = {};
    for (let i = 0; i < 40; i += 1) payload[`k${i}`] = i;
    const result = validateSnippetPayload(schema, payload);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues).toHaveLength(20);
  });

  it("rejects over-deep and cyclic payloads with a depth issue", () => {
    const cyclic: Record<string, unknown> = { name: "ab" };
    cyclic.self = cyclic;
    expect(validateSnippetPayload(schema, cyclic)).toEqual({
      ok: false,
      issues: [{ path: "", code: "depth" }],
    });
  });
});
