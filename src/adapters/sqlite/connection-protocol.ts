import type {
  ProjectionReplayJournalEvent,
  ProjectionSnapshot,
} from "../../domain/projection-replay.js";

export interface SqliteConnectionPolicy {
  readonly journalMode: "wal";
  readonly synchronous: 1;
  readonly busyTimeoutMs: 5000;
  readonly cacheSize: -20000;
  readonly tempStore: 2;
  readonly foreignKeys: 1;
}

export const SQLITE_CONNECTION_POLICY: SqliteConnectionPolicy = Object.freeze({
  journalMode: "wal",
  synchronous: 1,
  busyTimeoutMs: 5000,
  cacheSize: -20000,
  tempStore: 2,
  foreignKeys: 1,
});

export type SqliteBinding = null | string | number | bigint | Uint8Array;

export interface SqliteExecCommand {
  readonly kind: "exec";
  readonly sql: string;
}

export interface SqliteRunCommand {
  readonly kind: "run";
  readonly sql: string;
  readonly parameters?: readonly SqliteBinding[];
}

export interface SqliteGetCommand {
  readonly kind: "get";
  readonly sql: string;
  readonly parameters?: readonly SqliteBinding[];
}

export interface SqliteAllCommand {
  readonly kind: "all";
  readonly sql: string;
  readonly parameters?: readonly SqliteBinding[];
}

export type SqliteTransactionCommand =
  | SqliteExecCommand
  | SqliteRunCommand
  | SqliteGetCommand
  | SqliteAllCommand;

export type SqliteReadQuery = SqliteGetCommand | SqliteAllCommand;

export interface SqliteExecResult {
  readonly kind: "exec";
}

export interface SqliteRunResult {
  readonly kind: "run";
  readonly changes: number;
  readonly lastInsertRowid: number | bigint;
}

export interface SqliteGetResult {
  readonly kind: "get";
  readonly row: Readonly<Record<string, unknown>> | null;
}

export interface SqliteAllResult {
  readonly kind: "all";
  readonly rows: readonly Readonly<Record<string, unknown>>[];
}

export type SqliteCommandResult =
  | SqliteExecResult
  | SqliteRunResult
  | SqliteGetResult
  | SqliteAllResult;

export type SqliteReadResult = SqliteGetResult | SqliteAllResult;

export type SqliteConnectionErrorCode =
  | "WAL_MODE_REQUIRED"
  | "WAL_MODE_UNAVAILABLE"
  | "CONNECTION_POLICY_UNAVAILABLE"
  | "SQLITE_CONNECTION_FAILED"
  | "SQLITE_TRANSACTION_FAILED"
  | "SQLITE_QUERY_FAILED"
  | "SQLITE_SIDECAR_UNSAFE"
  | "SQLITE_WORKER_FAILED"
  | "INVALID_TRANSACTION_PROGRAM"
  | "WRITER_ALREADY_ACTIVE"
  | "CONNECTION_FACTORY_CLOSED"
  | "CONNECTION_CLOSED"
  | "RECALL_SNAPSHOT_FAILED"
  | "SQLITE_BUSY";

export type SqliteMigrationErrorCode =
  | "MIGRATION_BUNDLE_INVALID"
  | "MIGRATION_HISTORY_MISMATCH"
  | "MIGRATION_VERSION_UNSUPPORTED"
  | "MIGRATION_APPLICATION_FAILED"
  | "MIGRATION_RUNNER_UNAVAILABLE";

export type SqliteWorkerErrorCode =
  | SqliteConnectionErrorCode
  | SqliteMigrationErrorCode;

const CONNECTION_ERROR_MESSAGES: Readonly<
  Record<SqliteConnectionErrorCode, string>
> = Object.freeze({
  WAL_MODE_REQUIRED: "SQLite reader requires an existing WAL database",
  WAL_MODE_UNAVAILABLE: "SQLite writer could not enable WAL safely",
  CONNECTION_POLICY_UNAVAILABLE:
    "SQLite connection policy could not be applied safely",
  SQLITE_CONNECTION_FAILED: "SQLite connection could not be opened safely",
  SQLITE_TRANSACTION_FAILED: "SQLite write transaction failed and was rolled back",
  SQLITE_QUERY_FAILED: "SQLite read query failed safely",
  SQLITE_SIDECAR_UNSAFE: "SQLite WAL sidecar permissions are unsafe",
  SQLITE_WORKER_FAILED: "SQLite worker stopped before completing the operation",
  INVALID_TRANSACTION_PROGRAM:
    "SQLite write transaction requires at least one valid command",
  WRITER_ALREADY_ACTIVE:
    "SQLite database already has an active writer in this process",
  CONNECTION_FACTORY_CLOSED: "SQLite connection factory is closing or closed",
  CONNECTION_CLOSED: "SQLite reader connection is closed",
  RECALL_SNAPSHOT_FAILED:
    "SQLite recall snapshot failed and temporary state was discarded",
  SQLITE_BUSY: "SQLite writer lock was not available within five seconds",
});

