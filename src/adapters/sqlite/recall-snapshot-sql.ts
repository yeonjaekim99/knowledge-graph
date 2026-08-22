import { CLAIM_AGGREGATE_SQL_SOURCE } from "./claim-aggregate.js";

export interface RecallSnapshotSqlSource {
  readonly dropTempAggregate: string;
  readonly createTempAggregate: string;
  readonly selectValidClaimAggregates: string;
}

const createTempAggregate = [
  "CREATE TEMP TABLE recall_claim_agg AS",
  "SELECT",
  "  aggregate_source.claim_id AS claim_id,",
  "  aggregate_source.support_count AS support_count,",
  "  aggregate_source.strongest_rank AS strongest_rank,",
  "  aggregate_source.last_seen_at AS last_seen_at,",
  "  aggregate_source.relation_label AS relation_label,",
  "  aggregate_source.effective_expires_at AS effective_expires_at",
  "FROM (",
  CLAIM_AGGREGATE_SQL_SOURCE.recallSelect,
  ") AS aggregate_source",
].join("\n");

const selectValidClaimAggregates = [
  "SELECT",
  "  recall_agg.claim_id AS recall_aggregate_claim_id,",
  "  recall_agg.support_count AS recall_aggregate_support_count,",
  "  recall_agg.strongest_rank AS recall_aggregate_strongest_rank,",
  "  recall_agg.last_seen_at AS recall_aggregate_last_seen_at,",
  "  recall_agg.relation_label AS recall_aggregate_relation_label,",
  "  recall_agg.effective_expires_at AS recall_aggregate_effective_expires_at,",
  "  source_claim.scope_key AS recall_source_claim_scope_key,",
  "  source_claim.state AS recall_source_claim_state",
  "FROM temp.recall_claim_agg AS recall_agg",
  "JOIN claims AS source_claim ON source_claim.id = recall_agg.claim_id",
  "ORDER BY recall_agg.claim_id ASC",
].join("\n");

/**
 * The materialization wraps PRJ-008's parameterized reference SELECT rather
 * than restating validity predicates. Every projected name is explicit, and
 * later reads are rooted in the connection-local TEMP valid set.
 */
export const RECALL_SNAPSHOT_SQL_SOURCE: RecallSnapshotSqlSource =
  Object.freeze({
    dropTempAggregate: "DROP TABLE IF EXISTS temp.recall_claim_agg",
    createTempAggregate,
    selectValidClaimAggregates,
  });
