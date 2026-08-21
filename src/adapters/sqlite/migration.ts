import { createHash } from "node:crypto";

import {
  enqueueSqliteMigrationOperation,
  type SqliteConnectionFactory,
} from "./connection-factory.js";
import {
  SqliteMigrationError,
  type SqliteMigrationExecutionResult,
  type SqlitePreparedMigration,
} from "./connection-protocol.js";

export interface SqliteMigration {
  readonly version: number;
  readonly name: string;
  readonly source: Uint8Array;
}

export interface SqliteMigrationOptions {
  readonly appliedAtSeconds: number;
}

export interface SqliteMigrationResult {
  readonly appliedVersions: readonly number[];
  readonly currentVersion: number;
}

const TRANSACTION_CONTROL_KEYWORDS: ReadonlySet<string> = new Set([
  "BEGIN",
  "COMMIT",
  "END",
  "ROLLBACK",
  "SAVEPOINT",
  "RELEASE",
]);
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function invalidBundle(): never {
  throw new SqliteMigrationError("MIGRATION_BUNDLE_INVALID");
}

function containsTransactionControl(sql: string): boolean {
  let index = 0;
  let atStatementStart = true;
  let statementStartsWithCreate = false;
  let creatingTrigger = false;
  let insideTriggerBody = false;
  let triggerCaseDepth = 0;
  while (index < sql.length) {
    const character = sql[index];
    const next = sql[index + 1];

    if (character === "'" || character === '"' || character === "`") {
      const quote = character;
      index += 1;
      while (index < sql.length) {
        if (sql[index] === quote) {
          if (sql[index + 1] === quote) {
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    if (character === "[") {
      index += 1;
      while (index < sql.length && sql[index] !== "]") {
        index += 1;
      }
      index += 1;
      continue;
    }
    if (character === "-" && next === "-") {
      const lineEnd = sql.indexOf("\n", index + 2);
      index = lineEnd < 0 ? sql.length : lineEnd + 1;
      continue;
    }
    if (character === "/" && next === "*") {
      const commentEnd = sql.indexOf("*/", index + 2);
      index = commentEnd < 0 ? sql.length : commentEnd + 2;
      continue;
    }
    if (character === ";") {
      if (!insideTriggerBody) {
        atStatementStart = true;
        statementStartsWithCreate = false;
        creatingTrigger = false;
      }
      index += 1;
      continue;
    }
    if (character !== undefined && /[A-Za-z]/u.test(character)) {
      const start = index;
      index += 1;
      while (index < sql.length && /[A-Za-z_]/u.test(sql[index] ?? "")) {
        index += 1;
      }
      const keyword = sql.slice(start, index).toUpperCase();
      if (insideTriggerBody) {
        if (keyword === "CASE") {
          triggerCaseDepth += 1;
        } else if (keyword === "END") {
          if (triggerCaseDepth > 0) {
            triggerCaseDepth -= 1;
          } else {
            insideTriggerBody = false;
          }
        }
        continue;
      }
      if (atStatementStart) {
        if (TRANSACTION_CONTROL_KEYWORDS.has(keyword)) {
          return true;
        }
        atStatementStart = false;
        statementStartsWithCreate = keyword === "CREATE";
        continue;
      }
      if (statementStartsWithCreate && keyword === "TRIGGER") {
        creatingTrigger = true;
      } else if (creatingTrigger && keyword === "BEGIN") {
        insideTriggerBody = true;
        triggerCaseDepth = 0;
      }
      continue;
    }
    index += 1;
  }
  return false;
}

function prepareMigrations(
  migrations: readonly SqliteMigration[],
  options: SqliteMigrationOptions,
): readonly SqlitePreparedMigration[] {
  if (
    !Array.isArray(migrations) ||
    options === null ||
    typeof options !== "object" ||
    !Number.isSafeInteger(options.appliedAtSeconds) ||
    options.appliedAtSeconds < 0
  ) {
    return invalidBundle();
  }

  const names = new Set<string>();
  const prepared = migrations.map((migration) => {
    if (
      migration === null ||
      typeof migration !== "object" ||
      !Number.isSafeInteger(migration.version) ||
      migration.version <= 0 ||
      typeof migration.name !== "string" ||
      migration.name.length === 0 ||
      migration.name.trim() !== migration.name ||
      migration.name.includes("\0") ||
      !(migration.source instanceof Uint8Array)
    ) {
      return invalidBundle();
    }
    if (names.has(migration.name)) {
      return invalidBundle();
    }
    names.add(migration.name);

    const source = migration.source.slice();
    let sql: string;
    try {
      sql = utf8Decoder.decode(source);
    } catch {
      return invalidBundle();
    }
    if (sql.trim().length === 0 || containsTransactionControl(sql)) {
      return invalidBundle();
    }

    return Object.freeze({
      version: migration.version,
      name: migration.name,
      checksum: createHash("sha256").update(source).digest("hex"),
      sql,
      appliedAtSeconds: options.appliedAtSeconds,
    });
  });

  prepared.sort((left, right) => left.version - right.version);
  if (prepared.some((migration, index) => migration.version !== index + 1)) {
    return invalidBundle();
  }
  return Object.freeze(prepared);
}

function freezeResult(
  result: SqliteMigrationExecutionResult,
): SqliteMigrationResult {
  return Object.freeze({
    appliedVersions: Object.freeze([...result.appliedVersions]),
    currentVersion: result.currentVersion,
  });
}

export async function runSqliteMigrations(
  factory: SqliteConnectionFactory,
  migrations: readonly SqliteMigration[],
  options: SqliteMigrationOptions,
): Promise<SqliteMigrationResult> {
  const prepared = prepareMigrations(migrations, options);
  return freezeResult(await enqueueSqliteMigrationOperation(factory, prepared));
}