export class SqliteConnectionError extends Error {
  public override readonly name: string = "SqliteConnectionError";
  public readonly code: SqliteConnectionErrorCode;
  public readonly retryable: boolean;

  public constructor(code: SqliteConnectionErrorCode, retryable: boolean = false) {
    super(CONNECTION_ERROR_MESSAGES[code]);
    this.code = code;
    this.retryable = retryable;
  }
}

export class SqliteBusyError extends SqliteConnectionError {
  public override readonly name: string = "SqliteBusyError";
  public override readonly code: "SQLITE_BUSY" = "SQLITE_BUSY";
  public override readonly retryable: true = true;
  public readonly timeoutMs: 5000 = 5000;

  public constructor() {
    super("SQLITE_BUSY", true);
  }
}

const MIGRATION_ERROR_MESSAGES: Readonly<
  Record<SqliteMigrationErrorCode, string>
> = Object.freeze({
  MIGRATION_BUNDLE_INVALID: "SQLite migration bundle is invalid",
  MIGRATION_HISTORY_MISMATCH:
    "SQLite migration history does not match the bundled migrations",
  MIGRATION_VERSION_UNSUPPORTED:
    "SQLite schema version is newer than this server supports",
  MIGRATION_APPLICATION_FAILED:
    "SQLite migration failed and was rolled back safely",
  MIGRATION_RUNNER_UNAVAILABLE:
    "SQLite migration runner requires the managed writer connection",
});

export class SqliteMigrationError extends Error {
  public override readonly name: string = "SqliteMigrationError";
  public readonly code: SqliteMigrationErrorCode;
  public readonly retryable: false = false;

  public constructor(code: SqliteMigrationErrorCode) {
    super(MIGRATION_ERROR_MESSAGES[code]);
    this.code = code;
  }
}

export interface SqlitePreparedMigration {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly sql: string;
  readonly appliedAtSeconds: number;
}

export interface SqliteMigrationExecutionResult {
  readonly appliedVersions: readonly number[];
  readonly currentVersion: number;
}

export type SqliteWorkerRole = "writer" | "reader";

export interface SqliteWorkerData {
  readonly role: SqliteWorkerRole;
  readonly databasePath: string;
}

export interface SqliteWorkerTransactionRequest {
  readonly type: "transaction";
  readonly requestId: number;
  readonly commands: readonly SqliteTransactionCommand[];
}

export interface SqliteWorkerMigrationRequest {
  readonly type: "migrate";
  readonly requestId: number;
  readonly migrations: readonly SqlitePreparedMigration[];
}

export interface SqliteWorkerQueryRequest {
  readonly type: "query";
  readonly requestId: number;
  readonly query: SqliteReadQuery;
}

export interface SqliteRecallSnapshotBeginResult {
  readonly snapshotId: number;
}

export interface SqliteRecallAggregateRowsResult {
  readonly rows: readonly Readonly<Record<string, unknown>>[];
}

export interface SqliteRecallSurfaceStateRowsResult {
  readonly candidateRows: readonly Readonly<Record<string, unknown>>[];
  readonly entityRows: readonly Readonly<Record<string, unknown>>[];
  readonly redirectRows: readonly Readonly<Record<string, unknown>>[];
}

export interface SqliteRecallFtsRowsResult {
  readonly queryUnavailable: boolean;
  readonly candidateRows: readonly Readonly<Record<string, unknown>>[];
  readonly supportRows: readonly Readonly<Record<string, unknown>>[];
}

export interface SqliteRecallOverviewRowsResult {
  readonly entityRows: readonly Readonly<Record<string, unknown>>[];
  readonly rawRows: readonly Readonly<Record<string, unknown>>[];
}

export interface SqliteRecallTraversalStateRowsResult {
  readonly entityRow: Readonly<Record<string, unknown>> | null;
  readonly linkRows: readonly Readonly<Record<string, unknown>>[];
  readonly incidentRows: readonly Readonly<Record<string, unknown>>[];
}

export interface SqliteWorkerRecallSnapshotBeginRequest {
  readonly type: "recall-snapshot-begin";
  readonly requestId: number;
  readonly scopeKey: string;
  readonly evaluationNow: number;
}

