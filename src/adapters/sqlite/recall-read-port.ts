import {
  RecallReadError,
  createRecallReadContext,
  type RecallClaimAggregate,
  type RecallReadContext,
  type RecallReadPort,
  type RecallSnapshotOperation,
  type RecallValidClaimSource,
} from "../../application/ports/recall-read-port.js";

import {
  runSqliteRecallSnapshot,
  type SqliteConnectionFactory,
} from "./connection-factory.js";

const CLAIM_ID_PATTERN = /^c[1-9][0-9]*\.[0-9]+$/u;
const ROW_KEYS: readonly string[] = Object.freeze([
  "recall_aggregate_claim_id",
  "recall_aggregate_effective_expires_at",
  "recall_aggregate_last_seen_at",
  "recall_aggregate_relation_label",
  "recall_aggregate_strongest_rank",
  "recall_aggregate_support_count",
  "recall_source_claim_scope_key",
  "recall_source_claim_state",
]);

function invalidAggregate(): never {
  throw new RecallReadError("INVALID_RECALL_AGGREGATE");
}

function exactRow(
  value: unknown,
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return invalidAggregate();
  }
  const row = value as Readonly<Record<string, unknown>>;
  const keys = Object.keys(row).sort();
  if (
    keys.length !== ROW_KEYS.length ||
    !keys.every((key, index) => key === ROW_KEYS[index])
  ) {
    return invalidAggregate();
  }
  return row;
}

function safeEpoch(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    return invalidAggregate();
  }
  return Number(value);
}

function decodeAggregate(
  value: unknown,
  context: RecallReadContext,
): RecallClaimAggregate {
  const row = exactRow(value);
  const claimId = row["recall_aggregate_claim_id"];
  const supportCount = row["recall_aggregate_support_count"];
  const strongestRank = row["recall_aggregate_strongest_rank"];
  const relationLabel = row["recall_aggregate_relation_label"];
  const effectiveExpiresAt =
    row["recall_aggregate_effective_expires_at"];

  if (
    typeof claimId !== "string" ||
    !CLAIM_ID_PATTERN.test(claimId) ||
    !Number.isSafeInteger(supportCount) ||
    Number(supportCount) < 1 ||
    (strongestRank !== 1 && strongestRank !== 2 && strongestRank !== 3) ||
    (relationLabel !== null &&
      (typeof relationLabel !== "string" ||
        relationLabel.length === 0 ||
        relationLabel.trim() !== relationLabel)) ||
    row["recall_source_claim_scope_key"] !== context.scopeKey ||
    row["recall_source_claim_state"] !== "active"
  ) {
    return invalidAggregate();
  }

  const lastSeenAt = safeEpoch(row["recall_aggregate_last_seen_at"]);
  const expiry =
    effectiveExpiresAt === null ? null : safeEpoch(effectiveExpiresAt);
  if (expiry !== null && expiry <= context.evaluationNow) {
    return invalidAggregate();
  }

  return Object.freeze({
    claimId,
    supportCount: Number(supportCount),
    strongestRank,
    lastSeenAt,
    relationLabel,
    effectiveExpiresAt: expiry,
  });
}

function decodeAggregates(
  rows: readonly Readonly<Record<string, unknown>>[],
  context: RecallReadContext,
): readonly RecallClaimAggregate[] {
  if (!Array.isArray(rows)) {
    return invalidAggregate();
  }
  const result = rows.map((row) => decodeAggregate(row, context));
  for (let index = 1; index < result.length; index += 1) {
    const previous = result[index - 1];
    const current = result[index];
    if (
      previous === undefined ||
      current === undefined ||
      previous.claimId >= current.claimId
    ) {
      return invalidAggregate();
    }
  }
  return Object.freeze(result);
}

class SqliteRecallReadPort implements RecallReadPort {
  readonly #factory: SqliteConnectionFactory;

  public constructor(factory: SqliteConnectionFactory) {
    this.#factory = factory;
  }

  public async withSnapshot<Result>(
    suppliedContext: RecallReadContext,
    operation: RecallSnapshotOperation<Result>,
  ): Promise<Result> {
    const context = createRecallReadContext(
      suppliedContext?.scopeKey,
      suppliedContext?.evaluationNow,
    );
    if (typeof operation !== "function") {
      throw new RecallReadError("INVALID_RECALL_CONTEXT");
    }

    const reader = await this.#factory.openReader();
    try {
      return await runSqliteRecallSnapshot(
        reader,
        context.scopeKey,
        context.evaluationNow,
        async (snapshot) => {
          const source: RecallValidClaimSource = Object.freeze({
            listValidClaimAggregates: async () =>
              decodeAggregates(
                await snapshot.listRawAggregateRows(),
                context,
              ),
          });
          return operation(source);
        },
      );
    } finally {
      await reader.close();
    }
  }
}

export function createSqliteRecallReadPort(
  factory: SqliteConnectionFactory,
): RecallReadPort {
  return Object.freeze(new SqliteRecallReadPort(factory));
}
