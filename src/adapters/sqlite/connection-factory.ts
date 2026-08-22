import { Worker } from "node:worker_threads";

import type { ProjectionSnapshot } from "../../domain/projection-replay.js";

import {
  SQLITE_CONNECTION_POLICY,
  SqliteConnectionError,
  SqliteMigrationError,
  connectionErrorFromCode,
  type SqliteBinding,
  type SqliteCommandResult,
  type SqliteConnectionPolicy,
  type SqliteMigrationExecutionResult,
  type SqlitePreparedMigration,
  type SqliteProjectionDispatchAppendEvent,
  type SqliteProjectionDispatchBeginResult,
  type SqliteProjectionDispatchCommitResult,
  type SqliteProjectionDispatchPrepareResult,
  type SqliteProjectionPublishMode,
  type SqliteProjectionReplayBeginResult,
  type SqliteProjectionReplayCommitResult,
  type SqliteReadQuery,
  type SqliteReadResult,
  type SqliteRecallAggregateRowsResult,
  type SqliteRecallFtsRowsResult,
  type SqliteRecallOverviewRowsResult,
  type SqliteRecallRankingCandidate,
  type SqliteRecallRankingRowsResult,
  type SqliteRecallSnapshotBeginResult,
  type SqliteRecallSurfaceStateRowsResult,
  type SqliteRecallTraversalStateRowsResult,
  type SqliteTransactionCommand,
  type SqliteWriteEntityDraftInput,
  type SqliteWriteEntityDraftResolution,
  type SqliteWriteEntityFinalizationResult,
  type SqliteWorkerResponse,
  type SqliteWorkerRole,
} from "./connection-protocol.js";
import type { SqliteStartupReadiness } from "./startup-gate.js";

interface PendingWorkerRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: SqliteConnectionError | SqliteMigrationError) => void;
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

function snapshotRecallSurfaceNorms(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 10) {
    return invalidCommand("SQLITE_QUERY_FAILED");
  }
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0) {
      return invalidCommand("SQLITE_QUERY_FAILED");
    }
    result.push(item);
  }
  return Object.freeze(result);
}

function snapshotRecallEntityId(value: unknown): string {
  if (typeof value !== "string" || !/^e[1-9][0-9]*\.[0-9]+$/u.test(value)) {
    return invalidCommand("SQLITE_QUERY_FAILED");
  }
  return value;
}

function snapshotRecallRankingCandidates(
  value: unknown,
): readonly SqliteRecallRankingCandidate[] {
  if (!Array.isArray(value)) {
    return invalidCommand("SQLITE_QUERY_FAILED");
  }
  const seen = new Set<string>();
  const result: SqliteRecallRankingCandidate[] = [];
  for (const item of value) {
    if (
      item === null ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      !("claimId" in item) ||
      !("depth" in item) ||
      typeof item.claimId !== "string" ||
      !/^c[1-9][0-9]*\.[0-9]+$/u.test(item.claimId) ||
      !Number.isSafeInteger(item.depth) ||
      Number(item.depth) < 0 ||
      Number(item.depth) > 3 ||
      seen.has(item.claimId)
    ) {
      return invalidCommand("SQLITE_QUERY_FAILED");
    }
    seen.add(item.claimId);
    result.push(Object.freeze({
      claimId: item.claimId,
      depth: Number(item.depth),
    }));
  }
  return Object.freeze(result);
}

class SqliteWorkerClient {
  readonly #worker: Worker;
  readonly #pending: Map<number, PendingWorkerRequest> = new Map();
  readonly #ready: Promise<void>;
  #resolveReady!: () => void;
  #rejectReady!: (error: SqliteConnectionError | SqliteMigrationError) => void;
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

  public migrate(
    migrations: readonly SqlitePreparedMigration[],
  ): Promise<SqliteMigrationExecutionResult> {
    return this.#request({ type: "migrate", migrations }) as Promise<
      SqliteMigrationExecutionResult
    >;
  }

  public query(query: SqliteReadQuery): Promise<SqliteReadResult> {
    return this.#request({ type: "query", query }) as Promise<SqliteReadResult>;
  }

