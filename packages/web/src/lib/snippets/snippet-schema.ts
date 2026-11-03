// Payload schema subset for snippet actions. One validator: the manifest is
// parsed with `parseSnippetSchema`, every invoke is checked with
// `validateSnippetPayload`. No full JSON Schema: no pattern, $ref, oneOf, format.

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type SnippetSchema =
  | SnippetObjectSchema
  | { type: "string"; maxLength: number; minLength?: number; enum?: string[] }
  | { type: "number"; minimum?: number; maximum?: number; integer?: true }
  | { type: "boolean" }
  | { type: "array"; items: SnippetSchema; maxItems: number; minItems?: number }
  | { type: "selection"; maxLength: number };

export interface SnippetObjectSchema {
  type: "object";
  properties: Record<string, SnippetSchema>;
  required?: string[];
}

export type SnippetSchemaIssueCode =
  | "type"
  | "required"
  | "unknown_property"
  | "min_length"
  | "max_length"
  | "enum"
  | "minimum"
  | "maximum"
  | "integer"
  | "min_items"
  | "max_items"
  | "selection_mismatch"
  | "depth";

export interface SnippetSchemaIssue {
  path: string;
  code: SnippetSchemaIssueCode;
}

export const SNIPPET_SCHEMA_MAX_DEPTH = 4;
export const SNIPPET_SCHEMA_MAX_ISSUES = 20;
export const SNIPPET_STRING_MAX = 20_000;
export const SNIPPET_ARRAY_MAX = 100;
export const SNIPPET_PROPERTY_KEY_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,31}$/;
export const SNIPPET_SELECTION_SOURCE_RE = /^[A-Za-z0-9_-]{1,64}$/;

const MAX_PROPERTIES = 32;
const MAX_ENUM = 100;
const MAX_ENUM_VALUE = 200;

type ParseResult<T> = { ok: true; value: T } | { ok: false; path: string; message: string };

function fail(path: string, message: string): { ok: false; path: string; message: string } {
  return { ok: false, path, message };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function unknownKey(value: Record<string, unknown>, allowed: string[]): string | null {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) return key;
  return null;
}

function intInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function parseNode(value: unknown, path: string, depth: number): ParseResult<SnippetSchema> {
  if (!isPlainObject(value)) return fail(path, "schema must be an object");
  const type = value.type;
  if (type === "object") return parseObject(value, path, depth);
  if ((type === "array" || type === "selection") && depth > SNIPPET_SCHEMA_MAX_DEPTH) {
    return fail(path, "schema nesting over depth 4");
  }
  switch (type) {
    case "string": {
      const extra = unknownKey(value, ["type", "maxLength", "minLength", "enum"]);
      if (extra) return fail(`${path}/${extra}`, "unknown schema key");
      if (!intInRange(value.maxLength, 1, SNIPPET_STRING_MAX)) {
        return fail(`${path}/maxLength`, "maxLength required, integer 1..20000");
      }
      const maxLength = value.maxLength;
      const result: SnippetSchema = { type: "string", maxLength };
      if (value.minLength !== undefined) {
        if (!intInRange(value.minLength, 0, maxLength)) {
          return fail(`${path}/minLength`, "minLength integer 0..maxLength");
        }
        result.minLength = value.minLength;
      }
      if (value.enum !== undefined) {
        const values = value.enum;
        if (!Array.isArray(values) || values.length < 1 || values.length > MAX_ENUM) {
          return fail(`${path}/enum`, "enum needs 1..100 strings");
        }
        for (const item of values) {
          if (typeof item !== "string" || item.length > MAX_ENUM_VALUE || item.length > maxLength) {
            return fail(`${path}/enum`, "enum values: strings up to 200 chars and maxLength");
          }
        }
        result.enum = values as string[];
      }
      return { ok: true, value: result };
    }
    case "number": {
      const extra = unknownKey(value, ["type", "minimum", "maximum", "integer"]);
      if (extra) return fail(`${path}/${extra}`, "unknown schema key");
      const result: SnippetSchema = { type: "number" };
      for (const key of ["minimum", "maximum"] as const) {
        const bound = value[key];
        if (bound === undefined) continue;
        if (typeof bound !== "number" || !Number.isFinite(bound)) {
          return fail(`${path}/${key}`, `${key} must be a finite number`);
        }
        result[key] = bound;
      }
      if (
        result.minimum !== undefined &&
        result.maximum !== undefined &&
        result.minimum > result.maximum
      ) {
        return fail(path, "minimum above maximum");
      }
      if (value.integer !== undefined) {
        if (value.integer !== true) return fail(`${path}/integer`, "integer must be true");
        result.integer = true;
      }
      return { ok: true, value: result };
    }
    case "boolean": {
      const extra = unknownKey(value, ["type"]);
      if (extra) return fail(`${path}/${extra}`, "unknown schema key");
      return { ok: true, value: { type: "boolean" } };
    }
    case "array": {
      const extra = unknownKey(value, ["type", "items", "maxItems", "minItems"]);
      if (extra) return fail(`${path}/${extra}`, "unknown schema key");
      if (!intInRange(value.maxItems, 1, SNIPPET_ARRAY_MAX)) {
        return fail(`${path}/maxItems`, "maxItems required, integer 1..100");
      }
      const maxItems = value.maxItems;
      let minItems: number | undefined;
      if (value.minItems !== undefined) {
        if (!intInRange(value.minItems, 0, maxItems)) {
          return fail(`${path}/minItems`, "minItems integer 0..maxItems");
        }
        minItems = value.minItems;
      }
      const items = parseNode(value.items, `${path}/items`, depth + 1);
      if (!items.ok) return items;
      const result: SnippetSchema = { type: "array", items: items.value, maxItems };
      if (minItems !== undefined) result.minItems = minItems;
      return { ok: true, value: result };
    }
    case "selection": {
      const extra = unknownKey(value, ["type", "maxLength"]);
      if (extra) return fail(`${path}/${extra}`, "unknown schema key");
      if (!intInRange(value.maxLength, 1, SNIPPET_STRING_MAX)) {
        return fail(`${path}/maxLength`, "maxLength required, integer 1..20000");
      }
      return { ok: true, value: { type: "selection", maxLength: value.maxLength } };
    }
    default:
      return fail(`${path}/type`, "unsupported schema type");
  }
}

