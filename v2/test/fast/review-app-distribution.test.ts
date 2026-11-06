import { createHash } from "node:crypto";
import type * as ChildProcess from "node:child_process";
import { createWriteStream } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import type * as FileSystem from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createGzip, gzipSync } from "node:zlib";
import type * as Zlib from "node:zlib";
import type * as Tar from "tar";
import type * as TypeScript from "typescript";
import { afterEach, expect, test, vi } from "vitest";

interface ArchiveIndex {
  members: Map<string, { type: string; size: number; sha256: string }>;
  captured: Map<string, Buffer>;
  archiveSHA256: string;
  compressed: number;
  decoded: number;
  count: number;
}
interface Edge {
  from: string;
  specifier: string;
  target: string;
  requireCall: boolean;
}
interface References {
  utility: Map<string, Buffer>;
  commander: Map<string, Buffer>;
}
interface Verifier {
  preflightDependencies: (
    root?: string,
  ) => Promise<{ tar: typeof Tar; typescript: typeof TypeScript }>;
  readArchive: (input: Buffer | string, references?: Map<string, Buffer>) => Promise<ArchiveIndex>;
  assertRequiredEntries: (index: ArchiveIndex, entries: string[]) => void;
  assertCommanderIntegrity: (bytes: Buffer) => void;
  verifyGraph: (files: Map<string, Buffer>, typescript: typeof TypeScript) => Edge[];
  verifyClosure: (
    index: ArchiveIndex,
    references: References,
    commander: ArchiveIndex,
  ) => Promise<{ files: Map<string, Buffer>; edges: Edge[] }>;
  executeFrozenClosure: (
    root: string,
    files: Map<string, Buffer>,
    edges: Edge[],
  ) => Promise<unknown>;
}
const faults = vi.hoisted(() => ({ mode: "", writes: 0, children: 0, allowChildren: false }));
function fixtureJson<T>(text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error("Invalid fixture JSON");
  }
}
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FileSystem>();
  return {
    ...actual,
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      faults.writes++;
      return actual.writeFile(...args);
    },
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      if (faults.mode === "owner-link" && String(args[0]).endsWith("/v2/node_modules/tar"))
        throw Object.assign(new Error("fixture missing owner"), { code: "ENOENT" });
      return actual.lstat(...args);
    },
    realpath: async (...args: Parameters<typeof actual.realpath>) => {
      if (faults.mode === "foreign-root" && String(args[0]).endsWith("/v2/node_modules/tar"))
        return "/foreign-store/tar";
      if (
        faults.mode === "public-entry" &&
        String(args[0]).endsWith("/tar/dist/commonjs/index.min.js")
      )
        return "/foreign-store/index.min.js";
      return actual.realpath(...args);
    },
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      const value = await actual.readFile(...args);
      if (!faults.mode) return value;
      const path = String(args[0]);
      let text = String(value);
      if (faults.mode === "owner-declaration" && path.endsWith("/v2/package.json")) {
        const data = fixtureJson<{ devDependencies: { tar: string } }>(text);
        data.devDependencies.tar = "^7.5.21";
        text = JSON.stringify(data);
      }
      if (
        ["owner-version", "owner-exports", "owner-main", "owner-type"].includes(faults.mode) &&
        path.endsWith("/tar/package.json")
      ) {
        const data = fixtureJson<{
          version: string;
          exports?: unknown;
          main: string;
          type: string;
        }>(text);
        if (faults.mode === "owner-version") data.version = "7.5.20";
        if (faults.mode === "owner-exports") delete data.exports;
        if (faults.mode === "owner-main") data.main = "./dist/esm/index.min.js";
        if (faults.mode === "owner-type") data.type = "commonjs";
        text = JSON.stringify(data);
      }
      if (faults.mode === "installed-lock" && path.endsWith("/.pnpm/lock.yaml"))
        text += "\n# stale\n";
      if (path.endsWith("/pnpm-lock.yaml") || path.endsWith("/.pnpm/lock.yaml")) {
        if (faults.mode === "importer")
          text = text.replace("specifier: 7.5.21", "specifier: 7.5.20");
        if (faults.mode === "integrity")
          text = text.replace("sha512-XdhtCvlMywwx", "sha512-INVALID");
      }
      if (faults.mode === "layout" && path.endsWith("/.modules.yaml"))
        text = text.replace("layoutVersion: 5", "layoutVersion: 4");
      return text === String(value) ? value : typeof value === "string" ? text : Buffer.from(text);
    },
  };
});
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  const { promisify } = await import("node:util");
  const original = promisify(actual.execFile);
  const execFile = Object.assign(
    (...args: Parameters<typeof actual.execFile>) => {
      faults.children++;
      return actual.execFile(...args);
    },
    {
      [promisify.custom]: (...args: Parameters<typeof original>) => {
        faults.children++;
        return original(...args);
      },
    },
  );
  return { ...actual, execFile };
});
vi.mock("node:zlib", async (importOriginal) => {
  const actual = await importOriginal<typeof Zlib>();
  const { Transform } = await import("node:stream");
  return {
    ...actual,
    createGunzip: (...args: Parameters<typeof actual.createGunzip>) => {
      if (faults.mode !== "decoded-limit") return actual.createGunzip(...args);
      return new Transform({
        readableObjectMode: true,
        transform(_chunk, _encoding, callback) {
          this.push({ length: 2 * 1024 ** 3 + 1 });
          callback();
        },
      });
    },
  };
});

