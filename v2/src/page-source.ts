import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  createPage,
  isReservedPagePath,
  listPages,
  PAGE_CONFIG_FILE,
  readPageConfig,
  setPageSource,
  type CreatePageRequest,
  type PageSummary,
  type PageSyncStatus,
} from "./pages.js";
import { pageDirPath, pagesRoot, StoreError } from "./stores.js";

const MANIFEST = ".source-sync.json";
const SYNC_INTERVAL_MS = 2000;
interface Manifest {
  version: 1;
  files: string[];
  lastSyncedAt?: string;
}

function inside(root: string, path: string): boolean {
  const part = relative(root, path);
  return part === "" || (part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part));
}

function validOwnedPath(path: string): boolean {
  return (
    !isAbsolute(path) &&
    !path.includes("\\") &&
    !isReservedPagePath(path) &&
    path.split("/").every((part) => part !== ".." && part !== ".")
  );
}

/** Check every ancestor, including the leaf, without following a link. */
async function noLinks(path: string, allowMissing = false): Promise<void> {
  const parent = dirname(path);
  if (parent !== path) await noLinks(parent, allowMissing);
  try {
    if ((await lstat(path)).isSymbolicLink()) throw new Error(`Symlinks are not allowed: ${path}`);
  } catch (error) {
    if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

async function regularBytes(path: string): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!(await handle.stat()).isFile()) throw new Error(`Not a regular file: ${path}`);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function readManifest(dir: string): Promise<Manifest> {
  const path = join(dir, MANIFEST);
  try {
    await noLinks(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, files: [] };
    throw error;
  }
  let raw: unknown;
  try {
    raw = JSON.parse((await regularBytes(path)).toString("utf8")) as unknown;
  } catch {
    throw new Error("Invalid source sync manifest; no imported files were deleted");
  }
  if (typeof raw !== "object" || raw === null) throw new Error("Invalid source sync manifest");
  const value = raw as { version?: unknown; files?: unknown; lastSyncedAt?: unknown };
  if (
    value.version !== 1 ||
    !Array.isArray(value.files) ||
    !value.files.every((file: unknown) => typeof file === "string" && validOwnedPath(file)) ||
    (value.lastSyncedAt !== undefined &&
      (typeof value.lastSyncedAt !== "string" || !Number.isFinite(Date.parse(value.lastSyncedAt))))
  ) {
    throw new Error("Invalid source sync manifest; no imported files were deleted");
  }
  return {
    version: 1,
    files: value.files as string[],
    ...(typeof value.lastSyncedAt === "string" ? { lastSyncedAt: value.lastSyncedAt } : {}),
  };
}

/** One daemon-owned scheduler; mutations and reconciliation share each Page's queue. */
export class PageSourceSync {
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly statuses = new Map<string, { source: string; status: PageSyncStatus }>();
  private timer: NodeJS.Timeout | undefined;
  private pass: Promise<void> | undefined;
  private stopped = false;

  constructor(private readonly dataDir: () => string) {}

  private key(dataDir: string, id: string): string {
    return `${dataDir}\0${id}`;
  }

  private queue<T>(id: string, operation: (dataDir: string) => Promise<T>): Promise<T> {
    if (this.stopped) return Promise.reject(new Error("Page source sync has stopped"));
    const dataDir = this.dataDir();
    const key = this.key(dataDir, id);
    const result = (this.queues.get(key) ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => {
        if (this.stopped) throw new Error("Page source sync has stopped");
        return operation(dataDir);
      });
    this.queues.set(key, result);
    void result
      .finally(() => {
        if (this.queues.get(key) === result) this.queues.delete(key);
      })
      .catch(() => undefined);
    return result;
  }

  summarize(page: PageSummary): PageSummary {
    if (!page.source) return page;
    const cached = this.statuses.get(this.key(this.dataDir(), page.id));
    const sync =
      cached?.source === page.source.path ? cached.status : { state: "pending" as const };
    return { ...page, sync };
  }

  create(request: CreatePageRequest): Promise<PageSummary> {
    if (typeof request.id !== "string")
      return Promise.reject(new StoreError(400, "id is required"));
    return this.queue(request.id, async (dataDir) => {
      const page = createPage(dataDir, request);
      await this.attempt(dataDir, page.id);
      return this.summarize(page);
    });
  }

  bind(id: string, path: string | null): Promise<PageSummary> {
    return this.queue(id, async (dataDir) => {
      readPageConfig(dataDir, id);
      await noLinks(join(pageDirPath(dataDir, id), PAGE_CONFIG_FILE));
      const page = setPageSource(dataDir, id, path);
      this.statuses.delete(this.key(dataDir, id));
      await this.attempt(dataDir, id);
      return this.summarize(page);
    });
  }

  remove(id: string, remove: (dataDir: string) => Promise<void>): Promise<void> {
    return this.queue(id, async (dataDir) => {
      await remove(dataDir);
      this.statuses.delete(this.key(dataDir, id));
    });
  }

  sync(id: string): Promise<void> {
    return this.queue(id, (dataDir) => this.attempt(dataDir, id));
  }

  start(): void {
    if (this.timer || this.stopped) return;
    const tick = () => {
      if (this.pass || this.stopped) return;
      this.pass = this.reconcile()
        .catch(() => undefined)
        .finally(() => {
          this.pass = undefined;
        });
    };
    tick();
    this.timer = setInterval(tick, SYNC_INTERVAL_MS);
    this.timer.unref();
  }

  async reconcile(): Promise<void> {
    for (const page of listPages(this.dataDir())) {
      if (this.stopped) return;
      if (page.source) await this.sync(page.id).catch(() => undefined);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    await Promise.allSettled([...this.queues.values(), ...(this.pass ? [this.pass] : [])]);
  }

  private async attempt(dataDir: string, id: string): Promise<void> {
    const page = readPageConfig(dataDir, id);
    if (!page.source) return;
    const key = this.key(dataDir, id);
    const source = page.source.path;
    const previous = this.statuses.get(key);
    let status: PageSyncStatus = {
      state: "syncing",
      ...(previous?.source === source && previous.status.lastSyncedAt
        ? { lastSyncedAt: previous.status.lastSyncedAt }
        : {}),
    };
    this.statuses.set(key, { source, status });
    const dir = pageDirPath(dataDir, id);
    let stage: string | undefined;
    try {
      await noLinks(dir);
      const identity = await lstat(dir);
      const configBytes = await regularBytes(join(dir, PAGE_CONFIG_FILE));
      if (readPageConfig(dataDir, id).source?.path !== source) {
        throw new Error("Page source changed during sync; retrying");
      }
      const manifest = await readManifest(dir);
      if (manifest.lastSyncedAt) status = { ...status, lastSyncedAt: manifest.lastSyncedAt };
      const selected = resolve(source);
      await noLinks(selected);
      const sourceStat = await lstat(selected);
      if (
        !sourceStat.isDirectory() &&
        (!sourceStat.isFile() || ![".html", ".htm"].includes(extname(selected).toLowerCase()))
      ) {
        throw new Error("Source must be a site directory or an HTML file");
      }
      const root = sourceStat.isDirectory() ? selected : dirname(selected);
      status = { ...status, root };
      this.statuses.set(key, { source, status });
      const publicationRoot = await realpath(pagesRoot(dataDir));
      if (inside(root, publicationRoot) || inside(publicationRoot, root)) {
        throw new Error("Source root must not overlap Page storage");
      }
      const rootIdentity = await lstat(root);
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".source-sync-") && entry.isDirectory()) {
          await rm(join(dir, entry.name), { recursive: true, force: true });
        }
      }
      stage = await mkdtemp(join(dir, ".source-sync-"));
      const files: string[] = [];
      const snapshot = async (folder: string, prefix: string): Promise<void> => {
        for (const entry of await readdir(folder, { withFileTypes: true })) {
          const name = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (isReservedPagePath(name)) continue;
          if (!validOwnedPath(name)) throw new Error(`Invalid source path: ${name}`);
          const path = join(root, name);
          await noLinks(path);
          const stats = await lstat(path);
          if (stats.isDirectory()) await snapshot(path, name);
          else if (stats.isFile()) {
            const target = join(stage!, name);
            await mkdir(dirname(target), { recursive: true });
            await writeFile(target, await regularBytes(path));
            files.push(name);
          } else throw new Error(`Not a regular source file: ${path}`);
        }
      };
      await snapshot(root, "");
      if (!sourceStat.isDirectory()) {
        const name = relative(root, selected).split(sep).join("/");
        if (!files.includes(name)) throw new Error("Selected HTML is a reserved source file");
        await writeFile(join(stage, "index.html"), await regularBytes(join(stage, name)));
        if (!files.includes("index.html")) files.push("index.html");
      }
      if (!files.includes("index.html"))
        throw new Error("Source directory must contain index.html");
      files.sort();
      const currentRoot = await lstat(root);
      if (currentRoot.dev !== rootIdentity.dev || currentRoot.ino !== rootIdentity.ino) {
        throw new Error("Source root changed during sync; retrying");
      }
      const stillCurrent = async (): Promise<void> => {
        if (this.stopped || this.dataDir() !== dataDir) throw new Error("Source sync canceled");
        await noLinks(dir);
        const current = await lstat(dir);
        if (
          identity.dev !== current.dev ||
          identity.ino !== current.ino ||
          !configBytes.equals(await regularBytes(join(dir, PAGE_CONFIG_FILE)))
        ) {
          throw new Error("Page configuration changed during sync; retrying");
        }
      };
      await stillCurrent();
      const planned = [...new Set([...manifest.files, ...files])];
      for (const name of planned) {
        if (!validOwnedPath(name) || !inside(dir, join(dir, name)))
          throw new Error("Unsafe imported path");
        await noLinks(join(dir, name), true);
        try {
          if (!(await lstat(join(dir, name))).isFile()) {
            throw new Error(`Imported destination is not a regular file: ${name}`);
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      let changed = manifest.files.join("\n") !== files.join("\n") || !manifest.lastSyncedAt;
      const writes: string[] = [];
      for (const name of files) {
        try {
          if (
            !(await regularBytes(join(dir, name))).equals(await regularBytes(join(stage, name)))
          ) {
            writes.push(name);
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          writes.push(name);
        }
      }
      changed ||= writes.length > 0;
      const persist = async (value: Manifest): Promise<void> => {
        await stillCurrent();
        await noLinks(join(dir, MANIFEST), true);
        const temporary = join(stage!, ".manifest");
        await writeFile(temporary, JSON.stringify(value));
        await rename(temporary, join(dir, MANIFEST));
      };
      if (changed) {
        // Persist union before mutation: a crash cannot orphan newly imported files.
        await persist({ ...manifest, files: planned });
        for (const name of writes) {
          await stillCurrent();
          await noLinks(join(dir, name), true);
          await mkdir(dirname(join(dir, name)), { recursive: true });
          await rename(join(stage, name), join(dir, name));
        }
        for (const name of manifest.files) {
          if (files.includes(name)) continue;
          await stillCurrent();
          await noLinks(join(dir, name), true);
          await rm(join(dir, name), { force: true });
        }
        status = { ...status, lastSyncedAt: new Date().toISOString() };
        await persist({ version: 1, files, lastSyncedAt: status.lastSyncedAt! });
      }
      this.statuses.set(key, { source, status: { ...status, state: "synced" } });
    } catch (error) {
      this.statuses.set(key, {
        source,
        status: {
          ...status,
          state: "error",
          error: `${error instanceof Error ? error.message : String(error)}. ${
            status.lastSyncedAt
              ? "Last published version remains available."
              : "Source has not been published."
          }`,
        },
      });
    } finally {
      if (stage) {
        const stagedDir = stage;
        await noLinks(stagedDir)
          .then(() => rm(stagedDir, { recursive: true, force: true }))
          .catch(() => undefined);
      }
    }
  }
}