function parseObject(
  value: Record<string, unknown>,
  path: string,
  depth: number,
): ParseResult<SnippetObjectSchema> {
  if (depth > SNIPPET_SCHEMA_MAX_DEPTH) return fail(path, "schema nesting over depth 4");
  const extra = unknownKey(value, ["type", "properties", "required"]);
  if (extra) return fail(`${path}/${extra}`, "unknown schema key");
  if (!isPlainObject(value.properties)) return fail(`${path}/properties`, "properties required");
  const keys = Object.keys(value.properties);
  if (keys.length < 1 || keys.length > MAX_PROPERTIES) {
    return fail(`${path}/properties`, "properties need 1..32 keys");
  }
  const properties: Record<string, SnippetSchema> = {};
  for (const key of keys) {
    if (!SNIPPET_PROPERTY_KEY_RE.test(key)) {
      return fail(`${path}/properties/${key}`, "invalid property name");
    }
    const child = parseNode(value.properties[key], `${path}/properties/${key}`, depth + 1);
    if (!child.ok) return child;
    properties[key] = child.value;
  }
  const result: SnippetObjectSchema = { type: "object", properties };
  if (value.required !== undefined) {
    const required = value.required;
    if (!Array.isArray(required) || required.length > keys.length) {
      return fail(`${path}/required`, "required must list declared properties");
    }
    const seen = new Set<string>();
    for (const name of required) {
      if (typeof name !== "string" || !keys.includes(name) || seen.has(name)) {
        return fail(`${path}/required`, "required must list declared properties once each");
      }
      seen.add(name);
    }
    result.required = required as string[];
  }
  return { ok: true, value: result };
}

export type ParsedSnippetSchema =
  | { ok: true; schema: SnippetObjectSchema }
  | { ok: false; path: string; message: string };

export function parseSnippetSchema(value: unknown, path = ""): ParsedSnippetSchema {
  if (!isPlainObject(value) || value.type !== "object") {
    return fail(path, "payload schema root must be an object schema");
  }
  const result = parseObject(value, path, 1);
  return result.ok ? { ok: true, schema: result.value } : result;
}

// Measure payload nesting to a cap; recursion stops one level past the limit,
// so a cyclic structure cannot loop.
function exceedsDepth(value: unknown, depth: number): boolean {
  if (value === null || typeof value !== "object") return false;
  if (depth > SNIPPET_SCHEMA_MAX_DEPTH) return true;
  const children = Array.isArray(value) ? value : Object.values(value);
  return children.some((child) => exceedsDepth(child, depth + 1));
}

function pointer(path: string, key: string | number): string {
  return `${path}/${String(key).replaceAll("~", "~0").replaceAll("/", "~1")}`;
}

class IssueSink {
  readonly issues: SnippetSchemaIssue[] = [];
  add(path: string, code: SnippetSchemaIssueCode): void {
    if (this.issues.length < SNIPPET_SCHEMA_MAX_ISSUES) this.issues.push({ path, code });
  }
}

const SELECTION_KEYS = ["sourceId", "text", "start", "end", "quote"];

