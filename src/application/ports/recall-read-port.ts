import type { ScopeKey, UnixEpochSeconds } from "./runtime-provider.js";

const SCOPE_KEY_PATTERN =
  /^u:[A-Za-z0-9._-]{1,64}\/p:[A-Za-z0-9._-]{1,64}$/u;

export type RecallReadErrorCode =
  | "INVALID_RECALL_CONTEXT"
  | "INVALID_RECALL_AGGREGATE";

const RECALL_READ_ERROR_MESSAGES: Readonly<
  Record<RecallReadErrorCode, string>
> = Object.freeze({
  INVALID_RECALL_CONTEXT:
    "recall requires a validated request scope and UTC epoch snapshot",
  INVALID_RECALL_AGGREGATE:
    "recall aggregate state does not satisfy the read contract",
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

/**
 * This is the only capability application recall stages receive. Concrete
 * adapters may read projection rows only through methods rooted in the
 * request-local TEMP valid-claim set.
 */
export interface RecallValidClaimSource {
  listValidClaimAggregates(): Promise<readonly RecallClaimAggregate[]>;
}

export type RecallSnapshotOperation<Result> = (
  source: RecallValidClaimSource,
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