  public beginRecallSnapshot(
    scopeKey: string,
    evaluationNow: number,
  ): Promise<SqliteRecallSnapshotBeginResult> {
    return this.#request({
      type: "recall-snapshot-begin",
      scopeKey,
      evaluationNow,
    }) as Promise<SqliteRecallSnapshotBeginResult>;
  }

  public readRecallSnapshot(
    snapshotId: number,
  ): Promise<SqliteRecallAggregateRowsResult> {
    return this.#request({
      type: "recall-snapshot-read",
      snapshotId,
    }) as Promise<SqliteRecallAggregateRowsResult>;
  }

  public readRecallSurfaceState(
    snapshotId: number,
    surfaceNorms: readonly string[],
  ): Promise<SqliteRecallSurfaceStateRowsResult> {
    return this.#request({
      type: "recall-snapshot-surface",
      snapshotId,
      surfaceNorms: snapshotRecallSurfaceNorms(surfaceNorms),
    }) as Promise<SqliteRecallSurfaceStateRowsResult>;
  }

  public searchRecallSnapshotFts(
    snapshotId: number,
    matchExpression: string,
    phraseLiterals: readonly string[],
  ): Promise<SqliteRecallFtsRowsResult> {
    return this.#request({
      type: "recall-snapshot-fts",
      snapshotId,
      matchExpression,
      phraseLiterals,
    }) as Promise<SqliteRecallFtsRowsResult>;
  }

  public readRecallSnapshotOverview(
    snapshotId: number,
    limit: number,
  ): Promise<SqliteRecallOverviewRowsResult> {
    return this.#request({
      type: "recall-snapshot-overview",
      snapshotId,
      limit,
    }) as Promise<SqliteRecallOverviewRowsResult>;
  }

  public readRecallTraversalState(
    snapshotId: number,
    entityId: string,
  ): Promise<SqliteRecallTraversalStateRowsResult> {
    return this.#request({
      type: "recall-snapshot-traversal",
      snapshotId,
      entityId: snapshotRecallEntityId(entityId),
    }) as Promise<SqliteRecallTraversalStateRowsResult>;
  }

  public readRecallRankingRows(
    snapshotId: number,
    candidates: readonly SqliteRecallRankingCandidate[],
    probeLimit: number,
  ): Promise<SqliteRecallRankingRowsResult> {
    return this.#request({
      type: "recall-snapshot-ranking",
      snapshotId,
      candidates: snapshotRecallRankingCandidates(candidates),
      probeLimit,
    }) as Promise<SqliteRecallRankingRowsResult>;
  }

  public endRecallSnapshot(
    snapshotId: number,
    commit: boolean,
  ): Promise<void> {
    return this.#request({
      type: "recall-snapshot-end",
      snapshotId,
      commit,
    }) as Promise<void>;
  }

  public beginProjectionReplay(
    scopeKey: string,
  ): Promise<SqliteProjectionReplayBeginResult> {
    return this.#request({
      type: "projection-replay-begin",
      scopeKey,
    }) as Promise<SqliteProjectionReplayBeginResult>;
  }

  public commitProjectionReplay(
    replayId: number,
    rulesVersion: string,
    rebuiltAt: number,
    snapshot: ProjectionSnapshot,
  ): Promise<SqliteProjectionReplayCommitResult> {
    return this.#request({
      type: "projection-replay-commit",
      replayId,
      rulesVersion,
      rebuiltAt,
      snapshot,
    }) as Promise<SqliteProjectionReplayCommitResult>;
  }

  public rollbackProjectionReplay(replayId: number): Promise<void> {
    return this.#request({
      type: "projection-replay-rollback",
      replayId,
    }) as Promise<void>;
  }

  public beginProjectionDispatch(
    scopeKey: string,
    events: readonly SqliteProjectionDispatchAppendEvent[],
  ): Promise<SqliteProjectionDispatchBeginResult> {
    return this.#request({
      type: "projection-dispatch-begin",
      scopeKey,
      events,
    }) as Promise<SqliteProjectionDispatchBeginResult>;
  }

  public prepareProjectionDispatch(
    scopeKey: string,
  ): Promise<SqliteProjectionDispatchPrepareResult> {
    return this.#request({
      type: "projection-dispatch-prepare",
      scopeKey,
    }) as Promise<SqliteProjectionDispatchPrepareResult>;
  }

  public resolveProjectionDispatchEntities(
    dispatchId: number,
    drafts: readonly SqliteWriteEntityDraftInput[],
  ): Promise<readonly SqliteWriteEntityDraftResolution[]> {
    return this.#request({
      type: "projection-dispatch-resolve-entities",
      dispatchId,
      drafts,
    }) as Promise<readonly SqliteWriteEntityDraftResolution[]>;
  }

  public finalizeProjectionDispatchEntities(
    dispatchId: number,
    survivorDraftIndexes: readonly number[],
    statementBodyJson: string,
  ): Promise<SqliteWriteEntityFinalizationResult> {
    return this.#request({
      type: "projection-dispatch-finalize-entities",
      dispatchId,
      survivorDraftIndexes,
      statementBodyJson,
    }) as Promise<SqliteWriteEntityFinalizationResult>;
  }

  public appendProjectionDispatch(
    dispatchId: number,
    events: readonly SqliteProjectionDispatchAppendEvent[],
  ): Promise<SqliteProjectionDispatchBeginResult> {
    return this.#request({
      type: "projection-dispatch-append",
      dispatchId,
      events,
    }) as Promise<SqliteProjectionDispatchBeginResult>;
  }

  public commitProjectionDispatch(
    dispatchId: number,
    mode: SqliteProjectionPublishMode,
    rulesVersion: string,
    rebuiltAt: number,
    snapshot: ProjectionSnapshot,
  ): Promise<SqliteProjectionDispatchCommitResult> {
    return this.#request({
      type: "projection-dispatch-commit",
      dispatchId,
      mode,
      rulesVersion,
      rebuiltAt,
      snapshot,
    }) as Promise<SqliteProjectionDispatchCommitResult>;
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
      | {
          readonly type: "migrate";
          readonly migrations: readonly SqlitePreparedMigration[];
        }
      | {
          readonly type: "projection-replay-begin";
          readonly scopeKey: string;
        }
      | {
          readonly type: "projection-replay-commit";
          readonly replayId: number;
          readonly rulesVersion: string;
          readonly rebuiltAt: number;
          readonly snapshot: ProjectionSnapshot;
        }
      | {
          readonly type: "projection-replay-rollback";
          readonly replayId: number;
        }
      | {
          readonly type: "projection-dispatch-begin";
          readonly scopeKey: string;
          readonly events: readonly SqliteProjectionDispatchAppendEvent[];
        }
      | {
          readonly type: "projection-dispatch-prepare";
          readonly scopeKey: string;
        }
      | {
          readonly type: "projection-dispatch-resolve-entities";
          readonly dispatchId: number;
          readonly drafts: readonly SqliteWriteEntityDraftInput[];
        }
      | {
          readonly type: "projection-dispatch-finalize-entities";
          readonly dispatchId: number;
          readonly survivorDraftIndexes: readonly number[];
          readonly statementBodyJson: string;
        }
      | {
          readonly type: "projection-dispatch-append";
          readonly dispatchId: number;
          readonly events: readonly SqliteProjectionDispatchAppendEvent[];
        }
      | {
          readonly type: "projection-dispatch-commit";
          readonly dispatchId: number;
          readonly mode: SqliteProjectionPublishMode;
          readonly rulesVersion: string;
          readonly rebuiltAt: number;
          readonly snapshot: ProjectionSnapshot;
        }
      | { readonly type: "query"; readonly query: SqliteReadQuery }
      | {
          readonly type: "recall-snapshot-begin";
          readonly scopeKey: string;
          readonly evaluationNow: number;
        }
      | {
          readonly type: "recall-snapshot-read";
          readonly snapshotId: number;
        }
      | {
          readonly type: "recall-snapshot-surface";
          readonly snapshotId: number;
          readonly surfaceNorms: readonly string[];
        }
      | {
          readonly type: "recall-snapshot-fts";
          readonly snapshotId: number;
          readonly matchExpression: string;
          readonly phraseLiterals: readonly string[];
        }
      | {
          readonly type: "recall-snapshot-overview";
          readonly snapshotId: number;
          readonly limit: number;
        }
      | {
          readonly type: "recall-snapshot-traversal";
          readonly snapshotId: number;
          readonly entityId: string;
        }
      | {
          readonly type: "recall-snapshot-ranking";
          readonly snapshotId: number;
          readonly candidates: readonly SqliteRecallRankingCandidate[];
          readonly probeLimit: number;
        }
      | {
          readonly type: "recall-snapshot-end";
          readonly snapshotId: number;
          readonly commit: boolean;
        }
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

  #rejectPending(error: SqliteConnectionError | SqliteMigrationError): void {
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
  #onClose: (() => void) | null;
  #closed: boolean = false;
  #closePromise: Promise<void> | null = null;

  public constructor(client: SqliteWorkerClient, onClose?: () => void) {
    this.#client = client;
    this.#onClose = onClose ?? null;
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
    if (this.#closePromise !== null) {
      return this.#closePromise;
    }
    this.#closed = true;
    this.#closePromise = this.#client.close().finally(() => {
      const onClose = this.#onClose;
      this.#onClose = null;
      onClose?.();
    });
    return this.#closePromise;
  }

  public async withRecallSnapshot<Result>(
    scopeKey: string,
    evaluationNow: number,
    operation: SqliteRecallSnapshotOperation<Result>,
  ): Promise<Result> {
    if (this.#closed || typeof operation !== "function") {
      throw new SqliteConnectionError(
        this.#closed ? "CONNECTION_CLOSED" : "RECALL_SNAPSHOT_FAILED",
      );
    }

    const started = await this.#client.beginRecallSnapshot(
      scopeKey,
      evaluationNow,
    );
    let active = true;
    const source: SqliteRecallSnapshotSource = Object.freeze({
      assertActive: () => {
        if (!active) {
          throw new SqliteConnectionError("RECALL_SNAPSHOT_FAILED");
        }
      },
      listRawAggregateRows: async () => {
        if (!active) {
          throw new SqliteConnectionError("RECALL_SNAPSHOT_FAILED");
        }
        const result = await this.#client.readRecallSnapshot(
          started.snapshotId,
        );
        return result.rows;
      },
      readRawSurfaceState: async (surfaceNorms: readonly string[]) => {
        if (!active) {
          throw new SqliteConnectionError("RECALL_SNAPSHOT_FAILED");
        }
        return this.#client.readRecallSurfaceState(
          started.snapshotId,
          surfaceNorms,
        );
      },
      searchRawFtsRows: async (
        matchExpression: string,
        phraseLiterals: readonly string[],
      ) => {
        if (!active) {
          throw new SqliteConnectionError("RECALL_SNAPSHOT_FAILED");
        }
        return this.#client.searchRecallSnapshotFts(
          started.snapshotId,
          matchExpression,
          phraseLiterals,
        );
      },
      readRawOverviewState: async (limit: number) => {
        if (!active) {
          throw new SqliteConnectionError("RECALL_SNAPSHOT_FAILED");
        }
        return this.#client.readRecallSnapshotOverview(
          started.snapshotId,
          limit,
        );
      },
      readRawTraversalState: async (entityId: string) => {
        if (!active) {
          throw new SqliteConnectionError("RECALL_SNAPSHOT_FAILED");
        }
        return this.#client.readRecallTraversalState(
          started.snapshotId,
          entityId,
        );
      },
      readRawRankingRows: async (
        candidates: readonly SqliteRecallRankingCandidate[],
        probeLimit: number,
      ) => {
        if (!active) {
          throw new SqliteConnectionError("RECALL_SNAPSHOT_FAILED");
        }
        return this.#client.readRecallRankingRows(
          started.snapshotId,
          candidates,
          probeLimit,
        );
      },
    });

    try {
      const result = await operation(source);
      await this.#client.endRecallSnapshot(started.snapshotId, true);
      active = false;
      return result;
    } catch (error) {
      if (active) {
        active = false;
        try {
          await this.#client.endRecallSnapshot(started.snapshotId, false);
        } catch {
          // Preserve the safe primary operation error; close owns final cleanup.
        }
      }
      throw error;
    }
  }
}

