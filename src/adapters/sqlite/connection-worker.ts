import { lstatSync } from "node:fs";
import { createRequire } from "node:module";
import { parentPort, workerData } from "node:worker_threads";

import type {
  ProjectionReplayJournalEvent,
  ProjectionSnapshot,
} from "../../domain/projection-replay.js";

import {
  SQLITE_CONNECTION_POLICY,
  type SqliteAllResult,
  type SqliteBinding,
  type SqliteCommandResult,
  type SqliteConnectionPolicy,
  type SqliteGetResult,
  type SqliteMigrationExecutionResult,
  type SqlitePreparedMigration,
  type SqliteProjectionDispatchAppendEvent,
  type SqliteProjectionDispatchBeginResult,
  type SqliteProjectionDispatchCommitResult,
  type SqliteProjectionMetaSnapshot,
  type SqliteProjectionPublishMode,
  type SqliteProjectionReplayBeginResult,
  type SqliteProjectionReplayCommitResult,
  type SqliteReadQuery,
  type SqliteReadResult,
  type SqliteRunResult,
  type SqliteTransactionCommand,
  type SqliteWorkerData,
  type SqliteWorkerRequest,
  type SqliteWorkerErrorCode,
  type SqliteWorkerResponse,
} from "./connection-protocol.js";
import { RECALL_SNAPSHOT_SQL_SOURCE } from "./recall-snapshot-sql.js";

interface SqliteRunMetadata {
  readonly changes: number;
  readonly lastInsertRowid: number | bigint;
}

interface SqliteStatement {
  run(...parameters: readonly SqliteBinding[]): SqliteRunMetadata;
  run(parameters: Readonly<Record<string, SqliteBinding>>): SqliteRunMetadata;
  get(...parameters: readonly SqliteBinding[]): unknown;
  all(...parameters: readonly SqliteBinding[]): unknown[];
}

interface SqliteDatabaseConnection {
  readonly inTransaction: boolean;
  pragma(source: string, options?: { readonly simple?: boolean }): unknown;
  exec(sql: string): unknown;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

interface SqliteDatabaseConstructor {
  new (
    filename: string,
    options: {
      readonly readonly: boolean;
      readonly fileMustExist: boolean;
      readonly timeout: number;
    },
  ): SqliteDatabaseConnection;
}

class WorkerConnectionFailure extends Error {
  public readonly code: Exclude<SqliteWorkerErrorCode, "SQLITE_BUSY">;

  public constructor(code: Exclude<SqliteWorkerErrorCode, "SQLITE_BUSY">) {
    super(code);
    this.code = code;
  }
}

interface ActiveProjectionReplay {
  readonly replayId: number;
  readonly scopeKey: string;
  readonly events: readonly ProjectionReplayJournalEvent[];
  readonly current: ProjectionSnapshot;
}

interface WorkerProjectionReplayState {
  active: ActiveProjectionReplay | null;
}

interface ActiveRecallSnapshot {
  readonly snapshotId: number;
  readonly scopeKey: string;
  readonly evaluationNow: number;
}

interface WorkerRecallSnapshotState {
  active: ActiveRecallSnapshot | null;
}

const require = createRequire(import.meta.url);
const TRANSACTION_CONTROL_KEYWORDS: ReadonlySet<string> = new Set([
  "BEGIN",
  "COMMIT",
  "END",
  "ROLLBACK",
  "SAVEPOINT",
  "RELEASE",
]);
const REPLAY_SCOPE_PATTERN = /^u:[A-Za-z0-9._-]{1,64}\/p:[A-Za-z0-9._-]{1,64}$/u;
const DISPATCH_EVENT_ID_PATTERN = /^ev_[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
const REPLAY_RULES_CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
const SCHEMA_MIGRATIONS_DDL = `
CREATE TABLE schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  checksum   TEXT NOT NULL,
  applied_at INTEGER NOT NULL
)
`;

function loadSqliteDatabaseConstructor(): SqliteDatabaseConstructor {
  return require("better-sqlite3") as SqliteDatabaseConstructor;
}

function readWorkerData(value: unknown): SqliteWorkerData {
  if (
    value === null ||
    typeof value !== "object" ||
    !("role" in value) ||
    !("databasePath" in value) ||
    (value.role !== "writer" && value.role !== "reader") ||
    typeof value.databasePath !== "string" ||
    value.databasePath.length === 0
  ) {
    throw new WorkerConnectionFailure("SQLITE_CONNECTION_FAILED");
  }
  return Object.freeze({ role: value.role, databasePath: value.databasePath });
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as Error & { readonly code?: unknown }).code === code
  );
}

function assertSafeSidecars(databasePath: string): void {
  if (process.platform === "win32") {
    return;
  }

  for (const suffix of ["-wal", "-shm"] as const) {
    try {
      const status = lstatSync(`${databasePath}${suffix}`);
      if (
        status.isSymbolicLink() ||
        !status.isFile() ||
        (status.mode & 0o777) !== 0o600
      ) {
        throw new WorkerConnectionFailure("SQLITE_SIDECAR_UNSAFE");
      }
    } catch (error) {
      if (isErrnoCode(error, "ENOENT")) {
        continue;
      }
      if (error instanceof WorkerConnectionFailure) {
        throw error;
      }
      throw new WorkerConnectionFailure("SQLITE_SIDECAR_UNSAFE");
    }
  }
}

function simplePragma(
  database: SqliteDatabaseConnection,
  source: string,
): unknown {
  return database.pragma(source, { simple: true });
}

function applyConnectionPolicy(
  database: SqliteDatabaseConnection,
  role: "writer" | "reader",
): SqliteConnectionPolicy {
  const currentJournalMode = String(
    simplePragma(database, "journal_mode"),
  ).toLowerCase();
  const journalMode =
    role === "writer" && currentJournalMode !== SQLITE_CONNECTION_POLICY.journalMode
      ? String(simplePragma(database, "journal_mode = WAL")).toLowerCase()
      : currentJournalMode;
  if (journalMode !== SQLITE_CONNECTION_POLICY.journalMode) {
    throw new WorkerConnectionFailure(
      role === "writer" ? "WAL_MODE_UNAVAILABLE" : "WAL_MODE_REQUIRED",
    );
  }

  database.pragma("synchronous = NORMAL");
  database.pragma(`busy_timeout = ${SQLITE_CONNECTION_POLICY.busyTimeoutMs}`);
  database.pragma(`cache_size = ${SQLITE_CONNECTION_POLICY.cacheSize}`);
  database.pragma("temp_store = MEMORY");
  database.pragma("foreign_keys = ON");

  const configuration: SqliteConnectionPolicy = Object.freeze({
    journalMode: "wal",
    synchronous: Number(simplePragma(database, "synchronous")) as 1,
    busyTimeoutMs: Number(simplePragma(database, "busy_timeout")) as 5000,
    cacheSize: Number(simplePragma(database, "cache_size")) as -20000,
    tempStore: Number(simplePragma(database, "temp_store")) as 2,
    foreignKeys: Number(simplePragma(database, "foreign_keys")) as 1,
  });

  if (
    configuration.synchronous !== SQLITE_CONNECTION_POLICY.synchronous ||
    configuration.busyTimeoutMs !== SQLITE_CONNECTION_POLICY.busyTimeoutMs ||
    configuration.cacheSize !== SQLITE_CONNECTION_POLICY.cacheSize ||
    configuration.tempStore !== SQLITE_CONNECTION_POLICY.tempStore ||
    configuration.foreignKeys !== SQLITE_CONNECTION_POLICY.foreignKeys
  ) {
    throw new WorkerConnectionFailure("CONNECTION_POLICY_UNAVAILABLE");
  }
  return configuration;
}

function parametersOf(
  command: Exclude<SqliteTransactionCommand, { readonly kind: "exec" }>,
): readonly SqliteBinding[] {
  return command.parameters ?? [];
}

function rowOrNull(value: unknown): Readonly<Record<string, unknown>> | null {
  if (value === undefined) {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkerConnectionFailure("SQLITE_QUERY_FAILED");
  }
  return value as Readonly<Record<string, unknown>>;
}

function rows(value: unknown[]): readonly Readonly<Record<string, unknown>>[] {
  if (
    !value.every(
      (row) => row !== null && typeof row === "object" && !Array.isArray(row),
    )
  ) {
    throw new WorkerConnectionFailure("SQLITE_QUERY_FAILED");
  }
  return value as readonly Readonly<Record<string, unknown>>[];
}

function firstSqlKeyword(sql: string): string {
  let remainder = sql.trimStart();
  while (
    remainder.startsWith(";") ||
    remainder.startsWith("--") ||
    remainder.startsWith("/*")
  ) {
    if (remainder.startsWith(";")) {
      remainder = remainder.slice(1).trimStart();
      continue;
    }
    if (remainder.startsWith("--")) {
      const lineEnd = remainder.indexOf("\n");
      remainder = lineEnd < 0 ? "" : remainder.slice(lineEnd + 1).trimStart();
    } else {
      const commentEnd = remainder.indexOf("*/", 2);
      remainder =
        commentEnd < 0 ? "" : remainder.slice(commentEnd + 2).trimStart();
    }
  }
  return /^[A-Za-z]+/u.exec(remainder)?.[0]?.toUpperCase() ?? "";
}