export interface SqliteWorkerRecallSnapshotReadRequest {
  readonly type: "recall-snapshot-read";
  readonly requestId: number;
  readonly snapshotId: number;
}

export interface SqliteWorkerRecallSurfaceStateRequest {
  readonly type: "recall-snapshot-surface";
  readonly requestId: number;
  readonly snapshotId: number;
  readonly surfaceNorms: readonly string[];
}

export interface SqliteWorkerRecallSnapshotFtsRequest {
  readonly type: "recall-snapshot-fts";
  readonly requestId: number;
  readonly snapshotId: number;
  readonly matchExpression: string;
  readonly phraseLiterals: readonly string[];
}

export interface SqliteWorkerRecallSnapshotOverviewRequest {
  readonly type: "recall-snapshot-overview";
  readonly requestId: number;
  readonly snapshotId: number;
  readonly limit: number;
}

export interface SqliteWorkerRecallTraversalStateRequest {
  readonly type: "recall-snapshot-traversal";
  readonly requestId: number;
  readonly snapshotId: number;
  readonly entityId: string;
}

export interface SqliteWorkerRecallSnapshotEndRequest {
  readonly type: "recall-snapshot-end";
  readonly requestId: number;
  readonly snapshotId: number;
  readonly commit: boolean;
}

export interface SqliteProjectionMetaSnapshot {
  readonly lastSeq: number;
  readonly rulesVersion: string;
  readonly rebuiltAt: number;
}

export interface SqliteProjectionReplayBeginResult {
  readonly replayId: number;
  readonly events: readonly ProjectionReplayJournalEvent[];
  readonly meta: SqliteProjectionMetaSnapshot | null;
}

export interface SqliteProjectionReplayCommitResult {
  readonly lastSeq: number;
  readonly eventCount: number;
  readonly projectionRowCount: number;
}

export interface SqliteProjectionDispatchAppendEvent {
  readonly eventId: string;
  readonly kind: "statement" | "retraction" | "merge" | "alias";
  readonly bodyJson: string;
  readonly actor: string | null;
  readonly branch: string | null;
  readonly session: string | null;
  readonly createdAt: number;
}

export interface SqliteProjectionDispatchBeginResult {
  readonly dispatchId: number;
  readonly collision: boolean;
  readonly events: readonly ProjectionReplayJournalEvent[];
  readonly appendedEvents: readonly ProjectionReplayJournalEvent[];
  readonly current: ProjectionSnapshot;
  readonly meta: SqliteProjectionMetaSnapshot | null;
  readonly projectionValid: boolean;
  readonly previousLastSeq: number;
}

/**
 * A writer-owned dispatch snapshot captured before any journal row is added.
 * The open transaction may only be committed after a non-empty append and
 * projection publish; entity-resolution staging alone is rollback-only.
 */
export interface SqliteProjectionDispatchPrepareResult {
  readonly dispatchId: number;
  readonly current: ProjectionSnapshot;
  readonly meta: SqliteProjectionMetaSnapshot | null;
  readonly projectionValid: boolean;
  readonly previousLastSeq: number;
  readonly expectedJournalSeq: number;
}

export interface SqliteWriteEntityReferenceInput {
  readonly name: string;
  readonly kind: string | null;
  readonly aliases: readonly string[];
}

export interface SqliteWriteEntityDraftInput {
  readonly draftIndex: number;
  readonly subject: SqliteWriteEntityReferenceInput;
  readonly object: SqliteWriteEntityReferenceInput | null;
}

export interface SqliteWriteEntityAmbiguousCandidate {
  readonly entityId: string;
  readonly name: string;
}

export interface SqliteWriteEntityResolvedDraft {
  readonly draftIndex: number;
  readonly status: "resolved";
  readonly subjectId: string;
  readonly objectId: string | null;
}

export interface SqliteWriteEntityRejectedDraft {
  readonly draftIndex: number;
  readonly status: "rejected";
  readonly reason: "ambiguous_entity";
  readonly field: "subject" | "object";
  readonly candidates: readonly SqliteWriteEntityAmbiguousCandidate[];
  readonly note: string;
}

export type SqliteWriteEntityDraftResolution =
  | SqliteWriteEntityResolvedDraft
  | SqliteWriteEntityRejectedDraft;

export interface SqliteWriteEntityFinalizationResult {
  readonly expectedJournalSeq: number;
  readonly drafts: readonly SqliteWriteEntityResolvedDraft[];
}

export type SqliteProjectionPublishMode = "incremental" | "replay";

export interface SqliteProjectionDispatchCommitResult
  extends SqliteProjectionReplayCommitResult {
  readonly mode: SqliteProjectionPublishMode;
}