export interface SqliteRecallSnapshotSource {
  assertActive(): void;
  listRawAggregateRows(): Promise<
    readonly Readonly<Record<string, unknown>>[]
  >;
  readRawSurfaceState(
    surfaceNorms: readonly string[],
  ): Promise<SqliteRecallSurfaceStateRowsResult>;
  searchRawFtsRows(
    matchExpression: string,
    phraseLiterals: readonly string[],
  ): Promise<SqliteRecallFtsRowsResult>;
  readRawOverviewState(
    limit: number,
  ): Promise<SqliteRecallOverviewRowsResult>;
  readRawTraversalState(
    entityId: string,
  ): Promise<SqliteRecallTraversalStateRowsResult>;
  readRawRankingRows(
    candidates: readonly SqliteRecallRankingCandidate[],
    probeLimit: number,
  ): Promise<SqliteRecallRankingRowsResult>;
}

export type SqliteRecallSnapshotOperation<Result> = (
  source: SqliteRecallSnapshotSource,
) => Promise<Result>;

export function runSqliteRecallSnapshot<Result>(
  reader: SqliteReaderConnection,
  scopeKey: string,
  evaluationNow: number,
  operation: SqliteRecallSnapshotOperation<Result>,
): Promise<Result> {
  if (!(reader instanceof SqliteReaderConnectionImplementation)) {
    return Promise.reject(new SqliteConnectionError("RECALL_SNAPSHOT_FAILED"));
  }
  return reader.withRecallSnapshot(
    scopeKey,
    evaluationNow,
    operation,
  );
}

