import { constants } from "node:fs";
import { mkdir, open, readFile, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { PageSourceSync } from "../../src/page-source.js";
import { createPage, listPages, removePageDir } from "../../src/pages.js";
import { pageDirPath, StoreService } from "../../src/stores.js";
import { createTempDir } from "../helpers/common.js";

const roots: string[] = [];
const services: PageSourceSync[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.stop()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await createTempDir("spur-page-source-");
  roots.push(root);
  const data = join(root, "data");
  const source = join(root, "site");
  await mkdir(source);
  await writeFile(join(source, "index.html"), "<p>folder</p>");
  const sync = new PageSourceSync(() => data);
  services.push(sync);
  const status = (id = "site") => sync.summarize(listPages(data).find((page) => page.id === id)!);
  const output = (file: string, id = "site") => readFile(join(pageDirPath(data, id), file), "utf8");
  return { root, data, source, sync, status, output };
}

describe("Page source snapshots", () => {
  it("keeps training/films entries, SQL, IDs and config independent with shared local dependencies", async () => {
    const { data, source, sync, output, status } = await fixture();
    await writeFile(join(source, "training.html"), '<link href="assets/app.css"><p>training</p>');
    await writeFile(join(source, "films.html"), '<script src="app.js"></script><p>films</p>');
    await mkdir(join(source, "assets"));
    await writeFile(join(source, "assets/app.css"), "a{}");
    await writeFile(join(source, "app.js"), "old");
    for (const id of ["training", "films"]) {
      expect(
        (await sync.create({ id, source: { path: join(source, `${id}.html`) } })).sync?.state,
      ).toBe("synced");
    }
    const stores = new StoreService({ dataDir: data, readSession: () => undefined });
    await stores.set("page:training", "items", "one", { value: "training" });
    await stores.set("page:films", "items", "one", { value: "films" });
    const config = await output("page.yaml", "training");
    const time = status("training").sync?.lastSyncedAt;
    await sync.reconcile();
    expect(status("training").sync?.lastSyncedAt).toBe(time);
    await writeFile(join(source, "training.html"), "<p>revised training</p>");
    await rm(join(source, "app.js"));
    await writeFile(join(source, "assets/new.svg"), "<svg/>");
    await sync.reconcile();
    expect(await output("index.html", "training")).toBe("<p>revised training</p>");
    expect(await output("index.html", "films")).toContain("<p>films</p>");
    expect(await output("assets/new.svg", "films")).toBe("<svg/>");
    await expect(output("app.js", "training")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await output("page.yaml", "training")).toBe(config);
    expect((await stores.get("page:training", "items", "one")).data).toEqual({ value: "training" });
    expect((await stores.get("page:films", "items", "one")).data).toEqual({ value: "films" });
    expect(status("films").url).toBe("/p/films/");
  });

  it("detects equal-size equal-mtime edits, removes only owned files, and restores ownership on restart", async () => {
    const { data, source, sync, output } = await fixture();
    await writeFile(join(source, "asset.txt"), "one");
    await sync.create({ id: "site", source: { path: source } });
    await writeFile(join(pageDirPath(data, "site"), "manual.txt"), "keep");
    await writeFile(join(source, "asset.txt"), "two");
    await utimes(join(source, "asset.txt"), 0, 0);
    await sync.reconcile();
    expect(await output("asset.txt")).toBe("two");
    await sync.stop();
    const restarted = new PageSourceSync(() => data);
    services.push(restarted);
    await rm(join(source, "asset.txt"));
    await restarted.reconcile();
    await expect(output("asset.txt")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await output("manual.txt")).toBe("keep");
    expect(restarted.summarize(listPages(data)[0]!).sync?.state).toBe("synced");
  });

  it.each(["directory-to-file", "file-to-directory"])(
    "reconciles owned %s transitions",
    async (transition) => {
      const { data, source, sync, status, output } = await fixture();
      const asset = join(source, "assets");
      if (transition === "directory-to-file") {
        await mkdir(join(asset, "nested"), { recursive: true });
        await writeFile(join(asset, "nested/old.txt"), "old child");
      } else {
        await writeFile(asset, "old file");
      }
      await sync.create({ id: "site", source: { path: source } });
      const stores = new StoreService({ dataDir: data, readSession: () => undefined });
      await stores.set("page:site", "items", "one", { keep: true });
      const config = await output("page.yaml");
      await writeFile(join(pageDirPath(data, "site"), "manual.txt"), "unrelated");
      await rm(asset, { recursive: true });
      if (transition === "directory-to-file") {
        await writeFile(asset, "new file");
      } else {
        await mkdir(asset);
        await writeFile(join(asset, "new.txt"), "new child");
      }
      await sync.reconcile();
      expect(status().sync?.state).toBe("synced");
      expect(await output(transition === "directory-to-file" ? "assets" : "assets/new.txt")).toBe(
        transition === "directory-to-file" ? "new file" : "new child",
      );
      expect(await output("manual.txt")).toBe("unrelated");
      expect(await output("page.yaml")).toBe(config);
      expect((await stores.get("page:site", "items", "one")).data).toEqual({ keep: true });
      // Recover the union manifest retained by an interrupted final commit.
      await writeFile(
        join(pageDirPath(data, "site"), ".source-sync.json"),
        JSON.stringify({
          version: 1,
          files:
            transition === "directory-to-file"
              ? ["assets", "assets/nested/old.txt", "index.html"]
              : ["assets", "assets/new.txt", "index.html"],
        }),
      );
      await sync.reconcile();
      expect(status().sync?.state).toBe("synced");
      expect(await output(transition === "directory-to-file" ? "assets" : "assets/new.txt")).toBe(
        transition === "directory-to-file" ? "new file" : "new child",
      );
    },
  );

  it.each(["manual.txt", "data.sqlite", ".private", "link", "empty-directory"])(
    "retains publication when an owned directory contains unowned %s",
    async (name) => {
      const { root, data, source, sync, status, output } = await fixture();
      await mkdir(join(source, "assets"));
      await writeFile(join(source, "assets/old.txt"), "imported");
      await sync.create({ id: "site", source: { path: source } });
      const collision = join(pageDirPath(data, "site"), "assets", name);
      if (name === "empty-directory") {
        await mkdir(collision);
      } else if (name === "link") {
        await writeFile(join(root, "sentinel"), "unowned");
        await symlink(join(root, "sentinel"), collision);
      } else await writeFile(collision, "unowned");
      await rm(join(source, "assets"), { recursive: true });
      await writeFile(join(source, "assets"), "replacement");
      await writeFile(join(source, "index.html"), "must not publish");
      await sync.reconcile();
      expect(status().sync?.state).toBe("error");
      if (name === "empty-directory") {
        expect(await readdir(collision)).toEqual([]);
      } else expect(await output(`assets/${name}`)).toBe("unowned");
      expect(await output("assets/old.txt")).toBe("imported");
      expect(await output("index.html")).toBe("<p>folder</p>");
    },
  );

  it("retains an unowned file blocking a new source directory", async () => {
    const { data, source, sync, status, output } = await fixture();
    await sync.create({ id: "site", source: { path: source } });
    await writeFile(join(pageDirPath(data, "site"), "assets"), "unowned");
    await mkdir(join(source, "assets"));
    await writeFile(join(source, "assets/new.txt"), "new child");
    await writeFile(join(source, "index.html"), "must not publish");
    await sync.reconcile();
    expect(status().sync?.error).toContain("Unowned destination");
    expect(await output("assets")).toBe("unowned");
    expect(await output("index.html")).toBe("<p>folder</p>");
  });

  it("prunes empty imported directories for later replacement and retains unowned contents", async () => {
    const { data, source, sync, status, output } = await fixture();
    await mkdir(join(source, "assets/nested"), { recursive: true });
    await mkdir(join(source, "kept"));
    await writeFile(join(source, "assets/nested/old.txt"), "old");
    await writeFile(join(source, "kept/old.txt"), "old");
    await sync.create({ id: "site", source: { path: source } });
    await writeFile(join(pageDirPath(data, "site"), "kept/manual.txt"), "unowned");
    await rm(join(source, "assets/nested/old.txt"));
    await rm(join(source, "kept/old.txt"));
    await sync.reconcile();
    expect(status().sync?.state).toBe("synced");
    await expect(readdir(join(pageDirPath(data, "site"), "assets"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await output("kept/manual.txt")).toBe("unowned");
    await rm(join(source, "assets"), { recursive: true });
    await writeFile(join(source, "assets"), "later file");
    await sync.reconcile();
    expect(status().sync?.state).toBe("synced");
    expect(await output("assets")).toBe("later file");
    expect(await output("kept/manual.txt")).toBe("unowned");
  });

  it("skips native/service paths at every depth and preserves the native database", async () => {
    const { data, source, sync, output } = await fixture();
    for (const name of ["page.yaml", "data.sqlite", "data.sqlite-wal", ".secret"]) {
      await writeFile(join(source, name), "malicious");
    }
    await mkdir(join(source, "nested"));
    await mkdir(join(source, "_spur"));
    await writeFile(join(source, "nested/page.yaml"), "malicious");
    await writeFile(join(source, "_spur/sdk.js"), "malicious");
    createPage(data, { id: "site" });
    await writeFile(join(pageDirPath(data, "site"), "data.sqlite"), "native");
    await sync.bind("site", source);
    expect(await output("data.sqlite")).toBe("native");
    expect(await output("page.yaml")).toContain("title: site");
    await expect(output("nested/page.yaml")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(output("_spur/sdk.js")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains the last publication on missing source and entry, then recovers", async () => {
    const { source, sync, status, output } = await fixture();
    await sync.create({ id: "site", source: { path: source } });
    const last = status().sync?.lastSyncedAt;
    await rm(source, { recursive: true });
    await sync.reconcile();
    expect(status().sync).toMatchObject({ state: "error", lastSyncedAt: last });
    expect(await output("index.html")).toBe("<p>folder</p>");
    await mkdir(source);
    await sync.reconcile();
    expect(status().sync?.error).toContain("index.html");
    await writeFile(join(source, "index.html"), "recovered");
    await sync.reconcile();
    expect(status().sync?.state).toBe("synced");
    expect(await output("index.html")).toBe("recovered");
  });

  it("persists an initial inaccessible binding with error and retries", async () => {
    const { root, sync, status } = await fixture();
    const source = join(root, "later");
    expect((await sync.create({ id: "site", source: { path: source } })).sync?.state).toBe("error");
    expect(status().source?.path).toBe(source);
    await mkdir(source);
    await writeFile(join(source, "index.html"), "ready");
    await sync.reconcile();
    expect(status().sync?.state).toBe("synced");
  });

  it.each(["escape", "internal", "cycle", "ancestor"])(
    "rejects %s symlinks before changing output",
    async (kind) => {
      const { root, source, sync, output, status } = await fixture();
      await sync.create({ id: "site", source: { path: source } });
      await writeFile(join(source, "index.html"), "should not publish");
      if (kind === "ancestor") {
        await symlink(source, join(root, "link"));
        await sync.bind("site", join(root, "link/index.html"));
      } else {
        await symlink(
          kind === "escape" ? root : kind === "cycle" ? source : join(source, "index.html"),
          join(source, "link"),
        );
        await sync.reconcile();
      }
      expect(status().sync?.error).toContain("Symlinks");
      expect(await output("index.html")).toBe("<p>folder</p>");
    },
  );

  it("rejects sources overlapping any publication in either direction, accepts sibling prefixes", async () => {
    const { root, data, source, sync, status } = await fixture();
    await sync.create({ id: "site" });
    for (const path of [root, join(data, "pages"), pageDirPath(data, "site")]) {
      await sync.bind("site", path);
      expect(status().sync?.error).toContain("overlap");
    }
    const sibling = join(data, "pages-other");
    await mkdir(sibling);
    await writeFile(join(sibling, "index.html"), "safe");
    await sync.bind("site", sibling);
    expect(status().sync?.state).toBe("synced");
    await sync.bind("site", source);
  });

  it("rejects destination links without touching their outside targets", async () => {
    const { root, data, source, sync, output, status } = await fixture();
    await sync.create({ id: "site", source: { path: source } });
    await writeFile(join(root, "sentinel"), "outside");
    await symlink(join(root, "sentinel"), join(pageDirPath(data, "site"), "asset.txt"));
    await writeFile(join(source, "asset.txt"), "overwrite");
    await writeFile(join(source, "index.html"), "should not publish");
    await sync.reconcile();
    expect(status().sync?.state).toBe("error");
    expect(await readFile(join(root, "sentinel"), "utf8")).toBe("outside");
    expect(await output("index.html")).toBe("<p>folder</p>");
  });

  it("rejects special files and destination type conflicts before publication", async () => {
    const { source, data, sync, status, output } = await fixture();
    await sync.create({ id: "site", source: { path: source } });
    await writeFile(join(source, "index.html"), "must not publish");
    await promisify(execFile)("mkfifo", [join(source, "pipe")]);
    await sync.reconcile();
    expect(status().sync?.error).toContain("Not a regular source file");
    expect(await output("index.html")).toBe("<p>folder</p>");
    await rm(join(source, "pipe"));
    await mkdir(join(pageDirPath(data, "site"), "asset"));
    await writeFile(join(source, "asset"), "conflict");
    await sync.reconcile();
    expect(status().sync?.error).toContain("not a regular file");
    expect(await output("index.html")).toBe("<p>folder</p>");
  });

  it("rejects linked config on bind without changing the outside file", async () => {
    const { root, data, source, sync } = await fixture();
    await sync.create({ id: "site" });
    const config = join(pageDirPath(data, "site"), "page.yaml");
    const outside = join(root, "config");
    const bytes = await readFile(config, "utf8");
    await writeFile(outside, bytes);
    await rm(config);
    await symlink(outside, config);
    await expect(sync.bind("site", source)).rejects.toThrow("Symlinks");
    expect(await readFile(outside, "utf8")).toBe(bytes);
  });

  it.each(["{", '{"version":1,"files":["../victim"]}', '{"version":1,"files":["data.sqlite"]}'])(
    "rejects unsafe manifest %s without deletion",
    async (manifest) => {
      const { data, source, sync, status, output } = await fixture();
      await writeFile(join(source, "asset.txt"), "keep");
      await sync.create({ id: "site", source: { path: source } });
      await writeFile(join(pageDirPath(data, "site"), ".source-sync.json"), manifest);
      await rm(join(source, "asset.txt"));
      await sync.reconcile();
      expect(status().sync?.error).toContain("manifest");
      expect(await output("asset.txt")).toBe("keep");
    },
  );

  it("reports a FIFO manifest without blocking another Page or shutdown", async () => {
    const { data, source, sync, status, output } = await fixture();
    for (const id of ["a-bad", "z-good"]) {
      await sync.create({ id, source: { path: source } });
    }
    const fifo = join(pageDirPath(data, "a-bad"), ".source-sync.json");
    await rm(fifo);
    await promisify(execFile)("mkfifo", [fifo]);
    await writeFile(join(source, "index.html"), "updated");
    const reconciliation = sync.reconcile();
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("FIFO blocked source reconciliation")), 2000);
    });
    try {
      await Promise.race([reconciliation, deadline]);
      expect(status("a-bad").sync?.error).toContain("manifest");
      expect(status("z-good").sync?.state).toBe("synced");
      expect(await output("index.html", "a-bad")).toBe("<p>folder</p>");
      expect(await output("index.html", "z-good")).toBe("updated");
      await Promise.race([sync.stop(), deadline]);
    } finally {
      clearTimeout(timer);
      // Release a blocked read on regression before afterEach drains the service.
      const writer = await open(fifo, constants.O_RDWR | constants.O_NONBLOCK);
      try {
        await reconciliation;
      } finally {
        await writer.close();
      }
    }
  });

  it("serializes detach/delete with queued attempts and drains before stop resolves", async () => {
    const { data, source, sync, status, output } = await fixture();
    await sync.create({ id: "site", source: { path: source } });
    await Promise.all([sync.sync("site"), sync.bind("site", null), sync.sync("site")]);
    expect(status().source).toBeUndefined();
    await writeFile(join(source, "index.html"), "detached");
    await sync.reconcile();
    expect(await output("index.html")).toBe("<p>folder</p>");
    await sync.bind("site", source);
    await Promise.all([
      sync.sync("site"),
      sync.remove("site", async (dir) => removePageDir(dir, "site")),
    ]);
    expect(listPages(data)).toEqual([]);
    await sync.reconcile();
    expect(listPages(data)).toEqual([]);
    await sync.stop();
    await expect(sync.sync("site")).rejects.toThrow("stopped");
  });

  it("drains an admitted operation and cancels queued work on shutdown", async () => {
    const { source, sync, output } = await fixture();
    await sync.create({ id: "site", source: { path: source } });
    let release!: () => void;
    let entered!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const operation = sync.remove("site", async () => {
      entered();
      await barrier;
    });
    await started;
    const queued = sync.bind("site", null);
    const rejected = expect(queued).rejects.toThrow("stopped");
    let stopped = false;
    const stopping = sync.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release();
    await Promise.all([operation, stopping, rejected]);
    expect(await output("index.html")).toBe("<p>folder</p>");
  });
});
