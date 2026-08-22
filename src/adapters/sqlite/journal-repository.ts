import type {
  EventId,
  RuntimeProvider,
  RuntimeSnapshot,
} from "../../application/ports/runtime-provider.js";
import type { SqliteConnectionFactory } from "./connection-factory.js";
import type {
  SqliteAllResult,
  SqliteBinding,
} from "./connection-protocol.js";

const EVENT_ID_PATTERN = /^ev_[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
const JOURNAL_EVENT_KINDS: ReadonlySet<string> = new Set([
  "statement",
  "retraction",
  "merge",
  "alias",
]);

/** One initial transaction plus three full-batch retries. */
export const JOURNAL_ID_COLLISION_ATTEMPT_LIMIT: 4 = 4;

export type JournalEventKind =
  | "statement"
  | "retraction"
  | "merge"
  | "alias";

export interface JournalAppendIntent {
  readonly kind: JournalEventKind;
  /** Already sanitized and semantically validated JSON object text. */
  readonly bodyJson: string;
}

export interface JournalAppendEventReceipt {
  readonly index: number;
  readonly eventId: EventId;
  readonly seq: number;
}

export interface JournalAppendReceipt {
  readonly events: readonly JournalAppendEventReceipt[];
}

export interface AppendOnlyJournalRepository {
  append(events: readonly JournalAppendIntent[]): Promise<JournalAppendReceipt>;
}

export interface SqliteJournalRepositoryDependencies {
  readonly factory: SqliteConnectionFactory;
  /** Request-scoped trusted runtime; no ID, scope, time, or metadata tool input exists. */
  readonly runtime: RuntimeProvider;
}

export type JournalAppendErrorCode =
  | "INVALID_REPOSITORY_DEPENDENCIES"
  | "INVALID_EVENT_BATCH"
  | "INVALID_EVENT_ID"
  | "EVENT_ID_COLLISION_EXHAUSTED"
  | "APPEND_RESULT_INVALID";

const JOURNAL_APPEND_ERROR_MESSAGES: Readonly<
  Record<JournalAppendErrorCode, string>
> = Object.freeze({
  INVALID_REPOSITORY_DEPENDENCIES:
    "journal repository requires managed SQLite and trusted runtime dependencies",
  INVALID_EVENT_BATCH:
    "journal append requires a non-empty batch of validated event envelopes",
  INVALID_EVENT_ID:
    "runtime event ID does not satisfy the canonical journal contract",
  EVENT_ID_COLLISION_EXHAUSTED:
    "journal event ID collision retries were exhausted before commit",
  APPEND_RESULT_INVALID:
    "journal append result did not satisfy the atomic receipt contract",
});

export class JournalAppendError extends Error {
  public override readonly name: string = "JournalAppendError";
  public readonly code: JournalAppendErrorCode;
  public readonly retryable: boolean;

  public constructor(code: JournalAppendErrorCode) {
    super(JOURNAL_APPEND_ERROR_MESSAGES[code]);
    this.code = code;
    this.retryable = code === "EVENT_ID_COLLISION_EXHAUSTED";
  }
}

export interface PreparedJournalAppendIntent {
  readonly kind: JournalEventKind;
  readonly bodyJson: string;
}

function invalidBatch(): never {
  throw new JournalAppendError("INVALID_EVENT_BATCH");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactDataProperties(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Reflect.ownKeys(value);
  if (
    keys.some((key) => typeof key !== "string") ||
    keys.length !== expected.length ||
    !(keys as string[])
      .slice()
      .sort()
      .every((key, index) => key === expected[index])
  ) {
    return false;
  }
  return (keys as string[]).every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return (
      descriptor !== undefined &&
      descriptor.enumerable === true &&
      "value" in descriptor
    );
  });
}

function isJsonObjectText(value: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return false;
  }
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
}

function snapshotIntents(
  events: readonly JournalAppendIntent[],
): readonly PreparedJournalAppendIntent[] {
  if (!Array.isArray(events) || events.length === 0) {
    return invalidBatch();
  }
  const prepared = events.map((event) => {
    if (
      !isPlainRecord(event) ||
      !hasExactDataProperties(event, ["bodyJson", "kind"])
    ) {
      return invalidBatch();
    }
    const kind = event["kind"];
    const bodyJson = event["bodyJson"];
    if (
      typeof kind !== "string" ||
      !JOURNAL_EVENT_KINDS.has(kind) ||
      typeof bodyJson !== "string" ||
      !isJsonObjectText(bodyJson)
    ) {
      return invalidBatch();
    }
    return Object.freeze({
      kind: kind as JournalEventKind,
      bodyJson,
    });
  });
  return Object.freeze(prepared);
}

function checkedEventIds(
  runtime: RuntimeProvider,
  count: number,
): readonly EventId[] | null {
  const ids: EventId[] = [];
  const unique = new Set<string>();
  for (let index = 0; index < count; index += 1) {
    const eventId = runtime.nextEventId();
    if (typeof eventId !== "string" || !EVENT_ID_PATTERN.test(eventId)) {
      throw new JournalAppendError("INVALID_EVENT_ID");
    }
    ids.push(eventId);
    unique.add(eventId);
  }
  return unique.size === ids.length ? Object.freeze(ids) : null;
}

/** Internal shared boundary used by the atomic projection dispatcher. */
export function prepareJournalAppendIntents(
  events: readonly JournalAppendIntent[],
): readonly PreparedJournalAppendIntent[] {
  return snapshotIntents(events);
}

