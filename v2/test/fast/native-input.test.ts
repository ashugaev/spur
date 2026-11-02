import { join } from "node:path";
import type * as Fs from "node:fs/promises";
import { afterEach, expect, test, vi } from "vitest";
import { createTempDir } from "../helpers/common.js";

const faults = vi.hoisted(() => ({ at: 0, count: 0, events: [] as string[] }));
vi.mock("node:fs/promises", async () => {
  const fs = await vi.importActual<typeof Fs>("node:fs/promises");
  const step = (event: string) => {
    faults.events.push(event);
    faults.count += 1;
    if (faults.at === faults.count) throw new Error("publication interrupted");
  };
  return {
    ...fs,
    mkdir: async (...args: Parameters<typeof fs.mkdir>) => {
      step("before mkdir");
      const result = await fs.mkdir(...args);
      step("after mkdir");
      return result;
    },
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      const sync = handle.sync.bind(handle);
      vi.spyOn(handle, "sync").mockImplementation(async () => {
        step("before sync");
        await sync();
        step("after sync");
      });
      return handle;
    },
    writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
      step("before stage flush");
      await fs.writeFile(...args);
      step("after stage flush");
    },
    rename: async (...args: Parameters<typeof fs.rename>) => {
      step("before rename");
      await fs.rename(...args);
      step("after rename");
    },
  };
});