function assertTransactionBoundaryOwned(sql: string): void {
  if (TRANSACTION_CONTROL_KEYWORDS.has(firstSqlKeyword(sql))) {
    throw new WorkerConnectionFailure("INVALID_TRANSACTION_PROGRAM");
  }
}

function executeCommand(
  database: SqliteDatabaseConnection,
  command: SqliteTransactionCommand,
): SqliteCommandResult {
  assertTransactionBoundaryOwned(command.sql);
  if (command.kind === "exec") {
    database.prepare(command.sql).run();
    return Object.freeze({ kind: "exec" });
  }

  const statement = database.prepare(command.sql);
  const parameters = parametersOf(command);
  if (command.kind === "run") {
    const metadata = statement.run(...parameters);
    const result: SqliteRunResult = Object.freeze({
      kind: "run",
      changes: metadata.changes,
      lastInsertRowid: metadata.lastInsertRowid,
    });
    return result;
  }
  if (command.kind === "get") {
    const result: SqliteGetResult = Object.freeze({
      kind: "get",
      row: rowOrNull(statement.get(...parameters)),
    });
    return result;
  }
  const result: SqliteAllResult = Object.freeze({
    kind: "all",
    rows: rows(statement.all(...parameters)),
  });
  return result;
}

function executeTransaction(
  database: SqliteDatabaseConnection,
  databasePath: string,
  commands: readonly SqliteTransactionCommand[],
): readonly SqliteCommandResult[] {
  let transactionStarted = false;
  try {
    database.exec("BEGIN IMMEDIATE");
    transactionStarted = true;
    assertSafeSidecars(databasePath);
    const results = commands.map((command) => executeCommand(database, command));
    database.exec("COMMIT");
    return results;
  } catch (error) {
    if (transactionStarted && database.inTransaction) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // The original failure determines the safe public error.
      }
    }
    throw error;
  }
}

function projectionJournalEvents(
  database: SqliteDatabaseConnection,
  scopeKey: string,
): readonly ProjectionReplayJournalEvent[] {
  const rawRows = database
    .prepare(
      [
        "SELECT seq, id, scope_key, kind, body, actor, branch, session, created_at",
        "FROM journal WHERE scope_key = ? ORDER BY seq",
      ].join(" "),
    )
    .all(scopeKey);
  const events = rawRows.map((rawRow) => {
    if (rawRow === null || typeof rawRow !== "object" || Array.isArray(rawRow)) {
      throw new WorkerConnectionFailure("SQLITE_TRANSACTION_FAILED");
    }
    const row = rawRow as Readonly<Record<string, unknown>>;
    if (
      !Number.isSafeInteger(row["seq"]) ||
      Number(row["seq"]) <= 0 ||
      typeof row["id"] !== "string" ||
      row["scope_key"] !== scopeKey ||
      (row["kind"] !== "statement" &&
        row["kind"] !== "retraction" &&
        row["kind"] !== "merge" &&
        row["kind"] !== "alias") ||
      typeof row["body"] !== "string" ||
      (row["actor"] !== null && typeof row["actor"] !== "string") ||
      (row["branch"] !== null && typeof row["branch"] !== "string") ||
      (row["session"] !== null && typeof row["session"] !== "string") ||
      !Number.isSafeInteger(row["created_at"]) ||
      Number(row["created_at"]) < 0
    ) {
      throw new WorkerConnectionFailure("SQLITE_TRANSACTION_FAILED");
    }
    return Object.freeze({
      seq: Number(row["seq"]),
      eventId: row["id"],
      scopeKey,
      kind: row["kind"],
      bodyJson: row["body"],
      actor: row["actor"],
      branch: row["branch"],
      session: row["session"],
      createdAt: Number(row["created_at"]),
    }) as ProjectionReplayJournalEvent;
  });
  return Object.freeze(events);
}

function projectionMeta(
  database: SqliteDatabaseConnection,
  scopeKey: string,
): SqliteProjectionMetaSnapshot | null {
  const rawRow = database
    .prepare(
      "SELECT last_seq, rules_version, rebuilt_at FROM projection_meta WHERE scope_key = ?",
    )
    .get(scopeKey);
  if (rawRow === undefined) {
    return null;
  }
  if (rawRow === null || typeof rawRow !== "object" || Array.isArray(rawRow)) {
    throw new WorkerConnectionFailure("SQLITE_TRANSACTION_FAILED");
  }
  const row = rawRow as Readonly<Record<string, unknown>>;
  if (
    !Number.isSafeInteger(row["last_seq"]) ||
    Number(row["last_seq"]) < 0 ||
    typeof row["rules_version"] !== "string" ||
    !Number.isSafeInteger(row["rebuilt_at"]) ||
    Number(row["rebuilt_at"]) < 0
  ) {
    throw new WorkerConnectionFailure("SQLITE_TRANSACTION_FAILED");
  }
  return Object.freeze({
    lastSeq: Number(row["last_seq"]),
    rulesVersion: row["rules_version"],
    rebuiltAt: Number(row["rebuilt_at"]),
  });
}

function projectionRows(
  database: SqliteDatabaseConnection,
  sql: string,
  parameters: readonly SqliteBinding[],
): readonly Readonly<Record<string, unknown>>[] {
  return rows(database.prepare(sql).all(...parameters));
}

function projectionSnapshot(
  database: SqliteDatabaseConnection,
  scopeKey: string,
): ProjectionSnapshot {
  const statements = projectionRows(
    database,
    "SELECT event_id, scope_key, state, order_seq, created_at, provenance, expires_at FROM statements WHERE scope_key=? ORDER BY order_seq, event_id",
    [scopeKey],
  ).map((row) =>
    Object.freeze({
      eventId: row["event_id"] as string,
      scopeKey: row["scope_key"] as string,
      state: row["state"] as "live" | "retracted" | "superseded",
      orderSeq: Number(row["order_seq"]),
      createdAt: Number(row["created_at"]),
      provenance: row["provenance"] as "user_stated" | "observed" | "inferred",
      expiresAt:
        row["expires_at"] === null ? null : Number(row["expires_at"]),
    }),
  );
  const entities = projectionRows(
    database,
    "SELECT id, scope_key, name, normal_name, kind, merged_into, origin_seq FROM entities WHERE scope_key=? ORDER BY id",
    [scopeKey],
  ).map((row) =>
    Object.freeze({
      id: row["id"] as string,
      scopeKey: row["scope_key"] as string,
      name: row["name"] as string,
      normalName: row["normal_name"] as string,
      kind: row["kind"] as string | null,
      mergedInto: row["merged_into"] as string | null,
      originSeq: Number(row["origin_seq"]),
    }),
  );
  const surfaceForms = projectionRows(
    database,
    "SELECT scope_key, surface_norm, entity_id, origin FROM surface_forms WHERE scope_key=? ORDER BY surface_norm, entity_id",
    [scopeKey],
  ).map((row) =>
    Object.freeze({
      scopeKey: row["scope_key"] as string,
      surfaceNorm: row["surface_norm"] as string,
      entityId: row["entity_id"] as string,
      origin: row["origin"] as "name" | "agent_supplied" | "confirmed",
    }),
  );
  const claims = projectionRows(
    database,
    "SELECT id, scope_key, subject_id, relation, object_id, object_value, state, origin_seq, first_seen_at, last_seen_at FROM claims WHERE scope_key=? ORDER BY id",
    [scopeKey],
  ).map((row) =>
    Object.freeze({
      id: row["id"] as string,
      scopeKey: row["scope_key"] as string,
      subjectId: row["subject_id"] as string,
      relation: row["relation"] as "uses" | "rejects" | "contains" | "describes" | "relates_to",
      objectId: row["object_id"] as string | null,
      objectValue: row["object_value"] as string | null,
      state: row["state"] as "active" | "superseded" | "retracted",
      originSeq: Number(row["origin_seq"]),
      firstSeenAt: Number(row["first_seen_at"]),
      lastSeenAt: Number(row["last_seen_at"]),
    }),
  );
  const claimSupport = projectionRows(
    database,
    [
      "SELECT cs.claim_id, cs.event_id, cs.draft_index, cs.live, cs.expires_at",
      "FROM claim_support cs JOIN claims c ON c.id=cs.claim_id",
      "WHERE c.scope_key=? ORDER BY cs.claim_id, cs.event_id",
    ].join(" "),
    [scopeKey],
  ).map((row) =>
    Object.freeze({
      claimId: row["claim_id"] as string,
      eventId: row["event_id"] as string,
      draftIndex: Number(row["draft_index"]),
      live: Number(row["live"]) as 0 | 1,
      expiresAt:
        row["expires_at"] === null ? null : Number(row["expires_at"]),
    }),
  );
  const idRedirects = projectionRows(
    database,
    [
      "SELECT r.old_id, r.new_id, r.kind, r.reason FROM id_redirects r WHERE",
      "r.new_id IN (SELECT id FROM entities WHERE scope_key=? UNION SELECT id FROM claims WHERE scope_key=?)",
      "OR r.old_id IN (SELECT id FROM entities WHERE scope_key=? UNION SELECT id FROM claims WHERE scope_key=?)",
      "ORDER BY r.old_id",
    ].join(" "),
    [scopeKey, scopeKey, scopeKey, scopeKey],
  ).map((row) =>
    Object.freeze({
      oldId: row["old_id"] as string,
      newId: row["new_id"] as string,
      kind: row["kind"] as "entity" | "claim",
      reason: row["reason"] as "merge" | "rule_change" | "deduplicated",
    }),
  );
  return Object.freeze({
    statements: Object.freeze(statements),
    entities: Object.freeze(entities),
    surfaceForms: Object.freeze(surfaceForms),
    claims: Object.freeze(claims),
    claimSupport: Object.freeze(claimSupport),
    idRedirects: Object.freeze(idRedirects),
  });
}

