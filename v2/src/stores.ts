import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { sessionArtifactsDir, SESSION_WORK_DIR } from "./session-artifacts.js";
import { workspaceIdOf } from "./session-desk.js";
import type { SessionRecord } from "./types.js";

// Document stores: `page:<pageId>` lives in the page dir, `session:<sid>` in the
// session's (desk anchor's) work dir. One SQLite file per store, opened per op.

export const PAGE_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const STORE_ID_RE = /^(page:[a-z0-9][a-z0-9-]{0,39}|session:[A-Za-z0-9_-]{1,100})$/;
export const COLLECTION_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
export const DOC_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
export const FIELD_PATH_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}(\.[A-Za-z_][A-Za-z0-9_]{0,63}){0,7}$/;
export const ACTIONS_COLLECTION = "_actions";
export const STATE_COLLECTION = "_state";
export const MAX_DOC_BYTES = 262_144;
export const MAX_STORE_BYTES = 64 * 1024 * 1024;
export const MAX_WHERE_CLAUSES = 8;
export const MAX_IN_VALUES = 30;
export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 500;
export const CHANGES_KEPT = 10_000;
export const CHANGES_PAGE = 500;
export const STORE_DB_FILE = "data.sqlite";
const PAGES_DIR = "pages";
const TERMINAL_SESSION_STATUSES = new Set(["completed", "killed", "errored"]);

export class StoreError extends Error {
  constructor(
    readonly statusCode: 400 | 404 | 409 | 413 | 429 | 503,
    message: string,
  ) {
    super(message);
    this.name = "StoreError";
  }
}

export class StoreClosedError extends StoreError {
  constructor(store: string) {
    super(409, `Store ${store} is closed: its session has ended`);
    this.name = "StoreClosedError";
  }
}

export type StoreRef =
  | { readonly kind: "page"; readonly id: string; readonly pageId: string }
  | { readonly kind: "session"; readonly id: string; readonly sessionId: string };

export type JsonObject = Record<string, unknown>;

export interface StoreDoc {
  id: string;
  rev: number;
  createdAt: string;
  updatedAt: string;
  data: JsonObject;
}

export interface StoreChange {
  seq: number;
  collection: string;
  id: string;
  op: "set" | "delete";
  rev: number;
}

export interface StoreChangeEvent extends StoreChange {
  doc: StoreDoc | null;
}

export interface StoreChangesPage {
  changes: StoreChange[];
  lastSeq: number;
  reset?: true;
}

export type WhereOp = "==" | "!=" | "<" | "<=" | ">" | ">=" | "in" | "contains";
const WHERE_OPS = new Set<WhereOp>(["==", "!=", "<", "<=", ">", ">=", "in", "contains"]);

export interface StoreQuery {
  where?: Array<{ field: string; op: WhereOp; value: unknown }>;
  orderBy?: { field: string; direction?: "asc" | "desc" };
  limit?: number;
  startAfter?: string;
}

export interface WriteOptions {
  expectedRev?: number;
  // Daemon-internal writes (action docs, expiry) bypass the `_actions` gate, the
  // terminal-session gate and, except action inserts, the store size cap.
  internal?: boolean;
}

export type StoreSessionView = Pick<SessionRecord, "id" | "workspaceId" | "deskId" | "status">;

export interface StoreHost {
  dataDir: string;
  readSession(sessionId: string): StoreSessionView | null;
  /** Change rows kept per store; tests lower it. */
  changesKept?: number;
}

export interface MetaTx {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}

export function pagesRoot(dataDir: string): string {
  return join(dataDir, PAGES_DIR);
}

export function pageDirPath(dataDir: string, pageId: string): string {
  return join(pagesRoot(dataDir), pageId);
}

export function parseStoreId(raw: string): StoreRef {
  if (!STORE_ID_RE.test(raw)) {
    throw new StoreError(400, `Invalid store id: ${raw}`);
  }
  const separator = raw.indexOf(":");
  const kind = raw.slice(0, separator);
  const id = raw.slice(separator + 1);
  return kind === "page"
    ? { kind: "page", id: raw, pageId: id }
    : { kind: "session", id: raw, sessionId: id };
}

