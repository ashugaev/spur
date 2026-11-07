import { existsSync, rmSync } from "node:fs";
import { mkdir, rm, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sessionArtifactsDir } from "../../src/session-artifacts.js";
import {
  CHANGES_KEPT,
  MAX_DOC_BYTES,
  MAX_STORE_BYTES,
  StoreClosedError,
  StoreError,
  StoreService,
  type StoreChangeEvent,
  type StoreSessionView,
  pageDirPath,
  parseStoreId,
} from "../../src/stores.js";
import { createTempDir } from "../helpers/common.js";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function setup(sessions: Record<string, StoreSessionView> = {}, changesKept?: number) {
  const dataDir = await createTempDir("spur-stores-");
  tempDirs.push(dataDir);
  await mkdir(pageDirPath(dataDir, "films"), { recursive: true });
  const service = new StoreService({
    dataDir,
    readSession: (id) => sessions[id] ?? null,
    ...(changesKept === undefined ? {} : { changesKept }),
  });
  return { dataDir, service, sessions };
}

async function expectStatus(promise: Promise<unknown>, status: number): Promise<void> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(StoreError);
  expect((error as StoreError).statusCode).toBe(status);
}

describe("store ids", () => {
  it("parses page and session ids and rejects anything else", () => {
    expect(parseStoreId("page:films")).toMatchObject({ kind: "page", pageId: "films" });
    expect(parseStoreId("session:sp-1")).toMatchObject({ kind: "session", sessionId: "sp-1" });
    for (const bad of ["films", "page:Films", "page:../x", "session:", "other:x", "session:a/b"]) {
      expect(() => parseStoreId(bad)).toThrow(StoreError);
    }
  });
});