function beginProjectionReplay(
  database: SqliteDatabaseConnection,
  databasePath: string,
  replayState: WorkerProjectionReplayState,
  replayId: number,
  scopeKey: string,
): SqliteProjectionReplayBeginResult {
  if (
    replayState.active !== null ||
    !Number.isSafeInteger(replayId) ||
    replayId <= 0 ||
    typeof scopeKey !== "string" ||
    !REPLAY_SCOPE_PATTERN.test(scopeKey)
  ) {
    throw new WorkerConnectionFailure("SQLITE_TRANSACTION_FAILED");
  }
  let transactionStarted = false;
  try {
    database.exec("BEGIN IMMEDIATE");
    transactionStarted = true;
    database.pragma("defer_foreign_keys = ON");
    assertSafeSidecars(databasePath);
    const events = projectionJournalEvents(database, scopeKey);
    const meta = projectionMeta(database, scopeKey);
    replayState.active = Object.freeze({
      replayId,
      scopeKey,
      events,
      current: projectionSnapshot(database, scopeKey),
    });
    return Object.freeze({ replayId, events, meta });
  } catch (error) {
    if (transactionStarted && database.inTransaction) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // The original failure owns the public result.
      }
    }
    replayState.active = null;
    throw error;
  }
}

function beginProjectionDispatch(
  database: SqliteDatabaseConnection,
  databasePath: string,
  replayState: WorkerProjectionReplayState,
  dispatchId: number,
  scopeKey: string,
  appendEvents: readonly SqliteProjectionDispatchAppendEvent[],
): SqliteProjectionDispatchBeginResult {
  if (
    replayState.active !== null ||
    !Number.isSafeInteger(dispatchId) ||
    dispatchId <= 0 ||
    typeof scopeKey !== "string" ||
    !REPLAY_SCOPE_PATTERN.test(scopeKey) ||
    !Array.isArray(appendEvents) ||
    appendEvents.length === 0
  ) {
    throw new WorkerConnectionFailure("SQLITE_TRANSACTION_FAILED");
  }
  const ids = new Set<string>();
  for (const event of appendEvents) {
    if (
      event === null ||
      typeof event !== "object" ||
      typeof event.eventId !== "string" ||
      !DISPATCH_EVENT_ID_PATTERN.test(event.eventId) ||
      ids.has(event.eventId) ||
      (event.kind !== "statement" &&
        event.kind !== "retraction" &&
        event.kind !== "merge" &&
        event.kind !== "alias") ||
      typeof event.bodyJson !== "string" ||
      (event.actor !== null && typeof event.actor !== "string") ||
      (event.branch !== null && typeof event.branch !== "string") ||
      (event.session !== null && typeof event.session !== "string") ||
      !Number.isSafeInteger(event.createdAt) ||
      event.createdAt < 0
    ) {
      throw new WorkerConnectionFailure("SQLITE_TRANSACTION_FAILED");
    }
    ids.add(event.eventId);
  }

  let transactionStarted = false;
  try {
    database.exec("BEGIN IMMEDIATE");
    transactionStarted = true;
    database.pragma("defer_foreign_keys = ON");
    assertSafeSidecars(databasePath);
    const previousEvents = projectionJournalEvents(database, scopeKey);
    const previousLastSeq = previousEvents.at(-1)?.seq ?? 0;
    const current = projectionSnapshot(database, scopeKey);
    const meta = projectionMeta(database, scopeKey);
    const projectionValid = projectionScopeIsValid(database, scopeKey, current);
    const values = appendEvents.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
    const sql = [
      "WITH candidate(id, scope_key, kind, body, actor, branch, session, created_at, ordinal) AS (",
      `VALUES ${values}`,
      ")",
      "INSERT INTO journal(id, scope_key, kind, body, actor, branch, session, created_at)",
      "SELECT id, scope_key, kind, body, actor, branch, session, created_at FROM candidate",
      "WHERE NOT EXISTS (SELECT 1 FROM journal existing JOIN candidate proposed ON proposed.id=existing.id)",
      "ORDER BY ordinal RETURNING seq, id",
    ].join(" ");
    const parameters: SqliteBinding[] = [];
    for (const [index, event] of appendEvents.entries()) {
      parameters.push(
        event.eventId,
        scopeKey,
        event.kind,
        event.bodyJson,
        event.actor,
        event.branch,
        event.session,
        event.createdAt,
        index,
      );
    }
    const inserted = rows(database.prepare(sql).all(...parameters));
    if (inserted.length !== 0 && inserted.length !== appendEvents.length) {
      throw new WorkerConnectionFailure("SQLITE_TRANSACTION_FAILED");
    }
    const events =
      inserted.length === 0
        ? previousEvents
        : projectionJournalEvents(database, scopeKey);
    const appendedById = new Map(
      events
        .filter((event) => ids.has(event.eventId))
        .map((event) => [event.eventId, event]),
    );
    const appendedEvents = appendEvents.map((event) => appendedById.get(event.eventId));
    if (
      inserted.length > 0 &&
      appendedEvents.some((event) => event === undefined)
    ) {
      throw new WorkerConnectionFailure("SQLITE_TRANSACTION_FAILED");
    }
    replayState.active = Object.freeze({
      replayId: dispatchId,
      scopeKey,
      events,
      current,
    });
    return Object.freeze({
      dispatchId,
      collision: inserted.length === 0,
      events,
      appendedEvents: Object.freeze(
        inserted.length === 0
          ? []
          : (appendedEvents as readonly ProjectionReplayJournalEvent[]),
      ),
      current,
      meta,
      projectionValid,
      previousLastSeq,
    });
  } catch (error) {
    if (transactionStarted && database.inTransaction) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // The original failure owns the public result.
      }
    }
    replayState.active = null;
    throw error;
  }
}

function deleteScopeProjection(
  database: SqliteDatabaseConnection,
  scopeKey: string,
): void {
  database
    .prepare(
      [
        "DELETE FROM id_redirects WHERE",
        "new_id IN (SELECT id FROM entities WHERE scope_key = ? UNION SELECT id FROM claims WHERE scope_key = ?)",
        "OR old_id IN (SELECT id FROM entities WHERE scope_key = ? UNION SELECT id FROM claims WHERE scope_key = ?)",
      ].join(" "),
    )
    .run(scopeKey, scopeKey, scopeKey, scopeKey);
  database
    .prepare(
      [
        "DELETE FROM claim_support WHERE",
        "claim_id IN (SELECT id FROM claims WHERE scope_key = ?)",
        "OR event_id IN (SELECT event_id FROM statements WHERE scope_key = ?)",
      ].join(" "),
    )
    .run(scopeKey, scopeKey);
  database.prepare("DELETE FROM claims WHERE scope_key = ?").run(scopeKey);
  database
    .prepare("DELETE FROM surface_forms WHERE scope_key = ?")
    .run(scopeKey);
  database.prepare("DELETE FROM entities WHERE scope_key = ?").run(scopeKey);
  database.prepare("DELETE FROM statements WHERE scope_key = ?").run(scopeKey);
}

