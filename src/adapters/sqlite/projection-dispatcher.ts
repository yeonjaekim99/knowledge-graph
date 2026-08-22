import type {
  EventId,
  RuntimeProvider,
  RuntimeSnapshot,
} from "../../application/ports/runtime-provider.js";
import {
  ProjectionIncrementalError,
  reduceIncrementalProjection,
} from "../../domain/projection-incremental.js";
import {
  ProjectionDispatchError as DomainProjectionDispatchError,
  planProjectionDispatch,
  projectProjectionSnapshot,
} from "../../domain/projection-dispatch.js";
import { ProjectionReplayContractError } from "../../domain/projection-replay.js";
import {
  enqueueSqliteProjectionDispatchSession,
  type SqliteConnectionFactory,
} from "./connection-factory.js";
import type { SqliteProjectionDispatchAppendEvent } from "./connection-protocol.js";
import {
  JOURNAL_ID_COLLISION_ATTEMPT_LIMIT,
  JournalAppendError,
  generateJournalEventIds,
  prepareJournalAppendIntents,
  type JournalAppendEventReceipt,
  type JournalAppendIntent,
  type PreparedJournalAppendIntent,
} from "./journal-repository.js";

export interface SqliteProjectionDispatcherDependencies {
  readonly factory: SqliteConnectionFactory;
  readonly runtime: RuntimeProvider;
}

export type ProjectionDispatchMode = "incremental" | "replay";

export type ProjectionDispatchReason =
  | "safe_suffix"
  | "historical_event"
  | "missing_meta"
  | "rules_version_changed"
  | "journal_sequence_changed"
  | "projection_invariant_failed";

export interface SqliteProjectionDispatchReceipt {
  readonly events: readonly JournalAppendEventReceipt[];
  readonly mode: ProjectionDispatchMode;
  readonly reason: ProjectionDispatchReason;
  readonly lastSeq: number;
  readonly eventCount: number;
  readonly projectionRowCount: number;
}

export interface SqliteProjectionDispatcher {
  execute(
    events: readonly JournalAppendIntent[],
  ): Promise<SqliteProjectionDispatchReceipt>;
}

export type SqliteProjectionDispatcherErrorCode =
  | "INVALID_DISPATCHER_DEPENDENCIES"
  | "PROJECTION_DISPATCH_FAILED";

const ERROR_MESSAGES: Readonly<
  Record<SqliteProjectionDispatcherErrorCode, string>
> = Object.freeze({
  INVALID_DISPATCHER_DEPENDENCIES:
    "projection dispatcher requires managed SQLite and trusted runtime dependencies",
  PROJECTION_DISPATCH_FAILED:
    "journal and projection dispatch failed safely before commit",
});

export class SqliteProjectionDispatcherError extends Error {
  public override readonly name: string = "SqliteProjectionDispatcherError";
  public readonly code: SqliteProjectionDispatcherErrorCode;
  public readonly retryable: false = false;

  public constructor(code: SqliteProjectionDispatcherErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.code = code;
  }
}

function validDependencies(
  value: SqliteProjectionDispatcherDependencies,
): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    value.factory !== null &&
    typeof value.factory === "object" &&
    typeof value.factory.openReader === "function" &&
    typeof value.factory.enqueueWriteTransaction === "function" &&
    value.runtime !== null &&
    typeof value.runtime === "object" &&
    typeof value.runtime.capture === "function" &&
    typeof value.runtime.nextEventId === "function"
  );
}

function appendEvents(
  intents: readonly PreparedJournalAppendIntent[],
  ids: readonly EventId[],
  runtime: RuntimeSnapshot,
): readonly SqliteProjectionDispatchAppendEvent[] {
  return Object.freeze(
    intents.map((intent, index) => {
      const eventId = ids[index];
      if (eventId === undefined) {
        throw new SqliteProjectionDispatcherError("PROJECTION_DISPATCH_FAILED");
      }
      return Object.freeze({
        eventId,
        kind: intent.kind,
        bodyJson: intent.bodyJson,
        actor: runtime.metadata.actor,
        branch: runtime.metadata.branch,
        session: runtime.metadata.session,
        createdAt: runtime.recordedAt,
      });
    }),
  );
}

function historicalReason(reason: string): ProjectionDispatchReason {
  return reason === "safe_suffix" ? "safe_suffix" : "historical_event";
}

