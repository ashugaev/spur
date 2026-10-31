import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, open, readdir, rm, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export const MCP_RESULT_BYTES = 128 * 1024;

export function encodeMcpResult(data: Record<string, unknown>): CallToolResult {
  return {
    ...(data.ok === false ? { isError: true } : {}),
    structuredContent: data,
    content: [{ type: "text", text: JSON.stringify(data) }],
  };
}

const INLINE_BYTES = 32 * 1024;
const PAGE_BYTES = 16 * 1024;
const MAX_PAGE_BYTES = 32 * 1024;
const MAX_UPLOAD_BYTES = 15_000_000;
const TTL_MS = 10 * 60_000;
const MAX_HANDLES = 32;
const MAX_BYTES = 1024 ** 3;

interface Stored {
  file: FileHandle;
  size: number;
  expires: number;
  kind: "response" | "request";
  complete: boolean;
  busy: boolean;
}

/** Private, host-owned byte store. Protocol wrappers never own its lifetime. */
export class McpResults {
  private readonly handles = new Map<string, Stored>();
  private size = 0;
  private closed = false;
  private readonly cleanup: ReturnType<typeof setInterval>;
  private constructor(private readonly directory: string) {
    this.cleanup = setInterval(() => {
      void this.expire().catch(() => undefined);
    }, 30_000);
    this.cleanup.unref();
  }

  static async create(dataDir: string): Promise<McpResults> {
    const parent = join(dataDir, "mcp");
    await mkdir(parent, { recursive: true, mode: 0o700 });
    for (const entry of await readdir(parent, { withFileTypes: true })) {
      const pid = /^host-(\d+)-/.exec(entry.name)?.[1];
      if (!entry.isDirectory() || !pid) continue;
      try {
        process.kill(Number(pid), 0);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ESRCH")
          await rm(join(parent, entry.name), { recursive: true, force: true });
      }
    }
    return new McpResults(await mkdtemp(join(parent, `host-${process.pid}-`)));
  }

  private async expire(): Promise<void> {
    for (const [id, stored] of this.handles) {
      if (!stored.busy && stored.expires <= Date.now()) await this.remove(id, stored);
    }
  }

  private async remove(id: string, stored: Stored): Promise<void> {
    if (this.handles.get(id) !== stored) return;
    this.handles.delete(id);
    this.size -= stored.size;
    await stored.file.close();
    await rm(join(this.directory, id), { force: true });
  }

  private get(id: string, kind: Stored["kind"]): Stored {
    const stored = this.handles.get(id);
    if (!stored || stored.kind !== kind || stored.expires <= Date.now())
      throw new Error("Unknown or expired MCP handle; ephemeral handles do not survive restart");
    if (stored.busy) throw new Error("MCP handle is in use");
    return stored;
  }

  private async allocate(kind: Stored["kind"]): Promise<[string, Stored]> {
    await this.expire();
    if (this.closed) throw new Error("MCP store is closed");
    if (this.handles.size >= MAX_HANDLES) throw new Error("MCP handle quota exceeded");
    const id = randomUUID();
    // Recheck the map after file creation: allocations may run concurrently.
    const stored: Stored = {
      file: await open(join(this.directory, id), "wx+", 0o600),
      size: 0,
      expires: Date.now() + TTL_MS,
      kind,
      complete: false,
      busy: true,
    };
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- close() may run during awaited open().
    if (this.closed || this.handles.size >= MAX_HANDLES) {
      await stored.file.close();
      await rm(join(this.directory, id), { force: true });
      throw new Error("MCP handle quota exceeded or store closed");
    }
    this.handles.set(id, stored);
    return [id, stored];
  }

  private async append(stored: Stored, data: Uint8Array): Promise<void> {
    if (this.closed || this.size + data.byteLength > MAX_BYTES)
      throw new Error("MCP spool quota exceeded");
    this.size += data.byteLength;
    const start = stored.size;
    stored.size += data.byteLength;
    let written = 0;
    while (written < data.byteLength) {
      const result = await stored.file.write(
        data,
        written,
        data.byteLength - written,
        start + written,
      );
      if (!result.bytesWritten) throw new Error("MCP spool write failed");
      written += result.bytesWritten;
    }
  }

  private async readWhole(stored: Stored): Promise<Buffer> {
    const data = Buffer.alloc(stored.size);
    let offset = 0;
    while (offset < data.length) {
      const chunk = await stored.file.read(data, offset, data.length - offset, offset);
      if (!chunk.bytesRead) throw new Error("Incomplete MCP spool data");
      offset += chunk.bytesRead;
    }
    return data;
  }

