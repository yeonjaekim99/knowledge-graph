import { Worker } from "node:worker_threads";

import {
  SQLITE_CONNECTION_POLICY,
  SqliteConnectionError,
  connectionErrorFromCode,
  type SqliteBinding,
  type SqliteCommandResult,
  type SqliteConnectionPolicy,
  type SqliteReadQuery,
  type SqliteReadResult,
  type SqliteTransactionCommand,
  type SqliteWorkerResponse,
  type SqliteWorkerRole,
} from "./connection-protocol.js";
import type { SqliteStartupReadiness } from "./startup-gate.js";

interface PendingWorkerRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: SqliteConnectionError) => void;
}

type WorkerClientState = "opening" | "open" | "closing" | "closed" | "failed";
const activeWriterPaths: Set<string> = new Set();

function invalidCommand(
  code: "INVALID_TRANSACTION_PROGRAM" | "SQLITE_QUERY_FAILED",
): never {
  throw new SqliteConnectionError(code);
}

function snapshotBinding(
  value: unknown,
  errorCode: "INVALID_TRANSACTION_PROGRAM" | "SQLITE_QUERY_FAILED",
): SqliteBinding {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "bigint" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (value instanceof Uint8Array) {
    return value.slice();
  }
  return invalidCommand(errorCode);
}

function snapshotParameters(
  value: unknown,
  errorCode: "INVALID_TRANSACTION_PROGRAM" | "SQLITE_QUERY_FAILED",
): readonly SqliteBinding[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    return invalidCommand(errorCode);
  }
  return Object.freeze(
    value.map((binding) => snapshotBinding(binding, errorCode)),
  );
}

function snapshotCommand(
  value: unknown,
  errorCode: "INVALID_TRANSACTION_PROGRAM" | "SQLITE_QUERY_FAILED",
): SqliteTransactionCommand {
  if (
    value === null ||
    typeof value !== "object" ||
    !("kind" in value) ||
    !("sql" in value) ||
    typeof value.sql !== "string" ||
    value.sql.trim().length === 0
  ) {
    return invalidCommand(errorCode);
  }
  if (value.kind === "exec") {
    return Object.freeze({ kind: "exec", sql: value.sql });
  }
  if (value.kind !== "run" && value.kind !== "get" && value.kind !== "all") {
    return invalidCommand(errorCode);
  }
  const parameters = snapshotParameters(
    "parameters" in value ? value.parameters : undefined,
    errorCode,
  );
  return parameters === undefined
    ? Object.freeze({ kind: value.kind, sql: value.sql })
    : Object.freeze({ kind: value.kind, sql: value.sql, parameters });
}

function snapshotReadQuery(value: unknown): SqliteReadQuery {
  const command = snapshotCommand(value, "SQLITE_QUERY_FAILED");
  if (command.kind !== "get" && command.kind !== "all") {
    return invalidCommand("SQLITE_QUERY_FAILED");
  }
  return command;
}

class SqliteWorkerClient {
  readonly #worker: Worker;
  readonly #pending: Map<number, PendingWorkerRequest> = new Map();
  readonly #ready: Promise<void>;
  #resolveReady!: () => void;
  #rejectReady!: (error: SqliteConnectionError) => void;
  #nextRequestId: number = 1;
  #state: WorkerClientState = "opening";
  #configuration: SqliteConnectionPolicy | null = null;
  #closePromise: Promise<void> | null = null;