function insertProjectionSnapshot(
  database: SqliteDatabaseConnection,
  snapshot: ProjectionSnapshot,
): void {
  const insertStatement = database.prepare(
    "INSERT INTO statements(event_id, scope_key, state, order_seq, created_at, provenance, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  for (const row of snapshot.statements) {
    insertStatement.run(
      row.eventId,
      row.scopeKey,
      row.state,
      row.orderSeq,
      row.createdAt,
      row.provenance,
      row.expiresAt,
    );
  }

  const insertEntity = database.prepare(
    "INSERT INTO entities(id, scope_key, name, normal_name, kind, merged_into, origin_seq) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  for (const row of snapshot.entities) {
    insertEntity.run(
      row.id,
      row.scopeKey,
      row.name,
      row.normalName,
      row.kind,
      row.mergedInto,
      row.originSeq,
    );
  }

  const insertSurface = database.prepare(
    "INSERT INTO surface_forms(scope_key, surface_norm, entity_id, origin) VALUES (?, ?, ?, ?)",
  );
  for (const row of snapshot.surfaceForms) {
    insertSurface.run(row.scopeKey, row.surfaceNorm, row.entityId, row.origin);
  }

  const insertClaim = database.prepare(
    "INSERT INTO claims(id, scope_key, subject_id, relation, object_id, object_value, state, origin_seq, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const row of snapshot.claims) {
    insertClaim.run(
      row.id,
      row.scopeKey,
      row.subjectId,
      row.relation,
      row.objectId,
      row.objectValue,
      row.state,
      row.originSeq,
      row.firstSeenAt,
      row.lastSeenAt,
    );
  }

  const insertSupport = database.prepare(
    "INSERT INTO claim_support(claim_id, event_id, draft_index, live, expires_at) VALUES (?, ?, ?, ?, ?)",
  );
  for (const row of snapshot.claimSupport) {
    insertSupport.run(
      row.claimId,
      row.eventId,
      row.draftIndex,
      row.live,
      row.expiresAt,
    );
  }

  const insertRedirect = database.prepare(
    "INSERT INTO id_redirects(old_id, new_id, kind, reason) VALUES (?, ?, ?, ?)",
  );
  for (const row of snapshot.idRedirects) {
    insertRedirect.run(row.oldId, row.newId, row.kind, row.reason);
  }
}

function hasRow(database: SqliteDatabaseConnection, sql: string): boolean {
  return database.prepare(sql).get() !== undefined;
}

function hasBoundRow(
  database: SqliteDatabaseConnection,
  sql: string,
  parameters: readonly SqliteBinding[],
): boolean {
  return database.prepare(sql).get(...parameters) !== undefined;
}

function redirectGraphIsValid(snapshot: ProjectionSnapshot): boolean {
  const entityIds = new Set(snapshot.entities.map((row) => row.id));
  const claimIds = new Set(snapshot.claims.map((row) => row.id));
  const redirects = new Map(snapshot.idRedirects.map((row) => [row.oldId, row]));
  for (const redirect of snapshot.idRedirects) {
    const targets = redirect.kind === "entity" ? entityIds : claimIds;
    if (!targets.has(redirect.newId)) {
      return false;
    }
    let current = redirect.oldId;
    const seen = new Set<string>();
    for (let depth = 0; ; depth += 1) {
      const next = redirects.get(current);
      if (next === undefined) {
        break;
      }
      if (depth >= 32 || seen.has(current) || next.kind !== redirect.kind) {
        return false;
      }
      seen.add(current);
      current = next.newId;
    }
  }
  return true;
}

function projectionScopeIsValid(
  database: SqliteDatabaseConnection,
  scopeKey: string,
  snapshot: ProjectionSnapshot,
): boolean {
  try {
    return !(
      hasBoundRow(
        database,
        "SELECT 1 FROM statements s LEFT JOIN journal j ON j.id=s.event_id WHERE s.scope_key=? AND (j.id IS NULL OR j.scope_key<>s.scope_key OR j.kind<>'statement') LIMIT 1",
        [scopeKey],
      ) ||
      hasBoundRow(
        database,
        "SELECT 1 FROM claims c WHERE c.scope_key=? AND c.state='active' AND NOT EXISTS (SELECT 1 FROM claim_support cs JOIN statements s ON s.event_id=cs.event_id WHERE cs.claim_id=c.id AND cs.live=1 AND s.state='live') LIMIT 1",
        [scopeKey],
      ) ||
      hasBoundRow(
        database,
        "SELECT 1 FROM claim_support cs JOIN claims c ON c.id=cs.claim_id JOIN statements s ON s.event_id=cs.event_id WHERE c.scope_key=? AND cs.expires_at IS NOT s.expires_at LIMIT 1",
        [scopeKey],
      ) ||
      hasBoundRow(
        database,
        "SELECT 1 FROM claims WHERE scope_key=? AND state='active' AND relation='describes' GROUP BY subject_id HAVING COUNT(*)>1 LIMIT 1",
        [scopeKey],
      ) ||
      !redirectGraphIsValid(snapshot)
    );
  } catch {
    return false;
  }
}

function validateProjectionInvariants(database: SqliteDatabaseConnection): void {
  const allRedirects = projectionRows(
    database,
    "SELECT old_id, new_id, kind, reason FROM id_redirects ORDER BY old_id",
    [],
  );
  if (
    database.prepare("PRAGMA foreign_key_check").all().length > 0 ||
    hasRow(
      database,
      "SELECT 1 FROM statements s JOIN journal j ON j.id=s.event_id WHERE s.scope_key<>j.scope_key OR j.kind<>'statement' LIMIT 1",
    ) ||
    hasRow(
      database,
      "SELECT 1 FROM surface_forms sf JOIN entities e ON e.id=sf.entity_id WHERE sf.scope_key<>e.scope_key LIMIT 1",
    ) ||
    hasRow(
      database,
      "SELECT 1 FROM entities e JOIN entities m ON m.id=e.merged_into WHERE e.scope_key<>m.scope_key LIMIT 1",
    ) ||
    hasRow(
      database,
      "SELECT 1 FROM claims c JOIN entities s ON s.id=c.subject_id LEFT JOIN entities o ON o.id=c.object_id WHERE c.scope_key<>s.scope_key OR (o.id IS NOT NULL AND c.scope_key<>o.scope_key) LIMIT 1",
    ) ||
    hasRow(
      database,
      "SELECT 1 FROM claim_support cs JOIN claims c ON c.id=cs.claim_id JOIN statements s ON s.event_id=cs.event_id WHERE c.scope_key<>s.scope_key LIMIT 1",
    ) ||
    hasRow(
      database,
      [
        "WITH target(id, scope_key, kind) AS (",
        "SELECT id, scope_key, 'entity' FROM entities UNION ALL SELECT id, scope_key, 'claim' FROM claims",
        ") SELECT 1 FROM id_redirects r LEFT JOIN target t ON t.id=r.new_id",
        "WHERE t.id IS NULL OR t.kind<>r.kind LIMIT 1",
      ].join(" "),
    ) ||
    hasRow(
      database,
      "SELECT 1 FROM claims c WHERE c.state='active' AND NOT EXISTS (SELECT 1 FROM claim_support cs JOIN statements s ON s.event_id=cs.event_id WHERE cs.claim_id=c.id AND cs.live=1 AND s.state='live') LIMIT 1",
    ) ||
    hasRow(
      database,
      "SELECT 1 FROM claim_support cs JOIN statements s ON s.event_id=cs.event_id WHERE cs.expires_at IS NOT s.expires_at LIMIT 1",
    ) ||
    hasRow(
      database,
      "SELECT 1 FROM claims WHERE state='active' AND relation='describes' GROUP BY scope_key, subject_id HAVING COUNT(*)>1 LIMIT 1",
    )
  ) {
    throw new WorkerConnectionFailure("SQLITE_TRANSACTION_FAILED");
  }
  const targetRows = projectionRows(
    database,
    "SELECT id, 'entity' AS kind FROM entities UNION ALL SELECT id, 'claim' AS kind FROM claims",
    [],
  );
  const targetKind = new Map(
    targetRows.map((row) => [row["id"] as string, row["kind"] as string]),
  );
  const redirects = new Map(
    allRedirects.map((row) => [
      row["old_id"] as string,
      Object.freeze({
        newId: row["new_id"] as string,
        kind: row["kind"] as string,
      }),
    ]),
  );
  for (const [oldId, redirect] of redirects) {
    let current = oldId;
    const seen = new Set<string>();
    for (let depth = 0; ; depth += 1) {
      const next = redirects.get(current);
      if (next === undefined) {
        if (targetKind.get(current) !== redirect.kind) {
          throw new WorkerConnectionFailure("SQLITE_TRANSACTION_FAILED");
        }
        break;
      }
      if (depth >= 32 || seen.has(current) || next.kind !== redirect.kind) {
        throw new WorkerConnectionFailure("SQLITE_TRANSACTION_FAILED");
      }
      seen.add(current);
      current = next.newId;
    }
  }
}

function rowKey(parts: readonly (string | number)[]): string {
  return JSON.stringify(parts);
}

function rowsEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertNoIncrementalRemoval(
  current: ReadonlyMap<string, unknown>,
  desired: ReadonlyMap<string, unknown>,
): void {
  for (const key of current.keys()) {
    if (!desired.has(key)) {
      throw new WorkerConnectionFailure("SQLITE_TRANSACTION_FAILED");
    }
  }
}