  async capture(
    response: Response,
    signal: AbortSignal,
    receipt?: { after: string },
  ): Promise<Record<string, unknown>> {
    const [responseId, stored] = await this.allocate("response");
    const reader = response.body?.getReader();
    const abort = () => {
      void reader?.cancel(signal.reason).catch(() => undefined);
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      if (reader) {
        for (;;) {
          signal.throwIfAborted();
          const chunk = await reader.read();
          signal.throwIfAborted();
          if (chunk.done) break;
          await this.append(stored, chunk.value);
        }
      }
      stored.complete = true;
      stored.busy = false;
      const metadata = {
        ...receipt,
        status: response.status,
        ok: response.ok,
        headers: Object.fromEntries(
          [
            "content-type",
            "content-disposition",
            "location",
            "retry-after",
            "x-spur-lifecycle-instance-id",
          ].flatMap((name) =>
            response.headers.has(name) ? [[name, response.headers.get(name)]] : [],
          ),
        ),
      };
      if (stored.size <= INLINE_BYTES) {
        const buffer = await this.readWhole(stored);
        const mime = response.headers.get("content-type") ?? "";
        const decoded = buffer.toString("utf8");
        let inline: Record<string, unknown>;
        if (!Buffer.from(decoded, "utf8").equals(buffer)) {
          inline = { ...metadata, encoding: "base64", body: buffer.toString("base64") };
        } else if (mime.includes("json")) {
          try {
            const body = JSON.parse(decoded) as unknown;
            const serialized = JSON.stringify(body);
            if (
              !Buffer.from(serialized, "utf8").equals(buffer) &&
              !Buffer.from(`${serialized}\n`, "utf8").equals(buffer)
            )
              return { ...metadata, responseId, ...(await this.read(responseId)) };
            inline = { ...metadata, body, rawBody: decoded };
          } catch {
            inline = { ...metadata, encoding: "base64", body: buffer.toString("base64") };
          }
        } else if (mime.startsWith("text/")) inline = { ...metadata, body: decoded };
        else inline = { ...metadata, encoding: "base64", body: buffer.toString("base64") };
        if (Buffer.byteLength(JSON.stringify(encodeMcpResult(inline))) <= MCP_RESULT_BYTES) {
          await this.remove(responseId, stored);
          return inline;
        }
      }
      return { ...metadata, responseId, ...(await this.read(responseId)) };
    } catch (error) {
      await this.remove(responseId, stored);
      throw error;
    } finally {
      signal.removeEventListener("abort", abort);
      await reader?.cancel().catch(() => undefined);
      reader?.releaseLock();
    }
  }

  async read(responseId: string, offset = 0, limit = PAGE_BYTES): Promise<Record<string, unknown>> {
    const stored = this.get(responseId, "response");
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > stored.size ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > MAX_PAGE_BYTES
    )
      throw new Error("Invalid MCP byte page");
    stored.busy = true;
    try {
      const data = Buffer.alloc(Math.min(limit, stored.size - offset));
      const { bytesRead } = await stored.file.read(data, 0, data.length, offset);
      const nextOffset = offset + bytesRead;
      return {
        responseId,
        offset,
        totalBytes: stored.size,
        data: data.subarray(0, bytesRead).toString("base64"),
        encoding: "base64",
        nextOffset,
        eof: nextOffset === stored.size,
      };
    } finally {
      stored.busy = false;
    }
  }

  /** Bounded internal receipt inspection; the lossless response remains stored. */
  async inspectJson(responseId: string): Promise<unknown> {
    const stored = this.get(responseId, "response");
    if (stored.size > MAX_UPLOAD_BYTES) return undefined;
    stored.busy = true;
    try {
      const data = await this.readWhole(stored);
      try {
        return JSON.parse(data.toString("utf8")) as unknown;
      } catch {
        return undefined;
      }
    } finally {
      stored.busy = false;
    }
  }

  async release(responseId: string): Promise<boolean> {
    const stored = this.handles.get(responseId);
    if (!stored || stored.kind !== "response") return false;
    if (stored.busy) throw new Error("MCP response is in use");
    try {
      await this.remove(responseId, stored);
    } catch {
      throw new Error("MCP response cleanup failed");
    }
    return true;
  }

  async stage(input: {
    bodyHandle?: string | undefined;
    offset?: number | undefined;
    data: string;
    complete?: boolean | undefined;
  }): Promise<Record<string, unknown>> {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.data))
      throw new Error("Invalid base64 request chunk");
    const data = Buffer.from(input.data, "base64");
    if (data.length > MAX_PAGE_BYTES) throw new Error("Request chunk exceeds 32768 bytes");
    const [bodyHandle, stored] = input.bodyHandle
      ? ([input.bodyHandle, this.get(input.bodyHandle, "request")] as const)
      : await this.allocate("request");
    if ((input.offset ?? 0) !== stored.size || stored.complete) {
      stored.busy = false;
      if (!input.bodyHandle) await this.remove(bodyHandle, stored);
      throw new Error("Invalid request offset or completed request");
    }
    stored.busy = true;
    try {
      if (stored.size + data.length > MAX_UPLOAD_BYTES)
        throw new Error("Request exceeds 15000000 bytes");
      await this.append(stored, data);
      if (input.complete) {
        const buffer = await this.readWhole(stored);
        try {
          JSON.parse(buffer.toString("utf8"));
        } catch {
          throw new Error("Staged request must contain valid JSON");
        }
        stored.complete = true;
      }
      return { bodyHandle, nextOffset: stored.size, complete: stored.complete };
    } catch (error) {
      await this.remove(bodyHandle, stored);
      throw error;
    } finally {
      stored.busy = false;
    }
  }

  /** Consume before the mutation starts. Failed writes must never replay a handle. */
  async consume(bodyHandle: string): Promise<Buffer> {
    const stored = this.get(bodyHandle, "request");
    if (!stored.complete) throw new Error("Staged request is incomplete");
    stored.busy = true;
    try {
      return await this.readWhole(stored);
    } finally {
      await this.remove(bodyHandle, stored);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.cleanup);
    await Promise.allSettled([...this.handles.values()].map((stored) => stored.file.close()));
    this.handles.clear();
    this.size = 0;
    await rm(this.directory, { recursive: true, force: true });
  }
}
