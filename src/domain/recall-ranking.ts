import {
  ProjectionIdentifierError,
  assertCanonicalIdentifier,
  compareOccurrenceIdentifiers,
} from "./projection-identifiers.js";
import {
  ProjectionRuleError,
  getRelationDefinition,
  normalizeLiteralIdentity,
  type CanonicalRelation,
} from "./projection-rules.js";
import type { RecallReachedClaim } from "./recall-graph-traversal.js";

const CLAIM_ID_PARTS = /^c([1-9][0-9]*)\.([0-9]+)$/u;
const MAX_REACHED_CLAIMS = 41_896_500;
const MAX_PATH_CODE_POINTS = 8_192;

export type RecallRankingErrorCode =
  | "INVALID_RANKING_INPUT"
  | "INVALID_RANKING_STATE";

const ERROR_MESSAGES: Readonly<Record<RecallRankingErrorCode, string>> =
  Object.freeze({
    INVALID_RANKING_INPUT:
      "recall ranking input does not satisfy the bounded reached-claim contract",
    INVALID_RANKING_STATE:
      "recall ranking state does not satisfy aggregate-backed invariants",
  });

export class RecallRankingError extends TypeError {
  public override readonly name: string = "RecallRankingError";
  public readonly code: RecallRankingErrorCode;

  public constructor(code: RecallRankingErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.code = code;
  }
}

function reject(code: RecallRankingErrorCode): never {
  throw new RecallRankingError(code);
}

function snapshotRecord(
  value: unknown,
  expectedKeys: readonly string[],
  code: RecallRankingErrorCode,
): Readonly<Record<string, unknown>> {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return reject(code);
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return reject(code);
    }
    const keys = Reflect.ownKeys(value);
    if (
      keys.some((key) => typeof key !== "string") ||
      keys.length !== expectedKeys.length ||
      !expectedKeys.every((key) => keys.includes(key))
    ) {
      return reject(code);
    }
    const snapshot: Record<string, unknown> = {};
    for (const key of expectedKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        descriptor.enumerable !== true ||
        !("value" in descriptor)
      ) {
        return reject(code);
      }
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    return reject(code);
  }
}

function snapshotArray(
  value: unknown,
  maximumLength: number,
  code: RecallRankingErrorCode,
): readonly unknown[] {
  try {
    if (!Array.isArray(value)) {
      return reject(code);
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (
      lengthDescriptor === undefined ||
      !("value" in lengthDescriptor) ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      Number(lengthDescriptor.value) < 0 ||
      Number(lengthDescriptor.value) > maximumLength
    ) {
      return reject(code);
    }
    const length = Number(lengthDescriptor.value);
    const keys = Reflect.ownKeys(value);
    if (
      keys.some((key) => typeof key !== "string") ||
      keys.length !== length + 1
    ) {
      return reject(code);
    }
    const snapshot: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (
        descriptor === undefined ||
        descriptor.enumerable !== true ||
        !("value" in descriptor)
      ) {
        return reject(code);
      }
      snapshot.push(descriptor.value);
    }
    return Object.freeze(snapshot);
  } catch {
    return reject(code);
  }
}

function canonicalIdentifier(
  value: unknown,
  kind: "claim" | "entity",
  code: RecallRankingErrorCode,
): string {
  try {
    return assertCanonicalIdentifier(value, kind);
  } catch (error: unknown) {
    if (error instanceof ProjectionIdentifierError) {
      return reject(code);
    }
    throw error;
  }
}

function scalarText(
  value: unknown,
  maximumCodePoints: number,
  code: RecallRankingErrorCode,
): string {
  if (
    typeof value !== "string" ||
    !value.isWellFormed() ||
    value.length === 0 ||
    value.trim() !== value ||
    Array.from(value).length > maximumCodePoints
  ) {
    return reject(code);
  }
  return value;
}

function canonicalLiteralText(
  value: unknown,
  code: RecallRankingErrorCode,
): string {
  const literal = scalarText(value, 1_024, code);
  let normalized: string;
  try {
    normalized = normalizeLiteralIdentity(literal);
  } catch (error: unknown) {
    if (error instanceof ProjectionRuleError) {
      return reject(code);
    }
    throw error;
  }
  if (normalized !== literal) {
    return reject(code);
  }
  return literal;
}

function safeInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  code: RecallRankingErrorCode,
): number {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < minimum ||
    Number(value) > maximum
  ) {
    return reject(code);
  }
  return Number(value);
}

function canonicalRelation(
  value: unknown,
  code: RecallRankingErrorCode,
): CanonicalRelation {
  try {
    return getRelationDefinition(value).relation;
  } catch (error: unknown) {
    if (error instanceof ProjectionRuleError) {
      return reject(code);
    }
    throw error;
  }
}

export interface RecallRankingReadCandidate {
  readonly claimId: string;
  readonly depth: 0 | 1 | 2 | 3;
}

