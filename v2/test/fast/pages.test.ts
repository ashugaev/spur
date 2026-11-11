import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  blankTemplate,
  createPage,
  listPages,
  readPageConfig,
  removePageDir,
  resolvePageFile,
  setPageSource,
  watchPageDir,
} from "../../src/pages.js";
import { StoreError, pageDirPath } from "../../src/stores.js";
import { createTempDir } from "../helpers/common.js";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function dataDir(): Promise<string> {
  const dir = await createTempDir("spur-pages-");
  tempDirs.push(dir);
  return dir;
}

function statusOf(run: () => unknown): number | undefined {
  try {
    run();
  } catch (error) {
    if (error instanceof StoreError) return error.statusCode;
    throw error;
  }
  return undefined;
}

describe("page ids and page.yaml", () => {
  it("validates source before creation and changes only its binding", async () => {
    const dir = await dataDir();
    expect(statusOf(() => createPage(dir, { id: "bad", source: { path: "relative" } }))).toBe(400);
    expect(listPages(dir)).toEqual([]);
    const page = createPage(dir, {
      id: "site",
      title: "Source page",
      runtime: "codex",
      model: "auto",
      source: { path: join(dir, "missing") },
    });
    const config = join(page.path, "page.yaml");
    await writeFile(
      config,
      `${await readFile(config, "utf8")}icon: assets/icon.png\ncustom: keep\n`,
    );
    expect(setPageSource(dir, "site", join(dir, "new"))).toMatchObject({
      title: "Source page",
      icon: "assets/icon.png",
      agent: { runtime: "codex", model: "auto" },
      source: { path: join(dir, "new") },
    });
    expect(await readFile(config, "utf8")).toContain("custom: keep");
    expect(setPageSource(dir, "site", null)).toMatchObject({
      title: "Source page",
      icon: "assets/icon.png",
      agent: { runtime: "codex", model: "auto" },
    });
    expect(readPageConfig(dir, "site").source).toBeUndefined();
    expect(statusOf(() => resolvePageFile(dir, "site", "page.yaml"))).toBe(404);
  });
  it("creates page.yaml and index.html, lists pages and rejects duplicates", async () => {
    const dir = await dataDir();
    const page = createPage(dir, {
      id: "films",
      title: "Films <&>",
      runtime: "codex",
      model: "gpt-5",
    });
    expect(page).toMatchObject({
      id: "films",
      url: "/p/films/",
      agent: { runtime: "codex", model: "gpt-5" },
    });
    expect(readPageConfig(dir, "films")).toEqual({
      title: "Films <&>",
      agent: { runtime: "codex", model: "gpt-5" },
    });
    const html = await readFile(join(pageDirPath(dir, "films"), "index.html"), "utf8");
    expect(html).toContain("Your page starts here.");
    expect(html).not.toContain("<spur-chat>");
    expect(html).toContain("Films &#60;&#38;&#62;");
    expect(html).not.toContain("innerHTML");
    expect(statusOf(() => createPage(dir, { id: "films" }))).toBe(409);
    createPage(dir, { id: "notes" });
    expect(readPageConfig(dir, "notes")).toEqual({ title: "notes", agent: { runtime: "claude" } });
    expect(listPages(dir).map((entry) => entry.id)).toEqual(["films", "notes"]);
  });

  it("validates id, title, runtime, model and template", async () => {
    const dir = await dataDir();
    for (const id of ["Films", "-films", "a".repeat(41), "fi/lms", "..", ""]) {
      expect(statusOf(() => createPage(dir, { id }))).toBe(400);
    }
    expect(statusOf(() => createPage(dir, { id: "a", title: "line\nbreak" }))).toBe(400);
    expect(statusOf(() => createPage(dir, { id: "a", runtime: "gpt" }))).toBe(400);
    expect(statusOf(() => createPage(dir, { id: "a", model: "bad model" }))).toBe(400);
    expect(statusOf(() => createPage(dir, { id: "a", template: "films" }))).toBe(400);
    expect(statusOf(() => readPageConfig(dir, "missing"))).toBe(404);
  });

  it("hides a page with broken page.yaml from the list and removes a page dir", async () => {
    const dir = await dataDir();
    createPage(dir, { id: "good" });
    await mkdir(pageDirPath(dir, "broken"), { recursive: true });
    await writeFile(join(pageDirPath(dir, "broken"), "page.yaml"), "title: [", "utf8");
    expect(listPages(dir).map((entry) => entry.id)).toEqual(["good"]);
    removePageDir(dir, "good");
    expect(listPages(dir)).toEqual([]);
    expect(statusOf(() => removePageDir(dir, "good"))).toBe(404);
  });

  it("escapes the title in the blank template", () => {
    expect(blankTemplate(`"><script>x</script>`)).not.toContain("<script>x</script>");
  });

  it("accepts local PNG metadata and rejects external, hidden and store paths", async () => {
    const dir = await dataDir();
    createPage(dir, { id: "icon" });
    const config = join(pageDirPath(dir, "icon"), "page.yaml");
    await writeFile(config, "title: Renamed\nicon: assets/icon.png\nagent:\n  runtime: codex\n");
    expect(readPageConfig(dir, "icon")).toMatchObject({
      title: "Renamed",
      icon: "assets/icon.png",
    });
    for (const icon of [
      "../x.png",
      "/x.png",
      "https://test/x.png",
      ".x.png",
      "a//x.png",
      "a\\x.png",
      "a.png?x",
      "icon.svg",
      "data.sqlite.png",
      "_spur/icon.png",
      "nested/page.yaml/icon.png",
    ]) {
      await writeFile(config, `title: Icon\nicon: '${icon}'\n`);
      expect(
        statusOf(() => readPageConfig(dir, "icon")),
        icon,
      ).toBe(400);
    }
  });
});

