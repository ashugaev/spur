import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startServer } from "../../src/server.js";
import type { CronStorageView } from "../../src/types.js";
import * as hostMemory from "../../src/host-memory.js";
import { cleanupTrackedTempDirs, createTempDir, findFreePort } from "../helpers/common.js";

beforeEach(() => {
  vi.spyOn(hostMemory, "readHostMemory").mockReturnValue({
    totalBytes: 64_000_000_000,
    availableBytes: 32_000_000_000,
    swapTotalBytes: 8_000_000_000,
    swapFreeBytes: 8_000_000_000,
  });
  vi.spyOn(hostMemory, "readCgroupMemorySnapshot").mockReturnValue(null);
  vi.spyOn(hostMemory, "readCgroupPressure").mockReturnValue(null);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTrackedTempDirs();
});

async function bootServer(): Promise<{
  base: string;
  root: string;
  dataDir: string;
  stop: () => Promise<void>;
}> {
  const root = await createTempDir("spur-cron-storage-server-");
  const repoDir = join(root, "repo");
  const dataDir = join(root, "data");
  await mkdir(repoDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  const port = await findFreePort();
  const webhookPort = await findFreePort();
  const configPath = join(root, "spur.yaml");
  await writeFile(
    configPath,
    [
      "server:",
      "  host: 127.0.0.1",
      `  port: ${port}`,
      `dataDir: ${dataDir}`,
      `worktreeDir: ${join(root, "worktrees")}`,
      "projects:",
      "  demo:",
      `    path: ${repoDir}`,
      "    sources:",
      "      nightly: {type: cron, schedule: '0 3 * * *', runOnStart: false}",
      "      hook:",
      "        type: webhook",
      "        host: 127.0.0.1",
      `        port: ${webhookPort}`,
      "        path: /hook",
      "        secret: webhook-secret-x",
      "    triggers:",
      "      audit:",
      "        source: nightly",
      "        event: cron:tick",
      "        spawn:",
      "          prompt: audit sessions",
      "      onhook:",
      "        source: hook",
      "        event: webhook:received",
      "        spawn:",
      "          prompt: handle hook",
    ].join("\n"),
    "utf8",
  );
  const server = await startServer(configPath, { info: () => undefined, warn: () => undefined });
  return {
    base: `http://127.0.0.1:${port}`,
    root,
    dataDir,
    stop: () => server.stop(),
  };
}

function patchNote(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("cron storage routes", () => {
  it("lists, saves the note, serves files and clears an orphan-capable dir", async () => {
    const { base, dataDir, stop } = await bootServer();
    const storage = `${base}/projects/demo/cron/audit/storage`;
    try {
      const empty = await fetch(storage);
      expect(empty.status).toBe(200);
      expect(await empty.json()).toEqual({
        note: "",
        noteUpdatedAt: null,
        files: [],
        totalBytes: 0,
        updatedAt: null,
        truncated: false,
      } satisfies CronStorageView);

      const saved = await patchNote(`${storage}/note`, { note: "remember X" });
      expect(saved.status).toBe(200);
      expect(((await saved.json()) as CronStorageView).note).toBe("remember X");

      const dir = join(dataDir, "cron-storage", "demo", "audit");
      await mkdir(join(dir, "nested"), { recursive: true });
      await writeFile(join(dir, "nested", "data.txt"), "12345");
      await writeFile(join(dir, "report.html"), "<p>hi</p>");
      await writeFile(join(dir, "chart.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");

      const listed = (await (await fetch(storage)).json()) as CronStorageView;
      expect(listed.note).toBe("remember X");
      expect(listed.noteUpdatedAt).toEqual(expect.any(String));
      expect(listed.files.map((file) => file.id).sort()).toEqual([
        "chart.svg",
        "nested/data.txt",
        "report.html",
      ]);

      const nested = await fetch(`${storage}/files/nested/data.txt`);
      expect(nested.status).toBe(200);
      expect(await nested.text()).toBe("12345");

      const html = await fetch(`${storage}/files/report.html`);
      expect(html.status).toBe(200);
      expect(html.headers.get("content-security-policy")).toBe(
        "sandbox allow-scripts allow-forms allow-popups allow-modals",
      );
      expect(html.headers.get("cache-control")).toBe("no-store");

      const svg = await fetch(`${storage}/files/chart.svg`);
      expect(svg.status).toBe(200);
      expect(svg.headers.get("content-disposition")).toMatch(/^attachment;/);

      expect((await fetch(`${storage}/files/..%2F..%2Fspur.yaml`)).status).toBe(404);
      expect((await fetch(`${storage}/files/%ZZ`)).status).toBe(404);
      expect((await fetch(`${storage}/files/missing.txt`)).status).toBe(404);

      const cleared = await fetch(storage, { method: "DELETE" });
      expect(cleared.status).toBe(200);
      expect(((await cleared.json()) as CronStorageView).files).toEqual([]);
      expect(existsSync(dir)).toBe(false);
      expect(((await (await fetch(storage)).json()) as CronStorageView).note).toBe("");
    } finally {
      await stop();
    }
  });

  it("reads and clears a dir with no configured trigger", async () => {
    const { base, dataDir, stop } = await bootServer();
    const dir = join(dataDir, "cron-storage", "demo", "renamed");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "left.txt"), "old");
    try {
      const storage = `${base}/projects/demo/cron/renamed/storage`;
      const listed = (await (await fetch(storage)).json()) as CronStorageView;
      expect(listed.files.map((file) => file.id)).toEqual(["left.txt"]);
      expect((await fetch(storage, { method: "DELETE" })).status).toBe(200);
      expect(existsSync(dir)).toBe(false);
    } finally {
      await stop();
    }
  });

  it("rejects note saves without a configured cron spawn trigger or with a bad body", async () => {
    const { base, dataDir, stop } = await bootServer();
    try {
      const note = (trigger: string) => `${base}/projects/demo/cron/${trigger}/storage/note`;
      expect((await patchNote(note("missing"), { note: "x" })).status).toBe(404);
      expect((await patchNote(note("onhook"), { note: "x" })).status).toBe(404);
      expect(
        (await patchNote(`${base}/projects/ghost/cron/audit/storage/note`, { note: "x" })).status,
      ).toBe(404);
      for (const inherited of ["__proto__", "toString", "constructor"]) {
        expect(
          (await patchNote(`${base}/projects/${inherited}/cron/audit/storage/note`, { note: "x" }))
            .status,
        ).toBe(404);
        expect((await patchNote(note(inherited), { note: "x" })).status).toBe(404);
      }
      expect(existsSync(join(dataDir, "cron-storage"))).toBe(false);
      expect((await patchNote(note("audit"), { note: 1 })).status).toBe(400);
      expect((await patchNote(note("audit"), { note: "x", extra: true })).status).toBe(400);
      expect((await patchNote(note("audit"), ["x"])).status).toBe(400);
      expect(existsSync(join(dataDir, "cron-storage"))).toBe(false);
    } finally {
      await stop();
    }
  });

  it("answers 400 on ids outside the id pattern", async () => {
    const { base, stop } = await bootServer();
    try {
      expect((await fetch(`${base}/projects/a.b/cron/audit/storage`)).status).toBe(400);
      expect(
        (await fetch(`${base}/projects/demo/cron/a.b/storage`, { method: "DELETE" })).status,
      ).toBe(400);
      expect(
        (await patchNote(`${base}/projects/demo/cron/a%ZZ/storage/note`, { note: "" })).status,
      ).toBe(400);
      expect((await fetch(`${base}/projects/demo/cron/a.b/storage/files/x.txt`)).status).toBe(400);
    } finally {
      await stop();
    }
  });

  it("answers 409 when the storage root or its project dir is a symlink", async () => {
    const { base, root, dataDir, stop } = await bootServer();
    const outside = join(root, "outside");
    await mkdir(join(outside, "audit"), { recursive: true });
    await writeFile(join(outside, "audit", "secret.txt"), "secret");
    const storage = `${base}/projects/demo/cron/audit/storage`;
    try {
      await mkdir(join(dataDir, "cron-storage"));
      await symlink(outside, join(dataDir, "cron-storage", "demo"));
      expect((await fetch(storage)).status).toBe(409);
      expect((await fetch(`${storage}/files/secret.txt`)).status).toBe(409);
      expect((await patchNote(`${storage}/note`, { note: "x" })).status).toBe(409);
      expect((await fetch(storage, { method: "DELETE" })).status).toBe(409);
      expect(await readFile(join(outside, "audit", "secret.txt"), "utf8")).toBe("secret");
      expect(existsSync(join(outside, "audit", "note.md"))).toBe(false);
    } finally {
      await stop();
    }
  });

  it("answers 409 when the trigger dir itself is a symlink", async () => {
    const { base, root, dataDir, stop } = await bootServer();
    const outside = join(root, "outside");
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "secret.txt"), "secret");
    const storage = `${base}/projects/demo/cron/audit/storage`;
    try {
      await mkdir(join(dataDir, "cron-storage", "demo"), { recursive: true });
      await symlink(outside, join(dataDir, "cron-storage", "demo", "audit"));
      expect((await fetch(storage)).status).toBe(409);
      expect((await patchNote(`${storage}/note`, { note: "x" })).status).toBe(409);
      expect(existsSync(join(outside, "note.md"))).toBe(false);
    } finally {
      await stop();
    }
  });
});
