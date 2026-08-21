import { createRequire } from "node:module";
import { chmodSync, existsSync } from "node:fs";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const databasePath = process.argv[2];

if (
  typeof databasePath !== "string" ||
  databasePath.length === 0 ||
  process.send === undefined
) {
  process.exit(2);
}

process.umask(0o077);
const database = new Database(databasePath);
database.pragma("journal_mode = WAL");
database.pragma("synchronous = NORMAL");
database.exec("BEGIN IMMEDIATE");
database.exec(`
  CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    checksum TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  );
  CREATE TABLE crash_probe(id INTEGER PRIMARY KEY, value TEXT NOT NULL);
  INSERT INTO crash_probe(id, value) VALUES (1, 'uncommitted');
  INSERT INTO schema_migrations(version, name, checksum, applied_at)
    VALUES (1, 'crash_probe', '${"f".repeat(64)}', 1700000000);
`);

if (process.platform !== "win32") {
  for (const path of [
    databasePath,
    `${databasePath}-wal`,
    `${databasePath}-shm`,
  ]) {
    if (existsSync(path)) {
      chmodSync(path, 0o600);
    }
  }
}

process.send({ type: "migration-transaction-open" });
setInterval(() => undefined, 1_000);
