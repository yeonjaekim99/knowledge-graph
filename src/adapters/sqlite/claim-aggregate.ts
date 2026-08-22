export interface ClaimAggregateSqlSource {
  readonly diagnosticSelect: string;
  readonly recallSelect: string;
  readonly createDiagnosticView: string;
  readonly dropRecallTempTable: string;
  readonly createRecallTempTable: string;
  readonly projectionValidityInvariant: string;
  readonly diagnosticContestedExpression: string;
  readonly recallContestedExpression: string;
}

function aggregateSelect(
  nowExpression: "unixepoch('now')" | ":now",
  scopePredicate: "" | "AND c.scope_key = :scope_key",
): string {
  return [
    "WITH valid_support AS (",
    "  SELECT",
    "    cs.claim_id,",
    "    cs.expires_at,",
    "    s.provenance,",
    "    s.created_at,",
    "    s.order_seq,",
    "    j.seq AS journal_seq,",
    "    cs.draft_index,",
    "    NULLIF(TRIM(json_extract(",
    "      j.body,",
    "      '$.parsed[' || cs.draft_index || '].relation_label'",
    "    )), '') AS relation_label",
    "  FROM claim_support cs",
    "  JOIN statements s ON s.event_id = cs.event_id",
    "  JOIN claims c     ON c.id = cs.claim_id",
    "  JOIN journal j    ON j.id = cs.event_id",
    "  WHERE cs.live = 1",
    "    AND s.state = 'live'",
    "    AND c.state = 'active'",
    "    AND s.scope_key = c.scope_key",
    "    AND j.scope_key = c.scope_key",
    ...(scopePredicate === "" ? [] : [`    ${scopePredicate}`]),
    `    AND (cs.expires_at IS NULL OR cs.expires_at > ${nowExpression})`,
    ")",
    "SELECT",
    "  grouped.claim_id,",
    "  COUNT(*) AS support_count,",
    "  MAX(CASE grouped.provenance",
    "        WHEN 'user_stated' THEN 3",
    "        WHEN 'observed'    THEN 2",
    "        ELSE 1 END) AS strongest_rank,",
    "  MAX(grouped.created_at) AS last_seen_at,",
    "  (",
    "    SELECT latest.relation_label",
    "    FROM valid_support latest",
    "    WHERE latest.claim_id = grouped.claim_id",
    "      AND latest.relation_label IS NOT NULL",
    "    ORDER BY latest.order_seq DESC, latest.journal_seq DESC, latest.draft_index DESC",
    "    LIMIT 1",
    "  ) AS relation_label,",
    "  CASE WHEN COUNT(*) > COUNT(grouped.expires_at)",
    "       THEN NULL",
    "       ELSE MAX(grouped.expires_at)",
    "  END AS effective_expires_at",
    "FROM valid_support grouped",
    "GROUP BY grouped.claim_id",
  ].join("\n");
}

function contestedExpression(
  aggregateTable: "claim_agg" | "recall_claim_agg",
): string {
  return [
    "CASE WHEN c.relation IN ('uses','rejects') THEN EXISTS (",
    "  SELECT 1",
    "  FROM claims x",
    `  JOIN ${aggregateTable} xa ON xa.claim_id = x.id`,
    "  WHERE x.scope_key = c.scope_key",
    "    AND x.subject_id = c.subject_id",
    "    AND x.object_id IS c.object_id",
    "    AND x.object_value IS c.object_value",
    "    AND x.relation = CASE c.relation",
    "      WHEN 'uses' THEN 'rejects'",
    "      WHEN 'rejects' THEN 'uses'",
    "    END",
    ") ELSE 0 END",
  ].join("\n");
}

const diagnosticSelect = aggregateSelect("unixepoch('now')", "");
const recallSelect = aggregateSelect(
  ":now",
  "AND c.scope_key = :scope_key",
);

const projectionValidityInvariant = [
  "SELECT",
  "  (",
  "    SELECT COUNT(*)",
  "    FROM statements s",
  "    JOIN journal j ON j.id = s.event_id",
  "    WHERE s.scope_key = :scope_key",
  "      AND (",
  "        json_type(j.body, '$.ttl') IS NOT 'text'",
  "        OR json_extract(j.body, '$.ttl') NOT IN ('session','weeks','permanent')",
  "        OR s.expires_at IS NOT CASE json_extract(j.body, '$.ttl')",
  "          WHEN 'session' THEN s.created_at + 43200",
  "          WHEN 'weeks' THEN s.created_at + 2592000",
  "          WHEN 'permanent' THEN NULL",
  "        END",
  "      )",
  "  ) AS statement_expiry_mismatch_count,",
  "  (",
  "    SELECT COUNT(*)",
  "    FROM claim_support cs",
  "    JOIN statements s ON s.event_id = cs.event_id",
  "    WHERE s.scope_key = :scope_key",
  "      AND cs.expires_at IS NOT s.expires_at",
  "  ) AS support_expiry_mismatch_count,",
  "  (",
  "    SELECT COUNT(*)",
  "    FROM (",
  "      SELECT 'statement' AS row_kind, s.event_id AS first_id, '' AS second_id",
  "      FROM statements s",
  "      JOIN journal j ON j.id = s.event_id",
  "      WHERE (s.scope_key = :scope_key OR j.scope_key = :scope_key)",
  "        AND s.scope_key IS NOT j.scope_key",
  "      UNION ALL",
  "      SELECT 'support', cs.claim_id, cs.event_id",
  "      FROM claim_support cs",
  "      JOIN claims c ON c.id = cs.claim_id",
  "      JOIN statements s ON s.event_id = cs.event_id",
  "      WHERE (c.scope_key = :scope_key OR s.scope_key = :scope_key)",
  "        AND c.scope_key IS NOT s.scope_key",
  "    ) scope_violations",
  "  ) AS scope_mismatch_count",
].join("\n");

/**
 * ADR-010's diagnostic view and per-call TEMP materialization are generated
 * from aggregateSelect so their validity predicates cannot drift apart.
 * Named values are always bound by the caller; no trusted value is interpolated.
 */
export const CLAIM_AGGREGATE_SQL_SOURCE: ClaimAggregateSqlSource =
  Object.freeze({
    diagnosticSelect,
    recallSelect,
    createDiagnosticView: `CREATE VIEW claim_agg AS\n${diagnosticSelect}`,
    dropRecallTempTable: "DROP TABLE IF EXISTS temp.recall_claim_agg",
    createRecallTempTable: `CREATE TEMP TABLE recall_claim_agg AS\n${recallSelect}`,
    projectionValidityInvariant,
    diagnosticContestedExpression: contestedExpression("claim_agg"),
    recallContestedExpression: contestedExpression("recall_claim_agg"),
  });