const verifier: Verifier = await import(
  new URL("../../../scripts/verify-review-app-package.mjs", import.meta.url).href
);
// This file must not be run until the parent/CI has approved the genuine installation.
// No missing-owner skip, manual link or synthetic positive grants that prerequisite.
const qualified = await verifier.preflightDependencies();
const { tar } = qualified;
const root = fileURLToPath(new URL("../../../", import.meta.url));
const require = createRequire(join(root, "v2/package.json"));
const directories: string[] = [];
afterEach(async () => {
  const unexpectedChildren = !faults.allowChildren && faults.children !== 0;
  faults.mode = "";
  faults.writes = 0;
  faults.children = 0;
  faults.allowChildren = false;
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
  expect(unexpectedChildren).toBe(false);
});

type EntryType =
  | "File"
  | "OldFile"
  | "Directory"
  | "Link"
  | "SymbolicLink"
  | "FIFO"
  | "CharacterDevice"
  | "BlockDevice"
  | "ContiguousFile";
interface Entry {
  path: string;
  data?: Buffer;
  type?: EntryType;
  mode?: number;
  linkpath?: string;
}
function header(
  path: string,
  size: number,
  type: EntryType | "ExtendedHeader" | "GlobalExtendedHeader" | "NextFileHasLongPath",
  mode = 0o644,
  linkpath = "",
) {
  const block = Buffer.alloc(512);
  new tar.Header({ path, size, type, mode, linkpath }).encode(block);
  return block;
}
function body(bytes: Buffer) {
  return Buffer.concat([bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512)]);
}
function member(entry: Entry) {
  const data = entry.data ?? Buffer.alloc(0);
  return Buffer.concat([
    header(entry.path, data.length, entry.type ?? "File", entry.mode, entry.linkpath),
    body(data),
  ]);
}
function archive(entries: Entry[], before = Buffer.alloc(0), after = Buffer.alloc(0)) {
  return gzipSync(Buffer.concat([before, ...entries.map(member), Buffer.alloc(1024), after]));
}
function metadata(
  bytes: Buffer,
  type: "ExtendedHeader" | "GlobalExtendedHeader" | "NextFileHasLongPath" = "ExtendedHeader",
) {
  return Buffer.concat([header("PaxHeader/fixture", bytes.length, type), body(bytes)]);
}
function framed(key: string, value: string) {
  const field = `${key}=${value}\n`;
  let size = Buffer.byteLength(field) + 2;
  for (;;) {
    const record = `${size} ${field}`;
    const actual = Buffer.byteLength(record);
    if (actual === size) return Buffer.from(record);
    size = actual;
  }
}
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "spur-review-package-test-"));
  directories.push(path);
  return path;
}

