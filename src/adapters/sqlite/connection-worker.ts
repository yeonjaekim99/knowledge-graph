import { lstatSync } from "node:fs";
import { createRequire } from "node:module";
import { parentPort, workerData } from "node:worker_threads";

import type {
  ProjectionReplayJournalEvent,
  ProjectionSnapshot,
} from "../../domain/projection-replay.js";
import {
  EntityProjectionError,
  resolveEntityReference,
  strongestSurfaceOrigin,
} from "../../domain/projection-entities.js";
import {
  ProjectionIdentifierError,
} from "../../domain/projection-identifiers.js";
import {
  ProjectionRuleError,
  normalizeV1,
} from "../../domain/projection-rules.js";

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
  type SqliteProjectionDispatchPrepareResult,
  type SqliteProjectionMetaSnapshot,
  type SqliteProjectionPublishMode,
  type SqliteProjectionReplayBeginResult,
  type SqliteProjectionReplayCommitResult,
  type SqliteReadQuery,
  type SqliteReadResult,
  type SqliteRunResult,
  type SqliteTransactionCommand,
  type SqliteWriteEntityDraftInput,
  type SqliteWriteEntityDraftResolution,
  type SqliteWriteEntityFinalizationResult,
  type SqliteWriteEntityResolvedDraft,
  type SqliteWorkerData,
  type SqliteWorkerRequest,
  type SqliteWorkerErrorCode,
  type SqliteWorkerResponse,
} from "./connection-protocol.js";
import { RECALL_SNAPSHOT_SQL_SOURCE } from "./recall-snapshot-sql.js";
import { RECALL_FTS_SQL_SOURCE } from "./recall-fts-sql.js";
import { RECALL_OVERVIEW_SQL_SOURCE } from "./recall-overview-sql.js";
import { RECALL_TRAVERSAL_SQL_SOURCE } from "./recall-traversal-sql.js";
import { RECALL_RANKING_SQL_SOURCE } from "./recall-ranking-sql.js";

interface SqliteRunMetadata {
  readonly changes: number;
  readonly lastInsertRowid: number | bigint;
}

interface SqliteStatement {
  run(...parameters: readonly SqliteBinding[]): SqliteRunMetadata;
  run(parameters: Readonly<Record<string, SqliteBinding>>): SqliteRunMetadata;
  get(...parameters: readonly SqliteBinding[]): unknown;
  get(parameters: Readonly<Record<string, SqliteBinding>>): unknown;
  all(...parameters: readonly SqliteBinding[]): unknown[];
  all(parameters: Readonly<Record<string, SqliteBinding>>): unknown[];
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
  readonly kind: "replay";
  readonly replayId: number;
  readonly scopeKey: string;
  readonly events: readonly ProjectionReplayJournalEvent[];
  readonly current: ProjectionSnapshot;
}

interface ActiveProjectionDispatch {
  readonly kind: "dispatch";
  readonly replayId: number;
  readonly scopeKey: string;
  readonly events: readonly ProjectionReplayJournalEvent[];
  readonly current: ProjectionSnapshot;
  readonly meta: SqliteProjectionMetaSnapshot | null;
  readonly projectionValid: boolean;
  readonly previousLastSeq: number;
  readonly expectedJournalSeq: number;
  readonly resolutionSavepointOpen: boolean;
  readonly resolutionCompleted: boolean;
  readonly resolutionDrafts: readonly ValidatedWriteEntityDraft[] | null;
  readonly resolutionResults:
    | readonly SqliteWriteEntityDraftResolution[]
    | null;
  readonly finalizationCompleted: boolean;
  readonly finalizedDrafts: readonly FinalizedWriteEntityDraft[] | null;
  readonly finalizedBodyJson: string | null;
  readonly appendedEvents: readonly ProjectionReplayJournalEvent[];
}

