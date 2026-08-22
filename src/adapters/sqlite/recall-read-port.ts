import {
  RecallReadError,
  createRecallReadContext,
  type RecallClaimAggregate,
  type RecallFtsCandidateResult,
  type RecallFtsNote,
  type RecallFtsRawCandidate,
  type RecallFtsReachedClaimCandidate,
  type RecallFtsSeedCandidate,
  type RecallFtsTerm,
  type RecallOverviewCandidateResult,
  type RecallOverviewNote,
  type RecallOverviewSeedCandidate,
  type RecallRawCandidate,
  type RecallReadContext,
  type RecallReadPort,
  type RecallSnapshotSource,
  type RecallSnapshotOperation,
  type RecallTruncationReason,
} from "../../application/ports/recall-read-port.js";
import {
  RecallQuerySurfaceError,
  resolveRecallSurfaceSeeds,
  type RecallQueryTerm,
  type RecallSurfaceCandidateState,
  type RecallSurfaceEntityState,
} from "../../domain/recall-query-surface.js";
import type { IdentifierRedirectRow } from "../../domain/projection-identifiers.js";
import { compareOccurrenceIdentifiers } from "../../domain/projection-identifiers.js";
import {
  createRecallFtsNote,
  prepareRecallFtsQuery,
} from "../../application/recall-fts-query.js";
import { createRecallOverviewNote } from "../../application/recall-overview.js";

import {
  runSqliteRecallSnapshot,
  type SqliteConnectionFactory,
} from "./connection-factory.js";