describe("store CRUD", () => {
  it("adds, gets, sets, merges, deletes and bumps rev", async () => {
    const { service } = await setup();
    const added = await service.add("page:films", "items", { title: "Dune", meta: { a: 1, b: 2 } });
    expect(added.rev).toBe(1);
    expect(added.id).toMatch(/^[a-f0-9]{20}$/);
    expect(await service.get("page:films", "items", added.id)).toMatchObject({
      data: { title: "Dune" },
    });

    const merged = await service.update("page:films", "items", added.id, {
      meta: { b: null, c: 3 },
      watched: true,
    });
    expect(merged.rev).toBe(2);
    expect(merged.data).toEqual({ title: "Dune", meta: { a: 1, c: 3 }, watched: true });

    const replaced = await service.set("page:films", "items", added.id, { title: "Arrival" });
    expect(replaced.rev).toBe(3);
    expect(replaced.data).toEqual({ title: "Arrival" });
    expect(replaced.createdAt).toBe(added.createdAt);

    await service.delete("page:films", "items", added.id);
    await expectStatus(service.get("page:films", "items", added.id), 404);
    await expectStatus(service.update("page:films", "items", added.id, { x: 1 }), 404);
    await expectStatus(service.delete("page:films", "items", added.id), 404);
  });

  it("returns 409 on an expectedRev mismatch for set, update and delete", async () => {
    const { service } = await setup();
    const doc = await service.set("page:films", "items", "d1", { n: 1 }, { expectedRev: 0 });
    await expectStatus(service.set("page:films", "items", "d1", { n: 2 }, { expectedRev: 0 }), 409);
    await expectStatus(
      service.update("page:films", "items", "d1", { n: 2 }, { expectedRev: 5 }),
      409,
    );
    await expectStatus(service.delete("page:films", "items", "d1", { expectedRev: 9 }), 409);
    expect(
      (await service.update("page:films", "items", "d1", { n: 2 }, { expectedRev: doc.rev })).rev,
    ).toBe(2);
  });

  it("validates collection, doc id and data shape", async () => {
    const { service } = await setup();
    await expectStatus(service.set("page:films", "bad name", "d", {}), 400);
    await expectStatus(service.set("page:films", "items", "bad/id", {}), 400);
    await expectStatus(service.set("page:films", "items", "d", [] as unknown), 400);
    await expectStatus(service.set("page:films", "items", "d", "text" as unknown), 400);
  });

  it("rejects generic writes to _actions but allows _state and internal inserts", async () => {
    const { service } = await setup();
    await expectStatus(service.add("page:films", "_actions", { a: 1 }), 400);
    await expectStatus(service.set("page:films", "_actions", "a1", { a: 1 }), 400);
    expect((await service.set("page:films", "_state", "page", { app: {} })).rev).toBe(1);
    const first = await service.insertIfAbsent("page:films", "_actions", "a1", {
      status: "pending",
    });
    const second = await service.insertIfAbsent("page:films", "_actions", "a1", {
      status: "other",
    });
    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(second.doc.data).toEqual({ status: "pending" });
    expect((await service.get("page:films", "_actions", "a1")).data).toEqual({ status: "pending" });
  });

  it("caps documents at MAX_DOC_BYTES and the store file at MAX_STORE_BYTES", async () => {
    const { service, dataDir } = await setup();
    await expectStatus(
      service.add("page:films", "items", { blob: "x".repeat(MAX_DOC_BYTES) }),
      413,
    );
    await service.set("page:films", "items", "d", { blob: "x".repeat(MAX_DOC_BYTES / 2) });
    await expectStatus(
      service.update("page:films", "items", "d", { more: "y".repeat(MAX_DOC_BYTES / 2) }),
      413,
    );
    const file = join(pageDirPath(dataDir, "films"), "data.sqlite");
    await truncate(file, MAX_STORE_BYTES + 1);
    await expectStatus(service.add("page:films", "items", { n: 1 }), 413);
  });

  it("lets internal writes close actions on a full store but caps new action inserts", async () => {
    const { service, dataDir } = await setup();
    await service.insertIfAbsent("page:films", "_actions", "a1", { status: "pending" });
    await truncate(join(pageDirPath(dataDir, "films"), "data.sqlite"), MAX_STORE_BYTES + 1);
    const closed = await service.update(
      "page:films",
      "_actions",
      "a1",
      { status: "failed", error: "timeout" },
      { internal: true },
    );
    expect(closed.data).toEqual({ status: "failed", error: "timeout" });
    await service.transactMeta("page:films", (meta) => meta.set("budget.auto", 1));
    await expectStatus(
      service.insertIfAbsent("page:films", "_actions", "a2", { status: "pending" }),
      413,
    );
  });

  it("404s a page store write racing page removal without recreating the page dir", async () => {
    const { service, dataDir } = await setup();
    const pageDir = pageDirPath(dataDir, "films");
    // resolve() passes synchronously; the dir goes before the async open.
    const write = service.set("page:films", "items", "d1", { title: "Dune" });
    rmSync(pageDir, { recursive: true, force: true });
    await expectStatus(write, 404);
    expect(existsSync(pageDir)).toBe(false);
  });

  it("persists across service instances", async () => {
    const { service, dataDir } = await setup();
    await service.set("page:films", "items", "d1", { title: "Dune" });
    const reopened = new StoreService({ dataDir, readSession: () => null });
    expect((await reopened.get("page:films", "items", "d1")).data).toEqual({ title: "Dune" });
  });
});

