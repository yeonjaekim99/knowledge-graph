import type { ScopeKey, UnixEpochSeconds } from "./runtime-provider.js";
import type {
  RecallQuerySurfaceSelection,
  RecallQueryTerm,
} from "../../domain/recall-query-surface.js";

const SCOPE_KEY_PATTERN =
  /^u:[A-Za-z0-9._-]{1,64}\/p:[A-Za-z0-9._-]{1,64}$/u;

export type RecallReadErrorCode =
  | "INVALID_RECALL_CONTEXT"
  | "INVALID_RECALL_AGGREGATE"
  | "INVALID_RECALL_SURFACE_STATE"
  | "INVALID_RECALL_FTS_REQUEST"
  | "INVALID_RECALL_FTS_CANDIDATE"
  | "INVALID_RECALL_OVERVIEW_REQUEST"
  | "INVALID_RECALL_OVERVIEW_CANDIDATE";

const RECALL_READ_ERROR_MESSAGES: Readonly<
  Record<RecallReadErrorCode, string>
> = Object.freeze({
  INVALID_RECALL_CONTEXT:
    "recall requires a validated request scope and UTC epoch snapshot",
  INVALID_RECALL_AGGREGATE:
    "recall aggregate state does not satisfy the read contract",
  INVALID_RECALL_SURFACE_STATE:
    "recall surface state does not satisfy the read contract",
  INVALID_RECALL_FTS_REQUEST:
    "recall FTS requires one validated collection of at most ten text candidates",
  INVALID_RECALL_FTS_CANDIDATE:
    "recall FTS candidate state does not satisfy the read contract",
  INVALID_RECALL_OVERVIEW_REQUEST:
    "recall overview requires one validated result limit",
  INVALID_RECALL_OVERVIEW_CANDIDATE:
    "recall overview candidate state does not satisfy the read contract",
});

export class RecallReadError extends Error {
  public override readonly name: string = "RecallReadError";
  public readonly code: RecallReadErrorCode;

  public constructor(code: RecallReadErrorCode) {
    super(RECALL_READ_ERROR_MESSAGES[code]);
    this.code = code;
  }
}

export interface RecallReadContext {
  readonly scopeKey: ScopeKey;
  readonly evaluationNow: UnixEpochSeconds;
}

export interface RecallClaimAggregate {
  readonly claimId: string;
  readonly supportCount: number;
  readonly strongestRank: 1 | 2 | 3;
  readonly lastSeenAt: UnixEpochSeconds;
  readonly relationLabel: string | null;
  readonly effectiveExpiresAt: UnixEpochSeconds | null;
}

export type RecallFtsNoteCode =
  | "fts_terms_too_short"
  | "fts_candidate_limit"
  | "fts_query_unavailable";

export interface RecallFtsNote {
  readonly code: RecallFtsNoteCode;
  readonly text: string;
}

export interface RecallFtsTerm {
  readonly display: string;
  readonly phraseLiteral: string;
}

export interface RecallFtsSeedCandidate {
  readonly entityId: string;
  readonly endpoint: "subject" | "object";
  readonly matchedTerm: string;
  readonly pathLabel: string;
  readonly eventId: string;
  readonly statementSeq: number;
  readonly ftsRank: number;
}

export interface RecallFtsReachedClaimCandidate {
  readonly claimId: string;
  readonly depth: 0;
  readonly anchorEntityId: string;
  readonly seedEntityId: string;
  readonly seedOrder: number;
  readonly matchedTerm: string;
  readonly eventId: string;
  readonly statementSeq: number;
  readonly ftsRank: number;
}

export interface RecallRawCandidate {
  readonly eventId: string;
  readonly text: string;
  readonly createdAt: UnixEpochSeconds;
  readonly recordedAt: UnixEpochSeconds;
  readonly provenance: "user_stated" | "observed" | "inferred";
  readonly statementSeq: number;
}

export interface RecallFtsRawCandidate extends RecallRawCandidate {
  readonly matchedTerm: string;
  readonly ftsRank: number;
}

export interface RecallOverviewSeedCandidate {
  readonly entityId: string;
  readonly display: string;
  readonly depth: 0;
  readonly seedOrder: number;
  readonly incidentClaimCount: number;
  readonly lastSeenAt: UnixEpochSeconds;
}

export type RecallOverviewNoteCode =
  | "overview_seed_limit"
  | "overview_raw_limit";

export interface RecallOverviewNote {
  readonly code: RecallOverviewNoteCode;
  readonly text: string;
}

export type RecallTruncationReason =
  | "fts_candidates"
  | "overview_seeds"
  | "overview_raw_candidates";

export interface RecallTruncationLedger {
  readonly reasons: readonly RecallTruncationReason[];
}

export interface RecallFtsCandidateResult {
  readonly kind: "skipped" | "searched" | "unavailable";
  readonly terms: readonly RecallFtsTerm[];
  readonly seeds: readonly RecallFtsSeedCandidate[];
  readonly reachedClaims: readonly RecallFtsReachedClaimCandidate[];
  readonly rawCandidates: readonly RecallFtsRawCandidate[];
  readonly truncation: RecallTruncationLedger;
  readonly notes: readonly RecallFtsNote[];
}

export interface RecallOverviewCandidateResult {
  readonly seeds: readonly RecallOverviewSeedCandidate[];
  readonly rawCandidates: readonly RecallRawCandidate[];
  readonly truncation: RecallTruncationLedger;
  readonly notes: readonly RecallOverviewNote[];
}

/**
 * This is the only capability application recall stages receive. Concrete
 * adapters keep every typed lookup in the request-local snapshot; claim reads
 * remain rooted in the request-local TEMP valid-claim set.
 */
export interface RecallValidClaimSource {
  listValidClaimAggregates(): Promise<readonly RecallClaimAggregate[]>;
  resolveSurfaceSeeds(
    terms: readonly RecallQueryTerm[],
  ): Promise<RecallQuerySurfaceSelection>;
}

export interface RecallFtsCandidateSource {
  searchFtsCandidates(
    candidates: readonly string[],
  ): Promise<RecallFtsCandidateResult>;
}

export interface RecallOverviewCandidateSource {
  selectOverviewCandidates(
    limit: number,
  ): Promise<RecallOverviewCandidateResult>;
}

export interface RecallSnapshotSource
  extends RecallValidClaimSource,
    RecallFtsCandidateSource,
    RecallOverviewCandidateSource {}

export type RecallSnapshotOperation<Result> = (
  source: RecallSnapshotSource,
) => Promise<Result>;

export interface RecallReadPort {
  withSnapshot<Result>(
    context: RecallReadContext,
    operation: RecallSnapshotOperation<Result>,
  ): Promise<Result>;
}

export function createRecallReadContext(
  scopeKey: unknown,
  evaluationNow: unknown,
): RecallReadContext {
  if (
    typeof scopeKey !== "string" ||
    !SCOPE_KEY_PATTERN.test(scopeKey) ||
    !Number.isSafeInteger(evaluationNow) ||
    Number(evaluationNow) < 0
  ) {
    throw new RecallReadError("INVALID_RECALL_CONTEXT");
  }
  return Object.freeze({
    scopeKey: scopeKey as ScopeKey,
    evaluationNow: Number(evaluationNow),
  });
}