const CLAIM_ID_PATTERN = /^c[1-9][0-9]*\.[0-9]+$/u;
const ENTITY_ID_PATTERN = /^e[1-9][0-9]*\.[0-9]+$/u;
const EVENT_ID_PATTERN = /^ev_[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
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

const FTS_CANDIDATE_ROW_KEYS: readonly string[] = Object.freeze(
  [
    "recall_fts_created_at",
    "recall_fts_event_id",
    "recall_fts_has_valid_graph_duplicate",
    "recall_fts_journal_scope_key",
    "recall_fts_parsed_count",
    "recall_fts_parsed_type",
    "recall_fts_phrase_index",
    "recall_fts_provenance",
    "recall_fts_rank",
    "recall_fts_raw_text",
    "recall_fts_raw_text_type",
    "recall_fts_recorded_at",
    "recall_fts_statement_expires_at",
    "recall_fts_statement_scope_key",
    "recall_fts_statement_seq",
    "recall_fts_statement_state",
  ].sort(),
);
const FTS_SUPPORT_ROW_KEYS: readonly string[] = Object.freeze(
  [
    "recall_fts_claim_id",
    "recall_fts_claim_origin_seq",
    "recall_fts_claim_scope_key",
    "recall_fts_claim_state",
    "recall_fts_has_object_value",
    "recall_fts_object_id",
    "recall_fts_object_merged_into",
    "recall_fts_object_scope_key",
    "recall_fts_subject_id",
    "recall_fts_subject_merged_into",
    "recall_fts_subject_scope_key",
    "recall_fts_support_draft_index",
    "recall_fts_support_event_id",
    "recall_fts_support_expires_at",
    "recall_fts_support_live",
  ].sort(),
);
const FTS_RESULT_KEYS: readonly string[] = Object.freeze([
  "candidateRows",
  "queryUnavailable",
  "supportRows",
]);
const OVERVIEW_RESULT_KEYS: readonly string[] = Object.freeze([
  "entityRows",
  "rawRows",
]);
const OVERVIEW_ENTITY_ROW_KEYS: readonly string[] = Object.freeze(
  [
    "recall_overview_entity_id",
    "recall_overview_entity_incident_count",
    "recall_overview_entity_merged_into",
    "recall_overview_entity_name",
    "recall_overview_entity_recent_at",
    "recall_overview_entity_scope_key",
  ].sort(),
);
const OVERVIEW_RAW_ROW_KEYS: readonly string[] = Object.freeze(
  [
    "recall_overview_created_at",
    "recall_overview_event_id",
    "recall_overview_has_valid_graph_duplicate",
    "recall_overview_journal_scope_key",
    "recall_overview_parsed_count",
    "recall_overview_parsed_type",
    "recall_overview_provenance",
    "recall_overview_raw_text",
    "recall_overview_raw_text_type",
    "recall_overview_recorded_at",
    "recall_overview_statement_expires_at",
    "recall_overview_statement_scope_key",
    "recall_overview_statement_seq",
    "recall_overview_statement_state",
  ].sort(),
);
const MAX_FTS_SUPPORT_ROWS = 2_100;

interface DecodedFtsStatement {
  readonly eventId: string;
  readonly statementSeq: number;
  readonly ftsRank: number;
  readonly rawText: string;
  readonly parsedCount: number;
  readonly createdAt: number;
  readonly recordedAt: number;
  readonly provenance: "user_stated" | "observed" | "inferred";
  readonly expiresAt: number | null;
  readonly hasValidGraphDuplicate: boolean;
  readonly term: RecallFtsTerm;
}

interface DecodedFtsSupport {
  readonly eventId: string;
  readonly claimId: string;
  readonly claimOriginSeq: number;
  readonly draftIndex: number;
  readonly subjectId: string;
  readonly objectId: string | null;
}

interface DecodedOverviewEntity {
  readonly entityId: string;
  readonly display: string;
  readonly incidentClaimCount: number;
  readonly lastSeenAt: number;
}

function invalidAggregate(): never {
  throw new RecallReadError("INVALID_RECALL_AGGREGATE");
}

function invalidSurfaceState(): never {
  throw new RecallReadError("INVALID_RECALL_SURFACE_STATE");
}

function invalidFtsCandidate(): never {
  throw new RecallReadError("INVALID_RECALL_FTS_CANDIDATE");
}

function invalidOverviewRequest(): never {
  throw new RecallReadError("INVALID_RECALL_OVERVIEW_REQUEST");
}

function invalidOverviewCandidate(): never {
  throw new RecallReadError("INVALID_RECALL_OVERVIEW_CANDIDATE");
}

function snapshotExactRecord(
  value: unknown,
  expectedKeys: readonly string[],
  invalid: () => never,
): Readonly<Record<string, unknown>> {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return invalid();
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return invalid();
    }
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key !== "string")) {
      return invalid();
    }
    const keys = (ownKeys as string[]).sort();
    if (
      keys.length !== expectedKeys.length ||
      !keys.every((key, index) => key === expectedKeys[index])
    ) {
      return invalid();
    }
    const snapshot: Record<string, unknown> = {};
    for (const key of expectedKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        descriptor.enumerable !== true ||
        !("value" in descriptor)
      ) {
        return invalid();
      }
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    return invalid();
  }
}

function exactRow(
  value: unknown,
): Readonly<Record<string, unknown>> {
  return snapshotExactRecord(value, ROW_KEYS, invalidAggregate);
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

function exactFtsRow(
  value: unknown,
  expectedKeys: readonly string[],
): Readonly<Record<string, unknown>> {
  return snapshotExactRecord(value, expectedKeys, invalidFtsCandidate);
}

function snapshotExactArray(
  value: unknown,
  maximumLength: number,
  invalid: () => never,
): readonly unknown[] {
  try {
    if (!Array.isArray(value)) {
      return invalid();
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (
      lengthDescriptor === undefined ||
      !("value" in lengthDescriptor) ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      Number(lengthDescriptor.value) < 0 ||
      Number(lengthDescriptor.value) > maximumLength
    ) {
      return invalid();
    }
    const length = Number(lengthDescriptor.value);
    const expectedKeys = new Set([
      "length",
      ...Array.from({ length }, (_, index) => String(index)),
    ]);
    if (
      Reflect.ownKeys(value).some(
        (key) => typeof key !== "string" || !expectedKeys.has(key),
      )
    ) {
      return invalid();
    }
    const snapshot: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (
        descriptor === undefined ||
        descriptor.enumerable !== true ||
        !("value" in descriptor)
      ) {
        return invalid();
      }
      snapshot.push(descriptor.value);
    }
    return Object.freeze(snapshot);
  } catch {
    return invalid();
  }
}

function safeEpoch(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    return invalidAggregate();
  }
  return Number(value);
}

