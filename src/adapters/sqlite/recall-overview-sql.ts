import { RECALL_VALID_GRAPH_DUPLICATE_EXISTS_SQL } from "./recall-fts-sql.js";

export interface RecallOverviewSqlSource {
  readonly selectEntityCandidates: string;
  readonly selectRawCandidates: string;
}

const selectEntityCandidates = [
  "WITH valid_incident(entity_id, claim_id, last_seen_at) AS (",
  "  SELECT candidate_claim.subject_id, candidate_claim.id, valid_claim.last_seen_at",
  "  FROM temp.recall_claim_agg AS valid_claim",
  "  JOIN claims AS candidate_claim ON candidate_claim.id = valid_claim.claim_id",
  "  UNION ALL",
  "  SELECT candidate_claim.object_id, candidate_claim.id, valid_claim.last_seen_at",
  "  FROM temp.recall_claim_agg AS valid_claim",
  "  JOIN claims AS candidate_claim ON candidate_claim.id = valid_claim.claim_id",
  "  WHERE candidate_claim.object_id IS NOT NULL",
  ")",
  "SELECT",
  "  valid_incident.entity_id AS recall_overview_entity_id,",
  "  candidate_entity.name AS recall_overview_entity_name,",
  "  candidate_entity.scope_key AS recall_overview_entity_scope_key,",
  "  candidate_entity.merged_into AS recall_overview_entity_merged_into,",
  "  COUNT(DISTINCT valid_incident.claim_id) AS recall_overview_entity_incident_count,",
  "  MAX(valid_incident.last_seen_at) AS recall_overview_entity_recent_at",
  "FROM valid_incident",
  "LEFT JOIN entities AS candidate_entity",
  "  ON candidate_entity.id = valid_incident.entity_id",
  "GROUP BY valid_incident.entity_id",
  "ORDER BY",
  "  recall_overview_entity_incident_count DESC,",
  "  recall_overview_entity_recent_at DESC,",
  "  CAST(substr(valid_incident.entity_id, 2, instr(valid_incident.entity_id, '.') - 2) AS INTEGER) ASC,",
  "  CAST(substr(valid_incident.entity_id, instr(valid_incident.entity_id, '.') + 1) AS INTEGER) ASC,",
  "  valid_incident.entity_id COLLATE BINARY ASC",
  "LIMIT :overview_seed_probe_limit",
].join("\n");

const selectRawCandidates = [
  "SELECT",
  "  candidate_journal.id AS recall_overview_event_id,",
  "  candidate_journal.seq AS recall_overview_statement_seq,",
  "  json_type(candidate_journal.body, '$.raw_text') AS recall_overview_raw_text_type,",
  "  json_extract(candidate_journal.body, '$.raw_text') AS recall_overview_raw_text,",
  "  json_type(candidate_journal.body, '$.parsed') AS recall_overview_parsed_type,",
  "  json_array_length(candidate_journal.body, '$.parsed') AS recall_overview_parsed_count,",
  "  candidate_journal.scope_key AS recall_overview_journal_scope_key,",
  "  candidate_journal.created_at AS recall_overview_recorded_at,",
  "  candidate_statement.scope_key AS recall_overview_statement_scope_key,",
  "  candidate_statement.state AS recall_overview_statement_state,",
  "  candidate_statement.created_at AS recall_overview_created_at,",
  "  candidate_statement.provenance AS recall_overview_provenance,",
  "  candidate_statement.expires_at AS recall_overview_statement_expires_at,",
  `  ${RECALL_VALID_GRAPH_DUPLICATE_EXISTS_SQL} AS recall_overview_has_valid_graph_duplicate`,
  "FROM statements AS candidate_statement",
  "JOIN journal AS candidate_journal",
  "  ON candidate_journal.id = candidate_statement.event_id",
  "WHERE candidate_journal.kind = 'statement'",
  "  AND candidate_journal.scope_key = :scope_key",
  "  AND candidate_statement.scope_key = :scope_key",
  "  AND candidate_statement.state = 'live'",
  "  AND (candidate_statement.expires_at IS NULL",
  "       OR candidate_statement.expires_at > :now)",
  "  AND (",
  "    json_type(candidate_journal.body, '$.raw_text') IS NOT 'text'",
  "    OR json_type(candidate_journal.body, '$.parsed') IS NOT 'array'",
  "    OR json_array_length(candidate_journal.body, '$.parsed') > 100",
  "    OR (",
  "      json_array_length(candidate_journal.body, '$.parsed') = 0",
  `      AND NOT ${RECALL_VALID_GRAPH_DUPLICATE_EXISTS_SQL}`,
  "    )",
  "  )",
  "ORDER BY candidate_statement.created_at DESC, candidate_journal.seq DESC",
  "LIMIT :overview_raw_probe_limit",
].join("\n");

export const RECALL_OVERVIEW_SQL_SOURCE: RecallOverviewSqlSource =
  Object.freeze({ selectEntityCandidates, selectRawCandidates });
