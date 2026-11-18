// Child-process probe: a file turns into a FIFO between the walk and the open. If the archive
// ever opens it blocking, this process hangs and the parent's spawnSync timeout kills it.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { writeCloseoutArchive } from "../../src/closeout-archive.js";

const base = process.argv[2] as string;
const root = join(base, "root");
const sessionDir = join(base, "sessions", "s1");
fs.mkdirSync(root, { recursive: true });
fs.mkdirSync(sessionDir, { recursive: true });
fs.writeFileSync(join(root, "f.txt"), "data");

const realOpen = fs.openSync;
fs.openSync = ((path: fs.PathLike, ...rest: unknown[]) => {
  if (String(path).endsWith("f.txt")) {
    fs.rmSync(path);
    execFileSync("mkfifo", [String(path)]);
  }
  return (realOpen as (...args: unknown[]) => number)(path, ...rest);
}) as typeof fs.openSync;
syncBuiltinESMExports();

const manifest = writeCloseoutArchive({
  sessionDir,
  sessionId: "s1",
  project: "p",
  completedAt: "2026-01-01T00:00:00.000Z",
  links: [],
  snapshotVersion: null,
  headSha: null,
  roots: { artifacts: root, work: null, workspace: null },
  include: ["artifacts:**"],
  maxBytes: 1000,
});
process.stdout.write(JSON.stringify({ files: manifest.files, skipped: manifest.skipped }));