test("public-owner Header/Pax reader indexes typed bytes without materialization", async () => {
  const bytes = Buffer.from("selected");
  const pax = new tar.Pax({ path: "package/selected.js", comment: "ascii" }).encode();
  const input = archive([{ path: "package/short", data: bytes }], pax);
  const writes = faults.writes;
  const index = await verifier.readArchive(input, new Map([["package/selected.js", bytes]]));
  expect(index.captured.get("package/selected.js")).toEqual(bytes);
  expect(index.members.get("package/selected.js")).toMatchObject({
    type: "File",
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
  expect(index.archiveSHA256).toBe(createHash("sha256").update(input).digest("hex"));
  expect(faults.writes).toBe(writes);
});

test.each([
  "/package/a",
  "C:/package/a",
  "package/C:/a",
  "package\\a",
  "package//a",
  "package/./a",
  "package/../a",
  "other/a",
  "package/a\0b",
  "package/a\nb",
  "package/\uFFFD",
])("reader rejects unsafe effective member %j", async (path) => {
  const prefix = new tar.Pax({ path }).encode();
  await expect(
    verifier.readArchive(archive([{ path: "package/short" }], prefix)),
  ).rejects.toThrow();
});
test.each([
  "Link",
  "SymbolicLink",
  "FIFO",
  "CharacterDevice",
  "BlockDevice",
  "ContiguousFile",
] as const)("reader rejects surfaced %s", async (type) => {
  await expect(
    verifier.readArchive(
      archive([{ path: "package/a", type, linkpath: type.includes("Link") ? "target" : "" }]),
    ),
  ).rejects.toThrow();
});
test.each(
  (
    [
      [{ path: "package/a" }, { path: "package/a" }],
      [{ path: "package/a" }, { path: "package/a/", type: "Directory" }],
      [{ path: "package/a" }, { path: "package/a/b" }],
      [{ path: "package/a/b" }, { path: "package/a" }],
    ] satisfies Entry[][]
  ).map((entries) => ({ entries })),
)("reader rejects duplicate/ancestor order $entries", async ({ entries }) => {
  await expect(verifier.readArchive(archive(entries))).rejects.toThrow();
});
test.each([0o666, 0o4755, 0o2755, 0o1755])("reader rejects selected mode %o", async (mode) => {
  await expect(
    verifier.readArchive(
      archive([{ path: "package/a", data: Buffer.from("a"), mode }]),
      new Map([["package/a", Buffer.from("a")]]),
    ),
  ).rejects.toThrow();
});

test.each([
  "length",
  "duplicate",
  "control",
  "unknown",
  "mode",
  "link",
  "global",
  "gnu",
  "chain",
  "dangling",
  "oversize",
  "replacement",
  "invalid-utf8",
])("public metadata guard refuses %s before returning selected bytes", async (mode) => {
  let text = framed("comment", "ascii");
  if (mode === "length") text = Buffer.from("999 comment=ascii\n");
  if (mode === "duplicate") text = Buffer.concat([text, text]);
  if (mode === "control") text = framed("comment", "a\0b");
  if (["unknown", "mode", "link"].includes(mode))
    text = framed(mode === "link" ? "linkpath" : mode, "value");
  if (mode === "oversize") text = framed("comment", "x".repeat(1024 ** 2));
  if (mode === "replacement" || mode === "invalid-utf8") {
    text = framed("comment", "\uFFFD");
    if (mode === "invalid-utf8") {
      const start = text.indexOf(Buffer.from("\uFFFD"));
      text = Buffer.concat([
        text.subarray(0, start),
        Buffer.from([0xff]),
        text.subarray(start + 3),
      ]);
    }
  }
  const type =
    mode === "global"
      ? "GlobalExtendedHeader"
      : mode === "gnu"
        ? "NextFileHasLongPath"
        : "ExtendedHeader";
  let prefix = metadata(text, type);
  if (mode === "chain") prefix = Buffer.concat([prefix, prefix]);
  const entries = mode === "dangling" ? [] : [{ path: "package/a", data: Buffer.from("a") }];
  const writes = faults.writes;
  const result = verifier.readArchive(
    archive(entries, prefix),
    new Map([["package/a", Buffer.from("a")]]),
  );
  if (mode === "replacement" || mode === "invalid-utf8")
    await expect(result).rejects.toThrow("replacement");
  else await expect(result).rejects.toThrow();
  expect(faults.writes).toBe(writes);
});

test("valid multibyte metadata passes intact; split vendor replacement is refused", async () => {
  const intact = new tar.Pax({ comment: "é", path: "package/a" }).encode();
  expect(
    (await verifier.readArchive(archive([{ path: "package/a" }], intact))).members.has("package/a"),
  ).toBe(true);
  let split: Buffer | undefined;
  for (let length = 470; length < 520; length++) {
    const value = framed("comment", "x".repeat(length) + "é");
    if (value.indexOf(Buffer.from("é")) === 511) split = value;
  }
  if (!split) throw new Error("Missing multibyte boundary fixture");
  await expect(
    verifier.readArchive(archive([{ path: "package/a" }], metadata(split))),
  ).rejects.toThrow("replacement");
});
test("ASCII PAX and EOF remain correct across multiple public parser slices", async () => {
  const prefix = new tar.Pax({ path: "package/a", comment: "x".repeat(1200) }).encode();
  const index = await verifier.readArchive(
    archive([{ path: "package/a", data: Buffer.alloc(1025, 7) }], prefix),
  );
  expect(index.members.get("package/a")?.size).toBe(1025);
});
test("real public Parser resumes queued metadata/EOF after backpressure", async () => {
  const write = tar.Parser.prototype.write;
  let forced = false;
  vi.spyOn(tar.Parser.prototype, "write").mockImplementation(function (this: Tar.Parser, ...args) {
    const result: unknown = Reflect.apply(write, this, args);
    if (typeof result !== "boolean") throw new Error("Unexpected parser write result");
    if (!forced) {
      forced = true;
      queueMicrotask(() => this.emit("drain"));
      return false;
    }
    return result;
  });
  const prefix = new tar.Pax({ path: "package/a", comment: "x".repeat(1200) }).encode();
  const index = await verifier.readArchive(
    archive([{ path: "package/a", data: Buffer.from("a") }], prefix),
  );
  expect(forced).toBe(true);
  expect(index.members.get("package/a")?.size).toBe(1);
});

test.each([
  "checksum",
  "body",
  "gzip",
  "crc",
  "eof",
  "unaligned",
  "tail",
  "concat",
  "nested",
  "ratio",
])("reader rejects %s corruption even after a selected member", async (mode) => {
  const file = member({ path: "package/a", data: Buffer.from("a") });
  let decoded = Buffer.concat([file, Buffer.alloc(1024)]);
  if (mode === "checksum") decoded[0] = 1;
  if (mode === "body")
    decoded = Buffer.concat([header("package/a", 1024, "File"), Buffer.alloc(1)]);
  if (mode === "eof") decoded = file;
  if (mode === "unaligned") decoded = Buffer.concat([decoded, Buffer.alloc(1)]);
  if (mode === "tail")
    decoded = Buffer.concat([decoded, member({ path: "package/late", type: "FIFO" })]);
  if (mode === "nested") decoded = gzipSync(decoded);
  if (mode === "ratio")
    decoded = Buffer.concat([
      member({ path: "package/zeros", data: Buffer.alloc(2 * 1024 ** 2) }),
      Buffer.alloc(1024),
    ]);
  let input = gzipSync(decoded);
  if (mode === "gzip") input = input.subarray(0, input.length - 5);
  if (mode === "crc") input[input.length - 8] = (input[input.length - 8] ?? 0) ^ 1;
  if (mode === "concat") input = Buffer.concat([input, archive([{ path: "package/late" }])]);
  await expect(
    verifier.readArchive(input, new Map([["package/a", Buffer.from("a")]])),
  ).rejects.toThrow();
});
test.each(["type", "duplicate", "ancestor", "metadata"])(
  "selected prefix never admits a late hostile %s member",
  async (mode) => {
    const selected = Buffer.from("selected");
    const prefix = member({ path: "package/selected", data: selected });
    let late = member({ path: "package/late", type: "FIFO" });
    if (mode === "duplicate") late = member({ path: "package/selected", data: selected });
    if (mode === "ancestor") late = member({ path: "package/selected/child" });
    if (mode === "metadata")
      late = Buffer.concat([metadata(framed("mode", "0777")), member({ path: "package/late" })]);
    const input = gzipSync(Buffer.concat([prefix, late, Buffer.alloc(1024)]));
    const writes = faults.writes;
    await expect(
      verifier.readArchive(input, new Map([["package/selected", selected]])),
    ).rejects.toThrow();
    expect(faults.writes).toBe(writes);
  },
);
test("archive count, metadata and compressed-file ceilings are enforced", async () => {
  const entries = Array.from({ length: 65_537 }, (_, index) => ({ path: `package/f${index}` }));
  await expect(verifier.readArchive(archive(entries))).rejects.toThrow("entry limit");
  const path = join(await directory(), "sparse.tgz");
  const file = await open(path, "wx", 0o600);
  try {
    await file.truncate(1024 ** 3 + 1);
  } finally {
    await file.close();
  }
  await expect(verifier.readArchive(path)).rejects.toThrow("invalid archive input");
});
test("synthetic decoder counter fault crosses decoded ceiling before materialization", async () => {
  faults.mode = "decoded-limit";
  const writes = faults.writes;
  await expect(verifier.readArchive(archive([{ path: "package/a" }]))).rejects.toThrow(
    "decoded limit",
  );
  expect(faults.writes).toBe(writes);
});
test("drains the observed 143MB unselected size without a 16MiB capture ceiling", async () => {
  const path = join(await directory(), "large.tgz");
  const size = 143_144_904;
  const chunk = Buffer.from(Array.from({ length: 64 * 1024 }, (_, index) => index % 251));
  await pipeline(
    Readable.from(
      (async function* () {
        yield header("package/large", size, "File");
        for (let left = size; left > 0; left -= chunk.length)
          yield chunk.subarray(0, Math.min(left, chunk.length));
        yield Buffer.alloc((512 - (size % 512)) % 512);
        yield member({ path: "package/selected", data: Buffer.from("ok") });
        yield Buffer.alloc(1024);
      })(),
    ),
    createGzip(),
    createWriteStream(path, { flags: "wx", mode: 0o600 }),
  );
  const index = await verifier.readArchive(
    path,
    new Map([["package/selected", Buffer.from("ok")]]),
  );
  expect(index.members.get("package/large")?.size).toBe(size);
  expect(index.captured.size).toBe(1);
});

test.each(["a1", "a1b", "a-mcp", "a2", "a-large"])(
  "migrated %s fixture proves reader/required-list PHASE only",
  async (mode) => {
    const required = (await readFile(join(root, "v2/required-package-files.txt"), "utf8"))
      .trim()
      .split("\n");
    let names = [...required];
    if (mode === "a1" || mode === "a1b")
      names = names.filter((name) => name !== "web/dist-server/web-server.js");
    if (mode === "a1b") names.push("web/dist-server/web-server.js.map");
    if (mode === "a-mcp") names = names.filter((name) => name !== "dist/mcp-http.js");
    if (mode === "a-large")
      names.push(
        ...Array.from({ length: 5000 }, (_, index) => `filler/${index}-${"x".repeat(100)}`),
      );
    const input = archive(names.map((name) => ({ path: `package/${name}` })));
    const index = await verifier.readArchive(input);
    if (["a1", "a1b", "a-mcp"].includes(mode))
      expect(() => verifier.assertRequiredEntries(index, required)).toThrow(
        "missing required member",
      );
    else {
      verifier.assertRequiredEntries(index, required);
      if (mode === "a-large") expect(index.decoded).toBeGreaterThan(64 * 1024);
      // Complete presence alone never satisfies production selected-byte/closure admission.
      await expect(
        verifier.readArchive(
          input,
          new Map([["package/dist/review-app-cli.js", Buffer.from("nonempty emitted reference")]]),
        ),
      ).rejects.toThrow();
    }
  },
);

async function syntheticClosure() {
  const commanderRoot = dirname(require.resolve("commander"));
  const commander = new Map<string, Buffer>();
  for (const name of [
    "esm.mjs",
    "index.js",
    "lib/argument.js",
    "lib/command.js",
    "lib/error.js",
    "lib/help.js",
    "lib/option.js",
    "lib/suggestSimilar.js",
    "package.json",
    "LICENSE",
  ])
    commander.set(`package/${name}`, await readFile(join(commanderRoot, name)));
  const utility = new Map<string, Buffer>([
    [
      "package/dist/review-app-cli.js",
      Buffer.from(
        'import "./review-app.js"; import {Command} from "commander"; export const createReviewAppProgram=()=>new Command(); export const run=async()=>{};',
      ),
    ],
    [
      "package/dist/review-app.js",
      Buffer.from(
        'import "./review-interface.js"; import "./review-state.js"; import "./github-app.js";',
      ),
    ],
    ...["review-interface.js", "review-state.js", "github-app.js"].map((name): [string, Buffer] => [
      `package/dist/${name}`,
      Buffer.from("export const fixture=true;"),
    ]),
    ["package/package.json", await readFile(join(root, "v2/package.json"))],
  ]);
  const pack = (files: Map<string, Buffer>) =>
    archive([...files].map(([path, data]) => ({ path, data })));
  const candidate = await verifier.readArchive(pack(utility), utility);
  const dependency = await verifier.readArchive(pack(commander), commander);
  return { references: { utility, commander }, candidate, dependency, pack };
}
test("synthetic closure mechanics use real public AST and installed references; no artifact approval", async () => {
  const fixture = await syntheticClosure();
  const { files, edges } = await verifier.verifyClosure(
    fixture.candidate,
    fixture.references,
    fixture.dependency,
  );
  expect(files.has("dist/review-app-cli.js")).toBe(true);
  expect(edges.some((edge) => edge.target === "node_modules/commander/esm.mjs")).toBe(true);
  expect(() =>
    verifier.assertCommanderIntegrity(fixture.pack(fixture.references.commander)),
  ).toThrow("SRI mismatch");
});
test.each([
  "missing-js",
  "tampered-js",
  "metadata",
  "version",
  "exports",
  "license",
  "dependency-bytes",
])("synthetic closure refuses %s without executing it", async (mode) => {
  const fixture = await syntheticClosure();
  if (mode === "missing-js") fixture.candidate.captured.delete("package/dist/github-app.js");
  if (mode === "tampered-js") {
    const changed = new Map(fixture.references.utility);
    changed.set("package/dist/github-app.js", Buffer.from("altered"));
    await expect(
      verifier.readArchive(fixture.pack(changed), fixture.references.utility),
    ).rejects.toThrow();
    return;
  }
  if (mode === "metadata")
    fixture.candidate.captured.set(
      "package/package.json",
      Buffer.from('{"name":"other","version":"1.0.0","type":"module"}'),
    );
  if (mode === "license") {
    const changed = new Map(fixture.references.commander);
    changed.delete("package/LICENSE");
    await expect(
      verifier.readArchive(fixture.pack(changed), fixture.references.commander),
    ).rejects.toThrow("missing selected member");
    return;
  }
  if (mode === "dependency-bytes") {
    const changed = new Map(fixture.references.commander);
    changed.set("package/lib/help.js", Buffer.from("altered"));
    await expect(
      verifier.readArchive(fixture.pack(changed), fixture.references.commander),
    ).rejects.toThrow();
    return;
  }
  if (mode === "version" || mode === "exports") {
    const metadata = fixtureJson<{ version: string; exports: unknown }>(
      String(fixture.references.commander.get("package/package.json")),
    );
    if (mode === "version") metadata.version = "14.0.0";
    else metadata.exports = { ".": "./other.js" };
    const bytes = Buffer.from(JSON.stringify(metadata));
    fixture.references.commander.set("package/package.json", bytes);
    fixture.dependency.captured.set("package/package.json", bytes);
  }
  const writes = faults.writes;
  await expect(
    verifier.verifyClosure(fixture.candidate, fixture.references, fixture.dependency),
  ).rejects.toThrow();
  expect(faults.writes).toBe(writes);
});
test.each([
  'import("./"+"review-app.js");',
  'const r=require; r("commander");',
  'import "../outside.js";',
  'eval("1");',
  'globalThis["eval"]("1");',
  'import {createRequire} from "node:module";',
  'new Function("return 1");',
  'const p={}; p.command("unsafe", "executable description");',
  "export const = ;",
])("AST rejects loader/outside/executable syntax %s", async (source) => {
  const fixture = await syntheticClosure();
  const { files } = await verifier.verifyClosure(
    fixture.candidate,
    fixture.references,
    fixture.dependency,
  );
  files.set("dist/review-app-cli.js", Buffer.from(source));
  expect(() => verifier.verifyGraph(files, qualified.typescript)).toThrow();
});

test.each([
  "owner-declaration",
  "owner-link",
  "foreign-root",
  "public-entry",
  "owner-version",
  "owner-exports",
  "owner-main",
  "owner-type",
  "installed-lock",
  "importer",
  "integrity",
  "layout",
])("real-owner preflight negative mechanics refuse %s", async (mode) => {
  faults.mode = mode;
  await expect(verifier.preflightDependencies()).rejects.toThrow();
});
test("unapproved synthetic trees never supply genuine installation provenance", async () => {
  const tree = await directory();
  await mkdir(join(tree, "v2"));
  await writeFile(join(tree, "v2/package.json"), await readFile(join(root, "v2/package.json")));
  await writeFile(join(tree, "pnpm-lock.yaml"), await readFile(join(root, "pnpm-lock.yaml")));
  await expect(verifier.preflightDependencies(tree)).rejects.toThrow();
  // External installer approval is not inferred from these fixture files or a caller boolean.
});

test("missing physical dependency refuses execution even with a poisoned ancestor", async () => {
  const fixture = await syntheticClosure();
  const { files, edges } = await verifier.verifyClosure(
    fixture.candidate,
    fixture.references,
    fixture.dependency,
  );
  const tree = await directory();
  for (const [name, bytes] of files) {
    if (name === "node_modules/commander/index.js") continue;
    const path = join(tree, "package", name);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
  }
  await expect(verifier.executeFrozenClosure(tree, files, edges)).rejects.toThrow();
  await expect(lstat(join(tree, "poison-effect"))).rejects.toMatchObject({ code: "ENOENT" });
});
test("synthetic startup transport omits inherited hooks and credentials before Node starts", async () => {
  const fixture = await syntheticClosure();
  const { files, edges } = await verifier.verifyClosure(
    fixture.candidate,
    fixture.references,
    fixture.dependency,
  );
  const tree = await directory();
  const marker = join(tree, "inherited-effect");
  const preload = join(tree, "inherited-preload.cjs");
  await writeFile(
    preload,
    `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "preload");`,
  );
  const inherited = [
    "NODE_OPTIONS",
    "NODE_PATH",
    "NODE_V8_COVERAGE",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
    "HTTPS_PROXY",
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "SPUR_CONFIG",
  ];
  files.set(
    "dist/review-app-cli.js",
    Buffer.from(`
    import {writeFileSync} from "node:fs";
    import {fileURLToPath} from "node:url";
    if (${JSON.stringify(inherited)}.some(key => process.env[key] !== undefined)) {
      writeFileSync(${JSON.stringify(marker)}, "inherited");
      process.exit(91);
    }
    if (process.env.SPUR_SESSION !== "package-fixture") process.exit(92);
    if (process.argv[1] === fileURLToPath(import.meta.url)) {
      if (process.argv.length === 3 && process.argv[2] === "--help") process.stdout.write("review-app\\n");
      else process.exitCode = 1;
    }
  `),
  );
  for (const [name, bytes] of files) {
    const path = join(tree, "package", name);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
  }
  for (const key of inherited)
    vi.stubEnv(
      key,
      key === "NODE_OPTIONS" ? `--require ${JSON.stringify(preload)}` : "synthetic-poison",
    );
  vi.stubEnv("SPUR_SESSION", "synthetic-wrong-session");
  faults.allowChildren = true;
  try {
    // Direct startup/help/refusal probes must pass; the incomplete synthetic entry
    // must then fail the real fixed harness, never manufacture actual-candidate proof.
    await expect(verifier.executeFrozenClosure(tree, files, edges)).rejects.toThrow("child failed");
    expect(faults.children).toBe(8);
    await expect(lstat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    vi.unstubAllEnvs();
  }
});
test("fake child timeout terminates and returns failure; no budget widening", async () => {
  const fixture = await syntheticClosure();
  const { files, edges } = await verifier.verifyClosure(
    fixture.candidate,
    fixture.references,
    fixture.dependency,
  );
  files.set("dist/review-app-cli.js", Buffer.from("setInterval(()=>{},1000);"));
  const tree = await directory();
  for (const [name, bytes] of files) {
    const path = join(tree, "package", name);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
  }
  faults.allowChildren = true;
  await expect(verifier.executeFrozenClosure(tree, files, edges)).rejects.toThrow("child failed");
  expect(faults.children).toBe(1);
});
test.each(["external-fs", "prefixed-external"])(
  "production CLI sanitizes a synthetic private-path sentinel from %s failure",
  async (mode) => {
    const tree = await directory();
    const privatePath = join(tree, "synthetic-private-path", "archive.tgz");
    const message = `${mode === "prefixed-external" ? "review-app-package: " : ""}EACCES: ${privatePath}`;
    const marker = join(tree, "injected-error");
    const preload = join(tree, "filesystem-fault.mjs");
    await writeFile(
      preload,
      `
    import filesystem from "node:fs/promises";
    import {writeFileSync} from "node:fs";
    import {syncBuiltinESMExports} from "node:module";
    const original = filesystem.lstat;
    filesystem.lstat = async (...args) => {
      if (String(args[0]) === ${JSON.stringify(join(root, "v2/dist"))}) {
        writeFileSync(${JSON.stringify(marker)}, ${JSON.stringify(message)});
        throw Object.assign(new Error(${JSON.stringify(message)}), {code: "EACCES", path: ${JSON.stringify(privatePath)}});
      }
      return original(...args);
    };
    syncBuiltinESMExports();
  `,
    );
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    faults.allowChildren = true;
    const failure: unknown = await promisify(execFile)(
      process.execPath,
      [
        "--import",
        pathToFileURL(preload).href,
        join(root, "scripts/verify-review-app-package.mjs"),
        "--tarball",
        privatePath,
      ],
      {
        cwd: tree,
        env: { HOME: tree, TMPDIR: tree, PATH: tree, LANG: "C", LC_ALL: "C" },
        timeout: 5_000,
        killSignal: "SIGKILL",
        maxBuffer: 64 * 1024,
      },
    ).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: 1,
      stdout: "",
      stderr: "review-app-package: verification failed\n",
    });
    expect(await readFile(marker, "utf8")).toBe(message);
    expect(faults.children).toBe(1);
  },
);
test("existing PR/release hooks retain actual-tarball verification before install", async () => {
  const deploy = await readFile(join(root, "scripts/test-deploy.sh"), "utf8");
  const release = await readFile(join(root, ".github/workflows/release.yml"), "utf8");
  const hook = await readFile(join(root, "scripts/verify-package-tarball.sh"), "utf8");
  expect(deploy.indexOf('scripts/verify-package-tarball.sh" "$TGZ"')).toBeLessThan(
    deploy.indexOf("npm install -g"),
  );
  expect(release).toContain('scripts/verify-package-tarball.sh" "$tgz"');
  expect(hook).toContain('verify-review-app-package.mjs" --tarball "$TARBALL"');
  expect(hook).not.toMatch(/tar -t|grep|skip|presence-only|postpack/);
});