function safeFtsEpoch(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    return invalidFtsCandidate();
  }
  return Number(value);
}

function safeOverviewEpoch(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    return invalidOverviewCandidate();
  }
  return Number(value);
}

function safeOverviewPositiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    return invalidOverviewCandidate();
  }
  return Number(value);
}

function safePositiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    return invalidFtsCandidate();
  }
  return Number(value);
}

function isBoundedStoredRawText(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return false;
  }
  let codePoints = 0;
  for (const _codePoint of trimmed) {
    codePoints += 1;
    if (codePoints > 32_768) {
      return false;
    }
  }
  return true;
}

function isBoundedOverviewText(
  value: unknown,
  maximumCodePoints: number,
): value is string {
  if (
    typeof value !== "string" ||
    !value.isWellFormed() ||
    value.trim() !== value ||
    value.length === 0
  ) {
    return false;
  }
  let count = 0;
  for (const _codePoint of value) {
    count += 1;
    if (count > maximumCodePoints) {
      return false;
    }
  }
  return true;
}

function isBoundedOverviewRawText(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !value.isWellFormed() ||
    value.trim().length === 0
  ) {
    return false;
  }
  let count = 0;
  for (const _codePoint of value.trim()) {
    count += 1;
    if (count > 32_768) {
      return false;
    }
  }
  return true;
}