async function dispatchAttempt(
  factory: SqliteConnectionFactory,
  runtime: RuntimeSnapshot,
  intents: readonly PreparedJournalAppendIntent[],
  ids: readonly EventId[],
): Promise<SqliteProjectionDispatchReceipt | null> {
  return enqueueSqliteProjectionDispatchSession(factory, async (session) => {
    const begin = await session.begin(
      runtime.scope.scopeKey,
      appendEvents(intents, ids, runtime),
    );
    if (begin.collision) {
      await session.rollback(begin.dispatchId);
      return null;
    }
    if (begin.appendedEvents.length !== intents.length) {
      throw new SqliteProjectionDispatcherError("PROJECTION_DISPATCH_FAILED");
    }

    let mode: ProjectionDispatchMode;
    let reason: ProjectionDispatchReason;
    if (begin.meta === null) {
      mode = "replay";
      reason = "missing_meta";
    } else if (begin.meta.rulesVersion !== runtime.rulesVersion) {
      mode = "replay";
      reason = "rules_version_changed";
    } else if (begin.meta.lastSeq !== begin.previousLastSeq) {
      mode = "replay";
      reason = "journal_sequence_changed";
    } else if (!begin.projectionValid) {
      mode = "replay";
      reason = "projection_invariant_failed";
    } else {
      const plan = planProjectionDispatch(begin.appendedEvents);
      mode = plan.mode;
      reason = historicalReason(plan.reason);
    }

    let snapshot;
    if (mode === "incremental") {
      try {
        snapshot = reduceIncrementalProjection({
          scopeKey: runtime.scope.scopeKey,
          rulesVersion: runtime.rulesVersion,
          current: begin.current,
          events: begin.appendedEvents,
          history: begin.events,
        });
      } catch (error: unknown) {
        if (!(error instanceof ProjectionIncrementalError)) {
          throw error;
        }
        mode = "replay";
        reason = "projection_invariant_failed";
      }
    }
    if (mode === "replay") {
      snapshot = projectProjectionSnapshot({
        scopeKey: runtime.scope.scopeKey,
        rulesVersion: runtime.rulesVersion,
        events: begin.events,
      });
    }
    if (snapshot === undefined) {
      throw new SqliteProjectionDispatcherError("PROJECTION_DISPATCH_FAILED");
    }
    const committed = await session.commit(
      begin.dispatchId,
      mode,
      runtime.rulesVersion,
      runtime.recordedAt,
      snapshot,
    );
    const seqById = new Map(
      begin.appendedEvents.map((event) => [event.eventId, event.seq]),
    );
    const events = ids.map((eventId, index) => {
      const seq = seqById.get(eventId);
      if (seq === undefined) {
        throw new SqliteProjectionDispatcherError("PROJECTION_DISPATCH_FAILED");
      }
      return Object.freeze({ index, eventId, seq });
    });
    return Object.freeze({
      events: Object.freeze(events),
      mode: committed.mode,
      reason,
      lastSeq: committed.lastSeq,
      eventCount: committed.eventCount,
      projectionRowCount: committed.projectionRowCount,
    });
  });
}

function safeProjectionFailure(error: unknown): never {
  if (
    error instanceof JournalAppendError ||
    error instanceof SqliteProjectionDispatcherError
  ) {
    throw error;
  }
  if (
    error instanceof ProjectionIncrementalError ||
    error instanceof DomainProjectionDispatchError ||
    error instanceof ProjectionReplayContractError
  ) {
    throw new SqliteProjectionDispatcherError("PROJECTION_DISPATCH_FAILED");
  }
  throw error;
}

async function dispatchPrepared(
  dependencies: SqliteProjectionDispatcherDependencies,
  intents: readonly PreparedJournalAppendIntent[],
): Promise<SqliteProjectionDispatchReceipt> {
  const runtime = await dependencies.runtime.capture();
  for (
    let attempt = 0;
    attempt < JOURNAL_ID_COLLISION_ATTEMPT_LIMIT;
    attempt += 1
  ) {
    const ids = generateJournalEventIds(dependencies.runtime, intents.length);
    if (ids === null) {
      continue;
    }
    try {
      const receipt = await dispatchAttempt(
        dependencies.factory,
        runtime,
        intents,
        ids,
      );
      if (receipt !== null) {
        return receipt;
      }
    } catch (error: unknown) {
      return safeProjectionFailure(error);
    }
  }
  throw new JournalAppendError("EVENT_ID_COLLISION_EXHAUSTED");
}

export function createSqliteProjectionDispatcher(
  dependencies: SqliteProjectionDispatcherDependencies,
): SqliteProjectionDispatcher {
  if (!validDependencies(dependencies)) {
    throw new SqliteProjectionDispatcherError(
      "INVALID_DISPATCHER_DEPENDENCIES",
    );
  }
  const bound = Object.freeze({
    factory: dependencies.factory,
    runtime: dependencies.runtime,
  });
  return Object.freeze({
    execute(
      events: readonly JournalAppendIntent[],
    ): Promise<SqliteProjectionDispatchReceipt> {
      let intents;
      try {
        intents = prepareJournalAppendIntents(events);
      } catch (error: unknown) {
        return Promise.reject(error);
      }
      return dispatchPrepared(bound, intents);
    },
  });
}