function publishIncrementalProjection(
  database: SqliteDatabaseConnection,
  current: ProjectionSnapshot,
  desired: ProjectionSnapshot,
): void {
  const currentStatements = new Map(
    current.statements.map((row) => [row.eventId, row]),
  );
  const desiredStatements = new Map(
    desired.statements.map((row) => [row.eventId, row]),
  );
  const currentEntities = new Map(current.entities.map((row) => [row.id, row]));
  const desiredEntities = new Map(desired.entities.map((row) => [row.id, row]));
  const currentClaims = new Map(current.claims.map((row) => [row.id, row]));
  const desiredClaims = new Map(desired.claims.map((row) => [row.id, row]));
  const currentRedirects = new Map(
    current.idRedirects.map((row) => [row.oldId, row]),
  );
  const desiredRedirects = new Map(
    desired.idRedirects.map((row) => [row.oldId, row]),
  );
  assertNoIncrementalRemoval(currentStatements, desiredStatements);
  assertNoIncrementalRemoval(currentEntities, desiredEntities);
  assertNoIncrementalRemoval(currentClaims, desiredClaims);
  assertNoIncrementalRemoval(currentRedirects, desiredRedirects);

  const upsertStatement = database.prepare(
    [
      "INSERT INTO statements(event_id, scope_key, state, order_seq, created_at, provenance, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      "ON CONFLICT(event_id) DO UPDATE SET state=excluded.state, order_seq=excluded.order_seq, created_at=excluded.created_at, provenance=excluded.provenance, expires_at=excluded.expires_at",
    ].join(" "),
  );
  for (const row of desired.statements) {
    if (rowsEqual(currentStatements.get(row.eventId), row)) {
      continue;
    }
    upsertStatement.run(
      row.eventId,
      row.scopeKey,
      row.state,
      row.orderSeq,
      row.createdAt,
      row.provenance,
      row.expiresAt,
    );
  }

  const upsertEntity = database.prepare(
    [
      "INSERT INTO entities(id, scope_key, name, normal_name, kind, merged_into, origin_seq) VALUES (?, ?, ?, ?, ?, ?, ?)",
      "ON CONFLICT(id) DO UPDATE SET name=excluded.name, normal_name=excluded.normal_name, kind=excluded.kind, merged_into=excluded.merged_into, origin_seq=excluded.origin_seq",
    ].join(" "),
  );
  const changedEntities = desired.entities.filter(
    (row) => !rowsEqual(currentEntities.get(row.id), row),
  );
  for (const row of changedEntities.filter((value) => currentEntities.has(value.id))) {
    database
      .prepare("UPDATE entities SET merged_into=?, kind=? WHERE id=?")
      .run(row.mergedInto, row.kind, row.id);
  }
  for (const row of changedEntities) {
    upsertEntity.run(
      row.id,
      row.scopeKey,
      row.name,
      row.normalName,
      row.kind,
      row.mergedInto,
      row.originSeq,
    );
  }

  const currentSurfaces = new Map(
    current.surfaceForms.map((row) => [
      rowKey([row.scopeKey, row.surfaceNorm, row.entityId]),
      row,
    ]),
  );
  const desiredSurfaces = new Map(
    desired.surfaceForms.map((row) => [
      rowKey([row.scopeKey, row.surfaceNorm, row.entityId]),
      row,
    ]),
  );
  const deleteSurface = database.prepare(
    "DELETE FROM surface_forms WHERE scope_key=? AND surface_norm=? AND entity_id=?",
  );
  for (const [key, row] of currentSurfaces) {
    if (!desiredSurfaces.has(key)) {
      deleteSurface.run(row.scopeKey, row.surfaceNorm, row.entityId);
    }
  }
  const upsertSurface = database.prepare(
    [
      "INSERT INTO surface_forms(scope_key, surface_norm, entity_id, origin) VALUES (?, ?, ?, ?)",
      "ON CONFLICT(scope_key, surface_norm, entity_id) DO UPDATE SET origin=excluded.origin",
    ].join(" "),
  );
  for (const [key, row] of desiredSurfaces) {
    if (!rowsEqual(currentSurfaces.get(key), row)) {
      upsertSurface.run(row.scopeKey, row.surfaceNorm, row.entityId, row.origin);
    }
  }

  const changedClaims = desired.claims.filter(
    (row) => !rowsEqual(currentClaims.get(row.id), row),
  );
  const downgradeClaim = database.prepare(
    "UPDATE claims SET state='retracted' WHERE id=?",
  );
  for (const row of changedClaims) {
    if (currentClaims.has(row.id)) {
      downgradeClaim.run(row.id);
    }
  }
  const upsertClaim = database.prepare(
    [
      "INSERT INTO claims(id, scope_key, subject_id, relation, object_id, object_value, state, origin_seq, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      "ON CONFLICT(id) DO UPDATE SET subject_id=excluded.subject_id, relation=excluded.relation, object_id=excluded.object_id, object_value=excluded.object_value, state=excluded.state, origin_seq=excluded.origin_seq, first_seen_at=excluded.first_seen_at, last_seen_at=excluded.last_seen_at",
    ].join(" "),
  );
  for (const row of changedClaims) {
    upsertClaim.run(
      row.id,
      row.scopeKey,
      row.subjectId,
      row.relation,
      row.objectId,
      row.objectValue,
      row.state,
      row.originSeq,
      row.firstSeenAt,
      row.lastSeenAt,
    );
  }

  const currentSupports = new Map(
    current.claimSupport.map((row) => [
      rowKey([row.claimId, row.eventId]),
      row,
    ]),
  );
  const desiredSupports = new Map(
    desired.claimSupport.map((row) => [
      rowKey([row.claimId, row.eventId]),
      row,
    ]),
  );
  const deleteSupport = database.prepare(
    "DELETE FROM claim_support WHERE claim_id=? AND event_id=?",
  );
  for (const [key, row] of currentSupports) {
    if (!desiredSupports.has(key)) {
      deleteSupport.run(row.claimId, row.eventId);
    }
  }
  const upsertSupport = database.prepare(
    [
      "INSERT INTO claim_support(claim_id, event_id, draft_index, live, expires_at) VALUES (?, ?, ?, ?, ?)",
      "ON CONFLICT(claim_id, event_id) DO UPDATE SET draft_index=excluded.draft_index, live=excluded.live, expires_at=excluded.expires_at",
    ].join(" "),
  );
  for (const [key, row] of desiredSupports) {
    if (!rowsEqual(currentSupports.get(key), row)) {
      upsertSupport.run(
        row.claimId,
        row.eventId,
        row.draftIndex,
        row.live,
        row.expiresAt,
      );
    }
  }

  const upsertRedirect = database.prepare(
    [
      "INSERT INTO id_redirects(old_id, new_id, kind, reason) VALUES (?, ?, ?, ?)",
      "ON CONFLICT(old_id) DO UPDATE SET new_id=excluded.new_id, kind=excluded.kind, reason=excluded.reason",
    ].join(" "),
  );
  for (const row of desired.idRedirects) {
    if (!rowsEqual(currentRedirects.get(row.oldId), row)) {
      upsertRedirect.run(row.oldId, row.newId, row.kind, row.reason);
    }
  }
}

function commitProjectionReplay(
  database: SqliteDatabaseConnection,
  databasePath: string,
  replayState: WorkerProjectionReplayState,
  replayId: number,
  rulesVersion: string,
  rebuiltAt: number,
  snapshot: ProjectionSnapshot,
): SqliteProjectionReplayCommitResult {
  const active = replayState.active;
  if (
    active === null ||
    active.replayId !== replayId ||
    !database.inTransaction ||
    typeof rulesVersion !== "string" ||
    rulesVersion.length === 0 ||
    rulesVersion.length > 128 ||
    rulesVersion.trim() !== rulesVersion ||
    REPLAY_RULES_CONTROL_PATTERN.test(rulesVersion) ||
    !Number.isSafeInteger(rebuiltAt) ||
    rebuiltAt < 0 ||
    snapshot === null ||
    typeof snapshot !== "object"
  ) {
    throw new WorkerConnectionFailure("SQLITE_TRANSACTION_FAILED");
  }
  try {
    deleteScopeProjection(database, active.scopeKey);
    insertProjectionSnapshot(database, snapshot);
    validateProjectionInvariants(database);
    const lastSeq = active.events.at(-1)?.seq ?? 0;
    const currentLastSeq = Number(
      (
        database
          .prepare(
            "SELECT COALESCE(MAX(seq), 0) AS last_seq FROM journal WHERE scope_key = ?",
          )
          .get(active.scopeKey) as Readonly<Record<string, unknown>>
      )["last_seq"],
    );
    if (currentLastSeq !== lastSeq) {
      throw new WorkerConnectionFailure("SQLITE_TRANSACTION_FAILED");
    }
    database
      .prepare(
        [
          "INSERT INTO projection_meta(scope_key, last_seq, rules_version, rebuilt_at) VALUES (?, ?, ?, ?)",
          "ON CONFLICT(scope_key) DO UPDATE SET last_seq=excluded.last_seq, rules_version=excluded.rules_version, rebuilt_at=excluded.rebuilt_at",
        ].join(" "),
      )
      .run(active.scopeKey, lastSeq, rulesVersion, rebuiltAt);
    assertSafeSidecars(databasePath);
    database.exec("COMMIT");
    replayState.active = null;
    return Object.freeze({
      lastSeq,
      eventCount: active.events.length,
      projectionRowCount:
        snapshot.statements.length +
        snapshot.entities.length +
        snapshot.surfaceForms.length +
        snapshot.claims.length +
        snapshot.claimSupport.length +
        snapshot.idRedirects.length,
    });
  } catch (error) {
    if (database.inTransaction) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // The original failure owns the public result.
      }
    }
    replayState.active = null;
    throw error;
  }
}

