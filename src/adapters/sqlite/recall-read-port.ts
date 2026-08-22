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
  RecallQuerySurfaceError,
  resolveRecallSurfaceSeeds,
  type RecallQueryTerm,
  type RecallSurfaceCandidateState,
  type RecallSurfaceEntityState,
} from "../../domain/recall-query-surface.js";
import type { IdentifierRedirectRow } from "../../domain/projection-identifiers.js";

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
const SURFACE_CANDIDATE_ROW_KEYS: readonly string[] = Object.freeze([
  "recall_surface_entity_id",
  "recall_surface_norm",
  "recall_surface_scope_key",
  "recall_surface_term_order",
]);
const SURFACE_ENTITY_ROW_KEYS: readonly string[] = Object.freeze([
  "recall_surface_entity_id",
  "recall_surface_entity_merged_into",
  "recall_surface_entity_scope_key",
]);
const SURFACE_REDIRECT_ROW_KEYS: readonly string[] = Object.freeze([
  "recall_surface_redirect_kind",
  "recall_surface_redirect_new_id",
  "recall_surface_redirect_old_id",
  "recall_surface_redirect_reason",
]);

function invalidAggregate(): never {
  throw new RecallReadError("INVALID_RECALL_AGGREGATE");
}

function invalidSurfaceState(): never {
  throw new RecallReadError("INVALID_RECALL_SURFACE_STATE");
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

function exactSurfaceRow(
  value: unknown,
  expectedKeys: readonly string[],
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return invalidSurfaceState();
  }
  const row = value as Readonly<Record<string, unknown>>;
  const keys = Object.keys(row).sort();
  if (
    keys.length !== expectedKeys.length ||
    !keys.every((key, index) => key === expectedKeys[index])
  ) {
    return invalidSurfaceState();
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

function decodeSurfaceCandidates(
  values: readonly Readonly<Record<string, unknown>>[],
): readonly RecallSurfaceCandidateState[] {
  if (!Array.isArray(values)) {
    return invalidSurfaceState();
  }
  return Object.freeze(
    values.map((value) => {
      const row = exactSurfaceRow(value, SURFACE_CANDIDATE_ROW_KEYS);
      const termOrder = row["recall_surface_term_order"];
      const scopeKey = row["recall_surface_scope_key"];
      const surfaceNorm = row["recall_surface_norm"];
      const entityId = row["recall_surface_entity_id"];
      if (
        !Number.isSafeInteger(termOrder) ||
        typeof scopeKey !== "string" ||
        typeof surfaceNorm !== "string" ||
        typeof entityId !== "string"
      ) {
        return invalidSurfaceState();
      }
      return Object.freeze({
        termOrder: Number(termOrder),
        scopeKey,
        surfaceNorm,
        entityId,
      });
    }),
  );
}

function decodeSurfaceEntities(
  values: readonly Readonly<Record<string, unknown>>[],
): readonly RecallSurfaceEntityState[] {
  if (!Array.isArray(values)) {
    return invalidSurfaceState();
  }
  return Object.freeze(
    values.map((value) => {
      const row = exactSurfaceRow(value, SURFACE_ENTITY_ROW_KEYS);
      const id = row["recall_surface_entity_id"];
      const scopeKey = row["recall_surface_entity_scope_key"];
      const mergedInto = row["recall_surface_entity_merged_into"];
      if (
        typeof id !== "string" ||
        typeof scopeKey !== "string" ||
        (mergedInto !== null && typeof mergedInto !== "string")
      ) {
        return invalidSurfaceState();
      }
      return Object.freeze({ id, scopeKey, mergedInto });
    }),
  );
}

function decodeSurfaceRedirects(
  values: readonly Readonly<Record<string, unknown>>[],
): readonly IdentifierRedirectRow[] {
  if (!Array.isArray(values)) {
    return invalidSurfaceState();
  }
  return Object.freeze(
    values.map((value) => {
      const row = exactSurfaceRow(value, SURFACE_REDIRECT_ROW_KEYS);
      const oldId = row["recall_surface_redirect_old_id"];
      const newId = row["recall_surface_redirect_new_id"];
      const kind = row["recall_surface_redirect_kind"];
      const reason = row["recall_surface_redirect_reason"];
      if (
        typeof oldId !== "string" ||
        typeof newId !== "string" ||
        (kind !== "entity" && kind !== "claim") ||
        (reason !== "merge" &&
          reason !== "rule_change" &&
          reason !== "deduplicated")
      ) {
        return invalidSurfaceState();
      }
      return Object.freeze({ oldId, newId, kind, reason });
    }),
  );
}

function validateTermsForRead(
  terms: readonly RecallQueryTerm[],
  context: RecallReadContext,
): readonly RecallQueryTerm[] {
  try {
    return resolveRecallSurfaceSeeds({
      scopeKey: context.scopeKey,
      terms,
      candidates: [],
      entities: [],
      idRedirects: [],
    }).terms;
  } catch (error: unknown) {
    if (error instanceof RecallQuerySurfaceError) {
      return invalidSurfaceState();
    }
    throw error;
  }
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
            resolveSurfaceSeeds: async (
              suppliedTerms: readonly RecallQueryTerm[],
            ) => {
              const terms = validateTermsForRead(suppliedTerms, context);
              const raw = await snapshot.readRawSurfaceState(
                terms.map((term) => term.surfaceNorm),
              );
              try {
                return resolveRecallSurfaceSeeds({
                  scopeKey: context.scopeKey,
                  terms,
                  candidates: decodeSurfaceCandidates(raw.candidateRows),
                  entities: decodeSurfaceEntities(raw.entityRows),
                  idRedirects: decodeSurfaceRedirects(raw.redirectRows),
                });
              } catch (error: unknown) {
                if (error instanceof RecallQuerySurfaceError) {
                  return invalidSurfaceState();
                }
                throw error;
              }
            },
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