  public constructor(role: SqliteWorkerRole, databasePath: string) {
    this.#ready = new Promise<void>((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });
    this.#worker = new Worker(new URL("./connection-worker.js", import.meta.url), {
      workerData: Object.freeze({ role, databasePath }),
    });
    this.#worker.on("message", (message: unknown) => {
      this.#handleMessage(message);
    });
    this.#worker.on("error", () => {
      this.#failWorker();
    });
    this.#worker.on("exit", () => {
      if (this.#state === "closing" || this.#state === "closed") {
        this.#state = "closed";
        return;
      }
      this.#failWorker();
    });
  }

  public async initialize(): Promise<void> {
    await this.#ready;
  }

  public get configuration(): SqliteConnectionPolicy {
    if (this.#configuration === null) {
      throw new SqliteConnectionError("SQLITE_CONNECTION_FAILED");
    }
    return this.#configuration;
  }

  public transaction(
    commands: readonly SqliteTransactionCommand[],
  ): Promise<readonly SqliteCommandResult[]> {
    return this.#request({ type: "transaction", commands }) as Promise<
      readonly SqliteCommandResult[]
    >;
  }

  public query(query: SqliteReadQuery): Promise<SqliteReadResult> {
    return this.#request({ type: "query", query }) as Promise<SqliteReadResult>;
  }

  public close(): Promise<void> {
    if (this.#closePromise !== null) {
      return this.#closePromise;
    }
    if (this.#state === "closed" || this.#state === "failed") {
      return Promise.resolve();
    }

    const response = this.#request({ type: "close" });
    this.#state = "closing";
    this.#closePromise = (async (): Promise<void> => {
      try {
        await response;
      } finally {
        await this.#worker.terminate();
        this.#state = "closed";
      }
    })();
    return this.#closePromise;
  }

  #request(
    operation:
      | {
          readonly type: "transaction";
          readonly commands: readonly SqliteTransactionCommand[];
        }
      | { readonly type: "query"; readonly query: SqliteReadQuery }
      | { readonly type: "close" },
  ): Promise<unknown> {
    if (this.#state !== "open") {
      return Promise.reject(new SqliteConnectionError("CONNECTION_CLOSED"));
    }
    const requestId = this.#nextRequestId;
    this.#nextRequestId += 1;
    return new Promise<unknown>((resolve, reject) => {
      this.#pending.set(requestId, { resolve, reject });
      this.#worker.postMessage({ ...operation, requestId });
    });
  }

  #handleMessage(message: unknown): void {
    if (message === null || typeof message !== "object" || !("type" in message)) {
      this.#failWorker();
      return;
    }
    const response = message as SqliteWorkerResponse;
    if (response.type === "ready") {
      if (this.#state !== "opening") {
        this.#failWorker();
        return;
      }
      this.#configuration = Object.freeze({ ...response.configuration });
      this.#state = "open";
      this.#resolveReady();
      return;
    }
    if (response.type === "failure" && response.requestId === null) {
      const error = connectionErrorFromCode(response.code);
      this.#state = "failed";
      this.#rejectReady(error);
      this.#rejectPending(error);
      return;
    }
    if (!("requestId" in response) || response.requestId === null) {
      this.#failWorker();
      return;
    }
    const pending = this.#pending.get(response.requestId);
    if (pending === undefined) {
      this.#failWorker();
      return;
    }
    this.#pending.delete(response.requestId);
    if (response.type === "failure") {
      pending.reject(connectionErrorFromCode(response.code));
    } else {
      pending.resolve(response.result);
    }
  }

  #rejectPending(error: SqliteConnectionError): void {
    for (const pending of this.#pending.values()) {
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #failWorker(): void {
    if (this.#state === "closed" || this.#state === "failed") {
      return;
    }
    const error = new SqliteConnectionError("SQLITE_WORKER_FAILED");
    if (this.#state === "opening") {
      this.#rejectReady(error);
    }
    this.#state = "failed";
    this.#rejectPending(error);
  }
}

export interface SqliteReaderConnection {
  readonly configuration: SqliteConnectionPolicy;
  query(query: SqliteReadQuery): Promise<SqliteReadResult>;
  close(): Promise<void>;
}

class SqliteReaderConnectionImplementation implements SqliteReaderConnection {
  readonly #client: SqliteWorkerClient;
  readonly configuration: SqliteConnectionPolicy;
  #closed: boolean = false;

  public constructor(client: SqliteWorkerClient) {
    this.#client = client;
    this.configuration = client.configuration;
  }

  public query(query: SqliteReadQuery): Promise<SqliteReadResult> {
    if (this.#closed) {
      return Promise.reject(new SqliteConnectionError("CONNECTION_CLOSED"));
    }
    try {
      return this.#client.query(snapshotReadQuery(query));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  public close(): Promise<void> {
    if (this.#closed) {
      return Promise.resolve();
    }
    this.#closed = true;
    return this.#client.close();
  }
}

export interface SqliteConnectionFactory {
  readonly writerConfiguration: SqliteConnectionPolicy;
  enqueueWriteTransaction(
    commands: readonly SqliteTransactionCommand[],
  ): Promise<readonly SqliteCommandResult[]>;
  openReader(): Promise<SqliteReaderConnection>;
  close(): Promise<void>;
}

class SqliteConnectionFactoryImplementation implements SqliteConnectionFactory {
  readonly #readiness: SqliteStartupReadiness;
  readonly #writer: SqliteWorkerClient;
  readonly #readers: Set<SqliteReaderConnection> = new Set();
  readonly #readerOpenings: Set<Promise<SqliteReaderConnection>> = new Set();
  readonly #releaseWriterPath: () => void;
  readonly writerConfiguration: SqliteConnectionPolicy;
  #accepting: boolean = true;
  #writeTail: Promise<void> = Promise.resolve();
  #closePromise: Promise<void> | null = null;