function walk(schema: SnippetSchema, value: unknown, path: string, sink: IssueSink): JsonValue {
  switch (schema.type) {
    case "object": {
      if (!isPlainObject(value)) {
        sink.add(path, "type");
        return null;
      }
      const out: Record<string, JsonValue> = {};
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(schema.properties, key))
          sink.add(pointer(path, key), "unknown_property");
      }
      for (const [key, child] of Object.entries(schema.properties)) {
        if (!Object.hasOwn(value, key) || value[key] === undefined) {
          if (schema.required?.includes(key)) sink.add(pointer(path, key), "required");
          continue;
        }
        out[key] = walk(child, value[key], pointer(path, key), sink);
      }
      return out;
    }
    case "string": {
      if (typeof value !== "string") {
        sink.add(path, "type");
        return null;
      }
      if (value.length > schema.maxLength) sink.add(path, "max_length");
      else if (schema.minLength !== undefined && value.length < schema.minLength) {
        sink.add(path, "min_length");
      }
      if (schema.enum && !schema.enum.includes(value)) sink.add(path, "enum");
      return value;
    }
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        sink.add(path, "type");
        return null;
      }
      if (schema.integer && !Number.isInteger(value)) sink.add(path, "integer");
      if (schema.minimum !== undefined && value < schema.minimum) sink.add(path, "minimum");
      if (schema.maximum !== undefined && value > schema.maximum) sink.add(path, "maximum");
      return value;
    }
    case "boolean": {
      if (typeof value !== "boolean") {
        sink.add(path, "type");
        return null;
      }
      return value;
    }
    case "array": {
      if (!Array.isArray(value)) {
        sink.add(path, "type");
        return null;
      }
      if (value.length > schema.maxItems) sink.add(path, "max_items");
      else if (schema.minItems !== undefined && value.length < schema.minItems) {
        sink.add(path, "min_items");
      }
      return value
        .slice(0, schema.maxItems)
        .map((item, index) => walk(schema.items, item, pointer(path, index), sink));
    }
    case "selection": {
      if (!isPlainObject(value)) {
        sink.add(path, "type");
        return null;
      }
      for (const key of Object.keys(value)) {
        if (!SELECTION_KEYS.includes(key)) sink.add(pointer(path, key), "unknown_property");
      }
      for (const key of SELECTION_KEYS) {
        if (value[key] === undefined) sink.add(pointer(path, key), "required");
      }
      const { sourceId, text, start, end, quote } = value;
      if (typeof sourceId !== "string" || !SNIPPET_SELECTION_SOURCE_RE.test(sourceId)) {
        if (sourceId !== undefined) sink.add(pointer(path, "sourceId"), "type");
      }
      if (typeof text !== "string") {
        if (text !== undefined) sink.add(pointer(path, "text"), "type");
      } else if (text.length > schema.maxLength) sink.add(pointer(path, "text"), "max_length");
      if (typeof quote !== "string" && quote !== undefined)
        sink.add(pointer(path, "quote"), "type");
      const offsetsTyped = Number.isInteger(start) && Number.isInteger(end);
      if (!offsetsTyped) {
        for (const [key, offset] of [
          ["start", start],
          ["end", end],
        ] as const) {
          if (offset !== undefined && !Number.isInteger(offset))
            sink.add(pointer(path, key), "type");
        }
      }
      if (
        offsetsTyped &&
        typeof text === "string" &&
        typeof quote === "string" &&
        (!(
          (start as number) >= 0 &&
          (start as number) < (end as number) &&
          (end as number) <= text.length
        ) ||
          text.slice(start as number, end as number) !== quote)
      ) {
        sink.add(path, "selection_mismatch");
      }
      return {
        sourceId: typeof sourceId === "string" ? sourceId : "",
        text: typeof text === "string" ? text : "",
        start: typeof start === "number" ? start : 0,
        end: typeof end === "number" ? end : 0,
        quote: typeof quote === "string" ? quote : "",
      };
    }
  }
}

export type ValidatedSnippetPayload =
  | { ok: true; payload: { [key: string]: JsonValue } }
  | { ok: false; issues: SnippetSchemaIssue[] };

// Walks the payload against the declared schema. On success the payload is
// rebuilt in schema property order, so the prompt bytes are canonical.
export function validateSnippetPayload(
  schema: SnippetObjectSchema,
  payload: unknown,
): ValidatedSnippetPayload {
  if (exceedsDepth(payload, 1)) return { ok: false, issues: [{ path: "", code: "depth" }] };
  const sink = new IssueSink();
  const rebuilt = walk(schema, payload, "", sink);
  if (sink.issues.length > 0) return { ok: false, issues: sink.issues };
  return { ok: true, payload: rebuilt as { [key: string]: JsonValue } };
}