function commitProjectionDispatch(
  database: SqliteDatabaseConnection,
  databasePath: string,
  replayState: WorkerProjectionReplayState,
  dispatchId: number,
  mode: SqliteProjectionPublishMode,
  rulesVersion: string,
  rebuiltAt: number,
  snapshot: ProjectionSnapshot,
): SqliteProjectionDispatchCommitResult {
  const active = replayState.active;
  if (
    active === null ||
    active.replayId !== dispatchId ||
    !database.inTransaction ||
    (mode !== "incremental" && mode !== "replay") ||
    typeof rulesVersion !== "string" ||
    rulesVersion.length === 0 ||
    rulesVersion.length > 128 ||
    rulesVersion.trim() !== rulesVersion ||
    REPLAY_RULES_CONTROL_PATTERN.test(rulesVersion) ||
    !Number.isSafeInteger(rebuiltAt) ||
    rebuiltAt < 0 ||
    snapshot === null ||
    typeof snapshot !== "object"
  ) {
    throw new WorkerConnectionFailure("SQLITE_TRANSACTION_FAILED");
  }
  try {
    if (mode === "replay") {
      deleteScopeProjection(database, active.scopeKey);
      insertProjectionSnapshot(database, snapshot);
    } else {
      publishIncrementalProjection(database, active.current, snapshot);
    }
    validateProjectionInvariants(database);
    const lastSeq = active.events.at(-1)?.seq ?? 0;
    const currentLastSeq = Number(
      (
        database
          .prepare(
            "SELECT COALESCE(MAX(seq), 0) AS last_seq FROM journal WHERE scope_key = ?",
          )
          .get(active.scopeKey) as Readonly<Record<string, unknown>>
      )["last_seq"],
    );
    if (currentLastSeq !== lastSeq) {
      throw new WorkerConnectionFailure("SQLITE_TRANSACTION_FAILED");
    }
    database
      .prepare(
        [
          "INSERT INTO projection_meta(scope_key, last_seq, rules_version, rebuilt_at) VALUES (?, ?, ?, ?)",
          "ON CONFLICT(scope_key) DO UPDATE SET last_seq=excluded.last_seq, rules_version=excluded.rules_version, rebuilt_at=excluded.rebuilt_at",
        ].join(" "),
      )
      .run(active.scopeKey, lastSeq, rulesVersion, rebuiltAt);
    assertSafeSidecars(databasePath);
    database.exec("COMMIT");
    replayState.active = null;
    return Object.freeze({
      mode,
      lastSeq,
      eventCount: active.events.length,
      projectionRowCount:
        snapshot.statements.length +
        snapshot.entities.length +
        snapshot.surfaceForms.length +
        snapshot.claims.length +
        snapshot.claimSupport.length +
        snapshot.idRedirects.length,
    });
  } catch (error) {
    if (database.inTransaction) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // The original failure owns the public result.
      }
    }
    replayState.active = null;
    throw error;
  }
}

function rollbackProjectionReplay(
  database: SqliteDatabaseConnection,
  replayState: WorkerProjectionReplayState,
  replayId: number,
): null {
  if (
    replayState.active === null ||
    replayState.active.replayId !== replayId ||
    !database.inTransaction
  ) {
    throw new WorkerConnectionFailure("SQLITE_TRANSACTION_FAILED");
  }
  try {
    database.exec("ROLLBACK");
    return null;
  } finally {
    replayState.active = null;
  }
}

interface AppliedMigrationRow {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly appliedAtSeconds: number;
}

function readAppliedMigrations(
  database: SqliteDatabaseConnection,
): readonly AppliedMigrationRow[] {
  const rawRows = database
    .prepare(
      "SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version",
    )
    .all();
  return rawRows.map((rawRow) => {
    if (rawRow === null || typeof rawRow !== "object" || Array.isArray(rawRow)) {
      throw new WorkerConnectionFailure("MIGRATION_HISTORY_MISMATCH");
    }
    const row = rawRow as Readonly<Record<string, unknown>>;
    if (
      !Number.isSafeInteger(row["version"]) ||
      typeof row["name"] !== "string" ||
      typeof row["checksum"] !== "string" ||
      !/^[0-9a-f]{64}$/u.test(row["checksum"]) ||
      !Number.isSafeInteger(row["applied_at"]) ||
      Number(row["applied_at"]) < 0
    ) {
      throw new WorkerConnectionFailure("MIGRATION_HISTORY_MISMATCH");
    }
    return Object.freeze({
      version: Number(row["version"]),
      name: row["name"],
      checksum: row["checksum"],
      appliedAtSeconds: Number(row["applied_at"]),
    });
  });
}

function ensureSchemaMigrationsTable(database: SqliteDatabaseConnection): void {
  const schemaObject = database
    .prepare("SELECT type FROM sqlite_schema WHERE name = 'schema_migrations'")
    .get();
  if (schemaObject === undefined) {
    database.exec(SCHEMA_MIGRATIONS_DDL);
    return;
  }
  if (
    schemaObject === null ||
    typeof schemaObject !== "object" ||
    Array.isArray(schemaObject) ||
    (schemaObject as Readonly<Record<string, unknown>>)["type"] !== "table"
  ) {
    throw new WorkerConnectionFailure("MIGRATION_HISTORY_MISMATCH");
  }
}

function validatePreparedMigrations(
  migrations: readonly SqlitePreparedMigration[],
): void {
  if (!Array.isArray(migrations)) {
    throw new WorkerConnectionFailure("MIGRATION_BUNDLE_INVALID");
  }
  for (const [index, migration] of migrations.entries()) {
    if (
      migration === null ||
      typeof migration !== "object" ||
      migration.version !== index + 1 ||
      typeof migration.name !== "string" ||
      migration.name.length === 0 ||
      typeof migration.checksum !== "string" ||
      !/^[0-9a-f]{64}$/u.test(migration.checksum) ||
      typeof migration.sql !== "string" ||
      migration.sql.trim().length === 0 ||
      !Number.isSafeInteger(migration.appliedAtSeconds) ||
      migration.appliedAtSeconds < 0
    ) {
      throw new WorkerConnectionFailure("MIGRATION_BUNDLE_INVALID");
    }
  }
}

function executeMigrations(
  database: SqliteDatabaseConnection,
  databasePath: string,
  migrations: readonly SqlitePreparedMigration[],
): SqliteMigrationExecutionResult {
  validatePreparedMigrations(migrations);
  let transactionStarted = false;
  try {
    database.exec("BEGIN IMMEDIATE");
    transactionStarted = true;
    assertSafeSidecars(databasePath);
    ensureSchemaMigrationsTable(database);

    const applied = readAppliedMigrations(database);
    for (const [index, row] of applied.entries()) {
      if (row.version > migrations.length) {
        throw new WorkerConnectionFailure("MIGRATION_VERSION_UNSUPPORTED");
      }
      const expected = migrations[index];
      if (
        expected === undefined ||
        row.version !== index + 1 ||
        row.name !== expected.name ||
        row.checksum !== expected.checksum
      ) {
        throw new WorkerConnectionFailure("MIGRATION_HISTORY_MISMATCH");
      }
    }

    const appliedVersions: number[] = [];
    for (const migration of migrations.slice(applied.length)) {
      database.exec(migration.sql);
      if (!database.inTransaction) {
        throw new WorkerConnectionFailure("MIGRATION_APPLICATION_FAILED");
      }
      database
        .prepare(
          "INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
        )
        .run(
          migration.version,
          migration.name,
          migration.checksum,
          migration.appliedAtSeconds,
        );
      appliedVersions.push(migration.version);
    }
    database.exec("COMMIT");
    return Object.freeze({
      appliedVersions: Object.freeze(appliedVersions),
      currentVersion: migrations.length,
    });
  } catch (error) {
    if (transactionStarted && database.inTransaction) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // The original failure determines the safe public error.
      }
    }
    throw error;
  }
}

function executeRead(
  database: SqliteDatabaseConnection,
  query: SqliteReadQuery,
): SqliteReadResult {
  const result = executeCommand(database, query);
  if (result.kind !== "get" && result.kind !== "all") {
    throw new WorkerConnectionFailure("SQLITE_QUERY_FAILED");
  }
  return result;
}

function dropRecallTempAggregate(database: SqliteDatabaseConnection): void {
  database.exec(RECALL_SNAPSHOT_SQL_SOURCE.dropTempAggregate);
}