describe("store queries", () => {
  async function seeded() {
    const ctx = await setup();
    const rows = [
      {
        id: "a",
        data: { title: "A", rating: 3, watched: true, tags: ["sf"], info: { year: 2001 } },
      },
      {
        id: "b",
        data: { title: "B", rating: 5, watched: false, tags: ["drama"], info: { year: 1999 } },
      },
      {
        id: "c",
        data: {
          title: "C",
          rating: 5,
          watched: false,
          tags: ["sf", "drama"],
          info: { year: 2010 },
        },
      },
      { id: "d", data: { title: "D", rating: 1, watched: true, tags: [], info: { year: 2020 } } },
      { id: "e", data: { title: "E", watched: false } },
    ];
    for (const row of rows) await ctx.service.set("page:films", "items", row.id, row.data);
    return ctx;
  }
  const ids = (docs: Array<{ id: string }>) => docs.map((doc) => doc.id);

  it("supports each where op with bound values", async () => {
    const { service } = await seeded();
    const q = (field: string, op: string, value: unknown) =>
      service.query("page:films", "items", { where: [{ field, op: op as never, value }] });
    expect(ids(await q("watched", "==", true))).toEqual(["a", "d"]);
    expect(ids(await q("watched", "!=", true))).toEqual(["b", "c", "e"]);
    expect(ids(await q("rating", "<", 3))).toEqual(["d"]);
    expect(ids(await q("rating", "<=", 3))).toEqual(["a", "d"]);
    expect(ids(await q("rating", ">", 3))).toEqual(["b", "c"]);
    expect(ids(await q("rating", ">=", 5))).toEqual(["b", "c"]);
    expect(ids(await q("title", "in", ["A", "E"]))).toEqual(["a", "e"]);
    expect(ids(await q("tags", "contains", "sf"))).toEqual(["a", "c"]);
    expect(ids(await q("info.year", ">", 2005))).toEqual(["c", "d"]);
    expect(ids(await q("rating", "==", null))).toEqual(["e"]);
  });

  it("orders, limits and pages with startAfter tie-broken by id", async () => {
    const { service } = await seeded();
    const desc = { field: "rating", direction: "desc" as const };
    const all = await service.query("page:films", "items", { orderBy: desc });
    expect(ids(all)).toEqual(["c", "b", "a", "d", "e"]);
    const page1 = await service.query("page:films", "items", { orderBy: desc, limit: 1 });
    expect(ids(page1)).toEqual(["c"]);
    const page2 = await service.query("page:films", "items", {
      orderBy: desc,
      limit: 2,
      startAfter: "c",
    });
    expect(ids(page2)).toEqual(["b", "a"]);
    const tail = await service.query("page:films", "items", { orderBy: desc, startAfter: "d" });
    expect(ids(tail)).toEqual(["e"]);
    const asc = await service.query("page:films", "items", {
      orderBy: { field: "rating" },
      startAfter: "e",
    });
    expect(ids(asc)).toEqual(["d", "a", "b", "c"]);
    const byId = await service.query("page:films", "items", { startAfter: "b", limit: 2 });
    expect(ids(byId)).toEqual(["c", "d"]);
  });

  it("rejects field-path injection, bad ops, too many clauses and bad limits", async () => {
    const { service } = await seeded();
    for (const field of ["a') OR 1=1 --", "$.title", "a..b", "1abc", "a.b.c.d.e.f.g.h.i"]) {
      await expectStatus(
        service.query("page:films", "items", { where: [{ field, op: "==", value: 1 }] }),
        400,
      );
    }
    await expectStatus(service.query("page:films", "items", { orderBy: { field: "x;drop" } }), 400);
    await expectStatus(
      service.query("page:films", "items", {
        where: [{ field: "a", op: "LIKE" as never, value: 1 }],
      }),
      400,
    );
    await expectStatus(
      service.query("page:films", "items", {
        where: Array.from({ length: 9 }, () => ({ field: "a", op: "==" as const, value: 1 })),
      }),
      400,
    );
    await expectStatus(service.query("page:films", "items", { limit: 501 }), 400);
    await expectStatus(
      service.query("page:films", "items", { where: [{ field: "a", op: "==", value: { x: 1 } }] }),
      400,
    );
  });
});

