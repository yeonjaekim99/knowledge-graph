import type {
  JournalCommitPort,
  NonEmptyReadonlyArray,
} from "../../application/ports/journal-commit-port.js";

export {
  createSqliteConnectionFactory,
  openSqliteReader,
} from "./connection-factory.js";
export type {
  SqliteConnectionFactory,
  SqliteReaderConnection,
} from "./connection-factory.js";
export {
  WriteEntityResolutionError,
  finalizeSqliteWriteEntityDrafts,
  resolveSqliteWriteEntityDrafts,
} from "./write-entity-resolver.js";
export type {
  WriteEntityDraftResolution,
  WriteEntityDraftResolutionInput,
  WriteEntityFinalizationResult,
  WriteEntityReferenceResolutionInput,
  WriteEntityResolutionErrorCode,
} from "./write-entity-resolver.js";
export {
  SQLITE_CONNECTION_POLICY,
  SqliteBusyError,
  SqliteConnectionError,
  SqliteMigrationError,
} from "./connection-protocol.js";
export type {
  SqliteAllCommand,
  SqliteAllResult,
  SqliteBinding,
  SqliteCommandResult,
  SqliteConnectionErrorCode,
  SqliteConnectionPolicy,
  SqliteMigrationErrorCode,
  SqliteExecCommand,
  SqliteExecResult,
  SqliteGetCommand,
  SqliteGetResult,
  SqliteReadQuery,
  SqliteReadResult,
  SqliteRunCommand,
  SqliteRunResult,
  SqliteTransactionCommand,
} from "./connection-protocol.js";

export { runSqliteMigrations } from "./migration.js";
export type {
  SqliteMigration,
  SqliteMigrationOptions,
  SqliteMigrationResult,
} from "./migration.js";
export { runBundledSqliteMigrations } from "./bundled-migrations.js";

export { CLAIM_AGGREGATE_SQL_SOURCE } from "./claim-aggregate.js";
export type { ClaimAggregateSqlSource } from "./claim-aggregate.js";
export { createSqliteRecallReadPort } from "./recall-read-port.js";
export { RECALL_FTS_SQL_SOURCE } from "./recall-fts-sql.js";
export type { RecallFtsSqlSource } from "./recall-fts-sql.js";
export { RECALL_OVERVIEW_SQL_SOURCE } from "./recall-overview-sql.js";
export type { RecallOverviewSqlSource } from "./recall-overview-sql.js";
export { RECALL_SNAPSHOT_SQL_SOURCE } from "./recall-snapshot-sql.js";
export type { RecallSnapshotSqlSource } from "./recall-snapshot-sql.js";
export { RECALL_TRAVERSAL_SQL_SOURCE } from "./recall-traversal-sql.js";
export type { RecallTraversalSqlSource } from "./recall-traversal-sql.js";
export { RECALL_RANKING_SQL_SOURCE } from "./recall-ranking-sql.js";
export type { RecallRankingSqlSource } from "./recall-ranking-sql.js";

export {
  SqliteProjectionDispatcherError,
  createSqliteProjectionDispatcher,
} from "./projection-dispatcher.js";
export type {
  ProjectionDispatchMode,
  ProjectionDispatchReason,
  SqliteProjectionDispatcher,
  SqliteProjectionDispatcherDependencies,
  SqliteProjectionDispatcherErrorCode,
  SqliteProjectionDispatchReceipt,
} from "./projection-dispatcher.js";

export {
  JOURNAL_ID_COLLISION_ATTEMPT_LIMIT,
  JournalAppendError,
  createSqliteJournalRepository,
} from "./journal-repository.js";

export { createSqliteProjectionReplayService } from "./projection-replay.js";
export type {
  ProjectionReplayReason,
  SqliteProjectionCanonicalDump,
  SqliteProjectionReplayRequest,
  SqliteProjectionReplayResult,
  SqliteProjectionReplayService,
} from "./projection-replay.js";
export type {
  AppendOnlyJournalRepository,
  JournalAppendErrorCode,
  JournalAppendEventReceipt,
  JournalAppendIntent,
  JournalAppendReceipt,
  JournalEventKind,
  SqliteJournalRepositoryDependencies,
} from "./journal-repository.js";

export {
  RECALL_DB_PATH_ENV,
  SQLITE_STORAGE_PERMISSIONS,
  SqliteStartupError,
  createSqliteStartupGate,
  loadSqliteStartupConfig,
  runSqliteStartupGate,
} from "./startup-gate.js";
export type {
  SqliteCapabilities,
  SqliteCapabilityEvidence,
  SqliteCapabilityName,
  SqliteFilesystemEvidence,
  SqliteStartupConfig,
  SqliteStartupDependencyOverrides,
  SqliteStartupErrorCode,
  SqliteStartupGate,
  SqliteStartupReadiness,
  SqliteStoragePermissions,
} from "./startup-gate.js";

/**
 * STO-002 supplies the worker-backed transaction queue. STO-007 supplies the
 * concrete append/project executor that runs on it. The application port remains
 * asynchronous even though better-sqlite3 is synchronous inside its worker.
 */
export interface SqliteAtomicJournalExecutor<Intent, Receipt> {
  execute(events: NonEmptyReadonlyArray<Intent>): Promise<Receipt>;
}

export function createSqliteJournalCommitPort<Intent, Receipt>(
  executor: SqliteAtomicJournalExecutor<Intent, Receipt>,
): JournalCommitPort<Intent, Receipt> {
  return Object.freeze({
    appendAndProject(
      events: NonEmptyReadonlyArray<Intent>,
    ): Promise<Receipt> {
      return executor.execute(events);
    },
  });
}