  public constructor(
    readiness: SqliteStartupReadiness,
    writer: SqliteWorkerClient,
    releaseWriterPath: () => void,
  ) {
    this.#readiness = readiness;
    this.#writer = writer;
    this.#releaseWriterPath = releaseWriterPath;
    this.writerConfiguration = writer.configuration;
  }

  public enqueueWriteTransaction(
    commands: readonly SqliteTransactionCommand[],
  ): Promise<readonly SqliteCommandResult[]> {
    if (!this.#accepting) {
      return Promise.reject(
        new SqliteConnectionError("CONNECTION_FACTORY_CLOSED"),
      );
    }
    if (!Array.isArray(commands) || commands.length === 0) {
      return Promise.reject(
        new SqliteConnectionError("INVALID_TRANSACTION_PROGRAM"),
      );
    }

    let snapshot: readonly SqliteTransactionCommand[];
    try {
      snapshot = Object.freeze(
        commands.map((command) =>
          snapshotCommand(command, "INVALID_TRANSACTION_PROGRAM"),
        ),
      );
    } catch (error) {
      return Promise.reject(error);
    }

    const operation = this.#writeTail.then(() => this.#writer.transaction(snapshot));
    this.#writeTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  public async openReader(): Promise<SqliteReaderConnection> {
    if (!this.#accepting) {
      throw new SqliteConnectionError("CONNECTION_FACTORY_CLOSED");
    }
    const opening = openSqliteReader(this.#readiness);
    this.#readerOpenings.add(opening);
    try {
      const reader = await opening;
      if (!this.#accepting) {
        await reader.close();
        throw new SqliteConnectionError("CONNECTION_FACTORY_CLOSED");
      }
      this.#readers.add(reader);
      return reader;
    } finally {
      this.#readerOpenings.delete(opening);
    }
  }

  public close(): Promise<void> {
    if (this.#closePromise !== null) {
      return this.#closePromise;
    }
    this.#accepting = false;
    this.#closePromise = (async (): Promise<void> => {
      await this.#writeTail;
      await Promise.allSettled(this.#readerOpenings);
      const readerCloseResults = await Promise.allSettled(
        [...this.#readers].map((reader) => reader.close()),
      );
      this.#readers.clear();
      let closeError: SqliteConnectionError | null = null;
      const failedReader = readerCloseResults.find(
        (result) => result.status === "rejected",
      );
      if (failedReader?.status === "rejected") {
        closeError =
          failedReader.reason instanceof SqliteConnectionError
            ? failedReader.reason
            : new SqliteConnectionError("SQLITE_WORKER_FAILED");
      }
      try {
        await this.#writer.close();
      } catch (error) {
        closeError =
          error instanceof SqliteConnectionError
            ? error
            : new SqliteConnectionError("SQLITE_WORKER_FAILED");
      } finally {
        this.#releaseWriterPath();
      }
      if (closeError !== null) {
        throw closeError;
      }
    })();
    return this.#closePromise;
  }
}

async function openWorker(
  role: SqliteWorkerRole,
  readiness: SqliteStartupReadiness,
): Promise<SqliteWorkerClient> {
  const client = new SqliteWorkerClient(role, readiness.databasePath);
  try {
    await client.initialize();
    return client;
  } catch (error) {
    await client.close();
    throw error;
  }
}

export async function openSqliteReader(
  readiness: SqliteStartupReadiness,
): Promise<SqliteReaderConnection> {
  const client = await openWorker("reader", readiness);
  return new SqliteReaderConnectionImplementation(client);
}

export async function createSqliteConnectionFactory(
  readiness: SqliteStartupReadiness,
): Promise<SqliteConnectionFactory> {
  const databasePath = readiness.databasePath;
  if (activeWriterPaths.has(databasePath)) {
    throw new SqliteConnectionError("WRITER_ALREADY_ACTIVE");
  }
  activeWriterPaths.add(databasePath);
  let released = false;
  const releaseWriterPath = (): void => {
    if (!released) {
      released = true;
      activeWriterPaths.delete(databasePath);
    }
  };

  try {
    const writer = await openWorker("writer", readiness);
    return new SqliteConnectionFactoryImplementation(
      readiness,
      writer,
      releaseWriterPath,
    );
  } catch (error) {
    releaseWriterPath();
    throw error;
  }
}
