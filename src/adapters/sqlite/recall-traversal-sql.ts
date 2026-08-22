export interface RecallTraversalSqlSource {
  readonly dropTempLinks: string;
  readonly dropTempIncident: string;
  readonly createTempLinks: string;
  readonly createTempIncident: string;
  readonly selectEntity: string;
  readonly selectLinks: string;
  readonly selectIncidents: string;
}

const createTempLinks = [
  "CREATE TEMP VIEW recall_claim_links AS",
  "SELECT source_claim.subject_id AS from_id, source_claim.object_id AS to_id, source_claim.id AS claim_id",
  "FROM claims AS source_claim",
  "JOIN temp.recall_claim_agg AS valid_claim ON valid_claim.claim_id = source_claim.id",
  "WHERE source_claim.object_id IS NOT NULL",
  "UNION ALL",
  "SELECT source_claim.object_id AS from_id, source_claim.subject_id AS to_id, source_claim.id AS claim_id",
  "FROM claims AS source_claim",
  "JOIN temp.recall_claim_agg AS valid_claim ON valid_claim.claim_id = source_claim.id",
  "WHERE source_claim.object_id IS NOT NULL AND source_claim.object_id <> source_claim.subject_id",
].join("\n");

const createTempIncident = [
  "CREATE TEMP VIEW recall_claim_incident AS",
  "SELECT source_claim.subject_id AS entity_id, source_claim.id AS claim_id",
  "FROM claims AS source_claim",
  "JOIN temp.recall_claim_agg AS valid_claim ON valid_claim.claim_id = source_claim.id",
  "UNION ALL",
  "SELECT source_claim.object_id AS entity_id, source_claim.id AS claim_id",
  "FROM claims AS source_claim",
  "JOIN temp.recall_claim_agg AS valid_claim ON valid_claim.claim_id = source_claim.id",
  "WHERE source_claim.object_id IS NOT NULL AND source_claim.object_id <> source_claim.subject_id",
].join("\n");

const commonClaimColumns = [
  "source_claim.id AS recall_traversal_claim_id,",
  "source_claim.scope_key AS recall_traversal_claim_scope_key,",
  "source_claim.state AS recall_traversal_claim_state,",
  "source_claim.origin_seq AS recall_traversal_claim_origin_seq,",
  "valid_claim.support_count AS recall_traversal_support_count,",
  "valid_claim.strongest_rank AS recall_traversal_strongest_rank,",
  "valid_claim.last_seen_at AS recall_traversal_last_seen_at,",
  "subject_entity.id AS recall_traversal_subject_id,",
  "subject_entity.name AS recall_traversal_subject_name,",
  "subject_entity.scope_key AS recall_traversal_subject_scope_key,",
  "subject_entity.merged_into AS recall_traversal_subject_merged_into,",
  "object_entity.id AS recall_traversal_object_id,",
  "object_entity.name AS recall_traversal_object_name,",
  "object_entity.scope_key AS recall_traversal_object_scope_key,",
  "object_entity.merged_into AS recall_traversal_object_merged_into",
].join("\n  ");

const commonClaimJoins = [
  "JOIN claims AS source_claim ON source_claim.id = selected.claim_id",
  "JOIN temp.recall_claim_agg AS valid_claim ON valid_claim.claim_id = source_claim.id",
  "LEFT JOIN entities AS subject_entity ON subject_entity.id = source_claim.subject_id",
  "LEFT JOIN entities AS object_entity ON object_entity.id = source_claim.object_id",
].join("\n");

const ordering = [
  "valid_claim.support_count DESC,",
  "valid_claim.strongest_rank DESC,",
  "valid_claim.last_seen_at DESC,",
  "source_claim.origin_seq ASC,",
  "CAST(SUBSTR(source_claim.id, INSTR(source_claim.id, '.') + 1) AS INTEGER) ASC,",
  "source_claim.id COLLATE BINARY ASC",
].join("\n  ");

const selectLinks = [
  "SELECT",
  "  selected.from_id AS recall_traversal_from_id,",
  "  selected.to_id AS recall_traversal_to_id,",
  `  ${commonClaimColumns}`,
  "FROM temp.recall_claim_links AS selected",
  commonClaimJoins,
  "WHERE selected.from_id = ?",
  `ORDER BY ${ordering}`,
  "LIMIT 31",
].join("\n");

const selectIncidents = [
  "SELECT",
  `  ${commonClaimColumns}`,
  "FROM temp.recall_claim_incident AS selected",
  commonClaimJoins,
  "WHERE selected.entity_id = ?",
  `ORDER BY ${ordering}`,
  "LIMIT 31",
].join("\n");

/**
 * Request-local traversal views are rooted in RCL-001's valid aggregate.
 * They never broaden scope or lifetime and expose only bounded read queries.
 */
export const RECALL_TRAVERSAL_SQL_SOURCE: RecallTraversalSqlSource =
  Object.freeze({
    dropTempLinks: "DROP VIEW IF EXISTS temp.recall_claim_links",
    dropTempIncident: "DROP VIEW IF EXISTS temp.recall_claim_incident",
    createTempLinks,
    createTempIncident,
    selectEntity: [
      "SELECT",
      "  id AS recall_traversal_entity_id,",
      "  name AS recall_traversal_entity_name,",
      "  scope_key AS recall_traversal_entity_scope_key,",
      "  merged_into AS recall_traversal_entity_merged_into",
      "FROM entities WHERE id = ?",
    ].join("\n"),
    selectLinks,
    selectIncidents,
  });
