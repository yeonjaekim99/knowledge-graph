import type {
  JournalCommitPort,
  NonEmptyReadonlyArray,
} from "../../application/ports/journal-commit-port.js";

/**
 * STO-002/STO-007 supply the worker, connection, and transaction implementation.
 * Keeping that executor behind this adapter preserves an asynchronous application
 * port even though better-sqlite3 itself is synchronous.
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
