import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { get } from "node:https";
import { createRequire, isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { createGunzip } from "node:zlib";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const execFileAsync = promisify(execFile);
const identities = {
  tar: {
    section: "devDependencies",
    specifier: "7.5.21",
    version: "7.5.21",
    entry: "dist/commonjs/index.min.js",
    integrity:
      "sha512-XdhtCvlMywwxpCW8YEq3lOXBJpUPTR2OHHcwLPO3HwsJqOHa2Ok/oJ7ruGzp+JrKoRPVCzJwAdEjqLW/vNRPHA==",
  },
  typescript: {
    section: "devDependencies",
    specifier: "^5.7.0",
    version: "5.9.3",
    entry: "lib/typescript.js",
    integrity:
      "sha512-jl1vZzPDinLr9eUt3J/t7V6FgNEw9QjvBPdysz9KfQDD41fQrC2Y4vKQdiaUpFT4bXlb1RHhLpp8wtm6M5TgSw==",
  },
  yaml: {
    section: "dependencies",
    specifier: "^2.8.3",
    version: "2.8.3",
    entry: "dist/index.js",
    integrity:
      "sha512-AvbaCLOO2Otw/lW5bmh9d/WEdcDFdQp2Z2ZUH3pX9U2ihyUY0nvLv7J6TrWowklRGPYbB/IuIMfYgxaCPg5Bpg==",
  },
};

function refuse(reason) {
  throw new Error(`review-app-package: ${reason}`);
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) refuse(label);
  return value;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function dataFile(path, label) {
  try {
    return await readFile(path);
  } catch {
    refuse(label);
  }
}

async function jsonFile(path, label) {
  const raw = await dataFile(path, label);
  try {
    return object(JSON.parse(raw.toString("utf8")), label);
  } catch {
    refuse(label);
  }
}

function beneath(root, path) {
  const child = relative(root, path);
  return child !== "" && !isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`);
}

/** Filesystem qualification; installer provenance is independently bound by the parent/CI. */
export async function preflightDependencies(root = repositoryRoot) {
  const ownerPath = join(root, "v2/package.json");
  const owner = await jsonFile(ownerPath, "missing owner package metadata");
  if (owner.name !== "@shugaev/spur") refuse("wrong dependency owner");
  for (const [name, identity] of Object.entries(identities)) {
    if (object(owner[identity.section], "missing owner declaration")[name] !== identity.specifier)
      refuse(`missing or mismatched direct owner declaration: ${name}`);
  }

  const sourceLock = await dataFile(join(root, "pnpm-lock.yaml"), "missing source lock");
  const installedLock = await dataFile(
    join(root, "node_modules/.pnpm/lock.yaml"),
    "missing installed lock",
  );
  if (!sourceLock.equals(installedLock)) refuse("source and installed lock differ");
  const moduleMapRaw = await dataFile(
    join(root, "node_modules/.modules.yaml"),
    "missing installed module map",
  );
  let store;
  try {
    store = await realpath(join(root, "node_modules/.pnpm"));
  } catch {
    refuse("missing installed virtual store");
  }
  const require = createRequire(ownerPath);
  const packages = {};
  for (const [name, identity] of Object.entries(identities)) {
    const ownerLink = join(root, "v2/node_modules", name);
    let packageRoot;
    try {
      if (!(await lstat(ownerLink)).isSymbolicLink()) refuse("owner package must be a pnpm link");
      packageRoot = await realpath(ownerLink);
    } catch {
      refuse(`missing genuine owner link: ${name}`);
    }
    if (
      !beneath(store, packageRoot) ||
      packageRoot !== join(store, `${name}@${identity.version}`, "node_modules", name)
    )
      refuse(`owner package outside declared snapshot: ${name}`);
    const metadata = await jsonFile(join(packageRoot, "package.json"), "invalid package metadata");
    if (metadata.name !== name || metadata.version !== identity.version)
      refuse(`owner package identity mismatch: ${name}`);
    if (metadata.main !== `./${identity.entry}` || metadata.imports !== undefined)
      refuse(`owner package main/imports mismatch: ${name}`);
    if (name === "typescript" && (metadata.exports !== undefined || metadata.type !== undefined))
      refuse("TypeScript public metadata mismatch");
    if (
      name === "tar" &&
      (metadata.type !== "module" ||
        !sameData(object(metadata.exports, "missing tar exports")["."], {
          import: { types: "./dist/esm/index.d.ts", default: "./dist/esm/index.min.js" },
          require: { types: "./dist/commonjs/index.d.ts", default: "./dist/commonjs/index.min.js" },
        }))
    )
      refuse("tar public exports mismatch");
    if (
      name === "yaml" &&
      (metadata.type !== "commonjs" ||
        !sameData(object(metadata.exports, "missing yaml exports")["."], {
          types: "./dist/index.d.ts",
          node: "./dist/index.js",
          default: "./browser/index.js",
        }))
    )
      refuse("yaml public exports mismatch");
    let publicTarget;
    try {
      publicTarget = await realpath(require.resolve(name));
      const self = createRequire(join(packageRoot, "package.json"));
      if (publicTarget !== (await realpath(self.resolve(name))))
        refuse("owner/public resolution mismatch");
    } catch {
      refuse(`public package resolution failed: ${name}`);
    }
    if (
      !beneath(packageRoot, publicTarget) ||
      relative(packageRoot, publicTarget) !== identity.entry
    )
      refuse(`unexpected public entry: ${name}`);
    packages[name] = {
      root: packageRoot,
      ownerLink,
      publicTarget,
      publicSHA256: sha256(await dataFile(publicTarget, "missing public entry")),
      version: identity.version,
    };
  }

  // YAML is bootstrapped only after lock equality, exact links, metadata and public resolution.
  const yaml = require("yaml");
  const parse = (raw, label) => {
    const document = yaml.parseDocument(raw.toString("utf8"), { uniqueKeys: true });
    if (document.errors.length) refuse(label);
    return object(document.toJS({ maxAliasCount: 100 }), label);
  };
  const lock = parse(sourceLock, "invalid source lock");
  const modules = parse(moduleMapRaw, "invalid installed module map");
  if (
    lock.lockfileVersion !== "9.0" ||
    modules.layoutVersion !== 5 ||
    typeof modules.packageManager !== "string" ||
    !/^pnpm@9\./.test(modules.packageManager) ||
    object(modules.included, "missing dependency inclusion").devDependencies !== true ||
    typeof modules.virtualStoreDir !== "string" ||
    (await realpath(resolve(root, "node_modules", modules.virtualStoreDir))) !== store
  )
    refuse("unsupported installed pnpm layout");
  const importer = object(
    object(lock.importers, "missing lock importers").v2,
    "missing v2 importer",
  );
  const records = object(lock.packages, "missing locked package records");
  const snapshots = object(lock.snapshots, "missing locked snapshots");
  for (const [name, identity] of Object.entries(identities)) {
    const entry = object(
      object(importer[identity.section], "missing importer section")[name],
      "missing direct importer dependency",
    );
    if (entry.specifier !== identity.specifier || entry.version !== identity.version)
      refuse(`stale direct importer: ${name}`);
    const key = `${name}@${identity.version}`;
    const resolution = object(
      object(records[key], "missing locked package").resolution,
      "missing SRI",
    );
    if (resolution.integrity !== identity.integrity) refuse(`locked integrity mismatch: ${name}`);
    object(snapshots[key], "missing dependency snapshot");
  }
  const tarDependencies = {
    "@isaacs/fs-minipass": "4.0.1",
    chownr: "3.0.0",
    minipass: "7.1.2",
    minizlib: "3.1.0",
    yallist: "5.0.0",
  };
  const tarSnapshot = object(snapshots["tar@7.5.21"].dependencies, "missing tar dependencies");
  if (Object.keys(tarSnapshot).length !== Object.keys(tarDependencies).length)
    refuse("unexpected tar dependency snapshot");
  for (const [name, version] of Object.entries(tarDependencies)) {
    if (tarSnapshot[name] !== version) refuse("tar transitive version mismatch");
    const key = `${name}@${version}`;
    object(records[key], "missing tar transitive package");
    object(snapshots[key], "missing tar transitive snapshot");
  }
  const tar = require("tar");
  if (![tar.Parser, tar.Header, tar.Pax].every((value) => typeof value === "function"))
    refuse("missing public tar reader exports");
  return {
    tar,
    typescript: require("typescript"),
    report: { owner: "v2/package.json", lockSHA256: sha256(sourceLock), store, packages },
  };
}

const archiveLimits = {
  compressed: 1024 ** 3,
  decoded: 2 * 1024 ** 3,
  entries: 65_536,
  metadata: 1024 ** 2,
  ratio: 1000,
};
const paxKeys = new Set([
  "path",
  "size",
  "uid",
  "gid",
  "uname",
  "gname",
  "mtime",
  "atime",
  "ctime",
  "charset",
  "comment",
  "SCHILY.dev",
  "SCHILY.ino",
  "SCHILY.nlink",
]);

function metadataRecord(text) {
  if (typeof text !== "string" || text.includes("\uFFFD"))
    refuse("replacement character in metadata");
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length > archiveLimits.metadata) refuse("metadata limit");
  const keys = new Set();
  for (let offset = 0; offset < bytes.length; ) {
    const space = bytes.indexOf(32, offset);
    if (space < 0) refuse("metadata length framing");
    const decimal = bytes.subarray(offset, space).toString("ascii");
    if (!/^[1-9][0-9]*$/.test(decimal)) refuse("metadata length framing");
    const length = Number(decimal);
    const end = offset + length;
    if (
      !Number.isSafeInteger(length) ||
      end > bytes.length ||
      end <= space + 1 ||
      bytes[end - 1] !== 10
    )
      refuse("metadata length framing");
    const field = bytes.subarray(space + 1, end - 1).toString("utf8");
    if (/[\u0000-\u001f\u007f\uFFFD]/u.test(field))
      refuse("metadata control or replacement character");
    const equal = field.indexOf("=");
    const key = field.slice(0, equal);
    if (equal <= 0 || !paxKeys.has(key) || keys.has(key))
      refuse("unsupported or duplicate metadata key");
    keys.add(key);
    offset = end;
  }
  return keys;
}

function memberName(path, directory) {
  if (
    typeof path !== "string" ||
    !path ||
    /[\\\u0000-\u001f\u007f\uFFFD]/u.test(path) ||
    /(?:^|\/)[a-zA-Z]:/.test(path) ||
    path.startsWith("/")
  )
    refuse("unsafe member path");
  const name = directory && path.endsWith("/") ? path.slice(0, -1) : path;
  const parts = name.split("/");
  if (
    parts[0] !== "package" ||
    (!directory && parts.length < 2) ||
    parts.some((part) => !part || part === "." || part === "..")
  )
    refuse("noncanonical package member");
  return name;
}

async function* compressedInput(input) {
  if (Buffer.isBuffer(input)) {
    if (input.length > archiveLimits.compressed) refuse("compressed limit");
    for (let offset = 0; offset < input.length; offset += 64 * 1024)
      yield input.subarray(offset, offset + 64 * 1024);
    return;
  }
  const file = await open(input, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > archiveLimits.compressed) refuse("invalid archive input");
    for (;;) {
      const buffer = Buffer.alloc(64 * 1024);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      yield buffer.subarray(0, bytesRead);
    }
  } finally {
    await file.close();
  }
}

/** Phase API: validates the complete archive before returning any captured selected bytes. */
export async function readArchive(input, references = new Map()) {
  const { tar } = await preflightDependencies();
  const parser = new tar.Parser({ strict: true, maxMetaEntrySize: archiveLimits.metadata });
  let failure;
  const fail = (reason) => {
    if (failure) return;
    failure = reason instanceof Error ? reason : new Error(`review-app-package: ${reason}`);
    parser.abort(failure);
  };
  const ended = new Promise((accept, reject) => {
    parser.once("end", accept);
    parser.on("error", (error) => {
      failure ??= error;
      reject(error);
    });
    parser.on("abort", (error) => {
      failure ??= error;
      reject(error);
    });
  });
  // Errors can precede the final await while streaming; retain them without an unhandled rejection.
  void ended.catch(() => undefined);
  parser.on("warn", () => fail("archive warning"));
  parser.on("ignoredEntry", () => fail("ignored archive member or metadata"));
  let eof = false;
  let pendingMetadata;
  let count = 0;
  const members = new Map();
  const descendants = new Set();
  const captured = new Map();
  const captureLimit = [...references.values()].reduce((sum, bytes) => sum + bytes.length, 0);
  let capturedBytes = 0;
  parser.on("meta", (text) => {
    try {
      if (++count > archiveLimits.entries || pendingMetadata) refuse("metadata count or chain");
      pendingMetadata = metadataRecord(text);
    } catch (error) {
      fail(error);
    }
  });
  parser.on("eof", () => {
    if (pendingMetadata) fail("dangling metadata");
    eof = true;
  });
  parser.on("entry", (entry) => {
    try {
      if (++count > archiveLimits.entries) refuse("entry limit");
      const directory = entry.type === "Directory";
      if (!directory && entry.type !== "File" && entry.type !== "OldFile")
        refuse("unsupported member type");
      if (
        !Number.isSafeInteger(entry.size) ||
        entry.size < 0 ||
        entry.linkpath ||
        (directory && entry.size !== 0)
      )
        refuse("invalid member size or link");
      if (
        entry.globalExtended ||
        (pendingMetadata && !entry.extended) ||
        (!pendingMetadata && entry.extended)
      )
        refuse("invalid effective metadata ownership");
      pendingMetadata = undefined;
      const name = memberName(entry.path, directory);
      if (members.has(name) || (!directory && descendants.has(name)))
        refuse("duplicate or ancestor member");
      const parts = name.split("/");
      for (let index = 1; index < parts.length; index++) {
        const parent = parts.slice(0, index).join("/");
        if (members.has(parent) && members.get(parent).type !== "Directory")
          refuse("file ancestor");
        descendants.add(parent);
      }
      const member = { type: entry.type, size: entry.size };
      members.set(name, member);
      const bodyHash = createHash("sha256");
      entry.on("data", (chunk) => bodyHash.update(chunk));
      entry.once("end", () => {
        member.sha256 = bodyHash.digest("hex");
      });
      const expected = references.get(name);
      if (expected) {
        if (
          directory ||
          !Number.isSafeInteger(entry.mode) ||
          entry.mode < 0 ||
          entry.mode > 0o7777 ||
          (entry.mode & 0o7022) !== 0 ||
          entry.size > expected.length ||
          (name !== "package/package.json" && entry.size !== expected.length)
        )
          refuse("unsafe selected member mode or length");
        const chunks = [];
        let size = 0;
        entry.on("data", (chunk) => {
          size += chunk.length;
          capturedBytes += chunk.length;
          if (size > expected.length || capturedBytes > captureLimit) fail("selected byte limit");
          else chunks.push(chunk);
        });
        entry.once("end", () => {
          const bytes = Buffer.concat(chunks);
          if (
            bytes.length !== entry.size ||
            (name !== "package/package.json" && !bytes.equals(expected))
          )
            fail("selected bytes differ from reference");
          else captured.set(name, bytes);
        });
      }
      entry.on("error", fail);
      entry.resume();
    } catch (error) {
      entry.resume();
      fail(error);
    }
  });

  let compressed = 0;
  let decoded = 0;
  let remainder = Buffer.alloc(0);
  const hash = createHash("sha256");
  const source = Readable.from(
    (async function* () {
      for await (const bytes of compressedInput(input)) {
        compressed += bytes.length;
        if (compressed > archiveLimits.compressed) refuse("compressed limit");
        hash.update(bytes);
        yield bytes;
      }
    })(),
  );
  const gzip = createGunzip();
  source.on("error", (error) => gzip.destroy(error));
  source.pipe(gzip);
  try {
    for await (const bytes of gzip) {
      decoded += bytes.length;
      if (decoded > archiveLimits.decoded) refuse("decoded limit");
      remainder = Buffer.concat([remainder, bytes]);
      while (remainder.length >= 512) {
        const block = remainder.subarray(0, 512);
        remainder = remainder.subarray(512);
        if (
          decoded - remainder.length === 512 &&
          ["1f8b", "425a68", "fd377a585a00", "28b52ffd"].some(
            (magic) => block.subarray(0, magic.length / 2).toString("hex") === magic,
          )
        )
          refuse("nested compression");
        if (eof) {
          if (block.some((value) => value !== 0)) refuse("nonzero archive tail");
        } else {
          let drained;
          const drain = new Promise((accept) => {
            drained = accept;
            parser.once("drain", drained);
          });
          if (!parser.write(block)) await Promise.race([drain, ended]);
          parser.removeListener("drain", drained);
          await nextTurn();
          if (failure) throw failure;
        }
      }
    }
    if (remainder.length || !compressed || decoded / compressed > archiveLimits.ratio)
      refuse("archive alignment or expansion ratio");
    parser.end();
    await ended;
    if (failure) throw failure;
    if (!eof || pendingMetadata) refuse("missing complete archive EOF");
    for (const name of references.keys())
      if (!captured.has(name)) refuse(`missing selected member: ${name}`);
    return { members, captured, archiveSHA256: hash.digest("hex"), compressed, decoded, count };
  } catch (error) {
    fail(error);
    throw error;
  } finally {
    source.destroy();
    gzip.destroy();
    await Promise.all([
      finished(source, { cleanup: true }).catch(() => undefined),
      finished(gzip, { cleanup: true }).catch(() => undefined),
    ]);
  }
}

export function assertRequiredEntries(index, entries) {
  for (const entry of entries) {
    if (!entry || entry.startsWith("#")) continue;
    const member = index.members.get(`package/${entry}`);
    if (!member || !["File", "OldFile"].includes(member.type))
      refuse(`missing required member: package/${entry}`);
  }
}

const utilityFiles = [
  "review-app-cli.js",
  "review-app.js",
  "review-interface.js",
  "review-state.js",
  "github-app.js",
];
const commanderFiles = [
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
];
const commanderIntegrity =
  "sha512-/rFeCpNJQbhSZjGVwO9RFV3xPqbnERS8MmIQzCtD/zl6gpJuV/bMLuN92oG3F7d8oDEHHRrujSXNUr8fpjntKw==";

async function regularBytes(root, name) {
  const parts = name.split("/");
  for (let index = 1; index < parts.length; index++) {
    const stat = await lstat(join(root, ...parts.slice(0, index)));
    if (!stat.isDirectory() || stat.isSymbolicLink())
      refuse("symlink or nondirectory reference ancestor");
  }
  const file = await open(
    join(root, name),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    if (!(await file.stat()).isFile()) refuse("nonregular reference file");
    return await file.readFile();
  } finally {
    await file.close();
  }
}

function jsonBytes(bytes, label) {
  try {
    return object(JSON.parse(bytes.toString("utf8")), label);
  } catch {
    refuse(label);
  }
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stable(value[key])]),
    );
  return value;
}

function sameData(left, right) {
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
}

function commanderMetadata(bytes) {
  const metadata = jsonBytes(bytes, "invalid Commander metadata");
  if (
    metadata.name !== "commander" ||
    metadata.version !== "13.1.0" ||
    metadata.main !== "./index.js" ||
    metadata.type !== "commonjs" ||
    metadata.imports !== undefined ||
    !sameData(metadata.exports, {
      ".": {
        require: { types: "./typings/index.d.ts", default: "./index.js" },
        import: { types: "./typings/esm.d.mts", default: "./esm.mjs" },
        default: "./index.js",
      },
      "./esm.mjs": { types: "./typings/esm.d.mts", import: "./esm.mjs" },
    }) ||
    [metadata.dependencies, metadata.optionalDependencies, metadata.peerDependencies].some(
      (value) =>
        value !== undefined &&
        Object.keys(object(value, "invalid Commander dependencies")).length !== 0,
    )
  )
    refuse("Commander package resolution metadata mismatch");
  return metadata;
}

async function referencesFromCheckout(root) {
  const utility = new Map();
  for (const file of utilityFiles)
    utility.set(`package/dist/${file}`, await regularBytes(join(root, "v2"), `dist/${file}`));
  utility.set("package/package.json", await regularBytes(join(root, "v2"), "package.json"));
  const require = createRequire(join(root, "v2/package.json"));
  const manifest = await realpath(join(root, "v2/node_modules/commander/package.json"));
  const commanderRoot = dirname(manifest);
  const commander = new Map();
  for (const file of commanderFiles)
    commander.set(`package/${file}`, await regularBytes(commanderRoot, file));
  commanderMetadata(commander.get("package/package.json"));
  if ((await realpath(require.resolve("commander"))) !== join(commanderRoot, "index.js"))
    refuse("installed Commander public resolution mismatch");
  return { utility, commander };
}

export function assertCommanderIntegrity(bytes) {
  if (`sha512-${createHash("sha512").update(bytes).digest("base64")}` !== commanderIntegrity)
    refuse("official Commander SRI mismatch");
}

async function officialCommander() {
  const bytes = await new Promise((accept, reject) => {
    const request = get(
      "https://registry.npmjs.org/commander/-/commander-13.1.0.tgz",
      {
        headers: { Accept: "application/octet-stream" },
        signal: AbortSignal.timeout(30_000),
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.destroy();
          reject(new Error("review-app-package: official Commander acquisition failed"));
          return;
        }
        const chunks = [];
        let count = 0;
        response.on("data", (chunk) => {
          count += chunk.length;
          if (count > 16 * 1024 ** 2)
            response.destroy(new Error("review-app-package: Commander download limit"));
          else chunks.push(chunk);
        });
        response.once("end", () => accept(Buffer.concat(chunks)));
        response.once("error", reject);
      },
    );
    request.once("error", reject);
  });
  assertCommanderIntegrity(bytes);
  return bytes;
}

/** Phase API: static graph proof only, never permission to execute an unverified candidate. */
export function verifyGraph(files, typescript) {
  const entry = "dist/review-app-cli.js";
  const dependencyRoot = "node_modules/commander/";
  const allowed = new Set([
    ...utilityFiles.map((name) => `dist/${name}`),
    ...commanderFiles
      .filter((name) => /\.(?:js|mjs)$/.test(name))
      .map((name) => dependencyRoot + name),
  ]);
  const seen = new Set();
  const edges = [];
  const visitFile = (name) => {
    if (seen.has(name)) return;
    if (!allowed.has(name) || !files.has(name)) refuse("graph outside frozen closure");
    seen.add(name);
    const syntax = typescript.createSourceFile(
      name,
      files.get(name).toString("utf8"),
      typescript.ScriptTarget.Latest,
      true,
      typescript.ScriptKind.JS,
    );
    if (syntax.parseDiagnostics.length) refuse("JavaScript parse error");
    const commander = name.startsWith(dependencyRoot);
    const edge = (specifier, requireCall) => {
      if (isBuiltin(specifier)) {
        if (["module", "node:module", "vm", "node:vm"].includes(specifier))
          refuse("loader/eval builtin");
        return;
      }
      let target;
      if (specifier === "commander" && !commander)
        target = dependencyRoot + (requireCall ? "index.js" : "esm.mjs");
      else if (specifier.startsWith("./") || specifier.startsWith("../")) {
        target = relative("/", resolve("/", dirname(name), specifier))
          .split(sep)
          .join("/");
        if (!files.has(target) && requireCall && files.has(`${target}.js`)) target += ".js";
      } else refuse("external or aliased graph edge");
      if (
        !allowed.has(target) ||
        (!commander && target.startsWith("node_modules/") && !target.startsWith(dependencyRoot))
      )
        refuse("graph outside frozen closure");
      edges.push({ from: name, specifier, target, requireCall });
      visitFile(target);
    };
    const walk = (node) => {
      if (typescript.isImportDeclaration(node) || typescript.isExportDeclaration(node)) {
        if (node.moduleSpecifier) {
          if (!typescript.isStringLiteral(node.moduleSpecifier)) refuse("computed module edge");
          edge(node.moduleSpecifier.text, false);
        }
      }
      if (
        typescript.isIdentifier(node) &&
        ["eval", "Function", "createRequire", "createRequireFromPath"].includes(node.text)
      )
        refuse("eval or loader alias");
      if (
        typescript.isElementAccessExpression(node) &&
        typescript.isStringLiteral(node.argumentExpression) &&
        ["require", "eval", "Function", "createRequire"].includes(node.argumentExpression.text)
      )
        refuse("computed loader alias");
      if (typescript.isIdentifier(node) && node.text === "require") {
        const parent = node.parent;
        const call = typescript.isCallExpression(parent) && parent.expression === node;
        const main =
          commander &&
          typescript.isPropertyAccessExpression(parent) &&
          parent.expression === node &&
          parent.name.text === "main";
        if (!call && !main) refuse("require alias");
      }
      if (typescript.isCallExpression(node)) {
        const expression = node.expression;
        if (
          expression.kind === typescript.SyntaxKind.ImportKeyword ||
          (typescript.isIdentifier(expression) && expression.text === "require")
        ) {
          if (node.arguments.length !== 1 || !typescript.isStringLiteral(node.arguments[0]))
            refuse("computed import/require");
          edge(node.arguments[0].text, expression.kind !== typescript.SyntaxKind.ImportKeyword);
        }
        if (typescript.isPropertyAccessExpression(expression)) {
          if (["require", "eval", "createRequire", "_load"].includes(expression.name.text))
            refuse("loader alias");
          if (
            !commander &&
            (expression.name.text === "addCommand" ||
              (expression.name.text === "command" && node.arguments.length !== 1))
          )
            refuse("executable-style command registration");
        }
      }
      typescript.forEachChild(node, walk);
    };
    walk(syntax);
  };
  visitFile(entry);
  if (seen.size !== allowed.size) refuse("missing expected closure edge");
  return edges;
}

async function materialize(root, files) {
  const directories = new Set([root]);
  for (const [name, bytes] of files) {
    const parts = name.split("/");
    for (let index = 1; index < parts.length; index++) {
      const directory = join(root, ...parts.slice(0, index));
      if (!directories.has(directory)) {
        await mkdir(directory, { mode: 0o700 });
        directories.add(directory);
      }
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) refuse("unsafe selected output ancestor");
    }
    await writeFile(join(root, name), bytes, { flag: "wx", mode: 0o600, flush: true });
  }
}

async function physicalGraph(root, files, edges) {
  for (const name of files.keys()) {
    const path = join(root, name);
    if ((await realpath(path)) !== path || !(await lstat(path)).isFile())
      refuse("nonphysical closure member");
  }
  for (const { from, specifier, target, requireCall } of edges) {
    const require = createRequire(join(root, from));
    const resolved =
      specifier === "commander" && !requireCall
        ? join(root, "node_modules/commander/esm.mjs")
        : require.resolve(specifier);
    if ((await realpath(resolved)) !== join(root, target))
      refuse("physical resolution escaped closure");
  }
}

const executionHarness = String.raw`
import { generateKeyPairSync, createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const [entry, root] = process.argv.slice(2);
const assert = (condition, reason) => { if (!condition) throw new Error(reason); };
const calls = [];
const comments = [];
let nativePosts = 0, badReadback = false;
globalThis.fetch = async (input, options) => {
  const url = new URL(String(input));
  const method = options?.method ?? "GET";
  assert(url.origin === "https://api.github.com", "unexpected HTTP origin");
  calls.push(method + " " + url.pathname);
  if (method === "POST" && url.pathname.includes("/reviews")) nativePosts++;
  const token = new Headers(options?.headers).get("Authorization")?.slice(7) ?? "";
  let appId;
  if (/^fixture-[12]$/.test(token)) appId = Number(token.slice(-1));
  else {
    let payload;
    try { payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")); }
    catch { throw new Error("invalid fixture JWT"); }
    appId = Number(payload.iss);
  }
  assert(appId === 1 || appId === 2, "unexpected fixture App");
  const login = (appId === 1 ? "code" : "browser") + "[bot]";
  const path = url.pathname;
  if (method === "GET" && path === "/app") return Response.json({ id: appId, slug: login.slice(0, -5) });
  if (method === "GET" && path === "/repos/fixture/repo/installation") return Response.json({ id: 3, app_id: appId });
  if (method === "POST" && path === "/app/installations/3/access_tokens")
    return Response.json({ token: "fixture-" + appId, expires_at: new Date(Date.now() + 3600000).toISOString(), permissions: { pull_requests: "write", metadata: "read" } });
  if (method === "GET" && path === "/repos/fixture/repo") return Response.json({ id: 4, full_name: "fixture/repo" });
  if (method === "GET" && path === "/repos/fixture/repo/pulls/7")
    return Response.json({ state: "open", head: { sha: "a".repeat(40) }, base: { sha: "b".repeat(40) }, user: { login: "fixture-author" } });
  if (path === "/repos/fixture/repo/issues/7/comments") {
    if (method === "GET") return Response.json(comments);
    if (method === "POST") {
      let payload;
      try { payload = JSON.parse(String(options.body)); } catch { throw new Error("invalid fixture comment"); }
      const row = { id: comments.length + 1, body: payload.body, user: { login } };
      comments.push(row);
      return Response.json(row);
    }
  }
  if (method === "GET" && path === "/repos/fixture/repo/issues/comments/" + comments.length)
    return Response.json(badReadback ? {} : comments.at(-1));
  throw new Error("unexpected fixture HTTP: " + method + " " + path);
};
const { createReviewAppProgram, run } = await import(pathToFileURL(entry).href);
const program = createReviewAppProgram();
assert(program.commands.length === 1 && program.commands[0].name() === "review-app", "unexpected root command");
assert(JSON.stringify(program.commands[0].commands.map(command => command.name())) === JSON.stringify(["prepare", "block", "recover", "status", "publish"]), "unexpected grammar");
const inspect = command => { assert(!command._executableHandler, "executable command registration"); command.commands.forEach(inspect); };
inspect(program);
const key = join(root, "key.pem");
await writeFile(key, generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600, flag: "wx" });
const config = join(root, "apps.json");
const receipts = join(root, "receipts");
await writeFile(config, JSON.stringify({ repositories: ["fixture/repo"], receiptRoot: receipts, code: { appId: 1, keyPath: key }, browser: { appId: 2, keyPath: key } }), { mode: 0o600, flag: "wx" });
await mkdir(join(receipts, "fixture/repo/7"), { recursive: true, mode: 0o700 });
const receipt = join(receipts, "fixture/repo/7/code.json");
const original = Buffer.from(JSON.stringify({ repository: "fixture/repo", pr: 7, lane: "code", session: "historical", attempt: "historical-attempt", H: "c".repeat(40), B: "d".repeat(40), contractDigest: "e".repeat(64), status: "BLOCKED", localVerdict: "FAIL", publicationVerdict: "BLOCKED", evidence: [], reviewId: null }));
await writeFile(receipt, original, { mode: 0o600, flag: "wx" });
const digest = createHash("sha256").update(original).digest("hex");
const request = join(root, "request.json");
const feedback = { kind: "plan", reason: "Review current changes", check: "Named boundary checks", observed: "Checks pending", expected: "Supported behavior passes", evidence: "Pending execution", action: "Run checks and inspect results", actor: "Assigned reviewer" };
await writeFile(request, JSON.stringify({ repo: "fixture/repo", pr: 7, lane: "code", session: "package-fixture", attempt: "fresh-attempt", H: "a".repeat(40), B: "b".repeat(40), contractDigest: "c".repeat(64), receipt, feedback }), { mode: 0o600, flag: "wx" });
const argv = (...args) => [process.execPath, entry, "review-app", ...args];
await run(argv("status", "--app-config", config, "--repo", "fixture/repo", "--json"));
assert(!process.exitCode, "status failed");
const recover = argv("recover", "--app-config", config, "--request", request, "--legacy-sha256", digest, "--json");
await run(recover);
assert(!process.exitCode, "recover failed");
const pending = await readFile(receipt);
let state;
try { state = JSON.parse(pending.toString("utf8")); } catch { throw new Error("invalid pending receipt"); }
assert(state.status === "PENDING" && state.feedbackPublication?.status === "confirmed" && state.preparedFeedback?.kind === "plan" && state.reviewId === null && state.localVerdict === null && state.inputDigest === null && state.coverage === null && state.evidence.length === 0 && state.mutationStarted === false, "authority reset failed");
assert(state.supersededAttempts.includes("historical-attempt"), "attempt not retired");
assert(original.equals(await readFile(receipt + ".legacy-" + digest)), "archive changed");
await run(recover);
assert(!process.exitCode && pending.equals(await readFile(receipt)) && comments.length === 1, "replay changed state");
process.env.SPUR_SESSION = "other-session";
const beforeSessionFailure = calls.length;
await run(recover);
assert(process.exitCode === 1 && pending.equals(await readFile(receipt)) && calls.length === beforeSessionFailure, "session failure not enforced");
process.env.SPUR_SESSION = "package-fixture";
process.exitCode = undefined;
comments.splice(0);
badReadback = true;
await run(recover);
let failed;
try { failed = JSON.parse((await readFile(receipt)).toString("utf8")); } catch { throw new Error("invalid failed receipt"); }
// Ordinary FAIL replay adopts persisted feedback failure, not registered-denial replay semantics.
assert(process.exitCode === 1 && failed.status === "BLOCKED" && failed.feedbackPublication?.status === "failed" && original.equals(await readFile(receipt + ".legacy-" + digest)), "readback failure not enforced");
process.exitCode = undefined;
const beforeConfigFailure = calls.length;
await run(argv("status", "--app-config", join(root, "missing.json"), "--repo", "fixture/repo"));
assert(process.exitCode === 1 && calls.length === beforeConfigFailure, "error exit not enforced");
assert(nativePosts === 0, "native review POST attempted");
process.exitCode = undefined;
process.stdout.write("SPUR_PACKAGE_PROOF=" + JSON.stringify({ status: true, recover: true, pending: true, replay: true, session: true, readback: true, error: true, nativePosts, calls: calls.length }) + "\n");
`;

/** Phase API: fake execution mechanics; callers must first prove archive and closure admission. */
export async function executeFrozenClosure(root, files, edges) {
  const working = join(root, "poison-cwd");
  const home = join(root, "home");
  const temporary = join(root, "tmp");
  const path = join(root, "poison-path");
  for (const directory of [working, home, temporary, path]) await mkdir(directory, { mode: 0o700 });
  const marker = join(root, "poison-effect");
  const poison = `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)}, "effect"); process.exit(91);\n`;
  for (const name of ["spur", "git", "npm", "pnpm", "node", "opencode"])
    await writeFile(join(path, name), poison, { mode: 0o700, flag: "wx" });
  await writeFile(join(working, "spur.yaml"), "script: never-execute\n", {
    mode: 0o600,
    flag: "wx",
  });
  await writeFile(join(working, ".env"), "NODE_OPTIONS=--require ./poison.cjs\n", {
    mode: 0o600,
    flag: "wx",
  });
  await writeFile(join(working, "poison.cjs"), "throw new Error('preload executed');", {
    mode: 0o600,
    flag: "wx",
  });
  // An ancestor package must not supply any missing selected dependency.
  const ancestor = join(root, "node_modules/commander");
  await mkdir(ancestor, { recursive: true, mode: 0o700 });
  await writeFile(
    join(ancestor, "package.json"),
    JSON.stringify({ name: "commander", main: "poison.cjs" }),
    { mode: 0o600, flag: "wx" },
  );
  await writeFile(join(ancestor, "poison.cjs"), "throw new Error('ancestor Commander executed');", {
    mode: 0o600,
    flag: "wx",
  });
  const packageRoot = join(root, "package");
  await physicalGraph(packageRoot, files, edges);
  const entry = join(packageRoot, "dist/review-app-cli.js");
  const env = {
    HOME: home,
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
    PATH: path,
    NODE_ENV: "test",
    SPUR_SESSION: "package-fixture",
    LANG: "C",
    LC_ALL: "C",
  };
  const child = async (args, success) => {
    try {
      const output = await execFileAsync(process.execPath, args, {
        cwd: working,
        env,
        timeout: 5_000,
        killSignal: "SIGKILL",
        maxBuffer: 256 * 1024,
      });
      if (!success) refuse("forbidden command unexpectedly succeeded");
      return output;
    } catch (error) {
      if (
        success ||
        error.killed ||
        error.signal ||
        !Number.isInteger(error.code) ||
        error.code === 0
      )
        refuse("isolated child failed or exceeded its bound");
      return { stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
    }
  };
  const help = await child([entry, "--help"], true);
  if (!help.stdout.includes("review-app") || help.stdout.includes("daemon start"))
    refuse("wrong entry help");
  for (const args of [
    ["daemon", "--help"],
    ["--help", "daemon"],
    ["review-gate", "--help"],
    ["--config", "poison.yaml", "--help"],
    ["review-app", "daemon", "--help"],
    ["--version"],
  ])
    await child([entry, ...args], false);
  const harness = join(root, "fake-execution.mjs");
  await writeFile(harness, executionHarness, { mode: 0o600, flag: "wx" });
  const output = await child([harness, entry, temporary], true);
  const line = output.stdout.split("\n").find((value) => value.startsWith("SPUR_PACKAGE_PROOF="));
  if (!line) refuse("missing isolated fake proof");
  const proof = jsonBytes(
    Buffer.from(line.slice("SPUR_PACKAGE_PROOF=".length)),
    "invalid isolated fake proof",
  );
  if (
    ["status", "recover", "pending", "replay", "session", "readback", "error"].some(
      (key) => proof[key] !== true,
    ) ||
    proof.nativePosts !== 0
  )
    refuse("incomplete isolated fake proof");
  try {
    await lstat(marker);
    refuse("poison PATH was executed");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return proof;
}

async function checkoutHead(root) {
  const dotGit = join(root, ".git");
  const stat = await lstat(dotGit);
  let git = dotGit;
  if (stat.isFile()) {
    const text = (await dataFile(dotGit, "missing checkout identity")).toString("utf8").trim();
    if (!text.startsWith("gitdir: ")) refuse("invalid checkout identity");
    git = resolve(root, text.slice(8));
  } else if (!stat.isDirectory()) refuse("invalid checkout identity");
  const head = (await dataFile(join(git, "HEAD"), "missing checkout HEAD")).toString("utf8").trim();
  if (/^[a-f0-9]{40}$/.test(head)) return head;
  if (!/^ref: refs\/heads\/[a-zA-Z0-9_.\/-]+$/.test(head) || head.split("/").includes(".."))
    refuse("invalid checkout ref");
  let common = git;
  try {
    common = resolve(git, (await readFile(join(git, "commondir"), "utf8")).trim());
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const value = (await dataFile(join(common, head.slice(5)), "missing checkout ref"))
    .toString("utf8")
    .trim();
  if (!/^[a-f0-9]{40}$/.test(value)) refuse("invalid checkout commit");
  return value;
}

/** Phase API: synthetic references prove mechanics, never actual-artifact provenance. */
export async function verifyClosure(index, references, commanderArchive) {
  const dependencies = await preflightDependencies();
  const metadata = jsonBytes(
    index.captured.get("package/package.json"),
    "invalid package manifest",
  );
  const expected = jsonBytes(
    references.utility.get("package/package.json"),
    "invalid source manifest",
  );
  if (
    typeof metadata.version !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?(?:\+[a-zA-Z0-9.-]+)?$/.test(metadata.version)
  )
    refuse("invalid release-managed package version");
  if (!sameData({ ...metadata, version: expected.version }, expected))
    refuse("package metadata differs from reviewed source");
  if (
    !commanderArchive.captured
      .get("package/package.json")
      .equals(references.commander.get("package/package.json"))
  )
    refuse("official and installed Commander metadata differ");
  commanderMetadata(commanderArchive.captured.get("package/package.json"));
  const files = new Map([...index.captured].map(([name, bytes]) => [name.slice(8), bytes]));
  for (const [name, bytes] of commanderArchive.captured)
    files.set(`node_modules/commander/${name.slice(8)}`, bytes);
  const edges = verifyGraph(files, dependencies.typescript);
  return { files, edges };
}

export async function verifyReviewAppPackage(tarball) {
  const dependencies = await preflightDependencies();
  const references = await referencesFromCheckout(repositoryRoot);
  const index = await readArchive(tarball, references.utility);
  const required = (
    await dataFile(join(repositoryRoot, "v2/required-package-files.txt"), "missing required list")
  )
    .toString("utf8")
    .split(/\r?\n/);
  assertRequiredEntries(index, required);
  const commanderArchive = await readArchive(await officialCommander(), references.commander);
  const { files, edges } = await verifyClosure(index, references, commanderArchive);
  const root = await mkdtemp(join(await realpath(tmpdir()), "spur-review-app-package-"));
  try {
    await materialize(root, new Map([...files].map(([name, bytes]) => [`package/${name}`, bytes])));
    const execution = await executeFrozenClosure(root, files, edges);
    return {
      H: await checkoutHead(repositoryRoot),
      compiler: identities.typescript.version,
      dependencies: dependencies.report,
      archiveSHA256: index.archiveSHA256,
      members: [...index.members].map(([path, member]) => ({ path, ...member })),
      selectedSHA256: Object.fromEntries([...files].map(([path, bytes]) => [path, sha256(bytes)])),
      execution,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== "--tarball" || !process.argv[3])
      refuse("usage: verify-review-app-package.mjs --tarball <file>");
    const result = await verifyReviewAppPackage(process.argv[3]);
    // Keep machine paths in private preflight evidence, outside public CI output.
    const dependencies = {
      owner: result.dependencies.owner,
      lockSHA256: result.dependencies.lockSHA256,
      packages: Object.fromEntries(
        Object.entries(result.dependencies.packages).map(([name, value]) => [
          name,
          {
            version: value.version,
            publicTarget: identities[name].entry,
            publicSHA256: value.publicSHA256,
          },
        ]),
      ),
    };
    process.stdout.write(`${JSON.stringify({ ...result, dependencies })}\n`);
  } catch {
    process.stderr.write("review-app-package: verification failed\n");
    process.exitCode = 1;
  }
}
