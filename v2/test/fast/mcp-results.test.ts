import { createHash } from "node:crypto";
import { mkdtemp, rm, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { McpResults, encodeMcpResult, MCP_RESULT_BYTES } from "../../src/mcp-results.js";
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "mcp-results-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const store = await McpResults.create(root);
  cleanups.push(() => store.close());
  return { root, store };
}
const hash = (data: Buffer) => createHash("sha256").update(data).digest("hex");
it("reconstructs large binary and JSON without clipping, with private spool permissions", async () => {
  const { root, store } = await setup();
  for (const mime of ["application/octet-stream", "application/json"]) {
    const data = Buffer.from(
      mime.includes("json")
        ? JSON.stringify({ tool: "🙂".repeat(2_500_000) })
        : "b".repeat(9 * 1024 * 1024),
    );
    const captured = await store.capture(
      new Response(data, { headers: { "content-type": mime } }),
      AbortSignal.timeout(10_000),
    );
    const parts: Buffer[] = [];
    let offset = 0;
    for (;;) {
      const page = await store.read(String(captured.responseId), offset, 32768);
      parts.push(Buffer.from(String(page.data), "base64"));
      offset = Number(page.nextOffset);
      if (page.eof) break;
    }
    expect(hash(Buffer.concat(parts))).toBe(hash(data));
  }
  const entry = (await readdir(join(root, "mcp")))[0];
  if (!entry) throw new Error("Missing spool directory");
  const directory = join(root, "mcp", entry);
  expect((await stat(directory)).mode & 0o777).toBe(0o700);
  for (const file of await readdir(directory))
    expect((await stat(join(directory, file))).mode & 0o777).toBe(0o600);
});
it("stages near-limit JSON once, rejects offsets, invalid JSON, oversize chunks and replay", async () => {
  const { store } = await setup();
  const data = Buffer.from(
    JSON.stringify({ attachments: [{ name: "file", data: "a".repeat(14_800_000) }] }),
  );
  let bodyHandle: string | undefined;
  for (let offset = 0; offset < data.length; offset += 32768) {
    const next = await store.stage({
      bodyHandle,
      offset,
      data: data.subarray(offset, offset + 32768).toString("base64"),
      complete: offset + 32768 >= data.length,
    });
    bodyHandle = String(next.bodyHandle);
  }
  if (!bodyHandle) throw new Error("Missing staged handle");
  expect(hash(await store.consume(bodyHandle))).toBe(hash(data));
  await expect(store.consume(bodyHandle)).rejects.toThrow("expired");
  await expect(store.stage({ data: "eA==", complete: true })).rejects.toThrow("valid JSON");
  await expect(store.stage({ data: "%%%" })).rejects.toThrow("base64");
  await expect(store.stage({ data: Buffer.alloc(32769).toString("base64") })).rejects.toThrow(
    "32768",
  );
  const staged = await store.stage({ data: "e30=" });
  await expect(
    store.stage({ bodyHandle: String(staged.bodyHandle), offset: 0, data: "" }),
  ).rejects.toThrow("offset");
});
it("enforces handle quota and expiration and removes owned files on close", async () => {
  const { root, store } = await setup();
  const staged = await store.stage({ data: "e30=", complete: true });
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now + 600_001);
  await expect(store.consume(String(staged.bodyHandle))).rejects.toThrow("expired");
  for (let n = 0; n < 32; n++) await store.stage({ data: "e30=" });
  await expect(store.stage({ data: "e30=" })).rejects.toThrow("quota");
  await store.close();
  expect(await readdir(join(root, "mcp"))).toEqual([]);
});
it("cancels streaming captures and preserves invalid UTF-8 bytes", async () => {
  const { store } = await setup();
  const binary = Buffer.from([0xff, 0xfe, 0x00]);
  const captured = await store.capture(
    new Response(binary, { headers: { "content-type": "text/plain" } }),
    AbortSignal.timeout(1000),
  );
  expect(Buffer.from(String(captured.body), "base64")).toEqual(binary);
  const abort = new AbortController();
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Buffer.from("a"));
    },
    cancel() {
      cancelled = true;
    },
  });
  const pending = store.capture(new Response(stream), abort.signal);
  setTimeout(() => abort.abort(new Error("cancelled")), 5);
  await expect(pending).rejects.toThrow("cancelled");
  expect(cancelled).toBe(true);
});
it("retains escaped inline bodies until the actual duplicated MCP envelope fits", async () => {
  const { store, root } = await setup();
  for (const raw of ["\n".repeat(32768), "\0".repeat(32768)]) {
    const response = await store.capture(
      new Response(raw, { headers: { "content-type": "text/plain" } }),
      AbortSignal.timeout(1000),
      { after: "r".repeat(36) },
    );
    expect(response.responseId).toBeTypeOf("string");
    const parts: Buffer[] = [];
    let offset = 0;
    for (;;) {
      const page = await store.read(String(response.responseId), offset, 32768);
      parts.push(Buffer.from(String(page.data), "base64"));
      offset = Number(page.nextOffset);
      expect(Buffer.byteLength(JSON.stringify(encodeMcpResult(page)))).toBeLessThanOrEqual(
        MCP_RESULT_BYTES,
      );
      if (page.eof) break;
    }
    expect(Buffer.concat(parts)).toEqual(Buffer.from(raw));
    expect(Buffer.byteLength(JSON.stringify(encodeMcpResult(response)))).toBeLessThanOrEqual(
      MCP_RESULT_BYTES,
    );
  }
  const entry = (await readdir(join(root, "mcp")))[0];
  if (!entry) throw new Error("Missing spool directory");
  const before = await readdir(join(root, "mcp", entry));
  expect(
    await store.capture(
      new Response("small", { headers: { "content-type": "text/plain" } }),
      AbortSignal.timeout(1000),
    ),
  ).toMatchObject({ body: "small" });
  expect(await readdir(join(root, "mcp", entry))).toEqual(before);
});
it("preserves producing-response lifecycle headers for empty, paged, error and binary bodies", async () => {
  const { store } = await setup();
  for (const sample of [
    { body: Buffer.from("[]"), mime: "application/json", status: 200 },
    {
      body: Buffer.from(JSON.stringify(["x".repeat(40000)])),
      mime: "application/json",
      status: 200,
    },
    { body: Buffer.from("conflict"), mime: "text/plain", status: 409 },
    { body: Buffer.from([0xff, 0xfe]), mime: "application/octet-stream", status: 200 },
  ]) {
    const result = await store.capture(
      new Response(sample.body, {
        status: sample.status,
        headers: {
          "content-type": sample.mime,
          "x-spur-lifecycle-instance-id": "producing-instance",
        },
      }),
      AbortSignal.timeout(1000),
    );
    expect(result).toMatchObject({
      status: sample.status,
      headers: { "x-spur-lifecycle-instance-id": "producing-instance" },
    });
    expect(Buffer.byteLength(JSON.stringify(encodeMcpResult(result)))).toBeLessThanOrEqual(
      MCP_RESULT_BYTES,
    );
    if (result.responseId) {
      const first = await store.read(String(result.responseId), 0, 32768);
      const second = await store.read(String(result.responseId), Number(first.nextOffset), 32768);
      expect(
        Buffer.concat([
          Buffer.from(String(first.data), "base64"),
          Buffer.from(String(second.data), "base64"),
        ]),
      ).toEqual(sample.body);
    }
  }
});
it("retains exact small JSON artifact bytes instead of normalizing numbers, keys or spelling", async () => {
  const { store } = await setup();
  for (const raw of [
    '{\n  "n": 9007199254740993, "x":1, "x":2, "s":"\\u0061"\n}\n',
    '{"n":9007199254740993}',
    '{"x":1,"x":2}',
    ' { "x": 1 }\n',
    '{"s":"\\u0061"}',
    '{"n":-0}',
  ]) {
    const result = await store.capture(
      new Response(raw, { headers: { "content-type": "application/json" } }),
      AbortSignal.timeout(1000),
    );
    expect(result.responseId).toBeTypeOf("string");
    const page = await store.read(String(result.responseId));
    expect(hash(Buffer.from(String(page.data), "base64"))).toBe(hash(Buffer.from(raw)));
    expect(Buffer.byteLength(JSON.stringify(encodeMcpResult(result)))).toBeLessThanOrEqual(
      MCP_RESULT_BYTES,
    );
  }
  for (const rawBody of ['{"n":1}', '{"n":1}\n']) {
    expect(
      await store.capture(
        new Response(rawBody, { headers: { "content-type": "application/json" } }),
        AbortSignal.timeout(1000),
      ),
    ).toMatchObject({ body: { n: 1 }, rawBody });
  }
});
it("releases only response handles idempotently and preserves request uploads", async () => {
  const { store, root } = await setup();
  const response = await store.capture(new Response("x".repeat(40000)), AbortSignal.timeout(1000));
  const responseId = String(response.responseId);
  const staged = await store.stage({
    data: Buffer.from('{"ok":true}').toString("base64"),
    complete: true,
  });
  expect(await store.release(String(staged.bodyHandle))).toBe(false);
  expect(await store.release("../../private")).toBe(false);
  expect(await store.release("unknown")).toBe(false);
  expect(await Promise.all([store.release(responseId), store.release(responseId)])).toEqual([
    true,
    false,
  ]);
  await expect(store.read(responseId)).rejects.toThrow("Unknown or expired");
  expect((await store.consume(String(staged.bodyHandle))).toString()).toBe('{"ok":true}');
  const directory = (await readdir(join(root, "mcp")))[0];
  if (!directory) throw new Error("Missing store");
  expect(await readdir(join(root, "mcp", directory))).toEqual([]);
});
it("protects active response reads and reclaims expired response files", async () => {
  const { store } = await setup();
  const response = await store.capture(
    new Response("secret-body".repeat(4000)),
    AbortSignal.timeout(1000),
  );
  const responseId = String(response.responseId);
  const reading = store.read(responseId);
  await expect(store.release(responseId)).rejects.toThrow(/^MCP response is in use$/);
  await reading;
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now + 600_001);
  expect(await store.release(responseId)).toBe(true);
  expect(await store.release(responseId)).toBe(false);
});
it("reuses released response quota without deleting unrelated retained data", async () => {
  const { store } = await setup();
  const ids: string[] = [];
  for (let index = 0; index < 32; index++)
    ids.push(
      String(
        (await store.capture(new Response(String(index).repeat(40000)), AbortSignal.timeout(1000)))
          .responseId,
      ),
    );
  await expect(
    store.capture(new Response("full".repeat(12000)), AbortSignal.timeout(1000)),
  ).rejects.toThrow("quota");
  const first = ids.shift();
  if (!first) throw new Error("Missing response");
  expect(await store.release(first)).toBe(true);
  const next = await store.capture(new Response("new".repeat(12000)), AbortSignal.timeout(1000));
  expect(next.responseId).toBeTypeOf("string");
  const retained = ids[0];
  if (!retained) throw new Error("Missing retained response");
  expect(Buffer.from(String((await store.read(retained)).data), "base64").toString()).toBe(
    "1".repeat(16384),
  );
});
