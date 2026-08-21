import { lstatSync } from "node:fs";
import { createRequire } from "node:module";
import { parentPort, workerData } from "node:worker_threads";

import {
  SQLITE_CONNECTION_POLICY,
  type SqliteAllResult,
  type SqliteBinding,
  type SqliteCommandResult,
  type SqliteConnectionErrorCode,
  type SqliteConnectionPolicy,
  type SqliteGetResult,
  type SqliteReadQuery,
  type SqliteReadResult,
  type SqliteRunResult,
  type SqliteTransactionCommand,
  type SqliteWorkerData,
  type SqliteWorkerRequest,
  type SqliteWorkerResponse,
} from "./connection-protocol.js";

interface SqliteRunMetadata {
  readonly changes: number;
  readonly lastInsertRowid: number | bigint;
}

interface SqliteStatement {
  run(...parameters: readonly SqliteBinding[]): SqliteRunMetadata;
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
  public readonly code: Exclude<SqliteConnectionErrorCode, "SQLITE_BUSY">;

  public constructor(code: Exclude<SqliteConnectionErrorCode, "SQLITE_BUSY">) {
    super(code);
    this.code = code;
  }
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
  fallback: Exclude<SqliteConnectionErrorCode, "SQLITE_BUSY">,
): SqliteConnectionErrorCode {
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
): void {
  if (request.type === "close") {
    try {
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
      handleRequest(database as SqliteDatabaseConnection, data, request);
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