export interface SqliteConnectionFactory {
  readonly writerConfiguration: SqliteConnectionPolicy;
  enqueueWriteTransaction(
    commands: readonly SqliteTransactionCommand[],
  ): Promise<readonly SqliteCommandResult[]>;
  openReader(): Promise<SqliteReaderConnection>;
  close(): Promise<void>;
}

export interface SqliteProjectionReplaySession {
  begin(scopeKey: string): Promise<SqliteProjectionReplayBeginResult>;
  commit(
    replayId: number,
    rulesVersion: string,
    rebuiltAt: number,
    snapshot: ProjectionSnapshot,
  ): Promise<SqliteProjectionReplayCommitResult>;
  rollback(replayId: number): Promise<void>;
}

export interface SqliteProjectionDispatchSession {
  prepare(scopeKey: string): Promise<SqliteProjectionDispatchPrepareResult>;
  resolveEntities(
    dispatchId: number,
    drafts: readonly SqliteWriteEntityDraftInput[],
  ): Promise<readonly SqliteWriteEntityDraftResolution[]>;
  finalizeEntities(
    dispatchId: number,
    survivorDraftIndexes: readonly number[],
    statementBodyJson: string,
  ): Promise<SqliteWriteEntityFinalizationResult>;
  append(
    dispatchId: number,
    events: readonly SqliteProjectionDispatchAppendEvent[],
  ): Promise<SqliteProjectionDispatchBeginResult>;
  begin(
    scopeKey: string,
    events: readonly SqliteProjectionDispatchAppendEvent[],
  ): Promise<SqliteProjectionDispatchBeginResult>;
  commit(
    dispatchId: number,
    mode: SqliteProjectionPublishMode,
    rulesVersion: string,
    rebuiltAt: number,
    snapshot: ProjectionSnapshot,
  ): Promise<SqliteProjectionDispatchCommitResult>;
  rollback(dispatchId: number): Promise<void>;
}