function beginRecallSnapshot(
  database: SqliteDatabaseConnection,
  state: WorkerRecallSnapshotState,
  snapshotId: number,
  scopeKey: string,
  evaluationNow: number,
): Readonly<{ snapshotId: number }> {
  if (
    state.active !== null ||
    database.inTransaction ||
    !REPLAY_SCOPE_PATTERN.test(scopeKey) ||
    !Number.isSafeInteger(evaluationNow) ||
    evaluationNow < 0
  ) {
    throw new WorkerConnectionFailure("RECALL_SNAPSHOT_FAILED");
  }

  try {
    dropRecallTempAggregate(database);
    database.exec("BEGIN DEFERRED");
    database
      .prepare(RECALL_SNAPSHOT_SQL_SOURCE.createTempAggregate)
      .run({ now: evaluationNow, scope_key: scopeKey });
    if (!database.inTransaction) {
      throw new WorkerConnectionFailure("RECALL_SNAPSHOT_FAILED");
    }
    state.active = Object.freeze({ snapshotId, scopeKey, evaluationNow });
    return Object.freeze({ snapshotId });
  } catch (error) {
    if (database.inTransaction) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // The safe primary failure remains authoritative.
      }
    }
    state.active = null;
    try {
      dropRecallTempAggregate(database);
    } catch {
      // Closing the reader is the final cleanup fallback.
    }
    throw error;
  }
}

function readRecallSnapshotAggregates(
  database: SqliteDatabaseConnection,
  state: WorkerRecallSnapshotState,
  snapshotId: number,
): Readonly<{
  rows: readonly Readonly<Record<string, unknown>>[];
}> {
  if (
    state.active === null ||
    state.active.snapshotId !== snapshotId ||
    !database.inTransaction
  ) {
    throw new WorkerConnectionFailure("RECALL_SNAPSHOT_FAILED");
  }
  return Object.freeze({
    rows: rows(
      database
        .prepare(RECALL_SNAPSHOT_SQL_SOURCE.selectValidClaimAggregates)
        .all(),
    ),
  });
}

function readRecallSnapshotSurfaceState(
  database: SqliteDatabaseConnection,
  state: WorkerRecallSnapshotState,
  snapshotId: number,
  surfaceNorms: readonly string[],
): Readonly<{
  candidateRows: readonly Readonly<Record<string, unknown>>[];
  entityRows: readonly Readonly<Record<string, unknown>>[];
  redirectRows: readonly Readonly<Record<string, unknown>>[];
}> {
  if (
    state.active === null ||
    state.active.snapshotId !== snapshotId ||
    !database.inTransaction ||
    !Array.isArray(surfaceNorms) ||
    surfaceNorms.length > 10 ||
    surfaceNorms.some(
      (surfaceNorm, index) =>
        typeof surfaceNorm !== "string" ||
        surfaceNorm.length === 0 ||
        surfaceNorms.indexOf(surfaceNorm) !== index,
    )
  ) {
    throw new WorkerConnectionFailure("RECALL_SNAPSHOT_FAILED");
  }

  if (surfaceNorms.length === 0) {
    return Object.freeze({
      candidateRows: Object.freeze([]),
      entityRows: Object.freeze([]),
      redirectRows: Object.freeze([]),
    });
  }

  const requestedValues = surfaceNorms.map(() => "(?, ?)").join(", ");
  const parameters: SqliteBinding[] = [];
  for (let termOrder = 0; termOrder < surfaceNorms.length; termOrder += 1) {
    parameters.push(termOrder, surfaceNorms[termOrder] ?? "");
  }
  parameters.push(state.active.scopeKey);
  const candidateRows = rows(
    database
      .prepare(
        [
          `WITH requested(term_order, surface_norm) AS (VALUES ${requestedValues})`,
          "SELECT",
          "  requested.term_order AS recall_surface_term_order,",
          "  matched.scope_key AS recall_surface_scope_key,",
          "  matched.surface_norm AS recall_surface_norm,",
          "  matched.entity_id AS recall_surface_entity_id",
          "FROM requested",
          "JOIN surface_forms AS matched",
          "  ON matched.scope_key = ?",
          " AND matched.surface_norm = requested.surface_norm",
          "ORDER BY requested.term_order ASC, matched.entity_id COLLATE BINARY ASC",
        ].join("\n"),
      )
      .all(...parameters),
  );

  const entityStatement = database.prepare(
    [
      "SELECT",
      "  id AS recall_surface_entity_id,",
      "  scope_key AS recall_surface_entity_scope_key,",
      "  merged_into AS recall_surface_entity_merged_into",
      "FROM entities WHERE id = ?",
    ].join("\n"),
  );
  const redirectStatement = database.prepare(
    [
      "SELECT",
      "  old_id AS recall_surface_redirect_old_id,",
      "  new_id AS recall_surface_redirect_new_id,",
      "  kind AS recall_surface_redirect_kind,",
      "  reason AS recall_surface_redirect_reason",
      "FROM id_redirects WHERE old_id = ?",
    ].join("\n"),
  );
  const pending: string[] = [];
  for (const candidate of candidateRows) {
    const entityId = candidate["recall_surface_entity_id"];
    if (typeof entityId === "string") {
      pending.push(entityId);
    }
  }
  const visited = new Set<string>();
  const entityRows = new Map<string, Readonly<Record<string, unknown>>>();
  const redirectRows = new Map<string, Readonly<Record<string, unknown>>>();
  for (let cursor = 0; cursor < pending.length; cursor += 1) {
    const identifier = pending[cursor];
    if (identifier === undefined || visited.has(identifier)) {
      continue;
    }
    visited.add(identifier);
    const entity = rowOrNull(entityStatement.get(identifier));
    if (entity !== null) {
      entityRows.set(identifier, entity);
      const mergedInto = entity["recall_surface_entity_merged_into"];
      if (typeof mergedInto === "string") {
        pending.push(mergedInto);
      }
    }
    const redirect = rowOrNull(redirectStatement.get(identifier));
    if (redirect !== null) {
      redirectRows.set(identifier, redirect);
      const newId = redirect["recall_surface_redirect_new_id"];
      if (typeof newId === "string") {
        pending.push(newId);
      }
    }
  }

  return Object.freeze({
    candidateRows,
    entityRows: Object.freeze(
      [...entityRows.values()].sort((left, right) => {
        const leftId = String(left["recall_surface_entity_id"]);
        const rightId = String(right["recall_surface_entity_id"]);
        return leftId === rightId ? 0 : leftId < rightId ? -1 : 1;
      }),
    ),
    redirectRows: Object.freeze(
      [...redirectRows.values()].sort((left, right) => {
        const leftId = String(left["recall_surface_redirect_old_id"]);
        const rightId = String(right["recall_surface_redirect_old_id"]);
        return leftId === rightId ? 0 : leftId < rightId ? -1 : 1;
      }),
    ),
  });
}

function endRecallSnapshot(
  database: SqliteDatabaseConnection,
  state: WorkerRecallSnapshotState,
  snapshotId: number,
  commit: boolean,
): null {
  if (
    state.active === null ||
    state.active.snapshotId !== snapshotId ||
    !database.inTransaction ||
    typeof commit !== "boolean"
  ) {
    throw new WorkerConnectionFailure("RECALL_SNAPSHOT_FAILED");
  }

  try {
    if (commit) {
      dropRecallTempAggregate(database);
      database.exec("COMMIT");
    } else {
      database.exec("ROLLBACK");
    }
    state.active = null;
    if (!commit) {
      dropRecallTempAggregate(database);
    }
    return null;
  } catch (error) {
    if (database.inTransaction) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // The safe primary failure remains authoritative.
      }
    }
    state.active = null;
    try {
      dropRecallTempAggregate(database);
    } catch {
      // Closing the reader is the final cleanup fallback.
    }
    throw error;
  }
}

function isSqliteBusy(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof (error as Error & { readonly code?: unknown }).code === "string" &&
    ((error as Error & { readonly code: string }).code === "SQLITE_BUSY" ||
      (error as Error & { readonly code: string }).code.startsWith("SQLITE_BUSY_"))
  );
}

function safeFailureCode(
  error: unknown,
  fallback: Exclude<SqliteWorkerErrorCode, "SQLITE_BUSY">,
): SqliteWorkerErrorCode {
  if (isSqliteBusy(error)) {
    return "SQLITE_BUSY";
  }
  return error instanceof WorkerConnectionFailure ? error.code : fallback;
}

function post(response: SqliteWorkerResponse): void {
  parentPort?.postMessage(response);
}

