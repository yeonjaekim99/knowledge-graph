import { createRequire } from "node:module";
import { chmodSync, existsSync } from "node:fs";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const databasePath = process.argv[2];
const faultPoint = process.argv[3];
const CRASH_EVENT_ID = `ev_${"0".repeat(25)}2`;
const CRASH_BODY = JSON.stringify({ raw_text: "장애복구 커밋 문장", parsed: [] });

if (
  typeof databasePath !== "string" ||
  databasePath.length === 0 ||
  !["before-journal-insert", "after-journal-insert", "after-commit"].includes(
    faultPoint,
  ) ||
  process.send === undefined
) {
  process.exit(2);
}

function secureSidecars() {
  if (process.platform === "win32") {
    return;
  }
  for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    if (existsSync(path)) {
      chmodSync(path, 0o600);
    }
  }
}

function localCounts(database) {
  return {
    journalCount: database.prepare("SELECT COUNT(*) AS count FROM journal").get().count,
    ftsCount: database.prepare("SELECT COUNT(*) AS count FROM journal_fts").get().count,
  };
}

process.umask(0o077);
const database = new Database(databasePath, { fileMustExist: true });
database.pragma("journal_mode = WAL");
database.pragma("synchronous = NORMAL");
database.pragma("busy_timeout = 5000");
database.pragma("foreign_keys = ON");
database.exec("BEGIN IMMEDIATE");

if (faultPoint === "before-journal-insert") {
  secureSidecars();
  process.send({ type: "fault-ready", faultPoint, ...localCounts(database) });
} else {
  database
    .prepare(
      "INSERT INTO journal(id, scope_key, kind, body, actor, branch, session, created_at) VALUES (?, ?, 'statement', ?, ?, ?, NULL, ?)",
    )
    .run(
      CRASH_EVENT_ID,
      "u:crash-user/p:sto-008",
      CRASH_BODY,
      "crash-worker",
      "sto-008",
      1_700_000_001,
    );
  if (faultPoint === "after-commit") {
    database.exec("COMMIT");
  }
  secureSidecars();
  process.send({ type: "fault-ready", faultPoint, ...localCounts(database) });
}

setInterval(() => undefined, 1_000);