import {
  appendFile,
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import {
  appendNativeInputIntent,
  bindNativeInputUsers,
  captureNativeInputSources,
  readNativeInputJournal,
  writeNativeInputJournal,
  verifyNativeInputSources,
  type NativeInputIdentity,
  type NativeInputJournal,
} from "../../src/native-input.js";
import type { NativeUserObservation } from "../../src/agents/index.js";

const identity: NativeInputIdentity = {
  project: "fixture",
  sessionId: "worker",
  workspaceId: "worker",
  worktreePath: "/fixture/worktree",
  branch: "feature/native-input-proof",
  repository: "fixture/repository",
  pr: 1,
  taskDigest: "a".repeat(64),
  launchDigest: "b".repeat(64),
  agent: "claude",
};
const user: NativeUserObservation = {
  nativeSessionId: "native-current",
  source: "/fixture/native/current.jsonl",
  recordId: "user-1",
  recordDigest: "c".repeat(64),
  bodyDigest: "d".repeat(64),
};
const roots: string[] = [];
async function root(): Promise<string> {
  const dir = await createTempDir("native-input-");
  roots.push(dir);
  return dir;
}
function journal(): NativeInputJournal {
  return {
    identity,
    nativeSessionId: user.nativeSessionId,
    processes: [{ pid: 1, identity: "current-starttime" }],
    occurrences: [],
  };
}
function append(value: NativeInputJournal, initial = true) {
  return appendNativeInputIntent(value, {
    initial,
    bodyDigest: user.bodyDigest,
    typedAt: 1,
    baseline: { agent: "claude", file: user.source, size: 0 },
    sources: [
      {
        path: user.source,
        size: 0,
        device: null,
        inode: null,
        prefixDigest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      },
    ],
    predecessor: null,
  });
}
function opaque(value: NativeInputJournal) {
  return appendNativeInputIntent(value, {
    initial: true,
    typedAt: 1,
    predecessor: null,
    baseline: null,
    bodyDigest: null,
    sources: [],
    submittedDigest: "f".repeat(64),
    state: { kind: "unobservable", reason: "native_input_baseline_unavailable" },
  });
}
function path(dir: string): string {
  return join(
    dir,
    "native-inputs",
    identity.project,
    identity.sessionId,
    identity.launchDigest,
    "inputs.json",
  );
}
afterEach(async () => {
  faults.at = 0;
  faults.count = 0;
  faults.events = [];
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test("native accepted input commits one complete binding and recovers it after restart", async () => {
  const dir = await root();
  const value = journal();
  const input = append(value);
  await writeNativeInputJournal(dir, value);
  expect((await readNativeInputJournal(dir, identity))?.occurrences[0]?.state.kind).toBe("intent");
  input.state = { kind: "dispatched" };
  await writeNativeInputJournal(dir, value);
  bindNativeInputUsers(value, new Map([[input.id, [user]]]));
  await writeNativeInputJournal(dir, value);
  const recovered = await readNativeInputJournal(dir, identity);
  expect(recovered).toEqual(value);
  if (!recovered) throw new Error("journal missing");
  bindNativeInputUsers(recovered, new Map([[input.id, [user, user]]]));
  expect(recovered).toEqual(value);
});

test("native accepted input rejects queued-only, uncertain paste, old launch and wrong body", () => {
  const value = journal();
  const input = append(value);
  bindNativeInputUsers(value, new Map([[input.id, [user]]]));
  expect(input.state.kind).toBe("intent");
  input.state = { kind: "dispatched" };
  bindNativeInputUsers(
    value,
    new Map([
      [
        input.id,
        [
          { ...user, nativeSessionId: "old" },
          { ...user, bodyDigest: "e".repeat(64) },
        ],
      ],
    ]),
  );
  expect(input.state.kind).toBe("dispatched");
});

test("native accepted input preserves overlapping identical pastes as ambiguous", () => {
  const value = journal();
  const first = append(value);
  const second = append(value, false);
  first.state = { kind: "dispatched" };
  second.state = { kind: "dispatched" };
  bindNativeInputUsers(
    value,
    new Map([
      [first.id, [user]],
      [second.id, [user]],
    ]),
  );
  expect(value.occurrences.map((input) => input.state.kind)).toEqual(["ambiguous", "ambiguous"]);
  bindNativeInputUsers(
    value,
    new Map([
      [first.id, [user]],
      [second.id, [user]],
    ]),
  );
  expect(value.occurrences.map((input) => input.state.kind)).toEqual(["ambiguous", "ambiguous"]);
});

test("native accepted input never transfers an already owned native USER", () => {
  const value = journal();
  const first = append(value);
  first.state = { kind: "dispatched" };
  bindNativeInputUsers(value, new Map([[first.id, [user]]]));
  const second = append(value, false);
  second.state = { kind: "dispatched" };
  bindNativeInputUsers(value, new Map([[second.id, [user]]]));
  expect(first.state.kind).toBe("accepted");
  expect(second.state.kind).toBe("dispatched");
});

test.each([null, [], [{ pid: 1, identity: null }]])(
  "native accepted input retains unknown without current native process generation %j",
  (processes) => {
    const value = journal();
    value.processes = processes;
    const input = append(value);
    input.state = { kind: "dispatched" };
    bindNativeInputUsers(value, new Map([[input.id, [user]]]));
    expect(input.state.kind).toBe("dispatched");
  },
);

test("native accepted input cannot bypass an uncertain earlier identical paste", () => {
  const value = journal();
  const uncertain = append(value);
  const later = append(value, false);
  later.state = { kind: "dispatched" };
  bindNativeInputUsers(value, new Map([[later.id, [user]]]));
  expect(uncertain.state.kind).toBe("intent");
  expect(later.state.kind).toBe("ambiguous");
});

test("native accepted input preserves opaque intent across restart and repeated injected USER", async () => {
  const dir = await root();
  const value = journal();
  const input = opaque(value);
  await writeNativeInputJournal(dir, value);
  const recovered = await readNativeInputJournal(dir, identity);
  if (!recovered) throw new Error("journal missing");
  bindNativeInputUsers(recovered, new Map([[input.id, [user]]]));
  bindNativeInputUsers(recovered, new Map([[input.id, [user]]]));
  expect(recovered.occurrences[0]).toEqual(input);
  await writeNativeInputJournal(dir, recovered);
  const known = append(recovered, false);
  await writeNativeInputJournal(dir, recovered);
  known.state = { kind: "dispatched" };
  await writeNativeInputJournal(dir, recovered);
  bindNativeInputUsers(recovered, new Map([[known.id, [user]]]));
  expect(known.state.kind).toBe("ambiguous");
  expect(recovered.occurrences[0]).toEqual(input);
  expect(
    await readNativeInputJournal(dir, { ...identity, launchDigest: "c".repeat(64) }),
  ).toBeNull();
});

test("native accepted input rejects opaque upgrades and mixed null/known encodings", async () => {
  const dir = await root();
  const value = journal();
  const input = opaque(value);
  await writeNativeInputJournal(dir, value);
  const known = append(journal());
  value.occurrences[0] = { ...known, id: input.id };
  await expect(writeNativeInputJournal(dir, value)).rejects.toThrow("intent-immutable");
  for (const malformed of [
    { ...input, baseline: undefined },
    { ...input, bodyDigest: user.bodyDigest },
    { ...input, state: { kind: "accepted", user } },
    { ...input, state: { ...input.state, user } },
    { ...known, bodyDigest: null },
    { ...known, baseline: null },
  ]) {
    await writeFile(path(dir), JSON.stringify({ ...journal(), occurrences: [malformed] }));
    await expect(readNativeInputJournal(dir, identity)).rejects.toThrow();
  }
});

test("native accepted input refuses malformed, lossy and duplicate-owner snapshots", async () => {
  const dir = await root();
  const value = journal();
  const input = append(value);
  await writeNativeInputJournal(dir, value);
  input.state = { kind: "dispatched" };
  await writeNativeInputJournal(dir, value);
  input.state = { kind: "accepted", user };
  await writeNativeInputJournal(dir, value);
  expect(await readFile(path(dir), "utf8")).toContain(input.id);
  for (const malformed of [
    "{",
    JSON.stringify({
      ...value,
      occurrences: [{ ...input, baseline: { ...input.baseline, size: -1 } }],
    }),
    JSON.stringify({
      ...value,
      occurrences: [{ ...input, baseline: { agent: "codex", offsets: { invalid: "offset" } } }],
    }),
  ]) {
    await writeFile(path(dir), malformed, { mode: 0o600 });
    await expect(readNativeInputJournal(dir, identity)).rejects.toThrow();
  }
  const second = append(value, false);
  second.state = { kind: "accepted", user };
  await writeFile(path(dir), JSON.stringify(value));
  await expect(readNativeInputJournal(dir, identity)).rejects.toThrow("journal-owner-invalid");
});

test("native accepted input rejects root/path substitution and public journal files", async () => {
  const dir = await root();
  const outside = await root();
  await symlink(outside, join(dir, "native-inputs"));
  await expect(writeNativeInputJournal(dir, journal())).rejects.toThrow(
    "journal-directory-invalid",
  );
  await rm(join(dir, "native-inputs"));
  await writeNativeInputJournal(dir, journal());
  await chmod(path(dir), 0o644);
  await expect(readNativeInputJournal(dir, identity)).rejects.toThrow("journal-unreadable");
  await expect(
    writeNativeInputJournal(dir, { ...journal(), identity: { ...identity, project: ".." } }),
  ).rejects.toThrow("path-invalid");
});

test("native accepted input publishes all ancestors before first intent can permit a paste", async () => {
  const dir = await root();
  const value = journal();
  append(value);
  faults.count = 0;
  faults.events = [];
  await writeNativeInputJournal(dir, value);
  const events = [...faults.events];
  expect(events.filter((event) => event === "after mkdir")).toHaveLength(4);
  expect(events.filter((event) => event === "after sync")).toHaveLength(9);
  expect(events.indexOf("before stage flush")).toBeGreaterThan(events.lastIndexOf("after mkdir"));
  for (let at = 1; at <= events.length; at += 1) {
    const interruptedDir = await root();
    faults.count = 0;
    faults.at = at;
    let pasted = false;
    try {
      await writeNativeInputJournal(interruptedDir, value);
      pasted = true;
    } catch {
      // The simulated external action remains uncalled after any failed sync.
    }
    faults.at = 0;
    expect(pasted).toBe(false);
    const recovered = await readNativeInputJournal(interruptedDir, identity);
    expect(recovered === null || recovered.occurrences[0]?.state.kind === "intent").toBe(true);
    await writeNativeInputJournal(interruptedDir, value);
    expect(await readNativeInputJournal(interruptedDir, identity)).toEqual(value);
  }
});

test("native accepted input ignores stage debris and retains corrupt published ownership", async () => {
  const dir = await root();
  await mkdir(
    join(dir, "native-inputs", identity.project, identity.sessionId, identity.launchDigest),
    { recursive: true },
  );
  await writeFile(`${path(dir)}.orphan.stage`, "not an accepted claim");
  expect(await readNativeInputJournal(dir, identity)).toBeNull();
  await writeFile(path(dir), "not a complete journal", { mode: 0o600 });
  await expect(readNativeInputJournal(dir, identity)).rejects.toThrow("journal-unreadable");
});

test("native accepted input recovers one old or new complete snapshot at every accepted publication boundary", async () => {
  const dir = await root();
  const value = journal();
  const input = append(value);
  await writeNativeInputJournal(dir, value);
  input.state = { kind: "dispatched" };
  await writeNativeInputJournal(dir, value);
  input.state = { kind: "accepted", user };
  faults.count = 0;
  faults.events = [];
  await writeNativeInputJournal(dir, value);
  const steps = faults.count;
  for (let at = 1; at <= steps; at += 1) {
    const interruptedDir = await root();
    const pending = journal();
    const occurrence = append(pending);
    await writeNativeInputJournal(interruptedDir, pending);
    occurrence.state = { kind: "dispatched" };
    await writeNativeInputJournal(interruptedDir, pending);
    occurrence.state = { kind: "accepted", user };
    faults.count = 0;
    faults.at = at;
    let acknowledged = false;
    try {
      await writeNativeInputJournal(interruptedDir, pending);
      acknowledged = true;
    } catch {
      // A failed publication cannot return accepted permission to its caller.
    }
    faults.at = 0;
    expect(acknowledged).toBe(false);
    const recovered = await readNativeInputJournal(interruptedDir, identity);
    if (!recovered) throw new Error("previous complete journal lost");
    expect(recovered.occurrences).toHaveLength(1);
    expect(["dispatched", "accepted"]).toContain(recovered.occurrences[0]?.state.kind);
    bindNativeInputUsers(recovered, new Map([[occurrence.id, [user]]]));
    await writeNativeInputJournal(interruptedDir, recovered);
    expect((await readNativeInputJournal(interruptedDir, identity))?.occurrences[0]?.state).toEqual(
      { kind: "accepted", user },
    );
  }
});

test("native accepted input pins actual source inode and UTF-8 prefix across append and restart", async () => {
  const dir = await root();
  const file = join(dir, "native.jsonl");
  const prefix = '{"message":"Русский 🦊"}\n';
  await writeFile(file, prefix);
  const sources = await captureNativeInputSources({
    agent: "claude",
    file,
    size: Buffer.byteLength(prefix),
  });
  await appendFile(file, '{"message":"next USER"}\n');
  await expect(verifyNativeInputSources(sources)).resolves.toBeUndefined();
  await writeFile(file, prefix.replace("Русский", "Другой!"));
  await expect(verifyNativeInputSources(sources)).rejects.toThrow();
  await writeFile(file, prefix);
  await rename(file, `${file}.old`);
  await writeFile(file, prefix);
  await expect(verifyNativeInputSources(sources)).rejects.toThrow("native-source-changed");
});

test("native accepted input rejects escaped source paths and truncated persisted prefixes", async () => {
  const dir = await root();
  const file = join(dir, "native.jsonl");
  await writeFile(file, "native\n");
  const link = join(dir, "copied.jsonl");
  await symlink(file, link);
  await expect(captureNativeInputSources({ agent: "claude", file: link, size: 0 })).rejects.toThrow(
    "native-source-path-invalid",
  );
  const sources = await captureNativeInputSources({ agent: "claude", file, size: 7 });
  await writeFile(file, "");
  await expect(verifyNativeInputSources(sources)).rejects.toThrow("native-source-changed");
});