export interface SqliteWorkerProjectionReplayBeginRequest {
  readonly type: "projection-replay-begin";
  readonly requestId: number;
  readonly scopeKey: string;
}

export interface SqliteWorkerProjectionReplayCommitRequest {
  readonly type: "projection-replay-commit";
  readonly requestId: number;
  readonly replayId: number;
  readonly rulesVersion: string;
  readonly rebuiltAt: number;
  readonly snapshot: ProjectionSnapshot;
}

export interface SqliteWorkerProjectionReplayRollbackRequest {
  readonly type: "projection-replay-rollback";
  readonly requestId: number;
  readonly replayId: number;
}

export interface SqliteWorkerProjectionDispatchBeginRequest {
  readonly type: "projection-dispatch-begin";
  readonly requestId: number;
  readonly scopeKey: string;
  readonly events: readonly SqliteProjectionDispatchAppendEvent[];
}

export interface SqliteWorkerProjectionDispatchPrepareRequest {
  readonly type: "projection-dispatch-prepare";
  readonly requestId: number;
  readonly scopeKey: string;
}

export interface SqliteWorkerProjectionDispatchResolveEntitiesRequest {
  readonly type: "projection-dispatch-resolve-entities";
  readonly requestId: number;
  readonly dispatchId: number;
  readonly drafts: readonly SqliteWriteEntityDraftInput[];
}

export interface SqliteWorkerProjectionDispatchFinalizeEntitiesRequest {
  readonly type: "projection-dispatch-finalize-entities";
  readonly requestId: number;
  readonly dispatchId: number;
  readonly survivorDraftIndexes: readonly number[];
  readonly statementBodyJson: string;
}

export interface SqliteWorkerProjectionDispatchAppendRequest {
  readonly type: "projection-dispatch-append";
  readonly requestId: number;
  readonly dispatchId: number;
  readonly events: readonly SqliteProjectionDispatchAppendEvent[];
}

export interface SqliteWorkerProjectionDispatchCommitRequest {
  readonly type: "projection-dispatch-commit";
  readonly requestId: number;
  readonly dispatchId: number;
  readonly mode: SqliteProjectionPublishMode;
  readonly rulesVersion: string;
  readonly rebuiltAt: number;
  readonly snapshot: ProjectionSnapshot;
}

export interface SqliteWorkerCloseRequest {
  readonly type: "close";
  readonly requestId: number;
}

export type SqliteWorkerRequest =
  | SqliteWorkerTransactionRequest
  | SqliteWorkerMigrationRequest
  | SqliteWorkerQueryRequest
  | SqliteWorkerProjectionReplayBeginRequest
  | SqliteWorkerProjectionReplayCommitRequest
  | SqliteWorkerProjectionReplayRollbackRequest
  | SqliteWorkerProjectionDispatchBeginRequest
  | SqliteWorkerProjectionDispatchPrepareRequest
  | SqliteWorkerProjectionDispatchResolveEntitiesRequest
  | SqliteWorkerProjectionDispatchFinalizeEntitiesRequest
  | SqliteWorkerProjectionDispatchAppendRequest
  | SqliteWorkerProjectionDispatchCommitRequest
  | SqliteWorkerRecallSnapshotBeginRequest
  | SqliteWorkerRecallSnapshotReadRequest
  | SqliteWorkerRecallSurfaceStateRequest
  | SqliteWorkerRecallSnapshotFtsRequest
  | SqliteWorkerRecallSnapshotOverviewRequest
  | SqliteWorkerRecallTraversalStateRequest
  | SqliteWorkerRecallSnapshotEndRequest
  | SqliteWorkerCloseRequest;

export interface SqliteWorkerReadyResponse {
  readonly type: "ready";
  readonly configuration: SqliteConnectionPolicy;
}

export interface SqliteWorkerSuccessResponse {
  readonly type: "success";
  readonly requestId: number;
  readonly result: unknown;
}

export interface SqliteWorkerErrorResponse {
  readonly type: "failure";
  readonly requestId: number | null;
  readonly code: SqliteWorkerErrorCode;
}

export type SqliteWorkerResponse =
  | SqliteWorkerReadyResponse
  | SqliteWorkerSuccessResponse
  | SqliteWorkerErrorResponse;

export function connectionErrorFromCode(
  code: SqliteWorkerErrorCode,
): SqliteConnectionError | SqliteMigrationError {
  if (code === "SQLITE_BUSY") {
    return new SqliteBusyError();
  }
  if (code.startsWith("MIGRATION_")) {
    return new SqliteMigrationError(code as SqliteMigrationErrorCode);
  }
  return new SqliteConnectionError(code as SqliteConnectionErrorCode);
}
