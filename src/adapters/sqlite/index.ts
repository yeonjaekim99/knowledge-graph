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
  SQLITE_CONNECTION_POLICY,
  SqliteBusyError,
  SqliteConnectionError,
} from "./connection-protocol.js";
export type {
  SqliteAllCommand,
  SqliteAllResult,
  SqliteBinding,
  SqliteCommandResult,
  SqliteConnectionErrorCode,
  SqliteConnectionPolicy,
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
