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
  | "SQLITE_BUSY";

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

export interface SqliteWorkerQueryRequest {
  readonly type: "query";
  readonly requestId: number;
  readonly query: SqliteReadQuery;
}

export interface SqliteWorkerCloseRequest {
  readonly type: "close";
  readonly requestId: number;
}

export type SqliteWorkerRequest =
  | SqliteWorkerTransactionRequest
  | SqliteWorkerQueryRequest
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
  readonly code: SqliteConnectionErrorCode;
}

export type SqliteWorkerResponse =
  | SqliteWorkerReadyResponse
  | SqliteWorkerSuccessResponse
  | SqliteWorkerErrorResponse;

export function connectionErrorFromCode(
  code: SqliteConnectionErrorCode,
): SqliteConnectionError {
  return code === "SQLITE_BUSY"
    ? new SqliteBusyError()
    : new SqliteConnectionError(code);
}