export interface RecallRankingInput {
  readonly limit: number;
  readonly reached: readonly RecallReachedClaim[];
}

export interface ValidatedRecallRankingInput {
  readonly limit: number;
  readonly reached: readonly RecallReachedClaim[];
  readonly readCandidates: readonly RecallRankingReadCandidate[];
}

function validateReachedClaim(value: unknown): RecallReachedClaim {
  const row = snapshotRecord(
    value,
    ["anchorId", "claimId", "depth", "hops", "path", "seedOrder"],
    "INVALID_RANKING_INPUT",
  );
  const depth = safeInteger(
    row["depth"],
    0,
    3,
    "INVALID_RANKING_INPUT",
  ) as 0 | 1 | 2 | 3;
  return Object.freeze({
    claimId: canonicalIdentifier(
      row["claimId"],
      "claim",
      "INVALID_RANKING_INPUT",
    ),
    depth,
    seedOrder: safeInteger(
      row["seedOrder"],
      0,
      49,
      "INVALID_RANKING_INPUT",
    ),
    anchorId: canonicalIdentifier(
      row["anchorId"],
      "entity",
      "INVALID_RANKING_INPUT",
    ),
    path: scalarText(
      row["path"],
      MAX_PATH_CODE_POINTS,
      "INVALID_RANKING_INPUT",
    ),
    hops: safeInteger(row["hops"], 0, 4, "INVALID_RANKING_INPUT"),
  });
}

export function validateRecallRankingInput(
  value: unknown,
): ValidatedRecallRankingInput {
  const input = snapshotRecord(
    value,
    ["limit", "reached"],
    "INVALID_RANKING_INPUT",
  );
  const limit = safeInteger(
    input["limit"],
    1,
    50,
    "INVALID_RANKING_INPUT",
  );
  const reached = Object.freeze(
    snapshotArray(
      input["reached"],
      MAX_REACHED_CLAIMS,
      "INVALID_RANKING_INPUT",
    ).map(validateReachedClaim),
  );
  const seen = new Set<string>();
  for (const candidate of reached) {
    if (seen.has(candidate.claimId)) {
      return reject("INVALID_RANKING_INPUT");
    }
    seen.add(candidate.claimId);
  }
  return Object.freeze({
    limit,
    reached,
    readCandidates: Object.freeze(
      reached.map(({ claimId, depth }) => Object.freeze({
        claimId,
        depth: depth as 0 | 1 | 2 | 3,
      })),
    ),
  });
}

export interface RecallClaimBriefParts {
  readonly subjectName: string;
  readonly relation: CanonicalRelation;
  readonly relationLabel: string | null;
  readonly objectName: string | null;
  readonly objectValue: string | null;
}

function validateBriefParts(value: unknown): RecallClaimBriefParts {
  const row = snapshotRecord(
    value,
    [
      "objectName",
      "objectValue",
      "relation",
      "relationLabel",
      "subjectName",
    ],
    "INVALID_RANKING_STATE",
  );
  const objectName =
    row["objectName"] === null
      ? null
      : scalarText(row["objectName"], 1_024, "INVALID_RANKING_STATE");
  const objectValue =
    row["objectValue"] === null
      ? null
      : canonicalLiteralText(row["objectValue"], "INVALID_RANKING_STATE");
  if ((objectName === null) === (objectValue === null)) {
    return reject("INVALID_RANKING_STATE");
  }
  return Object.freeze({
    subjectName: scalarText(
      row["subjectName"],
      1_024,
      "INVALID_RANKING_STATE",
    ),
    relation: canonicalRelation(row["relation"], "INVALID_RANKING_STATE"),
    relationLabel:
      row["relationLabel"] === null
        ? null
        : scalarText(
            row["relationLabel"],
            256,
            "INVALID_RANKING_STATE",
          ),
    objectName,
    objectValue,
  });
}

export function formatRecallClaimBrief(value: RecallClaimBriefParts): string;
export function formatRecallClaimBrief(value: unknown): string {
  const parts = validateBriefParts(value);
  const predicate =
    parts.relationLabel ?? getRelationDefinition(parts.relation).defaultPredicate;
  return `${parts.subjectName} ${predicate} ${parts.objectName ?? parts.objectValue}`;
}

export interface RecallRankedClaimState extends RecallClaimBriefParts {
  readonly claimId: string;
  readonly depth: 0 | 1 | 2 | 3;
  readonly score: number;
  readonly subjectId: string;
  readonly objectId: string | null;
  readonly supportCount: number;
  readonly strongestRank: 1 | 2 | 3;
  readonly lastSeenAt: number;
  readonly contested: boolean;
  readonly recent: boolean;
  readonly originSeq: number;
  readonly totalCount: number;
}

