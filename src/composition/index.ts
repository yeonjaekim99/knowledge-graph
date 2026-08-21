import { JournalWriteService } from "../application/index.js";
import {
  createSqliteJournalCommitPort,
  type SqliteAtomicJournalExecutor,
} from "../adapters/sqlite/index.js";

/** Composition may wire adapters; it must not contain domain or application policy. */
export function composeJournalWriteService<Intent, Receipt>(
  executor: SqliteAtomicJournalExecutor<Intent, Receipt>,
): JournalWriteService<Intent, Receipt> {
  return new JournalWriteService(createSqliteJournalCommitPort(executor));
}