function assertCollection(collection: string): void {
  if (!COLLECTION_RE.test(collection)) {
    throw new StoreError(400, `Invalid collection: ${collection}`);
  }
}

function assertDocId(docId: string): void {
  if (!DOC_ID_RE.test(docId)) {
    throw new StoreError(400, `Invalid document id: ${docId}`);
  }
}

function assertFieldPath(field: unknown): string {
  if (typeof field !== "string" || !FIELD_PATH_RE.test(field)) {
    throw new StoreError(400, `Invalid field path: ${String(field)}`);
  }
  return `$.${field}`;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function encodeDocData(data: unknown): string {
  if (!isJsonObject(data)) {
    throw new StoreError(400, "Document data must be a JSON object");
  }
  const text = JSON.stringify(data);
  if (Buffer.byteLength(text, "utf8") > MAX_DOC_BYTES) {
    throw new StoreError(413, `Document exceeds ${MAX_DOC_BYTES} bytes`);
  }
  return text;
}

function bindScalar(value: unknown): SQLInputValue {
  if (value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") return value;
  throw new StoreError(400, "Query values must be strings, finite numbers, booleans, or null");
}

function normalizeLimit(limit: unknown): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new StoreError(400, `limit must be an integer between 1 and ${MAX_LIMIT}`);
  }
  return limit;
}

interface DocRow {
  id: string;
  data: string;
  rev: number;
  created_at: string;
  updated_at: string;
}

function rowToDoc(row: DocRow): StoreDoc {
  return {
    id: row.id,
    rev: Number(row.rev),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    data: JSON.parse(row.data) as JsonObject,
  };
}