const RANKED_STATE_KEYS = Object.freeze([
  "claimId",
  "contested",
  "depth",
  "lastSeenAt",
  "objectId",
  "objectName",
  "objectValue",
  "originSeq",
  "recent",
  "relation",
  "relationLabel",
  "score",
  "strongestRank",
  "subjectId",
  "subjectName",
  "supportCount",
  "totalCount",
]);

export function validateRecallRankedClaimState(
  value: unknown,
): RecallRankedClaimState {
  const row = snapshotRecord(
    value,
    RANKED_STATE_KEYS,
    "INVALID_RANKING_STATE",
  );
  const brief = validateBriefParts({
    subjectName: row["subjectName"],
    relation: row["relation"],
    relationLabel: row["relationLabel"],
    objectName: row["objectName"],
    objectValue: row["objectValue"],
  });
  const claimId = canonicalIdentifier(
    row["claimId"],
    "claim",
    "INVALID_RANKING_STATE",
  );
  const subjectId = canonicalIdentifier(
    row["subjectId"],
    "entity",
    "INVALID_RANKING_STATE",
  );
  const objectId =
    row["objectId"] === null
      ? null
      : canonicalIdentifier(
          row["objectId"],
          "entity",
          "INVALID_RANKING_STATE",
        );
  if ((objectId === null) !== (brief.objectName === null)) {
    return reject("INVALID_RANKING_STATE");
  }
  const depth = safeInteger(
    row["depth"],
    0,
    3,
    "INVALID_RANKING_STATE",
  ) as 0 | 1 | 2 | 3;
  const supportCount = safeInteger(
    row["supportCount"],
    1,
    Number.MAX_SAFE_INTEGER,
    "INVALID_RANKING_STATE",
  );
  const strongestRank = row["strongestRank"];
  if (strongestRank !== 1 && strongestRank !== 2 && strongestRank !== 3) {
    return reject("INVALID_RANKING_STATE");
  }
  const contested = row["contested"];
  const recent = row["recent"];
  if (typeof contested !== "boolean" || typeof recent !== "boolean") {
    return reject("INVALID_RANKING_STATE");
  }
  if (
    contested &&
    brief.relation !== "uses" &&
    brief.relation !== "rejects"
  ) {
    return reject("INVALID_RANKING_STATE");
  }
  const originSeq = safeInteger(
    row["originSeq"],
    1,
    Number.MAX_SAFE_INTEGER,
    "INVALID_RANKING_STATE",
  );
  const parts = CLAIM_ID_PARTS.exec(claimId);
  if (parts?.[1] === undefined || BigInt(parts[1]) !== BigInt(originSeq)) {
    return reject("INVALID_RANKING_STATE");
  }
  const expectedScore =
    -2 * depth +
    (strongestRank === 3 ? 6 : strongestRank === 2 ? 4 : 1) +
    Math.min(supportCount, 4) +
    (recent ? 2 : 0) -
    (contested ? 3 : 0);
  const score = safeInteger(
    row["score"],
    -9,
    12,
    "INVALID_RANKING_STATE",
  );
  if (score !== expectedScore) {
    return reject("INVALID_RANKING_STATE");
  }
  return Object.freeze({
    claimId,
    depth,
    score,
    subjectId,
    subjectName: brief.subjectName,
    relation: brief.relation,
    objectId,
    objectName: brief.objectName,
    objectValue: brief.objectValue,
    supportCount,
    strongestRank,
    lastSeenAt: safeInteger(
      row["lastSeenAt"],
      0,
      Number.MAX_SAFE_INTEGER,
      "INVALID_RANKING_STATE",
    ),
    relationLabel: brief.relationLabel,
    contested,
    recent,
    originSeq,
    totalCount: safeInteger(
      row["totalCount"],
      1,
      MAX_REACHED_CLAIMS,
      "INVALID_RANKING_STATE",
    ),
  });
}

export function compareRecallRankedClaimStates(
  left: RecallRankedClaimState,
  right: RecallRankedClaimState,
): number {
  return (
    right.score - left.score ||
    left.depth - right.depth ||
    right.strongestRank - left.strongestRank ||
    right.supportCount - left.supportCount ||
    (left.lastSeenAt === right.lastSeenAt
      ? 0
      : left.lastSeenAt > right.lastSeenAt
        ? -1
        : 1) ||
    left.originSeq - right.originSeq ||
    compareOccurrenceIdentifiers(left.claimId, right.claimId, "claim")
  );
}

export interface RecallRankedClaimCandidate {
  readonly claimId: string;
  readonly score: number;
  readonly depth: 0 | 1 | 2 | 3;
  readonly seedOrder: number;
  readonly anchorId: string;
  readonly text: string;
  readonly path: string;
  readonly hops: number;
  readonly contested: boolean;
  readonly supportCount: number;
  readonly strongestRank: 1 | 2 | 3;
  readonly lastSeenAt: number;
}