describe("page files", () => {
  it("serves page files with content types and hides dot paths, the store and outside files", async () => {
    const dir = await dataDir();
    createPage(dir, { id: "films" });
    const pageDir = pageDirPath(dir, "films");
    await mkdir(join(pageDir, "js"), { recursive: true });
    await mkdir(join(pageDir, ".git"), { recursive: true });
    await writeFile(join(pageDir, "js", "app.js"), "1", "utf8");
    await writeFile(join(pageDir, "blob.bin"), "1", "utf8");
    await writeFile(join(pageDir, ".env"), "SECRET=1", "utf8");
    await writeFile(join(pageDir, ".git", "config"), "x", "utf8");
    await mkdir(join(pageDir, "_spur"), { recursive: true });
    await writeFile(join(pageDir, "_spur", "icon.png"), "private", "utf8");
    await symlink(join(pageDir, "_spur", "icon.png"), join(pageDir, "icon.png"));
    await symlink(join(pageDir, "page.yaml"), join(pageDir, "config.png"));
    for (const name of ["data.sqlite", "data.sqlite-wal", "data.sqlite-shm"]) {
      await writeFile(join(pageDir, name), "x", "utf8");
    }
    await writeFile(join(dir, "outside.txt"), "secret", "utf8");
    await symlink(join(dir, "outside.txt"), join(pageDir, "link.txt"));
    await symlink(join(pageDir, ".env"), join(pageDir, "env.txt"));

    expect(resolvePageFile(dir, "films", "index.html").contentType).toBe(
      "text/html; charset=utf-8",
    );
    expect(resolvePageFile(dir, "films", "js/app.js").contentType).toBe(
      "text/javascript; charset=utf-8",
    );
    expect(resolvePageFile(dir, "films", "blob.bin").contentType).toBe("application/octet-stream");
    for (const path of [
      ".env",
      ".git/config",
      "data.sqlite",
      "data.sqlite-wal",
      "data.sqlite-shm",
      "../outside.txt",
      "js/../../outside.txt",
      "link.txt",
      "env.txt",
      "js",
      "missing.html",
      "js//app.js",
      "icon.png",
      "config.png",
      "_spur/icon.png",
      "page.yaml",
    ]) {
      expect(
        statusOf(() => resolvePageFile(dir, "films", path)),
        path,
      ).toBe(404);
    }
  });
});

describe("page watcher", () => {
  it("reloads root metadata and static files while ignoring reserved paths at every depth", async () => {
    const dir = await dataDir();
    createPage(dir, { id: "films" });
    const pageDir = pageDirPath(dir, "films");
    await mkdir(join(pageDir, "nested"));
    await mkdir(join(pageDir, "_spur"));
    const reloads: string[] = [];
    const stop = watchPageDir(dir, "films", (path) => reloads.push(path));
    try {
      await writeFile(join(pageDir, ".hidden"), "x", "utf8");
      await writeFile(join(pageDir, "data.sqlite"), "x", "utf8");
      await writeFile(join(pageDir, "nested", "page.yaml"), "title: Private", "utf8");
      await writeFile(join(pageDir, "nested", "data.sqlite-wal"), "x", "utf8");
      await writeFile(join(pageDir, "_spur", "icon.png"), "x", "utf8");
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(reloads).toEqual([]);
      await writeFile(join(pageDir, "index.html"), "a", "utf8");
      await writeFile(join(pageDir, "index.html"), "b", "utf8");
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(reloads).toEqual(["index.html"]);
      await writeFile(join(pageDir, "page.yaml"), "title: Renamed\nicon: icon.png\n", "utf8");
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(reloads).toEqual(["index.html", "page.yaml"]);
    } finally {
      stop();
    }
  });
});