let sqliteModule: Promise<typeof import("node:sqlite")> | undefined;
function loadSqlite(): Promise<typeof import("node:sqlite")> {
  sqliteModule ??= import("node:sqlite");
  return sqliteModule;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS docs (
  collection TEXT NOT NULL,
  id TEXT NOT NULL,
  data TEXT NOT NULL,
  rev INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (collection, id)
);
CREATE TABLE IF NOT EXISTS changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  collection TEXT NOT NULL,
  id TEXT NOT NULL,
  op TEXT NOT NULL,
  rev INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

interface Resolved {
  ref: StoreRef;
  path: string;
}

export class StoreService {
  private readonly emitter = new EventEmitter();

  constructor(private readonly host: StoreHost) {
    this.emitter.setMaxListeners(0);
  }

  /** Resolves the store file; 404 when the page dir or session is unknown, 409 on a closed write. */
  resolve(storeId: string, mode: "read" | "write" | "internal"): Resolved {
    const ref = parseStoreId(storeId);
    if (ref.kind === "page") {
      const dir = pageDirPath(this.host.dataDir, ref.pageId);
      if (!existsSync(dir)) {
        throw new StoreError(404, `Page not found: ${ref.pageId}`);
      }
      return { ref, path: join(dir, STORE_DB_FILE) };
    }
    const session = this.host.readSession(ref.sessionId);
    if (!session) {
      throw new StoreError(404, `Session not found: ${ref.sessionId}`);
    }
    if (mode === "write" && TERMINAL_SESSION_STATUSES.has(session.status)) {
      throw new StoreClosedError(ref.id);
    }
    const dir = join(
      sessionArtifactsDir(this.host.dataDir, workspaceIdOf(session)),
      SESSION_WORK_DIR,
    );
    return { ref, path: join(dir, STORE_DB_FILE) };
  }

  /** Subscribes to committed writes of the store's file (desk members share one file). */
  onChange(storeId: string, listener: (change: StoreChangeEvent) => void): () => void {
    const { path } = this.resolve(storeId, "read");
    this.emitter.on(path, listener);
    return () => {
      this.emitter.off(path, listener);
    };
  }

  private async open({ ref, path }: Resolved, create: boolean): Promise<DatabaseSync | null> {
    if (!create && !existsSync(path)) return null;
    const { DatabaseSync } = await loadSqlite();
    if (create) {
      // The work dir is Spur's to create; a page dir only `spur page` creates, so a
      // write racing page removal 404s instead of resurrecting the dir.
      if (ref.kind === "session") mkdirSync(dirname(path), { recursive: true });
      else if (!existsSync(dirname(path)))
        throw new StoreError(404, `Page not found: ${ref.pageId}`);
    }
    const db = new DatabaseSync(path);
    try {
      db.exec("PRAGMA busy_timeout = 2000");
      db.exec("PRAGMA journal_mode = WAL");
      db.exec(SCHEMA);
    } catch (error) {
      db.close();
      throw error;
    }
    return db;
  }

  private async withRead<T>(storeId: string, empty: T, fn: (db: DatabaseSync) => T): Promise<T> {
    const db = await this.open(this.resolve(storeId, "read"), false);
    if (!db) return empty;
    try {
      return fn(db);
    } finally {
      db.close();
    }
  }

  private async withWrite<T>(
    storeId: string,
    options: WriteOptions,
    fn: (db: DatabaseSync, changes: StoreChangeEvent[]) => T,
    capSize = !options.internal,
  ): Promise<T> {
    const resolved = this.resolve(storeId, options.internal ? "internal" : "write");
    const { path } = resolved;
    if (capSize) assertStoreSize(path);
    const db = await this.open(resolved, true);
    if (!db) throw new StoreError(404, `Store not found: ${storeId}`);
    const changes: StoreChangeEvent[] = [];
    let result: T;
    try {
      db.exec("BEGIN IMMEDIATE");
      try {
        result = fn(db, changes);
        if (changes.length > 0) {
          db.prepare("DELETE FROM changes WHERE seq <= (SELECT MAX(seq) FROM changes) - ?").run(
            this.host.changesKept ?? CHANGES_KEPT,
          );
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    } finally {
      db.close();
    }
    for (const change of changes) this.emitter.emit(path, change);
    return result;
  }

  async get(storeId: string, collection: string, docId: string): Promise<StoreDoc> {
    assertCollection(collection);
    assertDocId(docId);
    const doc = await this.withRead(storeId, null, (db) => readDoc(db, collection, docId));
    if (!doc) throw new StoreError(404, `Document not found: ${collection}/${docId}`);
    return doc;
  }

  async query(storeId: string, collection: string, query: StoreQuery): Promise<StoreDoc[]> {
    assertCollection(collection);
    const built = buildQuery(collection, query);
    return this.withRead(storeId, [], (db) => runQuery(db, collection, query, built));
  }

  async add(
    storeId: string,
    collection: string,
    data: unknown,
    options: WriteOptions = {},
  ): Promise<StoreDoc> {
    return this.set(storeId, collection, randomBytes(10).toString("hex"), data, options);
  }

  async set(
    storeId: string,
    collection: string,
    docId: string,
    data: unknown,
    options: WriteOptions = {},
  ): Promise<StoreDoc> {
    assertWritableCollection(collection, options);
    assertDocId(docId);
    const text = encodeDocData(data);
    return this.withWrite(storeId, options, (db, changes) => {
      const current = readDoc(db, collection, docId);
      assertExpectedRev(current, options.expectedRev, collection, docId);
      return writeDoc(db, changes, collection, docId, text, current);
    });
  }

  async update(
    storeId: string,
    collection: string,
    docId: string,
    patch: unknown,
    options: WriteOptions = {},
  ): Promise<StoreDoc> {
    assertWritableCollection(collection, options);
    assertDocId(docId);
    const patchText = encodeDocData(patch);
    return this.withWrite(storeId, options, (db, changes) => {
      const current = readDoc(db, collection, docId);
      if (!current) throw new StoreError(404, `Document not found: ${collection}/${docId}`);
      assertExpectedRev(current, options.expectedRev, collection, docId);
      const merged = db
        .prepare("SELECT json_patch(?, ?) AS data")
        .get(JSON.stringify(current.data), patchText) as { data: string };
      if (Buffer.byteLength(merged.data, "utf8") > MAX_DOC_BYTES) {
        throw new StoreError(413, `Document exceeds ${MAX_DOC_BYTES} bytes`);
      }
      return writeDoc(db, changes, collection, docId, merged.data, current);
    });
  }

  async delete(
    storeId: string,
    collection: string,
    docId: string,
    options: WriteOptions = {},
  ): Promise<void> {
    assertWritableCollection(collection, options);
    assertDocId(docId);
    await this.withWrite(storeId, options, (db, changes) => {
      const current = readDoc(db, collection, docId);
      if (!current) throw new StoreError(404, `Document not found: ${collection}/${docId}`);
      assertExpectedRev(current, options.expectedRev, collection, docId);
      db.prepare("DELETE FROM docs WHERE collection = ? AND id = ?").run(collection, docId);
      const rev = current.rev + 1;
      const info = db
        .prepare("INSERT INTO changes (collection, id, op, rev) VALUES (?, ?, 'delete', ?)")
        .run(collection, docId, rev);
      changes.push({
        seq: Number(info.lastInsertRowid),
        collection,
        id: docId,
        op: "delete",
        rev,
        doc: null,
      });
    });
  }

  /**
   * Inserts only when the doc is absent, atomically. Daemon-internal, size-capped.
   * `admit` runs in the same transaction before an insert and throws to refuse it.
   */
  async insertIfAbsent(
    storeId: string,
    collection: string,
    docId: string,
    data: unknown,
    admit?: (query: (query: StoreQuery) => StoreDoc[]) => void,
  ): Promise<{ inserted: boolean; doc: StoreDoc }> {
    assertCollection(collection);
    assertDocId(docId);
    const text = encodeDocData(data);
    return this.withWrite(
      storeId,
      { internal: true },
      (db, changes) => {
        const current = readDoc(db, collection, docId);
        if (current) return { inserted: false, doc: current };
        admit?.((query) => runQuery(db, collection, query, buildQuery(collection, query)));
        return { inserted: true, doc: writeDoc(db, changes, collection, docId, text, null) };
      },
      true,
    );
  }

  async changes(
    storeId: string,
    since: number,
    limit: number = CHANGES_PAGE,
  ): Promise<StoreChangesPage> {
    if (!Number.isInteger(since) || since < 0) {
      throw new StoreError(400, "since must be a non-negative integer");
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > CHANGES_PAGE) {
      throw new StoreError(400, `limit must be an integer between 1 and ${CHANGES_PAGE}`);
    }
    return this.withRead<StoreChangesPage>(
      storeId,
      since > 0 ? { changes: [], lastSeq: 0, reset: true } : { changes: [], lastSeq: 0 },
      (db) => readChanges(db, since, limit),
    );
  }

  /** Change rows with their current doc, for the page event stream. */
  async changesWithDocs(
    storeId: string,
    since: number,
    limit: number = CHANGES_PAGE,
  ): Promise<{
    changes: StoreChangeEvent[];
    lastSeq: number;
    reset?: true;
  }> {
    const page = await this.changes(storeId, since, limit);
    if (page.changes.length === 0) return { ...page, changes: [] };
    return this.withRead(storeId, { ...page, changes: [] }, (db) => ({
      ...page,
      changes: page.changes.map((change) => ({
        ...change,
        doc: change.op === "delete" ? null : readDoc(db, change.collection, change.id),
      })),
    }));
  }

  /** Runs `fn` against store meta in one write transaction. Daemon-internal. */
  async transactMeta<T>(storeId: string, fn: (meta: MetaTx) => T): Promise<T> {
    return this.withWrite(storeId, { internal: true }, (db) => {
      const meta: MetaTx = {
        get(key) {
          const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
            | { value: string }
            | undefined;
          return row ? (JSON.parse(row.value) as unknown) : undefined;
        },
        set(key, value) {
          db.prepare(
            "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
          ).run(key, JSON.stringify(value));
        },
      };
      return fn(meta);
    });
  }

  async readMeta(storeId: string, key: string): Promise<unknown> {
    return this.withRead<unknown>(storeId, undefined, (db) => {
      const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
        | { value: string }
        | undefined;
      return row ? (JSON.parse(row.value) as unknown) : undefined;
    });
  }
}

function assertWritableCollection(collection: string, options: WriteOptions): void {
  assertCollection(collection);
  if (collection === ACTIONS_COLLECTION && !options.internal) {
    throw new StoreError(400, "Collection _actions is written only through the actions route");
  }
}

function assertExpectedRev(
  current: StoreDoc | null,
  expectedRev: number | undefined,
  collection: string,
  docId: string,
): void {
  if (expectedRev === undefined) return;
  const actual = current?.rev ?? 0;
  if (actual !== expectedRev) {
    throw new StoreError(
      409,
      `Revision conflict on ${collection}/${docId}: expected ${expectedRev}, found ${actual}`,
    );
  }
}

function assertStoreSize(path: string): void {
  let total = 0;
  for (const file of [path, `${path}-wal`]) {
    try {
      total += statSync(file).size;
    } catch {
      // Absent file adds nothing.
    }
  }
  if (total > MAX_STORE_BYTES) {
    throw new StoreError(413, `Store exceeds ${MAX_STORE_BYTES} bytes`);
  }
}

function readDoc(db: DatabaseSync, collection: string, docId: string): StoreDoc | null {
  const row = db
    .prepare(
      "SELECT id, data, rev, created_at, updated_at FROM docs WHERE collection = ? AND id = ?",
    )
    .get(collection, docId) as DocRow | undefined;
  return row ? rowToDoc(row) : null;
}

function writeDoc(
  db: DatabaseSync,
  changes: StoreChangeEvent[],
  collection: string,
  docId: string,
  text: string,
  current: StoreDoc | null,
): StoreDoc {
  const now = new Date().toISOString();
  const rev = (current?.rev ?? 0) + 1;
  const createdAt = current?.createdAt ?? now;
  db.prepare(
    `INSERT INTO docs (collection, id, data, rev, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(collection, id) DO UPDATE SET data = excluded.data, rev = excluded.rev, updated_at = excluded.updated_at`,
  ).run(collection, docId, text, rev, createdAt, now);
  const info = db
    .prepare("INSERT INTO changes (collection, id, op, rev) VALUES (?, ?, 'set', ?)")
    .run(collection, docId, rev);
  const doc: StoreDoc = {
    id: docId,
    rev,
    createdAt,
    updatedAt: now,
    data: JSON.parse(text) as JsonObject,
  };
  changes.push({ seq: Number(info.lastInsertRowid), collection, id: docId, op: "set", rev, doc });
  return doc;
}

function readChanges(db: DatabaseSync, since: number, limit: number): StoreChangesPage {
  const seqRow = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'changes'").get() as
    | { seq: number }
    | undefined;
  const lastSeq = Number(seqRow?.seq ?? 0);
  const oldestRow = db.prepare("SELECT MIN(seq) AS seq FROM changes").get() as {
    seq: number | null;
  };
  const oldest = oldestRow.seq === null ? null : Number(oldestRow.seq);
  if (since > lastSeq || (since > 0 && oldest !== null && since < oldest - 1)) {
    return { changes: [], lastSeq, reset: true };
  }
  const rows = db
    .prepare("SELECT seq, collection, id, op, rev FROM changes WHERE seq > ? ORDER BY seq LIMIT ?")
    .all(since, limit) as unknown as StoreChange[];
  return {
    changes: rows.map((row) => ({ ...row, seq: Number(row.seq), rev: Number(row.rev) })),
    lastSeq,
  };
}

function runQuery(
  db: DatabaseSync,
  collection: string,
  query: StoreQuery,
  built: { sql: string; params: SQLInputValue[] },
): StoreDoc[] {
  const params = [...built.params];
  let sql = built.sql;
  if (query.startAfter !== undefined) {
    sql = sql.replace("/*cursor*/", cursorClause(db, collection, query, params));
  }
  const rows = db.prepare(sql).all(...params) as unknown as DocRow[];
  return rows.map(rowToDoc);
}

function buildQuery(
  collection: string,
  query: StoreQuery,
): { sql: string; params: SQLInputValue[] } {
  const where = query.where ?? [];
  if (!Array.isArray(where) || where.length > MAX_WHERE_CLAUSES) {
    throw new StoreError(400, `where accepts at most ${MAX_WHERE_CLAUSES} clauses`);
  }
  const clauses = ["collection = ?"];
  const params: SQLInputValue[] = [collection];
  for (const clause of where) {
    if (!isJsonObject(clause)) throw new StoreError(400, "where clause must be an object");
    const path = assertFieldPath(clause.field);
    const op = clause.op as WhereOp;
    if (!WHERE_OPS.has(op)) throw new StoreError(400, `Invalid where op: ${String(clause.op)}`);
    if (op === "in") {
      const values = clause.value;
      if (!Array.isArray(values) || values.length === 0 || values.length > MAX_IN_VALUES) {
        throw new StoreError(400, `in expects 1-${MAX_IN_VALUES} values`);
      }
      clauses.push(`json_extract(data, ?) IN (${values.map(() => "?").join(", ")})`);
      params.push(path, ...values.map(bindScalar));
    } else if (op === "contains") {
      clauses.push("EXISTS (SELECT 1 FROM json_each(data, ?) WHERE value = ?)");
      params.push(path, bindScalar(clause.value));
    } else if (op === "==" || op === "!=") {
      clauses.push(`json_extract(data, ?) ${op === "==" ? "IS" : "IS NOT"} ?`);
      params.push(path, bindScalar(clause.value));
    } else {
      if (clause.value === null) throw new StoreError(400, `${op} does not accept null`);
      clauses.push(`json_extract(data, ?) ${op} ?`);
      params.push(path, bindScalar(clause.value));
    }
  }
  if (query.startAfter !== undefined) {
    assertDocId(query.startAfter);
    clauses.push("/*cursor*/");
  }
  let order = "id ASC";
  if (query.orderBy !== undefined) {
    const path = assertFieldPath(query.orderBy.field);
    const direction = query.orderBy.direction ?? "asc";
    if (direction !== "asc" && direction !== "desc") {
      throw new StoreError(400, `Invalid orderBy direction: ${String(direction)}`);
    }
    order = `json_extract(data, ?) ${direction.toUpperCase()}, id ${direction.toUpperCase()}`;
    params.push(path);
  }
  const limit = normalizeLimit(query.limit);
  // Order params trail the where params; the cursor clause splices its own params in
  // before them (see cursorClause).
  return {
    sql: `SELECT id, data, rev, created_at, updated_at FROM docs WHERE ${clauses.join(" AND ")} ORDER BY ${order} LIMIT ${limit}`,
    params,
  };
}

// Keyset cursor after `startAfter`, ties broken by id. Inserts its params before the
// trailing orderBy param.
function cursorClause(
  db: DatabaseSync,
  collection: string,
  query: StoreQuery,
  params: SQLInputValue[],
): string {
  const startAfter = query.startAfter as string;
  const anchor = readDoc(db, collection, startAfter);
  if (!anchor) throw new StoreError(400, `startAfter document not found: ${startAfter}`);
  const insertAt = query.orderBy ? params.length - 1 : params.length;
  if (!query.orderBy) {
    params.splice(insertAt, 0, startAfter);
    return "id > ?";
  }
  const path = `$.${query.orderBy.field}`;
  const descending = query.orderBy.direction === "desc";
  const valueRow = db
    .prepare("SELECT json_extract(?, ?) AS v")
    .get(JSON.stringify(anchor.data), path) as {
    v: SQLInputValue;
  };
  const value = valueRow.v;
  let clause: string;
  let clauseParams: SQLInputValue[];
  // NULLs sort first ascending, last descending.
  if (value === null && descending) {
    clause = "(json_extract(data, ?) IS NULL AND id < ?)";
    clauseParams = [path, startAfter];
  } else if (value === null) {
    clause = "(json_extract(data, ?) IS NOT NULL OR id > ?)";
    clauseParams = [path, startAfter];
  } else if (descending) {
    clause =
      "(json_extract(data, ?) < ? OR json_extract(data, ?) IS NULL OR (json_extract(data, ?) = ? AND id < ?))";
    clauseParams = [path, value, path, path, value, startAfter];
  } else {
    clause = "(json_extract(data, ?) > ? OR (json_extract(data, ?) = ? AND id > ?))";
    clauseParams = [path, value, path, value, startAfter];
  }
  params.splice(insertAt, 0, ...clauseParams);
  return clause;
}