/** Internal shared ID gate used before entering a managed write transaction. */
export function generateJournalEventIds(
  runtime: RuntimeProvider,
  count: number,
): readonly EventId[] | null {
  return checkedEventIds(runtime, count);
}

function appendSql(eventCount: number): string {
  const values = Array.from(
    { length: eventCount },
    () => "(?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).join(", ");
  return [
    "WITH candidate(id, scope_key, kind, body, actor, branch, session, created_at, ordinal) AS (",
    `VALUES ${values}`,
    ")",
    "INSERT INTO journal(id, scope_key, kind, body, actor, branch, session, created_at)",
    "SELECT id, scope_key, kind, body, actor, branch, session, created_at",
    "FROM candidate",
    "WHERE NOT EXISTS (",
    "  SELECT 1 FROM journal AS existing",
    "  JOIN candidate AS proposed ON proposed.id = existing.id",
    ")",
    "ORDER BY ordinal",
    "RETURNING seq, id",
  ].join("\n");
}

function appendParameters(
  events: readonly PreparedJournalAppendIntent[],
  ids: readonly EventId[],
  snapshot: RuntimeSnapshot,
): readonly SqliteBinding[] {
  const bindings: SqliteBinding[] = [];
  for (const [index, event] of events.entries()) {
    const eventId = ids[index];
    if (eventId === undefined) {
      throw new JournalAppendError("APPEND_RESULT_INVALID");
    }
    bindings.push(
      eventId,
      snapshot.scope.scopeKey,
      event.kind,
      event.bodyJson,
      snapshot.metadata.actor,
      snapshot.metadata.branch,
      snapshot.metadata.session,
      snapshot.recordedAt,
      index,
    );
  }
  return Object.freeze(bindings);
}

function allResult(
  results: readonly unknown[],
): SqliteAllResult {
  if (
    results.length !== 1 ||
    results[0] === null ||
    typeof results[0] !== "object" ||
    !("kind" in results[0]) ||
    results[0].kind !== "all" ||
    !("rows" in results[0]) ||
    !Array.isArray(results[0].rows)
  ) {
    throw new JournalAppendError("APPEND_RESULT_INVALID");
  }
  return results[0] as SqliteAllResult;
}

function freezeReceipt(
  rows: readonly Readonly<Record<string, unknown>>[],
  ids: readonly EventId[],
): JournalAppendReceipt {
  if (rows.length !== ids.length) {
    throw new JournalAppendError("APPEND_RESULT_INVALID");
  }
  const seqById = new Map<EventId, number>();
  for (const row of rows) {
    const id = row["id"];
    const seq = row["seq"];
    if (
      typeof id !== "string" ||
      !EVENT_ID_PATTERN.test(id) ||
      !ids.includes(id as EventId) ||
      seqById.has(id as EventId) ||
      !Number.isSafeInteger(seq) ||
      Number(seq) <= 0
    ) {
      throw new JournalAppendError("APPEND_RESULT_INVALID");
    }
    seqById.set(id as EventId, Number(seq));
  }
  const events = ids.map((eventId, index) => {
    const seq = seqById.get(eventId);
    if (seq === undefined) {
      throw new JournalAppendError("APPEND_RESULT_INVALID");
    }
    return Object.freeze({ index, eventId, seq });
  });
  return Object.freeze({ events: Object.freeze(events) });
}

async function appendPrepared(
  dependencies: SqliteJournalRepositoryDependencies,
  events: readonly PreparedJournalAppendIntent[],
): Promise<JournalAppendReceipt> {
  const snapshot = await dependencies.runtime.capture();
  const sql = appendSql(events.length);

  for (
    let attempt = 0;
    attempt < JOURNAL_ID_COLLISION_ATTEMPT_LIMIT;
    attempt += 1
  ) {
    const ids = checkedEventIds(dependencies.runtime, events.length);
    if (ids === null) {
      continue;
    }
    const results = await dependencies.factory.enqueueWriteTransaction([
      {
        kind: "all",
        sql,
        parameters: appendParameters(events, ids, snapshot),
      },
    ]);
    const rows = allResult(results).rows;
    if (rows.length === 0) {
      continue;
    }
    return freezeReceipt(rows, ids);
  }

  throw new JournalAppendError("EVENT_ID_COLLISION_EXHAUSTED");
}

function validDependencies(
  value: SqliteJournalRepositoryDependencies,
): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    value.factory !== null &&
    typeof value.factory === "object" &&
    typeof value.factory.enqueueWriteTransaction === "function" &&
    value.runtime !== null &&
    typeof value.runtime === "object" &&
    typeof value.runtime.capture === "function" &&
    typeof value.runtime.nextEventId === "function"
  );
}

export function createSqliteJournalRepository(
  dependencies: SqliteJournalRepositoryDependencies,
): AppendOnlyJournalRepository {
  if (!validDependencies(dependencies)) {
    throw new JournalAppendError("INVALID_REPOSITORY_DEPENDENCIES");
  }
  const boundDependencies = Object.freeze({
    factory: dependencies.factory,
    runtime: dependencies.runtime,
  });
  return Object.freeze({
    append(events: readonly JournalAppendIntent[]): Promise<JournalAppendReceipt> {
      let snapshot: readonly PreparedJournalAppendIntent[];
      try {
        snapshot = snapshotIntents(events);
      } catch (error) {
        return Promise.reject(error);
      }
      return appendPrepared(boundDependencies, snapshot);
    },
  });
}
