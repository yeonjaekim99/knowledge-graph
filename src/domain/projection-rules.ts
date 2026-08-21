export const NORMALIZATION_VERSION = "v1" as const;

const NORMALIZATION_SEPARATOR_PATTERN = /[\p{White_Space}_-]+/gu;
const RELATION_LABEL_MAX_CODE_POINTS = 256;

export type ProjectionRuleErrorCode =
  | "INVALID_NORMALIZATION_INPUT"
  | "EMPTY_NORMALIZED_VALUE"
  | "INVALID_LITERAL_INPUT"
  | "EMPTY_LITERAL_VALUE"
  | "INVALID_RELATION"
  | "RELATION_LABEL_REQUIRED"
  | "INVALID_RELATION_LABEL";

const RULE_ERROR_MESSAGES: Readonly<Record<ProjectionRuleErrorCode, string>> =
  Object.freeze({
    INVALID_NORMALIZATION_INPUT:
      "projection normalization requires a text value",
    EMPTY_NORMALIZED_VALUE:
      "projection normalization produced an empty identity",
    INVALID_LITERAL_INPUT: "literal identity requires a text value",
    EMPTY_LITERAL_VALUE: "literal identity must not be empty",
    INVALID_RELATION: "projection relation is not part of the v1 registry",
    RELATION_LABEL_REQUIRED:
      "relates_to requires a non-empty relation label",
    INVALID_RELATION_LABEL:
      "relation label must be non-empty text within the v1 limit",
  });

export class ProjectionRuleError extends TypeError {
  public override readonly name: string = "ProjectionRuleError";
  public readonly code: ProjectionRuleErrorCode;

  public constructor(code: ProjectionRuleErrorCode) {
    super(RULE_ERROR_MESSAGES[code]);
    this.code = code;
  }
}

function reject(code: ProjectionRuleErrorCode): never {
  throw new ProjectionRuleError(code);
}

/**
 * Canonical entity and surface-form identity from ADR-006.
 * Display text stays in the journal/entity row and is never reconstructed here.
 */
export function normalizeV1(value: unknown): string {
  if (typeof value !== "string") {
    return reject("INVALID_NORMALIZATION_INPUT");
  }
  const normalized = value
    .trim()
    .normalize("NFKC")
    .toLowerCase()
    .replace(NORMALIZATION_SEPARATOR_PATTERN, "");
  if (normalized.length === 0) {
    return reject("EMPTY_NORMALIZED_VALUE");
  }
  return normalized;
}

/** Claim literal identity from ADR-009; internal text remains semantically exact. */
export function normalizeLiteralIdentity(value: unknown): string {
  if (typeof value !== "string") {
    return reject("INVALID_LITERAL_INPUT");
  }
  const normalized = value.trim().normalize("NFKC");
  if (normalized.length === 0) {
    return reject("EMPTY_LITERAL_VALUE");
  }
  return normalized;
}

export type CanonicalRelation =
  | "uses"
  | "rejects"
  | "contains"
  | "describes"
  | "relates_to";

export const CANONICAL_RELATIONS: readonly CanonicalRelation[] = Object.freeze([
  "uses",
  "rejects",
  "contains",
  "describes",
  "relates_to",
]);
export type RelationCardinality = "single" | "multiple";

export interface CanonicalRelationDefinition {
  readonly relation: CanonicalRelation;
  readonly meaning: string;
  readonly cardinality: RelationCardinality;
  readonly defaultPredicate: string;
}

function relationDefinition(
  relation: CanonicalRelation,
  meaning: string,
  cardinality: RelationCardinality,
  defaultPredicate: string,
): CanonicalRelationDefinition {
  return Object.freeze({
    relation,
    meaning,
    cardinality,
    defaultPredicate,
  });
}

export const RELATION_REGISTRY: Readonly<
  Record<CanonicalRelation, CanonicalRelationDefinition>
> = Object.freeze({
  uses: relationDefinition("uses", "의존·사용·요구", "multiple", "사용"),
  rejects: relationDefinition(
    "rejects",
    "배제·거부·탈락한 선택지",
    "multiple",
    "거부",
  ),
  contains: relationDefinition(
    "contains",
    "포함·위치·소속",
    "multiple",
    "포함",
  ),
  describes: relationDefinition(
    "describes",
    "속성 슬롯의 값 또는 상태",
    "single",
    "=",
  ),
  relates_to: relationDefinition(
    "relates_to",
    "다른 네 관계로 안전하게 분류할 수 없는 연결",
    "multiple",
    "관련",
  ),
});

const CANONICAL_RELATION_SET: ReadonlySet<string> = new Set(
  CANONICAL_RELATIONS,
);

export function getRelationDefinition(
  value: unknown,
): CanonicalRelationDefinition {
  if (typeof value !== "string" || !CANONICAL_RELATION_SET.has(value)) {
    return reject("INVALID_RELATION");
  }
  return RELATION_REGISTRY[value as CanonicalRelation];
}

/**
 * Preserve the agent's actual expression except for the normative edge trim.
 * JSON Schema maxLength counts Unicode code points rather than UTF-16 units.
 */
export function normalizeRelationLabel(
  relationValue: unknown,
  labelValue: unknown = undefined,
): string | null {
  const relation = getRelationDefinition(relationValue).relation;
  if (labelValue === undefined) {
    return relation === "relates_to"
      ? reject("RELATION_LABEL_REQUIRED")
      : null;
  }
  if (typeof labelValue !== "string") {
    return reject("INVALID_RELATION_LABEL");
  }
  const normalized = labelValue.trim();
  if (normalized.length === 0) {
    return relation === "relates_to"
      ? reject("RELATION_LABEL_REQUIRED")
      : reject("INVALID_RELATION_LABEL");
  }
  if (Array.from(normalized).length > RELATION_LABEL_MAX_CODE_POINTS) {
    return reject("INVALID_RELATION_LABEL");
  }
  return normalized;
}