describe("store changes", () => {
  it("records set/delete rows, emits after commit and pages by seq", async () => {
    const { service } = await setup();
    const events: StoreChangeEvent[] = [];
    const off = service.onChange("page:films", (change) => events.push(change));
    await service.set("page:films", "items", "d1", { n: 1 });
    await service.update("page:films", "items", "d1", { n: 2 });
    await service.delete("page:films", "items", "d1");
    off();
    await service.set("page:films", "items", "d2", { n: 1 });
    expect(events.map((event) => [event.seq, event.op, event.rev])).toEqual([
      [1, "set", 1],
      [2, "set", 2],
      [3, "delete", 3],
    ]);
    expect(events[1]?.doc?.data).toEqual({ n: 2 });
    expect(events[2]?.doc).toBeNull();
    expect(await service.changes("page:films", 0, 2)).toEqual({
      changes: [
        { seq: 1, collection: "items", id: "d1", op: "set", rev: 1 },
        { seq: 2, collection: "items", id: "d1", op: "set", rev: 2 },
      ],
      lastSeq: 4,
    });
    expect((await service.changes("page:films", 2)).changes.map((c) => c.seq)).toEqual([3, 4]);
    expect(await service.changes("page:films", 99)).toMatchObject({ reset: true, lastSeq: 4 });
  });

  it("prunes to the last changesKept rows and signals reset to a stale cursor", async () => {
    expect(CHANGES_KEPT).toBe(10_000);
    const { service } = await setup({}, 20);
    for (let index = 0; index < 25; index++) {
      await service.set("page:films", "items", "d", { index });
    }
    const page = await service.changes("page:films", 1);
    expect(page.reset).toBe(true);
    const fresh = await service.changes("page:films", 5);
    expect(fresh.reset).toBeUndefined();
    expect(fresh.changes[0]?.seq).toBe(6);
    expect(fresh.changes).toHaveLength(20);
  });

  it("reads an absent store as empty", async () => {
    const { service } = await setup();
    expect(await service.changes("page:films", 0)).toEqual({ changes: [], lastSeq: 0 });
    expect(await service.query("page:films", "items", {})).toEqual([]);
  });
});

describe("store meta", () => {
  it("is reachable only through meta helpers, never through doc ops", async () => {
    const { service } = await setup();
    await service.transactMeta("page:films", (meta) => meta.set("budget.auto", 3));
    expect(await service.readMeta("page:films", "budget.auto")).toBe(3);
    await expectStatus(service.get("page:films", "meta", "budget.auto"), 400);
    await expectStatus(service.get("page:films", "meta", "budget"), 404);
    expect(await service.query("page:films", "meta", {})).toEqual([]);
    expect((await service.changes("page:films", 0)).changes).toEqual([]);
  });
});

describe("store resolution", () => {
  it("404s an unknown page", async () => {
    const { service } = await setup();
    await expectStatus(service.get("page:nope", "items", "d"), 404);
    await expectStatus(service.add("page:nope", "items", {}), 404);
  });

  it("puts a session store in the desk anchor's work dir and 404s unknown sessions", async () => {
    const { service, dataDir } = await setup({
      "sp-1": { id: "sp-1", status: "running" },
      "sp-2": { id: "sp-2", workspaceId: "sp-1", status: "running" },
    });
    await service.set("session:sp-2", "notes", "n1", { text: "hi" });
    const file = join(sessionArtifactsDir(dataDir, "sp-1"), ".spur-work", "data.sqlite");
    expect(existsSync(file)).toBe(true);
    expect((await service.get("session:sp-1", "notes", "n1")).data).toEqual({ text: "hi" });
    await expectStatus(service.get("session:sp-9", "notes", "n1"), 404);
  });

  it("closes writes on a terminal session but keeps reads", async () => {
    const sessions: Record<string, StoreSessionView> = {
      "sp-1": { id: "sp-1", status: "running" },
    };
    const { service } = await setup(sessions);
    await service.set("session:sp-1", "notes", "n1", { text: "hi" });
    for (const status of ["completed", "killed", "errored"] as const) {
      sessions["sp-1"] = { id: "sp-1", status };
      const error = await service
        .set("session:sp-1", "notes", "n2", {})
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(StoreClosedError);
      expect((error as StoreError).statusCode).toBe(409);
      expect((await service.get("session:sp-1", "notes", "n1")).data).toEqual({ text: "hi" });
    }
    const internal = await service.insertIfAbsent("session:sp-1", "_actions", "a1", {
      status: "failed",
    });
    expect(internal.inserted).toBe(true);
  });

  it("does not create a store file on read", async () => {
    const { service, dataDir } = await setup({ "sp-1": { id: "sp-1", status: "running" } });
    await writeFile(join(pageDirPath(dataDir, "films"), "index.html"), "x");
    expect(await service.query("session:sp-1", "notes", {})).toEqual([]);
    expect(existsSync(join(sessionArtifactsDir(dataDir, "sp-1"), ".spur-work"))).toBe(false);
  });
});