export type SqliteProjectionDispatchSessionOperation<Result> = (
  session: SqliteProjectionDispatchSession,
) => Promise<Result>;

export type SqliteProjectionReplaySessionOperation<Result> = (
  session: SqliteProjectionReplaySession,
) => Promise<Result>;

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

  public enqueueMigrations(
    migrations: readonly SqlitePreparedMigration[],
  ): Promise<SqliteMigrationExecutionResult> {
    if (!this.#accepting) {
      return Promise.reject(
        new SqliteConnectionError("CONNECTION_FACTORY_CLOSED"),
      );
    }
    const snapshot = Object.freeze(
      migrations.map((migration) =>
        Object.freeze({
          version: migration.version,
          name: migration.name,
          checksum: migration.checksum,
          sql: migration.sql,
          appliedAtSeconds: migration.appliedAtSeconds,
        }),
      ),
    );
    const operation = this.#writeTail.then(() => this.#writer.migrate(snapshot));
    this.#writeTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  public enqueueProjectionReplaySession<Result>(
    operation: SqliteProjectionReplaySessionOperation<Result>,
  ): Promise<Result> {
    if (!this.#accepting) {
      return Promise.reject(
        new SqliteConnectionError("CONNECTION_FACTORY_CLOSED"),
      );
    }
    if (typeof operation !== "function") {
      return Promise.reject(
        new SqliteConnectionError("INVALID_TRANSACTION_PROGRAM"),
      );
    }

    const queued = this.#writeTail.then(async (): Promise<Result> => {
      let activeReplayId: number | null = null;
      const session: SqliteProjectionReplaySession = Object.freeze({
        begin: async (
          scopeKey: string,
        ): Promise<SqliteProjectionReplayBeginResult> => {
          if (activeReplayId !== null) {
            throw new SqliteConnectionError("SQLITE_TRANSACTION_FAILED");
          }
          const result = await this.#writer.beginProjectionReplay(scopeKey);
          activeReplayId = result.replayId;
          return result;
        },
        commit: async (
          replayId: number,
          rulesVersion: string,
          rebuiltAt: number,
          snapshot: ProjectionSnapshot,
        ): Promise<SqliteProjectionReplayCommitResult> => {
          if (activeReplayId !== replayId) {
            throw new SqliteConnectionError("SQLITE_TRANSACTION_FAILED");
          }
          const result = await this.#writer.commitProjectionReplay(
            replayId,
            rulesVersion,
            rebuiltAt,
            snapshot,
          );
          activeReplayId = null;
          return result;
        },
        rollback: async (replayId: number): Promise<void> => {
          if (activeReplayId !== replayId) {
            throw new SqliteConnectionError("SQLITE_TRANSACTION_FAILED");
          }
          await this.#writer.rollbackProjectionReplay(replayId);
          activeReplayId = null;
        },
      });

      try {
        return await operation(session);
      } finally {
        if (activeReplayId !== null) {
          const replayId = activeReplayId;
          activeReplayId = null;
          try {
            await this.#writer.rollbackProjectionReplay(replayId);
          } catch {
            // The primary operation error remains safe; the worker owns rollback.
          }
        }
      }
    });
    this.#writeTail = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  public enqueueProjectionDispatchSession<Result>(
    operation: SqliteProjectionDispatchSessionOperation<Result>,
  ): Promise<Result> {
    if (!this.#accepting) {
      return Promise.reject(
        new SqliteConnectionError("CONNECTION_FACTORY_CLOSED"),
      );
    }
    if (typeof operation !== "function") {
      return Promise.reject(
        new SqliteConnectionError("INVALID_TRANSACTION_PROGRAM"),
      );
    }

    const queued = this.#writeTail.then(async (): Promise<Result> => {
      let activeDispatchId: number | null = null;
      const session: SqliteProjectionDispatchSession = Object.freeze({
        prepare: async (
          scopeKey: string,
        ): Promise<SqliteProjectionDispatchPrepareResult> => {
          if (activeDispatchId !== null) {
            throw new SqliteConnectionError("SQLITE_TRANSACTION_FAILED");
          }
          const result = await this.#writer.prepareProjectionDispatch(scopeKey);
          activeDispatchId = result.dispatchId;
          return result;
        },
        resolveEntities: async (
          dispatchId: number,
          drafts: readonly SqliteWriteEntityDraftInput[],
        ): Promise<readonly SqliteWriteEntityDraftResolution[]> => {
          if (activeDispatchId !== dispatchId) {
            throw new SqliteConnectionError("SQLITE_TRANSACTION_FAILED");
          }
          return this.#writer.resolveProjectionDispatchEntities(
            dispatchId,
            drafts,
          );
        },
        finalizeEntities: async (
          dispatchId: number,
          survivorDraftIndexes: readonly number[],
          statementBodyJson: string,
        ): Promise<SqliteWriteEntityFinalizationResult> => {
          if (activeDispatchId !== dispatchId) {
            throw new SqliteConnectionError("SQLITE_TRANSACTION_FAILED");
          }
          return this.#writer.finalizeProjectionDispatchEntities(
            dispatchId,
            survivorDraftIndexes,
            statementBodyJson,
          );
        },
        append: async (
          dispatchId: number,
          events: readonly SqliteProjectionDispatchAppendEvent[],
        ): Promise<SqliteProjectionDispatchBeginResult> => {
          if (activeDispatchId !== dispatchId) {
            throw new SqliteConnectionError("SQLITE_TRANSACTION_FAILED");
          }
          return this.#writer.appendProjectionDispatch(dispatchId, events);
        },
        begin: async (
          scopeKey: string,
          events: readonly SqliteProjectionDispatchAppendEvent[],
        ) => {
          if (activeDispatchId !== null) {
            throw new SqliteConnectionError("SQLITE_TRANSACTION_FAILED");
          }
          const result = await this.#writer.beginProjectionDispatch(
            scopeKey,
            events,
          );
          activeDispatchId = result.dispatchId;
          return result;
        },
        commit: async (
          dispatchId: number,
          mode: SqliteProjectionPublishMode,
          rulesVersion: string,
          rebuiltAt: number,
          snapshot: ProjectionSnapshot,
        ) => {
          if (activeDispatchId !== dispatchId) {
            throw new SqliteConnectionError("SQLITE_TRANSACTION_FAILED");
          }
          const result = await this.#writer.commitProjectionDispatch(
            dispatchId,
            mode,
            rulesVersion,
            rebuiltAt,
            snapshot,
          );
          activeDispatchId = null;
          return result;
        },
        rollback: async (dispatchId: number) => {
          if (activeDispatchId !== dispatchId) {
            throw new SqliteConnectionError("SQLITE_TRANSACTION_FAILED");
          }
          await this.#writer.rollbackProjectionReplay(dispatchId);
          activeDispatchId = null;
        },
      });
      try {
        return await operation(session);
      } finally {
        if (activeDispatchId !== null) {
          const dispatchId = activeDispatchId;
          activeDispatchId = null;
          try {
            await this.#writer.rollbackProjectionReplay(dispatchId);
          } catch {
            // The primary operation error remains safe; the worker owns rollback.
          }
        }
      }
    });
    this.#writeTail = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  public async openReader(): Promise<SqliteReaderConnection> {
    if (!this.#accepting) {
      throw new SqliteConnectionError("CONNECTION_FACTORY_CLOSED");
    }
    let trackedReader: SqliteReaderConnection | undefined;
    const opening = openSqliteReaderWithCloseHook(this.#readiness, () => {
      if (trackedReader !== undefined) {
        this.#readers.delete(trackedReader);
      }
    });
    this.#readerOpenings.add(opening);
    try {
      const reader = await opening;
      trackedReader = reader;
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

export function enqueueSqliteProjectionReplaySession<Result>(
  factory: SqliteConnectionFactory,
  operation: SqliteProjectionReplaySessionOperation<Result>,
): Promise<Result> {
  if (!(factory instanceof SqliteConnectionFactoryImplementation)) {
    return Promise.reject(
      new SqliteConnectionError("INVALID_TRANSACTION_PROGRAM"),
    );
  }
  return factory.enqueueProjectionReplaySession(operation);
}

export function enqueueSqliteProjectionDispatchSession<Result>(
  factory: SqliteConnectionFactory,
  operation: SqliteProjectionDispatchSessionOperation<Result>,
): Promise<Result> {
  if (!(factory instanceof SqliteConnectionFactoryImplementation)) {
    return Promise.reject(
      new SqliteConnectionError("INVALID_TRANSACTION_PROGRAM"),
    );
  }
  return factory.enqueueProjectionDispatchSession(operation);
}

export function enqueueSqliteMigrationOperation(
  factory: SqliteConnectionFactory,
  migrations: readonly SqlitePreparedMigration[],
): Promise<SqliteMigrationExecutionResult> {
  if (!(factory instanceof SqliteConnectionFactoryImplementation)) {
    return Promise.reject(
      new SqliteMigrationError("MIGRATION_RUNNER_UNAVAILABLE"),
    );
  }
  return factory.enqueueMigrations(migrations);
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
  return openSqliteReaderWithCloseHook(readiness);
}

async function openSqliteReaderWithCloseHook(
  readiness: SqliteStartupReadiness,
  onClose?: () => void,
): Promise<SqliteReaderConnection> {
  const client = await openWorker("reader", readiness);
  return new SqliteReaderConnectionImplementation(client, onClose);
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