function safeFtsExpiry(
  value: unknown,
  context: RecallReadContext,
): number | null {
  if (value === null) {
    return null;
  }
  const expiry = safeFtsEpoch(value);
  return expiry > context.evaluationNow ? expiry : invalidFtsCandidate();
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

function decodeFtsStatements(
  value: unknown,
  context: RecallReadContext,
  terms: readonly RecallFtsTerm[],
): readonly DecodedFtsStatement[] {
  const candidates = snapshotExactArray(value, 21, invalidFtsCandidate);
  const seenEvents: Set<string> = new Set();
  const seenSequences: Set<number> = new Set();
  const result: DecodedFtsStatement[] = [];
  for (const candidate of candidates) {
    const row = exactFtsRow(candidate, FTS_CANDIDATE_ROW_KEYS);
    const eventId = row["recall_fts_event_id"];
    const rawText = row["recall_fts_raw_text"];
    const parsedCount = row["recall_fts_parsed_count"];
    const phraseIndex = row["recall_fts_phrase_index"];
    const provenance = row["recall_fts_provenance"];
    const rank = row["recall_fts_rank"];
    const duplicate = row["recall_fts_has_valid_graph_duplicate"];
    const statementSeq = safePositiveInteger(
      row["recall_fts_statement_seq"],
    );
    const term =
      Number.isSafeInteger(phraseIndex) && Number(phraseIndex) >= 0
        ? terms[Number(phraseIndex)]
        : undefined;
    if (
      typeof eventId !== "string" ||
      !EVENT_ID_PATTERN.test(eventId) ||
      seenEvents.has(eventId) ||
      seenSequences.has(statementSeq) ||
      row["recall_fts_raw_text_type"] !== "text" ||
      typeof rawText !== "string" ||
      !isBoundedStoredRawText(rawText) ||
      row["recall_fts_parsed_type"] !== "array" ||
      !Number.isSafeInteger(parsedCount) ||
      Number(parsedCount) < 0 ||
      Number(parsedCount) > 100 ||
      term === undefined ||
      (provenance !== "user_stated" &&
        provenance !== "observed" &&
        provenance !== "inferred") ||
      typeof rank !== "number" ||
      !Number.isFinite(rank) ||
      (duplicate !== 0 && duplicate !== 1) ||
      row["recall_fts_journal_scope_key"] !== context.scopeKey ||
      row["recall_fts_statement_scope_key"] !== context.scopeKey ||
      row["recall_fts_statement_state"] !== "live"
    ) {
      return invalidFtsCandidate();
    }
    const expiresAt = safeFtsExpiry(
      row["recall_fts_statement_expires_at"],
      context,
    );
    seenEvents.add(eventId);
    seenSequences.add(statementSeq);
    result.push(
      Object.freeze({
        eventId,
        statementSeq,
        ftsRank: rank,
        rawText,
        parsedCount: Number(parsedCount),
        createdAt: safeFtsEpoch(row["recall_fts_created_at"]),
        recordedAt: safeFtsEpoch(row["recall_fts_recorded_at"]),
        provenance,
        expiresAt,
        hasValidGraphDuplicate: duplicate === 1,
        term,
      }),
    );
  }
  for (let index = 1; index < result.length; index += 1) {
    const previous = result[index - 1];
    const current = result[index];
    if (
      previous === undefined ||
      current === undefined ||
      previous.ftsRank > current.ftsRank ||
      (previous.ftsRank === current.ftsRank &&
        previous.statementSeq <= current.statementSeq)
    ) {
      return invalidFtsCandidate();
    }
  }
  return Object.freeze(result);
}

function decodeFtsSupport(
  value: unknown,
  statement: DecodedFtsStatement,
  context: RecallReadContext,
): DecodedFtsSupport {
  const row = exactFtsRow(value, FTS_SUPPORT_ROW_KEYS);
  const eventId = row["recall_fts_support_event_id"];
  const claimId = row["recall_fts_claim_id"];
  const subjectId = row["recall_fts_subject_id"];
  const objectId = row["recall_fts_object_id"];
  const draftIndex = row["recall_fts_support_draft_index"];
  const hasObjectValue = row["recall_fts_has_object_value"];
  const supportExpiry = safeFtsExpiry(
    row["recall_fts_support_expires_at"],
    context,
  );
  if (
    eventId !== statement.eventId ||
    typeof claimId !== "string" ||
    !CLAIM_ID_PATTERN.test(claimId) ||
    row["recall_fts_claim_scope_key"] !== context.scopeKey ||
    row["recall_fts_claim_state"] !== "active" ||
    typeof subjectId !== "string" ||
    !ENTITY_ID_PATTERN.test(subjectId) ||
    row["recall_fts_subject_scope_key"] !== context.scopeKey ||
    row["recall_fts_subject_merged_into"] !== null ||
    !Number.isSafeInteger(draftIndex) ||
    Number(draftIndex) < 0 ||
    Number(draftIndex) >= statement.parsedCount ||
    row["recall_fts_support_live"] !== 1 ||
    supportExpiry !== statement.expiresAt ||
    ((objectId === null && hasObjectValue !== 1) ||
      (objectId !== null && hasObjectValue !== 0)) ||
    (objectId === null
      ? row["recall_fts_object_scope_key"] !== null ||
        row["recall_fts_object_merged_into"] !== null
      : typeof objectId !== "string" ||
        !ENTITY_ID_PATTERN.test(objectId) ||
        row["recall_fts_object_scope_key"] !== context.scopeKey ||
        row["recall_fts_object_merged_into"] !== null)
  ) {
    return invalidFtsCandidate();
  }
  return Object.freeze({
    eventId,
    claimId,
    claimOriginSeq: safePositiveInteger(row["recall_fts_claim_origin_seq"]),
    draftIndex: Number(draftIndex),
    subjectId,
    objectId: objectId as string | null,
  });
}

function freezeFtsResult(
  kind: RecallFtsCandidateResult["kind"],
  terms: readonly RecallFtsTerm[],
  seeds: readonly RecallFtsSeedCandidate[],
  reachedClaims: readonly RecallFtsReachedClaimCandidate[],
  rawCandidates: readonly RecallFtsRawCandidate[],
  truncated: boolean,
  notes: readonly RecallFtsNote[],
): RecallFtsCandidateResult {
  const reasons: readonly RecallTruncationReason[] = Object.freeze(
    truncated ? ["fts_candidates"] : [],
  );
  return Object.freeze({
    kind,
    terms,
    seeds: Object.freeze([...seeds]),
    reachedClaims: Object.freeze([...reachedClaims]),
    rawCandidates: Object.freeze([...rawCandidates]),
    truncation: Object.freeze({
      reasons,
    }),
    notes: Object.freeze([...notes]),
  });
}

function assembleFtsCandidates(
  candidateRows: unknown,
  supportRows: unknown,
  context: RecallReadContext,
  terms: readonly RecallFtsTerm[],
): RecallFtsCandidateResult {
  const statements = decodeFtsStatements(candidateRows, context, terms);
  const supportCandidates = snapshotExactArray(
    supportRows,
    MAX_FTS_SUPPORT_ROWS,
    invalidFtsCandidate,
  );
  const usedStatements = statements.slice(0, 20);
  const statementsByEvent: Map<string, DecodedFtsStatement> = new Map(
    statements.map((statement) => [statement.eventId, statement]),
  );
  const supportsByEvent: Map<string, DecodedFtsSupport[]> = new Map();
  const supportIdentity: Set<string> = new Set();
  for (const value of supportCandidates) {
    const row = exactFtsRow(value, FTS_SUPPORT_ROW_KEYS);
    const eventId = row["recall_fts_support_event_id"];
    const statement =
      typeof eventId === "string" ? statementsByEvent.get(eventId) : undefined;
    if (statement === undefined) {
      return invalidFtsCandidate();
    }
    const support = decodeFtsSupport(row, statement, context);
    const identity = `${support.eventId}\u0000${support.claimId}`;
    if (supportIdentity.has(identity)) {
      return invalidFtsCandidate();
    }
    supportIdentity.add(identity);
    const group = supportsByEvent.get(support.eventId) ?? [];
    group.push(support);
    supportsByEvent.set(support.eventId, group);
  }
  for (const group of supportsByEvent.values()) {
    for (let index = 1; index < group.length; index += 1) {
      const previous = group[index - 1];
      const current = group[index];
      if (
        previous === undefined ||
        current === undefined ||
        previous.draftIndex > current.draftIndex ||
        (previous.draftIndex === current.draftIndex &&
          (previous.claimOriginSeq > current.claimOriginSeq ||
            (previous.claimOriginSeq === current.claimOriginSeq &&
              previous.claimId >= current.claimId)))
      ) {
        return invalidFtsCandidate();
      }
    }
  }
  for (const statement of statements) {
    const supportCount = supportsByEvent.get(statement.eventId)?.length ?? 0;
    if (
      (statement.parsedCount === 0 && supportCount > 0) ||
      (statement.parsedCount > 0 && supportCount === 0)
    ) {
      return invalidFtsCandidate();
    }
  }

  const seeds: RecallFtsSeedCandidate[] = [];
  const seedOrderByEntity: Map<string, number> = new Map();
  const reachedClaims: RecallFtsReachedClaimCandidate[] = [];
  const seenClaims: Set<string> = new Set();
  const rawCandidates: RecallFtsRawCandidate[] = [];
  const addSeed = (
    statement: DecodedFtsStatement,
    entityId: string,
    endpoint: "subject" | "object",
  ): number => {
    const existing = seedOrderByEntity.get(entityId);
    if (existing !== undefined) {
      return existing;
    }
    const seedOrder = seeds.length;
    seeds.push(
      Object.freeze({
        entityId,
        endpoint,
        matchedTerm: statement.term.display,
        pathLabel: `${statement.term.display} (FTS)`,
        eventId: statement.eventId,
        statementSeq: statement.statementSeq,
        ftsRank: statement.ftsRank,
      }),
    );
    seedOrderByEntity.set(entityId, seedOrder);
    return seedOrder;
  };

  for (const statement of usedStatements) {
    const supports = supportsByEvent.get(statement.eventId) ?? [];
    if (supports.length > 0) {
      for (const support of supports) {
        const subjectSeedOrder = addSeed(
          statement,
          support.subjectId,
          "subject",
        );
        if (support.objectId !== null) {
          addSeed(statement, support.objectId, "object");
        }
        if (!seenClaims.has(support.claimId)) {
          seenClaims.add(support.claimId);
          reachedClaims.push(
            Object.freeze({
              claimId: support.claimId,
              depth: 0,
              anchorEntityId: support.subjectId,
              seedEntityId: support.subjectId,
              seedOrder: subjectSeedOrder,
              matchedTerm: statement.term.display,
              eventId: statement.eventId,
              statementSeq: statement.statementSeq,
              ftsRank: statement.ftsRank,
            }),
          );
        }
      }
    } else if (
      statement.parsedCount === 0 &&
      !statement.hasValidGraphDuplicate
    ) {
      rawCandidates.push(
        Object.freeze({
          eventId: statement.eventId,
          text: statement.rawText,
          createdAt: statement.createdAt,
          recordedAt: statement.recordedAt,
          provenance: statement.provenance,
          matchedTerm: statement.term.display,
          statementSeq: statement.statementSeq,
          ftsRank: statement.ftsRank,
        }),
      );
    }
  }

  const truncated = statements.length === 21;
  return freezeFtsResult(
    "searched",
    terms,
    seeds,
    reachedClaims,
    rawCandidates,
    truncated,
    truncated
      ? Object.freeze([createRecallFtsNote("fts_candidate_limit")])
      : Object.freeze([]),
  );
}

function decodeOverviewEntityRows(
  value: unknown,
  context: RecallReadContext,
  seedLimit: number,
): Readonly<{
  candidates: readonly RecallOverviewSeedCandidate[];
  truncated: boolean;
}> {
  const rows = snapshotExactArray(value, 11, invalidOverviewCandidate);
  if (rows.length > seedLimit + 1) {
    return invalidOverviewCandidate();
  }
  const decoded: DecodedOverviewEntity[] = [];
  const seen = new Set<string>();
  for (const valueRow of rows) {
    const row = snapshotExactRecord(
      valueRow,
      OVERVIEW_ENTITY_ROW_KEYS,
      invalidOverviewCandidate,
    );
    const entityId = row["recall_overview_entity_id"];
    const display = row["recall_overview_entity_name"];
    if (
      typeof entityId !== "string" ||
      !ENTITY_ID_PATTERN.test(entityId) ||
      seen.has(entityId) ||
      !isBoundedOverviewText(display, 1_024) ||
      row["recall_overview_entity_scope_key"] !== context.scopeKey ||
      row["recall_overview_entity_merged_into"] !== null
    ) {
      return invalidOverviewCandidate();
    }
    try {
      compareOccurrenceIdentifiers(entityId, entityId, "entity");
    } catch {
      return invalidOverviewCandidate();
    }
    seen.add(entityId);
    decoded.push(
      Object.freeze({
        entityId,
        display,
        incidentClaimCount: safeOverviewPositiveInteger(
          row["recall_overview_entity_incident_count"],
        ),
        lastSeenAt: safeOverviewEpoch(
          row["recall_overview_entity_recent_at"],
        ),
      }),
    );
  }

  const compareEntities = (
    left: DecodedOverviewEntity,
    right: DecodedOverviewEntity,
  ): number => {
    if (left.incidentClaimCount !== right.incidentClaimCount) {
      return left.incidentClaimCount > right.incidentClaimCount ? -1 : 1;
    }
    if (left.lastSeenAt !== right.lastSeenAt) {
      return left.lastSeenAt > right.lastSeenAt ? -1 : 1;
    }
    try {
      return compareOccurrenceIdentifiers(
        left.entityId,
        right.entityId,
        "entity",
      );
    } catch {
      return invalidOverviewCandidate();
    }
  };
  for (let index = 1; index < decoded.length; index += 1) {
    const previous = decoded[index - 1];
    const current = decoded[index];
    if (
      previous === undefined ||
      current === undefined ||
      compareEntities(previous, current) >= 0
    ) {
      return invalidOverviewCandidate();
    }
  }

  return Object.freeze({
    candidates: Object.freeze(
      decoded.slice(0, seedLimit).map((candidate, seedOrder) =>
        Object.freeze({
          entityId: candidate.entityId,
          display: candidate.display,
          depth: 0 as const,
          seedOrder,
          incidentClaimCount: candidate.incidentClaimCount,
          lastSeenAt: candidate.lastSeenAt,
        }),
      ),
    ),
    truncated: rows.length === seedLimit + 1,
  });
}

function decodeOverviewRawRows(
  value: unknown,
  context: RecallReadContext,
  limit: number,
): Readonly<{
  candidates: readonly RecallRawCandidate[];
  truncated: boolean;
}> {
  const rows = snapshotExactArray(value, 51, invalidOverviewCandidate);
  if (rows.length > limit + 1) {
    return invalidOverviewCandidate();
  }
  const decoded: RecallRawCandidate[] = [];
  const seenEvents = new Set<string>();
  const seenSequences = new Set<number>();
  for (const valueRow of rows) {
    const row = snapshotExactRecord(
      valueRow,
      OVERVIEW_RAW_ROW_KEYS,
      invalidOverviewCandidate,
    );
    const eventId = row["recall_overview_event_id"];
    const rawText = row["recall_overview_raw_text"];
    const provenance = row["recall_overview_provenance"];
    const statementSeq = safeOverviewPositiveInteger(
      row["recall_overview_statement_seq"],
    );
    if (
      typeof eventId !== "string" ||
      !EVENT_ID_PATTERN.test(eventId) ||
      seenEvents.has(eventId) ||
      seenSequences.has(statementSeq) ||
      row["recall_overview_raw_text_type"] !== "text" ||
      !isBoundedOverviewRawText(rawText) ||
      row["recall_overview_parsed_type"] !== "array" ||
      row["recall_overview_parsed_count"] !== 0 ||
      row["recall_overview_has_valid_graph_duplicate"] !== 0 ||
      row["recall_overview_journal_scope_key"] !== context.scopeKey ||
      row["recall_overview_statement_scope_key"] !== context.scopeKey ||
      row["recall_overview_statement_state"] !== "live" ||
      (provenance !== "user_stated" &&
        provenance !== "observed" &&
        provenance !== "inferred")
    ) {
      return invalidOverviewCandidate();
    }
    const expiry = row["recall_overview_statement_expires_at"];
    if (
      expiry !== null &&
      safeOverviewEpoch(expiry) <= context.evaluationNow
    ) {
      return invalidOverviewCandidate();
    }
    seenEvents.add(eventId);
    seenSequences.add(statementSeq);
    decoded.push(
      Object.freeze({
        eventId,
        text: rawText,
        createdAt: safeOverviewEpoch(row["recall_overview_created_at"]),
        recordedAt: safeOverviewEpoch(row["recall_overview_recorded_at"]),
        provenance,
        statementSeq,
      }),
    );
  }
  for (let index = 1; index < decoded.length; index += 1) {
    const previous = decoded[index - 1];
    const current = decoded[index];
    if (
      previous === undefined ||
      current === undefined ||
      previous.createdAt < current.createdAt ||
      (previous.createdAt === current.createdAt &&
        previous.statementSeq <= current.statementSeq)
    ) {
      return invalidOverviewCandidate();
    }
  }
  return Object.freeze({
    candidates: Object.freeze(decoded.slice(0, limit)),
    truncated: rows.length === limit + 1,
  });
}

function assembleOverviewCandidates(
  rawResult: unknown,
  context: RecallReadContext,
  limit: number,
): RecallOverviewCandidateResult {
  const envelope = snapshotExactRecord(
    rawResult,
    OVERVIEW_RESULT_KEYS,
    invalidOverviewCandidate,
  );
  const entities = decodeOverviewEntityRows(
    envelope["entityRows"],
    context,
    Math.min(limit, 10),
  );
  const raws = decodeOverviewRawRows(
    envelope["rawRows"],
    context,
    limit,
  );
  const reasons: RecallTruncationReason[] = [];
  const notes: RecallOverviewNote[] = [];
  if (entities.truncated) {
    reasons.push("overview_seeds");
    notes.push(createRecallOverviewNote("overview_seed_limit"));
  }
  if (raws.truncated) {
    reasons.push("overview_raw_candidates");
    notes.push(createRecallOverviewNote("overview_raw_limit"));
  }
  return Object.freeze({
    seeds: entities.candidates,
    rawCandidates: raws.candidates,
    truncation: Object.freeze({ reasons: Object.freeze(reasons) }),
    notes: Object.freeze(notes),
  });
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
          const source: RecallSnapshotSource = Object.freeze({
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
            searchFtsCandidates: async (candidates: readonly string[]) => {
              snapshot.assertActive();
              const plan = prepareRecallFtsQuery(candidates);
              if (plan.kind === "skip") {
                return freezeFtsResult(
                  "skipped",
                  plan.terms,
                  Object.freeze([]),
                  Object.freeze([]),
                  Object.freeze([]),
                  false,
                  plan.notes,
                );
              }
              const rawResult = await snapshot.searchRawFtsRows(
                plan.matchExpression,
                plan.terms.map((term) => term.phraseLiteral),
              );
              const envelope = exactFtsRow(rawResult, FTS_RESULT_KEYS);
              const queryUnavailable = envelope["queryUnavailable"];
              if (typeof queryUnavailable !== "boolean") {
                return invalidFtsCandidate();
              }
              const candidateRows = snapshotExactArray(
                envelope["candidateRows"],
                21,
                invalidFtsCandidate,
              );
              const supportRows = snapshotExactArray(
                envelope["supportRows"],
                MAX_FTS_SUPPORT_ROWS,
                invalidFtsCandidate,
              );
              if (queryUnavailable) {
                if (
                  candidateRows.length !== 0 ||
                  supportRows.length !== 0
                ) {
                  return invalidFtsCandidate();
                }
                return freezeFtsResult(
                  "unavailable",
                  plan.terms,
                  Object.freeze([]),
                  Object.freeze([]),
                  Object.freeze([]),
                  false,
                  Object.freeze([
                    createRecallFtsNote("fts_query_unavailable"),
                  ]),
                );
              }
              return assembleFtsCandidates(
                candidateRows,
                supportRows,
                context,
                plan.terms,
              );
            },
            selectOverviewCandidates: async (suppliedLimit: number) => {
              snapshot.assertActive();
              if (
                !Number.isSafeInteger(suppliedLimit) ||
                suppliedLimit < 1 ||
                suppliedLimit > 50
              ) {
                return invalidOverviewRequest();
              }
              try {
                const rawResult = await snapshot.readRawOverviewState(
                  suppliedLimit,
                );
                return assembleOverviewCandidates(
                  rawResult,
                  context,
                  suppliedLimit,
                );
              } catch {
                return invalidOverviewCandidate();
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