function handleRequest(
  database: SqliteDatabaseConnection,
  data: SqliteWorkerData,
  request: SqliteWorkerRequest,
  replayState: WorkerProjectionReplayState,
  recallState: WorkerRecallSnapshotState,
): void {
  if (request.type === "close") {
    try {
      if (replayState.active !== null && database.inTransaction) {
        database.exec("ROLLBACK");
        replayState.active = null;
      }
      if (recallState.active !== null && database.inTransaction) {
        database.exec("ROLLBACK");
        recallState.active = null;
      }
      dropRecallTempAggregate(database);
      database.close();
      post({ type: "success", requestId: request.requestId, result: null });
    } catch (error) {
      post({
        type: "failure",
        requestId: request.requestId,
        code: safeFailureCode(error, "SQLITE_CONNECTION_FAILED"),
      });
    } finally {
      parentPort?.close();
    }
    return;
  }

  if (request.type === "recall-snapshot-begin") {
    if (
      data.role !== "reader" ||
      replayState.active !== null ||
      recallState.active !== null
    ) {
      post({
        type: "failure",
        requestId: request.requestId,
        code: "RECALL_SNAPSHOT_FAILED",
      });
      return;
    }
    try {
      const result = beginRecallSnapshot(
        database,
        recallState,
        request.requestId,
        request.scopeKey,
        request.evaluationNow,
      );
      post({ type: "success", requestId: request.requestId, result });
    } catch (error) {
      post({
        type: "failure",
        requestId: request.requestId,
        code: safeFailureCode(error, "RECALL_SNAPSHOT_FAILED"),
      });
    }
    return;
  }

  if (request.type === "recall-snapshot-read") {
    if (data.role !== "reader") {
      post({
        type: "failure",
        requestId: request.requestId,
        code: "RECALL_SNAPSHOT_FAILED",
      });
      return;
    }
    try {
      const result = readRecallSnapshotAggregates(
        database,
        recallState,
        request.snapshotId,
      );
      post({ type: "success", requestId: request.requestId, result });
    } catch (error) {
      post({
        type: "failure",
        requestId: request.requestId,
        code: safeFailureCode(error, "RECALL_SNAPSHOT_FAILED"),
      });
    }
    return;
  }

  if (request.type === "recall-snapshot-surface") {
    if (data.role !== "reader") {
      post({
        type: "failure",
        requestId: request.requestId,
        code: "RECALL_SNAPSHOT_FAILED",
      });
      return;
    }
    try {
      const result = readRecallSnapshotSurfaceState(
        database,
        recallState,
        request.snapshotId,
        request.surfaceNorms,
      );
      post({ type: "success", requestId: request.requestId, result });
    } catch (error) {
      post({
        type: "failure",
        requestId: request.requestId,
        code: safeFailureCode(error, "RECALL_SNAPSHOT_FAILED"),
      });
    }
    return;
  }

  if (request.type === "recall-snapshot-end") {
    if (data.role !== "reader") {
      post({
        type: "failure",
        requestId: request.requestId,
        code: "RECALL_SNAPSHOT_FAILED",
      });
      return;
    }
    try {
      const result = endRecallSnapshot(
        database,
        recallState,
        request.snapshotId,
        request.commit,
      );
      post({ type: "success", requestId: request.requestId, result });
    } catch (error) {
      post({
        type: "failure",
        requestId: request.requestId,
        code: safeFailureCode(error, "RECALL_SNAPSHOT_FAILED"),
      });
    }
    return;
  }

  if (recallState.active !== null) {
    post({
      type: "failure",
      requestId: request.requestId,
      code: "RECALL_SNAPSHOT_FAILED",
    });
    return;
  }

  if (request.type === "projection-replay-begin") {
    if (data.role !== "writer" || replayState.active !== null) {
      post({
        type: "failure",
        requestId: request.requestId,
        code: "SQLITE_TRANSACTION_FAILED",
      });
      return;
    }
    try {
      const result = beginProjectionReplay(
        database,
        data.databasePath,
        replayState,
        request.requestId,
        request.scopeKey,
      );
      post({ type: "success", requestId: request.requestId, result });
    } catch (error) {
      post({
        type: "failure",
        requestId: request.requestId,
        code: safeFailureCode(error, "SQLITE_TRANSACTION_FAILED"),
      });
    }
    return;
  }

  if (request.type === "projection-dispatch-begin") {
    if (data.role !== "writer" || replayState.active !== null) {
      post({
        type: "failure",
        requestId: request.requestId,
        code: "SQLITE_TRANSACTION_FAILED",
      });
      return;
    }
    try {
      const result = beginProjectionDispatch(
        database,
        data.databasePath,
        replayState,
        request.requestId,
        request.scopeKey,
        request.events,
      );
      post({ type: "success", requestId: request.requestId, result });
    } catch (error) {
      post({
        type: "failure",
        requestId: request.requestId,
        code: safeFailureCode(error, "SQLITE_TRANSACTION_FAILED"),
      });
    }
    return;
  }

  if (request.type === "projection-replay-commit") {
    if (data.role !== "writer") {
      post({
        type: "failure",
        requestId: request.requestId,
        code: "SQLITE_TRANSACTION_FAILED",
      });
      return;
    }
    try {
      const result = commitProjectionReplay(
        database,
        data.databasePath,
        replayState,
        request.replayId,
        request.rulesVersion,
        request.rebuiltAt,
        request.snapshot,
      );
      post({ type: "success", requestId: request.requestId, result });
    } catch (error) {
      post({
        type: "failure",
        requestId: request.requestId,
        code: safeFailureCode(error, "SQLITE_TRANSACTION_FAILED"),
      });
    }
    return;
  }

  if (request.type === "projection-replay-rollback") {
    if (data.role !== "writer") {
      post({
        type: "failure",
        requestId: request.requestId,
        code: "SQLITE_TRANSACTION_FAILED",
      });
      return;
    }
    try {
      const result = rollbackProjectionReplay(
        database,
        replayState,
        request.replayId,
      );
      post({ type: "success", requestId: request.requestId, result });
    } catch (error) {
      post({
        type: "failure",
        requestId: request.requestId,
        code: safeFailureCode(error, "SQLITE_TRANSACTION_FAILED"),
      });
    }
    return;
  }

  if (request.type === "projection-dispatch-commit") {
    if (data.role !== "writer") {
      post({
        type: "failure",
        requestId: request.requestId,
        code: "SQLITE_TRANSACTION_FAILED",
      });
      return;
    }
    try {
      const result = commitProjectionDispatch(
        database,
        data.databasePath,
        replayState,
        request.dispatchId,
        request.mode,
        request.rulesVersion,
        request.rebuiltAt,
        request.snapshot,
      );
      post({ type: "success", requestId: request.requestId, result });
    } catch (error) {
      post({
        type: "failure",
        requestId: request.requestId,
        code: safeFailureCode(error, "SQLITE_TRANSACTION_FAILED"),
      });
    }
    return;
  }

  if (replayState.active !== null) {
    post({
      type: "failure",
      requestId: request.requestId,
      code: "SQLITE_TRANSACTION_FAILED",
    });
    return;
  }

  if (request.type === "transaction") {
    if (data.role !== "writer") {
      post({
        type: "failure",
        requestId: request.requestId,
        code: "SQLITE_TRANSACTION_FAILED",
      });
      return;
    }
    try {
      const result = executeTransaction(
        database,
        data.databasePath,
        request.commands,
      );
      post({ type: "success", requestId: request.requestId, result });
    } catch (error) {
      post({
        type: "failure",
        requestId: request.requestId,
        code: safeFailureCode(error, "SQLITE_TRANSACTION_FAILED"),
      });
    }
    return;
  }

  if (request.type === "migrate") {
    if (data.role !== "writer") {
      post({
        type: "failure",
        requestId: request.requestId,
        code: "MIGRATION_RUNNER_UNAVAILABLE",
      });
      return;
    }
    try {
      const result = executeMigrations(
        database,
        data.databasePath,
        request.migrations,
      );
      post({ type: "success", requestId: request.requestId, result });
    } catch (error) {
      post({
        type: "failure",
        requestId: request.requestId,
        code: safeFailureCode(error, "MIGRATION_APPLICATION_FAILED"),
      });
    }
    return;
  }

  try {
    const result = executeRead(database, request.query);
    post({ type: "success", requestId: request.requestId, result });
  } catch (error) {
    post({
      type: "failure",
      requestId: request.requestId,
      code: safeFailureCode(error, "SQLITE_QUERY_FAILED"),
    });
  }
}

function startWorker(): void {
  let database: SqliteDatabaseConnection | null = null;
  const replayState: WorkerProjectionReplayState = { active: null };
  const recallState: WorkerRecallSnapshotState = { active: null };
  try {
    const data = readWorkerData(workerData as unknown);
    assertSafeSidecars(data.databasePath);
    const BetterSqlite3 = loadSqliteDatabaseConstructor();
    database = new BetterSqlite3(data.databasePath, {
      readonly: data.role === "reader",
      fileMustExist: true,
      timeout: SQLITE_CONNECTION_POLICY.busyTimeoutMs,
    });
    const configuration = applyConnectionPolicy(database, data.role);
    assertSafeSidecars(data.databasePath);
    post({ type: "ready", configuration });
    parentPort?.on("message", (request: SqliteWorkerRequest) => {
      handleRequest(
        database as SqliteDatabaseConnection,
        data,
        request,
        replayState,
        recallState,
      );
    });
  } catch (error) {
    if (database !== null) {
      try {
        database.close();
      } catch {
        // Initialization already failed; only the safe primary code is returned.
      }
    }
    post({
      type: "failure",
      requestId: null,
      code: safeFailureCode(error, "SQLITE_CONNECTION_FAILED"),
    });
    parentPort?.close();
  }
}

startWorker();