interface WorkerProjectionReplayState {
  active: ActiveProjectionReplay | ActiveProjectionDispatch | null;
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
      kind: "replay",
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

function validateProjectionDispatchEvents(
  appendEvents: readonly SqliteProjectionDispatchAppendEvent[],
): void {
  if (!Array.isArray(appendEvents) || appendEvents.length === 0) {
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
}

function expectedNextJournalSeq(
  database: SqliteDatabaseConnection,
): number {
  const maximumRow = database
    .prepare("SELECT MAX(seq) AS value FROM journal")
    .get() as Readonly<Record<string, unknown>> | undefined;
  const sequenceRow = database
    .prepare("SELECT seq AS value FROM sqlite_sequence WHERE name='journal'")
    .get() as Readonly<Record<string, unknown>> | undefined;
  const maximum = maximumRow?.["value"];
  const sequence = sequenceRow?.["value"];

  if (maximum === null) {
    if (sequenceRow !== undefined) {
      throw new WorkerConnectionFailure("SQLITE_TRANSACTION_FAILED");
    }
    return 1;
  }
  if (
    !Number.isSafeInteger(maximum) ||
    Number(maximum) <= 0 ||
    !Number.isSafeInteger(sequence) ||
    Number(sequence) !== Number(maximum) ||
    Number(maximum) >= Number.MAX_SAFE_INTEGER
  ) {
    throw new WorkerConnectionFailure("SQLITE_TRANSACTION_FAILED");
  }
  return Number(maximum) + 1;
}

function prepareProjectionDispatch(
  database: SqliteDatabaseConnection,
  databasePath: string,
  replayState: WorkerProjectionReplayState,
  dispatchId: number,
  scopeKey: string,
): SqliteProjectionDispatchPrepareResult {
  if (
    replayState.active !== null ||
    !Number.isSafeInteger(dispatchId) ||
    dispatchId <= 0 ||
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
    const previousLastSeq = events.at(-1)?.seq ?? 0;
    const expectedJournalSeq = expectedNextJournalSeq(database);
    const current = projectionSnapshot(database, scopeKey);
    const meta = projectionMeta(database, scopeKey);
    const projectionValid = projectionScopeIsValid(database, scopeKey, current);
    database.exec("SAVEPOINT recall_record_entity_resolution");
    replayState.active = Object.freeze({
      kind: "dispatch",
      replayId: dispatchId,
      scopeKey,
      events,
      current,
      meta,
      projectionValid,
      previousLastSeq,
      expectedJournalSeq,
      resolutionSavepointOpen: true,
      resolutionCompleted: false,
      resolutionDrafts: null,
      resolutionResults: null,
      finalizationCompleted: false,
      finalizedDrafts: null,
      finalizedBodyJson: null,
      appendedEvents: Object.freeze([]),
    });
    return Object.freeze({
      dispatchId,
      current,
      meta,
      projectionValid,
      previousLastSeq,
      expectedJournalSeq,
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

function rollbackResolutionStaging(
  database: SqliteDatabaseConnection,
  active: ActiveProjectionDispatch,
): ActiveProjectionDispatch {
  if (!active.resolutionSavepointOpen) {
    return active;
  }
  database.exec(
    "ROLLBACK TO recall_record_entity_resolution; RELEASE recall_record_entity_resolution",
  );
  return Object.freeze({
    ...active,
    resolutionSavepointOpen: false,
  });
}

function appendPreparedProjectionDispatch(
  database: SqliteDatabaseConnection,
  replayState: WorkerProjectionReplayState,
  dispatchId: number,
  appendEvents: readonly SqliteProjectionDispatchAppendEvent[],
): SqliteProjectionDispatchBeginResult {
  const currentActive = replayState.active;
  if (
    currentActive === null ||
    currentActive.kind !== "dispatch" ||
    currentActive.replayId !== dispatchId ||
    !database.inTransaction ||
    currentActive.appendedEvents.length !== 0
  ) {
    throw new WorkerConnectionFailure("SQLITE_TRANSACTION_FAILED");
  }
  validateProjectionDispatchEvents(appendEvents);
  if (
    currentActive.resolutionCompleted &&
    (!currentActive.finalizationCompleted ||
      currentActive.finalizedDrafts === null ||
      currentActive.finalizedBodyJson === null)
  ) {
    throw new WorkerConnectionFailure("SQLITE_TRANSACTION_FAILED");
  }
  if (
    currentActive.finalizationCompleted &&
    (currentActive.finalizedDrafts === null ||
      currentActive.finalizedBodyJson === null ||
      !appendMatchesFinalizedEntityDrafts(
        appendEvents,
        currentActive.finalizedDrafts,
        currentActive.expectedJournalSeq,
      ) ||
      appendEvents[0]?.bodyJson !== currentActive.finalizedBodyJson ||
      expectedNextJournalSeq(database) !== currentActive.expectedJournalSeq)
  ) {
    throw new WorkerConnectionFailure("SQLITE_TRANSACTION_FAILED");
  }

  try {
    const active = rollbackResolutionStaging(database, currentActive);
    replayState.active = active;
    const ids = new Set(appendEvents.map((event) => event.eventId));
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
        active.scopeKey,
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
        ? active.events
        : projectionJournalEvents(database, active.scopeKey);
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
    const committedAppendEvents = Object.freeze(
      inserted.length === 0
        ? []
        : (appendedEvents as readonly ProjectionReplayJournalEvent[]),
    );
    if (
      inserted.length > 0 &&
      active.finalizationCompleted &&
      (committedAppendEvents.length !== 1 ||
        committedAppendEvents[0]?.seq !== active.expectedJournalSeq)
    ) {
      throw new WorkerConnectionFailure("SQLITE_TRANSACTION_FAILED");
    }
    replayState.active = Object.freeze({
      ...active,
      events,
      appendedEvents: committedAppendEvents,
    });
    return Object.freeze({
      dispatchId,
      collision: inserted.length === 0,
      events,
      appendedEvents: committedAppendEvents,
      current: active.current,
      meta: active.meta,
      projectionValid: active.projectionValid,
      previousLastSeq: active.previousLastSeq,
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

function beginProjectionDispatch(
  database: SqliteDatabaseConnection,
  databasePath: string,
  replayState: WorkerProjectionReplayState,
  dispatchId: number,
  scopeKey: string,
  appendEvents: readonly SqliteProjectionDispatchAppendEvent[],
): SqliteProjectionDispatchBeginResult {
  prepareProjectionDispatch(
    database,
    databasePath,
    replayState,
    dispatchId,
    scopeKey,
  );
  return appendPreparedProjectionDispatch(
    database,
    replayState,
    dispatchId,
    appendEvents,
  );
}

const WRITE_ENTITY_SUBJECT_NOTE =
  "subject matches multiple entities; retry with an exact canonical name or confirm an alias or merge";
const WRITE_ENTITY_OBJECT_NOTE =
  "object matches multiple entities; retry with an exact canonical name or confirm an alias or merge";

interface ValidatedWriteEntityReference {
  readonly name: string;
  readonly normalName: string;
  readonly kind: string | null;
  readonly aliases: readonly Readonly<{ name: string; normalName: string }>[];
}

interface ValidatedWriteEntityDraft {
  readonly draftIndex: number;
  readonly subject: ValidatedWriteEntityReference;
  readonly object: ValidatedWriteEntityReference | null;
}

interface FinalizedWriteEntityDraft {
  readonly draftIndex: number;
  readonly subject: ValidatedWriteEntityReference;
  readonly object: ValidatedWriteEntityReference | null;
  readonly subjectCandidateId: string;
  readonly objectCandidateId: string | null;
  readonly resolution: SqliteWriteEntityResolvedDraft;
}

function writeEntityText(
  value: unknown,
  maximumCodePoints: number,
): Readonly<{ name: string; normalName: string }> {
  if (typeof value !== "string") {
    throw new WorkerConnectionFailure("SQLITE_TRANSACTION_FAILED");
  }
  const name = value.trim();
  if (
    Array.from(name).length === 0 ||
    Array.from(name).length > maximumCodePoints
  ) {
    throw new WorkerConnectionFailure("SQLITE_TRANSACTION_FAILED");
  }
  try {
    return Object.freeze({ name, normalName: normalizeV1(name) });
  } catch (error: unknown) {
    if (error instanceof ProjectionRuleError) {
      throw new WorkerConnectionFailure("SQLITE_TRANSACTION_FAILED");
    }
    throw error;
  }
}

function writeEntityKind(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string" || !value.isWellFormed()) {
    throw new WorkerConnectionFailure("SQLITE_TRANSACTION_FAILED");
  }
  const kind = value.trim().normalize("NFKC").toLowerCase();
  if (Array.from(kind).length === 0 || Array.from(kind).length > 64) {
    throw new WorkerConnectionFailure("SQLITE_TRANSACTION_FAILED");
  }
  return kind;
}

function validateWriteEntityReference(
  value: unknown,
): ValidatedWriteEntityReference {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string")
  ) {
    throw new WorkerConnectionFailure("SQLITE_TRANSACTION_FAILED");
  }
  const input = value as Readonly<Record<string, unknown>>;
  const keys = Object.keys(input).sort();
  if (
    keys.length !== 3 ||
    keys[0] !== "aliases" ||
    keys[1] !== "kind" ||
    keys[2] !== "name"
  ) {
    throw new WorkerConnectionFailure("SQLITE_TRANSACTION_FAILED");
  }
  const name = writeEntityText(input["name"], 1_024);
  if (!Array.isArray(input["aliases"]) || input["aliases"].length > 20) {
    throw new WorkerConnectionFailure("SQLITE_TRANSACTION_FAILED");
  }
  const aliases = input["aliases"].map((alias) => writeEntityText(alias, 256));
  return Object.freeze({
    name: name.name,
    normalName: name.normalName,
    kind: writeEntityKind(input["kind"]),
    aliases: Object.freeze(aliases),
  });
}

function validateWriteEntityDrafts(
  value: unknown,
): readonly ValidatedWriteEntityDraft[] {
  if (!Array.isArray(value) || value.length > 100) {
    throw new WorkerConnectionFailure("SQLITE_TRANSACTION_FAILED");
  }
  const seenIndexes = new Set<number>();
  let previousIndex = -1;
  const drafts = value.map((item) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new WorkerConnectionFailure("SQLITE_TRANSACTION_FAILED");
    }
    const input = item as Readonly<Record<string, unknown>>;
    const keys = Object.keys(input).sort();
    if (
      keys.length !== 3 ||
      keys[0] !== "draftIndex" ||
      keys[1] !== "object" ||
      keys[2] !== "subject" ||
      !Number.isSafeInteger(input["draftIndex"]) ||
      Number(input["draftIndex"]) < 0 ||
      seenIndexes.has(Number(input["draftIndex"])) ||
      Number(input["draftIndex"]) <= previousIndex
    ) {
      throw new WorkerConnectionFailure("SQLITE_TRANSACTION_FAILED");
    }
    const draftIndex = Number(input["draftIndex"]);
    seenIndexes.add(draftIndex);
    previousIndex = draftIndex;
    return Object.freeze({
      draftIndex,
      subject: validateWriteEntityReference(input["subject"]),
      object:
        input["object"] === null
          ? null
          : validateWriteEntityReference(input["object"]),
    });
  });
  return Object.freeze(drafts);
}

function writeEntityReferenceState(
  database: SqliteDatabaseConnection,
  scopeKey: string,
  name: string,
): ReturnType<typeof resolveEntityReference> {
  const snapshot = projectionSnapshot(database, scopeKey);
  const entityRedirects = snapshot.idRedirects.filter(
    (redirect) => redirect.kind === "entity",
  );
  const anchorIds = new Set(snapshot.entities.map((entity) => entity.id));
  for (const redirect of entityRedirects) {
    anchorIds.add(redirect.oldId);
    anchorIds.add(redirect.newId);
  }
  try {
    return resolveEntityReference({
      scopeKey,
      name,
      entityAnchors: [...anchorIds].map((id) => ({
        id,
        kind: "entity",
        scopeKey,
      })),
      entities: snapshot.entities,
      surfaceForms: snapshot.surfaceForms,
      idRedirects: entityRedirects,
    });
  } catch (error: unknown) {
    if (
      error instanceof EntityProjectionError ||
      error instanceof ProjectionIdentifierError ||
      error instanceof ProjectionRuleError
    ) {
      throw new WorkerConnectionFailure("SQLITE_TRANSACTION_FAILED");
    }
    throw error;
  }
}

function entityOriginSeq(candidateId: string): number {
  const match = /^e([1-9][0-9]*)\.[0-9]+$/u.exec(candidateId);
  if (match?.[1] === undefined) {
    throw new WorkerConnectionFailure("SQLITE_TRANSACTION_FAILED");
  }
  const value = Number(match[1]);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new WorkerConnectionFailure("SQLITE_TRANSACTION_FAILED");
  }
  return value;
}

function upsertWriteSurface(
  database: SqliteDatabaseConnection,
  scopeKey: string,
  surfaceNorm: string,
  entityId: string,
  incomingOrigin: "name" | "agent_supplied",
): void {
  const existing = database
    .prepare(
      "SELECT origin FROM surface_forms WHERE scope_key=? AND surface_norm=? AND entity_id=?",
    )
    .get(scopeKey, surfaceNorm, entityId) as
    | Readonly<Record<string, unknown>>
    | undefined;
  const origin =
    existing === undefined
      ? incomingOrigin
      : strongestSurfaceOrigin(existing["origin"], incomingOrigin);
  database
    .prepare(
      [
        "INSERT INTO surface_forms(scope_key, surface_norm, entity_id, origin) VALUES (?, ?, ?, ?)",
        "ON CONFLICT(scope_key, surface_norm, entity_id) DO UPDATE SET origin=excluded.origin",
      ].join(" "),
    )
    .run(scopeKey, surfaceNorm, entityId, origin);
}

function stageCandidateRedirect(
  database: SqliteDatabaseConnection,
  scopeKey: string,
  candidateId: string,
  canonicalId: string,
): void {
  if (candidateId === canonicalId) {
    return;
  }
  const candidateEntity = database
    .prepare("SELECT scope_key FROM entities WHERE id=?")
    .get(candidateId) as Readonly<Record<string, unknown>> | undefined;
  if (candidateEntity !== undefined) {
    throw new WorkerConnectionFailure("SQLITE_TRANSACTION_FAILED");
  }
  const inserted = database
    .prepare(
      "INSERT OR IGNORE INTO id_redirects(old_id, new_id, kind, reason) VALUES (?, ?, 'entity', 'deduplicated')",
    )
    .run(candidateId, canonicalId);
  if (inserted.changes === 1) {
    return;
  }
  const existing = database
    .prepare("SELECT new_id, kind FROM id_redirects WHERE old_id=?")
    .get(candidateId) as Readonly<Record<string, unknown>> | undefined;
  if (
    existing === undefined ||
    existing["kind"] !== "entity" ||
    existing["new_id"] !== canonicalId
  ) {
    throw new WorkerConnectionFailure("SQLITE_TRANSACTION_FAILED");
  }
  const target = database
    .prepare(
      "SELECT scope_key, merged_into FROM entities WHERE id=?",
    )
    .get(canonicalId) as Readonly<Record<string, unknown>> | undefined;
  if (
    target === undefined ||
    target["scope_key"] !== scopeKey ||
    target["merged_into"] !== null
  ) {
    throw new WorkerConnectionFailure("SQLITE_TRANSACTION_FAILED");
  }
}

type StagedWriteEntityReference =
  | Readonly<{ status: "resolved"; entityId: string }>
  | Readonly<{
      status: "ambiguous";
      candidates: readonly Readonly<{ entityId: string; name: string }>[];
    }>;

function stageWriteEntityReference(
  database: SqliteDatabaseConnection,
  scopeKey: string,
  reference: ValidatedWriteEntityReference,
  candidateId: string,
): StagedWriteEntityReference {
  let resolution = writeEntityReferenceState(database, scopeKey, reference.name);
  if (resolution.status === "ambiguous") {
    return Object.freeze({
      status: "ambiguous",
      candidates: resolution.candidates,
    });
  }

  let entityId: string;
  let nameOrigin: "name" | "agent_supplied";
  if (resolution.status === "resolved") {
    entityId = resolution.entityId;
    nameOrigin = "agent_supplied";
  } else {
    const inserted = database
      .prepare(
        "INSERT OR IGNORE INTO entities(id, scope_key, name, normal_name, kind, merged_into, origin_seq) VALUES (?, ?, ?, ?, ?, NULL, ?)",
      )
      .run(
        candidateId,
        scopeKey,
        reference.name,
        reference.normalName,
        reference.kind,
        entityOriginSeq(candidateId),
      );
    resolution = writeEntityReferenceState(database, scopeKey, reference.name);
    if (resolution.status !== "resolved") {
      throw new WorkerConnectionFailure("SQLITE_TRANSACTION_FAILED");
    }
    entityId = resolution.entityId;
    nameOrigin = inserted.changes === 1 ? "name" : "agent_supplied";
  }

  stageCandidateRedirect(
    database,
    scopeKey,
    candidateId,
    entityId,
  );
  upsertWriteSurface(
    database,
    scopeKey,
    reference.normalName,
    entityId,
    nameOrigin,
  );
  return Object.freeze({ status: "resolved", entityId });
}

function applyWriteEntityAliases(
  database: SqliteDatabaseConnection,
  scopeKey: string,
  reference: ValidatedWriteEntityReference,
  entityId: string,
): void {
  const seen = new Set<string>();
  for (const alias of reference.aliases) {
    if (seen.has(alias.normalName)) {
      continue;
    }
    seen.add(alias.normalName);
    upsertWriteSurface(
      database,
      scopeKey,
      alias.normalName,
      entityId,
      "agent_supplied",
    );
  }
}

function rejectAmbiguousWriteDraft(
  database: SqliteDatabaseConnection,
  draftIndex: number,
  field: "subject" | "object",
  candidates: readonly Readonly<{ entityId: string; name: string }>[],
): SqliteWriteEntityDraftResolution {
  database.exec(
    "ROLLBACK TO recall_record_entity_draft; RELEASE recall_record_entity_draft",
  );
  return Object.freeze({
    draftIndex,
    status: "rejected",
    reason: "ambiguous_entity",
    field,
    candidates: Object.freeze(
      candidates.map((candidate) =>
        Object.freeze({
          entityId: candidate.entityId,
          name: candidate.name,
        }),
      ),
    ),
    note:
      field === "subject" ? WRITE_ENTITY_SUBJECT_NOTE : WRITE_ENTITY_OBJECT_NOTE,
  });
}

interface StagedWriteEntityDrafts {
  readonly results: readonly SqliteWriteEntityDraftResolution[];
  readonly finalized: readonly FinalizedWriteEntityDraft[];
}

function occurrenceCandidateId(seq: number, position: number): string {
  if (
    !Number.isSafeInteger(seq) ||
    seq <= 0 ||
    !Number.isSafeInteger(position) ||
    position < 0
  ) {
    throw new WorkerConnectionFailure("SQLITE_TRANSACTION_FAILED");
  }
  return `e${seq}.${position}`;
}

function stageWriteEntityDrafts(
  database: SqliteDatabaseConnection,
  scopeKey: string,
  expectedJournalSeq: number,
  drafts: readonly ValidatedWriteEntityDraft[],
  allowAmbiguity: boolean,
): StagedWriteEntityDrafts {
  const results: SqliteWriteEntityDraftResolution[] = [];
  const finalized: FinalizedWriteEntityDraft[] = [];
  let entityPosition = 0;

  for (const draft of drafts) {
    const subjectCandidateId = occurrenceCandidateId(
      expectedJournalSeq,
      entityPosition,
    );
    const objectCandidateId =
      draft.object === null
        ? null
        : occurrenceCandidateId(expectedJournalSeq, entityPosition + 1);
    database.exec("SAVEPOINT recall_record_entity_draft");
    try {
      const subject = stageWriteEntityReference(
        database,
        scopeKey,
        draft.subject,
        subjectCandidateId,
      );
      if (subject.status === "ambiguous") {
        if (!allowAmbiguity) {
          throw new WorkerConnectionFailure("SQLITE_TRANSACTION_FAILED");
        }
        results.push(
          rejectAmbiguousWriteDraft(
            database,
            draft.draftIndex,
            "subject",
            subject.candidates,
          ),
        );
        continue;
      }
      const object =
        draft.object === null || objectCandidateId === null
          ? null
          : stageWriteEntityReference(
              database,
              scopeKey,
              draft.object,
              objectCandidateId,
            );
      if (object?.status === "ambiguous") {
        if (!allowAmbiguity) {
          throw new WorkerConnectionFailure("SQLITE_TRANSACTION_FAILED");
        }
        results.push(
          rejectAmbiguousWriteDraft(
            database,
            draft.draftIndex,
            "object",
            object.candidates,
          ),
        );
        continue;
      }
      applyWriteEntityAliases(database, scopeKey, draft.subject, subject.entityId);
      if (draft.object !== null && object?.status === "resolved") {
        applyWriteEntityAliases(
          database,
          scopeKey,
          draft.object,
          object.entityId,
        );
      }
      database.exec("RELEASE recall_record_entity_draft");
      const resolution: SqliteWriteEntityResolvedDraft = Object.freeze({
        draftIndex: draft.draftIndex,
        status: "resolved",
        subjectId: subject.entityId,
        objectId:
          object === null || object.status !== "resolved"
            ? null
            : object.entityId,
      });
      results.push(resolution);
      finalized.push(
        Object.freeze({
          draftIndex: draft.draftIndex,
          subject: draft.subject,
          object: draft.object,
          subjectCandidateId,
          objectCandidateId,
          resolution,
        }),
      );
      entityPosition += draft.object === null ? 1 : 2;
    } catch (error) {
      try {
        database.exec(
          "ROLLBACK TO recall_record_entity_draft; RELEASE recall_record_entity_draft",
        );
      } catch {
        // The primary validation or SQLite failure owns the public result.
      }
      throw error;
    }
  }

  return Object.freeze({
    results: Object.freeze(results),
    finalized: Object.freeze(finalized),
  });
}

function resolveWriteEntityDrafts(
  database: SqliteDatabaseConnection,
  replayState: WorkerProjectionReplayState,
  dispatchId: number,
  draftValues: readonly SqliteWriteEntityDraftInput[],
): readonly SqliteWriteEntityDraftResolution[] {
  const active = replayState.active;
  if (
    active === null ||
    active.kind !== "dispatch" ||
    active.replayId !== dispatchId ||
    !database.inTransaction ||
    !active.resolutionSavepointOpen ||
    active.resolutionCompleted ||
    active.appendedEvents.length !== 0
  ) {
    throw new WorkerConnectionFailure("SQLITE_TRANSACTION_FAILED");
  }

  try {
    const drafts = validateWriteEntityDrafts(draftValues);
    const staged = stageWriteEntityDrafts(
      database,
      active.scopeKey,
      active.expectedJournalSeq,
      drafts,
      true,
    );
    replayState.active = Object.freeze({
      ...active,
      resolutionCompleted: true,
      resolutionDrafts: drafts,
      resolutionResults: staged.results,
    });
    return staged.results;
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

function validateSurvivorDraftIndexes(
  value: unknown,
  drafts: readonly ValidatedWriteEntityDraft[],
  results: readonly SqliteWriteEntityDraftResolution[],
): readonly number[] {
  if (!Array.isArray(value) || value.length > drafts.length) {
    throw new WorkerConnectionFailure("SQLITE_TRANSACTION_FAILED");
  }
  const resultByIndex = new Map(results.map((result) => [result.draftIndex, result]));
  const draftPositionByIndex = new Map(
    drafts.map((draft, position) => [draft.draftIndex, position]),
  );
  const indexes: number[] = [];
  let previousPosition = -1;
  for (const item of value) {
    if (!Number.isSafeInteger(item)) {
      throw new WorkerConnectionFailure("SQLITE_TRANSACTION_FAILED");
    }
    const draftIndex = Number(item);
    const position = draftPositionByIndex.get(draftIndex);
    const result = resultByIndex.get(draftIndex);
    if (
      position === undefined ||
      position <= previousPosition ||
      result?.status !== "resolved"
    ) {
      throw new WorkerConnectionFailure("SQLITE_TRANSACTION_FAILED");
    }
    previousPosition = position;
    indexes.push(draftIndex);
  }
  return Object.freeze(indexes);
}

function finalizeWriteEntityDrafts(
  database: SqliteDatabaseConnection,
  replayState: WorkerProjectionReplayState,
  dispatchId: number,
  survivorDraftIndexValues: readonly number[],
  statementBodyJson: unknown,
): SqliteWriteEntityFinalizationResult {
  const active = replayState.active;
  if (
    active === null ||
    active.kind !== "dispatch" ||
    active.replayId !== dispatchId ||
    !database.inTransaction ||
    !active.resolutionSavepointOpen ||
    !active.resolutionCompleted ||
    active.resolutionDrafts === null ||
    active.resolutionResults === null ||
    active.finalizationCompleted ||
    active.appendedEvents.length !== 0
  ) {
    throw new WorkerConnectionFailure("SQLITE_TRANSACTION_FAILED");
  }

  try {
    const survivorDraftIndexes = validateSurvivorDraftIndexes(
      survivorDraftIndexValues,
      active.resolutionDrafts,
      active.resolutionResults,
    );
    const survivorSet = new Set(survivorDraftIndexes);
    const survivors = active.resolutionDrafts.filter((draft) =>
      survivorSet.has(draft.draftIndex),
    );

    database.exec(
      "ROLLBACK TO recall_record_entity_resolution; RELEASE recall_record_entity_resolution; SAVEPOINT recall_record_entity_resolution",
    );
    const staged = stageWriteEntityDrafts(
      database,
      active.scopeKey,
      active.expectedJournalSeq,
      survivors,
      false,
    );
    if (
      staged.results.length !== survivors.length ||
      staged.finalized.length !== survivors.length ||
      staged.results.some((result) => result.status !== "resolved")
    ) {
      throw new WorkerConnectionFailure("SQLITE_TRANSACTION_FAILED");
    }
    if (
      typeof statementBodyJson !== "string" ||
      !statementBodyMatchesFinalizedEntityDrafts(
        statementBodyJson,
        staged.finalized,
        active.expectedJournalSeq,
      )
    ) {
      throw new WorkerConnectionFailure("SQLITE_TRANSACTION_FAILED");
    }
    const drafts = Object.freeze(
      staged.results as readonly SqliteWriteEntityResolvedDraft[],
    );
    replayState.active = Object.freeze({
      ...active,
      finalizationCompleted: true,
      finalizedDrafts: staged.finalized,
      finalizedBodyJson: statementBodyJson,
    });
    return Object.freeze({
      expectedJournalSeq: active.expectedJournalSeq,
      drafts,
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

function storedAliases(value: unknown): readonly string[] {
  if (value === undefined) {
    return Object.freeze([]);
  }
  if (!Array.isArray(value) || value.length > 20) {
    throw new WorkerConnectionFailure("SQLITE_TRANSACTION_FAILED");
  }
  return Object.freeze(value.map((item) => writeEntityText(item, 256).name));
}

function storedKind(value: unknown): string | null {
  return value === undefined ? null : writeEntityKind(value);
}

function sameValidatedReference(
  source: Readonly<Record<string, unknown>>,
  prefix: "subject" | "object",
  expected: ValidatedWriteEntityReference,
): boolean {
  const name = writeEntityText(source[prefix], 1_024).name;
  const kind = storedKind(source[`${prefix}_kind`]);
  const aliases = storedAliases(source[`${prefix}_aliases`]);
  return (
    name === expected.name &&
    kind === expected.kind &&
    aliases.length === expected.aliases.length &&
    aliases.every((alias, index) => alias === expected.aliases[index]?.name)
  );
}

function appendMatchesFinalizedEntityDrafts(
  appendEvents: readonly SqliteProjectionDispatchAppendEvent[],
  finalizedDrafts: readonly FinalizedWriteEntityDraft[],
  expectedJournalSeq: number,
): boolean {
  if (appendEvents.length !== 1 || appendEvents[0]?.kind !== "statement") {
    return false;
  }
  return statementBodyMatchesFinalizedEntityDrafts(
    appendEvents[0].bodyJson,
    finalizedDrafts,
    expectedJournalSeq,
  );
}

function statementBodyMatchesFinalizedEntityDrafts(
  statementBodyJson: string,
  finalizedDrafts: readonly FinalizedWriteEntityDraft[],
  expectedJournalSeq: number,
): boolean {
  let body: unknown;
  try {
    body = JSON.parse(statementBodyJson) as unknown;
  } catch {
    return false;
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return false;
  }
  const parsed = (body as Readonly<Record<string, unknown>>)["parsed"];
  if (!Array.isArray(parsed) || parsed.length !== finalizedDrafts.length) {
    return false;
  }
  try {
    let entityPosition = 0;
    for (let index = 0; index < parsed.length; index += 1) {
      const value = parsed[index];
      const finalized = finalizedDrafts[index];
      if (
        value === null ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        finalized === undefined
      ) {
        return false;
      }
      const draft = value as Readonly<Record<string, unknown>>;
      if (
        finalized.subjectCandidateId !==
          occurrenceCandidateId(expectedJournalSeq, entityPosition) ||
        finalized.objectCandidateId !==
          (finalized.object === null
            ? null
            : occurrenceCandidateId(expectedJournalSeq, entityPosition + 1)) ||
        finalized.resolution.draftIndex !== finalized.draftIndex
      ) {
        return false;
      }
      if (!sameValidatedReference(draft, "subject", finalized.subject)) {
        return false;
      }
      const hasObject = Object.hasOwn(draft, "object");
      const hasObjectValue = Object.hasOwn(draft, "object_value");
      if (hasObject === hasObjectValue) {
        return false;
      }
      if (finalized.object === null) {
        if (
          hasObject ||
          Object.hasOwn(draft, "object_kind") ||
          Object.hasOwn(draft, "object_aliases")
        ) {
          return false;
        }
      } else if (
        !hasObject ||
        !sameValidatedReference(draft, "object", finalized.object)
      ) {
        return false;
      }
      entityPosition += finalized.object === null ? 1 : 2;
    }
  } catch (error: unknown) {
    if (
      error instanceof WorkerConnectionFailure ||
      error instanceof ProjectionRuleError
    ) {
      return false;
    }
    throw error;
  }
  return true;
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
    active.kind !== "replay" ||
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
    active.kind !== "dispatch" ||
    active.replayId !== dispatchId ||
    !database.inTransaction ||
    active.resolutionSavepointOpen ||
    active.appendedEvents.length === 0 ||
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
  database.exec(RECALL_TRAVERSAL_SQL_SOURCE.dropTempLinks);
  database.exec(RECALL_TRAVERSAL_SQL_SOURCE.dropTempIncident);
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
    database.exec(RECALL_TRAVERSAL_SQL_SOURCE.createTempLinks);
    database.exec(RECALL_TRAVERSAL_SQL_SOURCE.createTempIncident);
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
      (surfaceNorm) =>
        typeof surfaceNorm !== "string" ||
        surfaceNorm.length === 0,
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

function isFtsQuerySyntaxFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    /(?:fts5:\s*syntax error|malformed MATCH expression|unterminated string)/iu.test(
      error.message,
    )
  );
}

function unavailableRecallFtsRows(): Readonly<{
  queryUnavailable: true;
  candidateRows: readonly Readonly<Record<string, unknown>>[];
  supportRows: readonly Readonly<Record<string, unknown>>[];
}> {
  return Object.freeze({
    queryUnavailable: true,
    candidateRows: Object.freeze([]),
    supportRows: Object.freeze([]),
  });
}

function searchRecallSnapshotFts(
  database: SqliteDatabaseConnection,
  state: WorkerRecallSnapshotState,
  snapshotId: number,
  matchExpression: string,
  phraseLiterals: readonly string[],
): Readonly<{
  queryUnavailable: boolean;
  candidateRows: readonly Readonly<Record<string, unknown>>[];
  supportRows: readonly Readonly<Record<string, unknown>>[];
}> {
  if (
    state.active === null ||
    state.active.snapshotId !== snapshotId ||
    !database.inTransaction ||
    typeof matchExpression !== "string" ||
    !Array.isArray(phraseLiterals) ||
    phraseLiterals.length < 1 ||
    phraseLiterals.length > 10 ||
    !phraseLiterals.every(
      (phrase) =>
        typeof phrase === "string" &&
        phrase.length >= 2 &&
        phrase.length <= 8_194 &&
        phrase.startsWith('"') &&
        phrase.endsWith('"') &&
        !/[\u0000-\u001f\u007f-\u009f]/u.test(phrase),
    ) ||
    matchExpression !== phraseLiterals.join(" OR ")
  ) {
    throw new WorkerConnectionFailure("RECALL_SNAPSHOT_FAILED");
  }

  let candidateRows: readonly Readonly<Record<string, unknown>>[];
  try {
    candidateRows = rows(
      database
        .prepare(RECALL_FTS_SQL_SOURCE.selectCandidateStatements)
        .all({
          fts_query: matchExpression,
          scope_key: state.active.scopeKey,
          now: state.active.evaluationNow,
        }),
    );
  } catch (error) {
    if (isFtsQuerySyntaxFailure(error)) {
      return unavailableRecallFtsRows();
    }
    throw error;
  }

  const phraseMatcher = database.prepare(
    RECALL_FTS_SQL_SOURCE.matchCandidatePhrase,
  );
  const supportSelector = database.prepare(
    RECALL_FTS_SQL_SOURCE.selectCandidateSupports,
  );
  const matchedRows: Readonly<Record<string, unknown>>[] = [];
  const supportRows: Readonly<Record<string, unknown>>[] = [];

  try {
    for (const candidate of candidateRows) {
      const statementSeq = candidate["recall_fts_statement_seq"];
      if (!Number.isSafeInteger(statementSeq) || Number(statementSeq) < 1) {
        throw new WorkerConnectionFailure("RECALL_SNAPSHOT_FAILED");
      }
      let matchedPhraseIndex = -1;
      for (let index = 0; index < phraseLiterals.length; index += 1) {
        const phraseLiteral = phraseLiterals[index];
        if (phraseLiteral === undefined) {
          throw new WorkerConnectionFailure("RECALL_SNAPSHOT_FAILED");
        }
        const matchRow = rowOrNull(
          phraseMatcher.get({
            statement_seq: Number(statementSeq),
            fts_phrase: phraseLiteral,
          }),
        );
        const matched = matchRow?.["recall_fts_phrase_matches"];
        if (matched !== 0 && matched !== 1) {
          throw new WorkerConnectionFailure("RECALL_SNAPSHOT_FAILED");
        }
        if (matched === 1) {
          matchedPhraseIndex = index;
          break;
        }
      }
      if (matchedPhraseIndex < 0) {
        throw new WorkerConnectionFailure("RECALL_SNAPSHOT_FAILED");
      }
      matchedRows.push(
        Object.freeze({
          ...candidate,
          recall_fts_phrase_index: matchedPhraseIndex,
        }),
      );
    }

    for (const candidate of matchedRows) {
      const eventId = candidate["recall_fts_event_id"];
      if (typeof eventId !== "string") {
        throw new WorkerConnectionFailure("RECALL_SNAPSHOT_FAILED");
      }
      supportRows.push(
        ...rows(
          supportSelector.all({
            event_id: eventId,
            scope_key: state.active.scopeKey,
            now: state.active.evaluationNow,
          }),
        ),
      );
    }
  } catch (error) {
    if (isFtsQuerySyntaxFailure(error)) {
      return unavailableRecallFtsRows();
    }
    throw error;
  }

  return Object.freeze({
    queryUnavailable: false,
    candidateRows: Object.freeze(matchedRows),
    supportRows: Object.freeze(supportRows),
  });
}

function readRecallSnapshotOverview(
  database: SqliteDatabaseConnection,
  state: WorkerRecallSnapshotState,
  snapshotId: number,
  limit: number,
): Readonly<{
  entityRows: readonly Readonly<Record<string, unknown>>[];
  rawRows: readonly Readonly<Record<string, unknown>>[];
}> {
  if (
    state.active === null ||
    state.active.snapshotId !== snapshotId ||
    !database.inTransaction ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 50
  ) {
    throw new WorkerConnectionFailure("RECALL_SNAPSHOT_FAILED");
  }

  const seedLimit = Math.min(limit, 10);
  const bindings = Object.freeze({
    scope_key: state.active.scopeKey,
    now: state.active.evaluationNow,
    overview_seed_probe_limit: seedLimit + 1,
    overview_raw_probe_limit: limit + 1,
  });
  return Object.freeze({
    entityRows: rows(
      database
        .prepare(RECALL_OVERVIEW_SQL_SOURCE.selectEntityCandidates)
        .all(bindings),
    ),
    rawRows: rows(
      database
        .prepare(RECALL_OVERVIEW_SQL_SOURCE.selectRawCandidates)
        .all(bindings),
    ),
  });
}

function readRecallSnapshotTraversalState(
  database: SqliteDatabaseConnection,
  state: WorkerRecallSnapshotState,
  snapshotId: number,
  entityId: string,
): Readonly<{
  entityRow: Readonly<Record<string, unknown>> | null;
  linkRows: readonly Readonly<Record<string, unknown>>[];
  incidentRows: readonly Readonly<Record<string, unknown>>[];
}> {
  if (
    state.active === null ||
    state.active.snapshotId !== snapshotId ||
    !database.inTransaction ||
    !/^e[1-9][0-9]*\.[0-9]+$/u.test(entityId)
  ) {
    throw new WorkerConnectionFailure("RECALL_SNAPSHOT_FAILED");
  }
  return Object.freeze({
    entityRow: rowOrNull(
      database.prepare(RECALL_TRAVERSAL_SQL_SOURCE.selectEntity).get(entityId),
    ),
    linkRows: rows(
      database.prepare(RECALL_TRAVERSAL_SQL_SOURCE.selectLinks).all(entityId),
    ),
    incidentRows: rows(
      database
        .prepare(RECALL_TRAVERSAL_SQL_SOURCE.selectIncidents)
        .all(entityId),
    ),
  });
}

function readRecallSnapshotRankingRows(
  database: SqliteDatabaseConnection,
  state: WorkerRecallSnapshotState,
  snapshotId: number,
  candidates: readonly Readonly<{ readonly claimId: string; readonly depth: number }>[],
  probeLimit: number,
): Readonly<{
  rows: readonly Readonly<Record<string, unknown>>[];
}> {
  if (
    state.active === null ||
    state.active.snapshotId !== snapshotId ||
    !database.inTransaction ||
    !Array.isArray(candidates) ||
    candidates.length < 1 ||
    !Number.isSafeInteger(probeLimit) ||
    probeLimit < 2 ||
    probeLimit > 51
  ) {
    throw new WorkerConnectionFailure("RECALL_SNAPSHOT_FAILED");
  }
  const seen = new Set<string>();
  const reached: Array<Readonly<{ claimId: string; depth: number }>> = [];
  for (const candidate of candidates) {
    if (
      candidate === null ||
      typeof candidate !== "object" ||
      Array.isArray(candidate) ||
      typeof candidate.claimId !== "string" ||
      !/^c[1-9][0-9]*\.[0-9]+$/u.test(candidate.claimId) ||
      !Number.isSafeInteger(candidate.depth) ||
      candidate.depth < 0 ||
      candidate.depth > 3 ||
      seen.has(candidate.claimId)
    ) {
      throw new WorkerConnectionFailure("RECALL_SNAPSHOT_FAILED");
    }
    seen.add(candidate.claimId);
    reached.push(Object.freeze({
      claimId: candidate.claimId,
      depth: candidate.depth,
    }));
  }
  return Object.freeze({
    rows: rows(
      database
        .prepare(RECALL_RANKING_SQL_SOURCE.selectRankedClaims)
        .all({
          reached_json: JSON.stringify(reached),
          scope_key: state.active.scopeKey,
          now: state.active.evaluationNow,
          probe_limit: probeLimit,
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

  if (request.type === "recall-snapshot-fts") {
    if (data.role !== "reader") {
      post({
        type: "failure",
        requestId: request.requestId,
        code: "RECALL_SNAPSHOT_FAILED",
      });
      return;
    }
    try {
      const result = searchRecallSnapshotFts(
        database,
        recallState,
        request.snapshotId,
        request.matchExpression,
        request.phraseLiterals,
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

  if (request.type === "recall-snapshot-overview") {
    if (data.role !== "reader") {
      post({
        type: "failure",
        requestId: request.requestId,
        code: "RECALL_SNAPSHOT_FAILED",
      });
      return;
    }
    try {
      const result = readRecallSnapshotOverview(
        database,
        recallState,
        request.snapshotId,
        request.limit,
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

  if (request.type === "recall-snapshot-traversal") {
    if (data.role !== "reader") {
      post({
        type: "failure",
        requestId: request.requestId,
        code: "RECALL_SNAPSHOT_FAILED",
      });
      return;
    }
    try {
      const result = readRecallSnapshotTraversalState(
        database,
        recallState,
        request.snapshotId,
        request.entityId,
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

  if (request.type === "recall-snapshot-ranking") {
    if (data.role !== "reader") {
      post({
        type: "failure",
        requestId: request.requestId,
        code: "RECALL_SNAPSHOT_FAILED",
      });
      return;
    }
    try {
      const result = readRecallSnapshotRankingRows(
        database,
        recallState,
        request.snapshotId,
        request.candidates,
        request.probeLimit,
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

  if (request.type === "projection-dispatch-prepare") {
    if (data.role !== "writer" || replayState.active !== null) {
      post({
        type: "failure",
        requestId: request.requestId,
        code: "SQLITE_TRANSACTION_FAILED",
      });
      return;
    }
    try {
      const result = prepareProjectionDispatch(
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

  if (request.type === "projection-dispatch-resolve-entities") {
    if (data.role !== "writer") {
      post({
        type: "failure",
        requestId: request.requestId,
        code: "SQLITE_TRANSACTION_FAILED",
      });
      return;
    }
    try {
      const result = resolveWriteEntityDrafts(
        database,
        replayState,
        request.dispatchId,
        request.drafts,
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

  if (request.type === "projection-dispatch-finalize-entities") {
    if (data.role !== "writer") {
      post({
        type: "failure",
        requestId: request.requestId,
        code: "SQLITE_TRANSACTION_FAILED",
      });
      return;
    }
    try {
      const result = finalizeWriteEntityDrafts(
        database,
        replayState,
        request.dispatchId,
        request.survivorDraftIndexes,
        request.statementBodyJson,
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

  if (request.type === "projection-dispatch-append") {
    if (data.role !== "writer") {
      post({
        type: "failure",
        requestId: request.requestId,
        code: "SQLITE_TRANSACTION_FAILED",
      });
      return;
    }
    try {
      const result = appendPreparedProjectionDispatch(
        database,
        replayState,
        request.dispatchId,
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
