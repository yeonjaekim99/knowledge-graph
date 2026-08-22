import {
  JSON_SCHEMA_DIALECT_2020_12,
  defineJsonSchema,
} from "../schema/index.js";
import type {
  DefinedJsonSchema,
  InferJsonSchema,
} from "../schema/index.js";

type TrimmedTextSchema<Maximum extends number> = Readonly<{
  type: "string";
  minLength: 1;
  pattern: string;
  "x-recall-trimmedCodePointMinLength": 1;
  "x-recall-trimmedCodePointMaxLength": Maximum;
}>;

type PatternStringSchema<
  Minimum extends number,
  Maximum extends number | undefined = undefined,
> = Readonly<{
  type: "string";
  minLength: Minimum;
  pattern: string;
}> &
  (Maximum extends number
    ? Readonly<{ maxLength: Maximum }>
    : Readonly<Record<never, never>>);

type EnumSchema<Values extends readonly string[]> = Readonly<{
  enum: Values;
}>;

type ConstSchema<Value extends string> = Readonly<{
  const: Value;
}>;

type ArraySchema<
  Items,
  Minimum extends number,
  Maximum extends number,
> = Readonly<{
  type: "array";
  items: Items;
  minItems: Minimum;
  maxItems: Maximum;
}>;

type ClosedObjectSchema<
  Properties extends Readonly<Record<string, unknown>>,
  Required extends readonly (keyof Properties & string)[],
> = Readonly<{
  type: "object";
  properties: Properties;
  required: Required;
  additionalProperties: false;
}>;

type OneOfSchema<Branches extends readonly unknown[]> = Readonly<{
  oneOf: Branches;
}>;

type NormativeSchemaSource<Id extends string, Shape> = Readonly<{
  $schema: typeof JSON_SCHEMA_DIALECT_2020_12;
  $id: Id;
}> &
  Shape;

const EVENT_ID_PATTERN = "^ev_[0-7][0-9A-HJKMNP-TV-Z]{25}$";
const CLAIM_ID_PATTERN = "^c[1-9][0-9]*\\.[0-9]+$";
const REINTERPRET_APPROVAL_PATTERN = "^ra_[A-Za-z0-9_-]{43}$";

/*
 * JSON Schema patterns count the trimmed payload without changing the returned
 * source string. The private runtime contracts repeat the count in plain code
 * so an SDK regex implementation change cannot weaken this trust boundary.
 */
const RAW_TEXT_SCHEMA: TrimmedTextSchema<32_768> = {
  type: "string",
  minLength: 1,
  pattern:
    "^(?![\\s\\S]*[\\uD800-\\uDFFF])\\s*\\S(?:[\\s\\S]{0,32766}\\S)?\\s*$",
  "x-recall-trimmedCodePointMinLength": 1,
  "x-recall-trimmedCodePointMaxLength": 32_768,
};

const CLAIM_TEXT_SCHEMA: TrimmedTextSchema<1_024> = {
  type: "string",
  minLength: 1,
  pattern:
    "^(?![\\s\\S]*[\\uD800-\\uDFFF])\\s*\\S(?:[\\s\\S]{0,1022}\\S)?\\s*$",
  "x-recall-trimmedCodePointMinLength": 1,
  "x-recall-trimmedCodePointMaxLength": 1_024,
};

const LABEL_OR_ALIAS_SCHEMA: TrimmedTextSchema<256> = {
  type: "string",
  minLength: 1,
  pattern:
    "^(?![\\s\\S]*[\\uD800-\\uDFFF])\\s*\\S(?:[\\s\\S]{0,254}\\S)?\\s*$",
  "x-recall-trimmedCodePointMinLength": 1,
  "x-recall-trimmedCodePointMaxLength": 256,
};

const ENTITY_KIND_SCHEMA: TrimmedTextSchema<64> = {
  type: "string",
  minLength: 1,
  pattern:
    "^(?![\\s\\S]*[\\uD800-\\uDFFF])\\s*\\S(?:[\\s\\S]{0,62}\\S)?\\s*$",
  "x-recall-trimmedCodePointMinLength": 1,
  "x-recall-trimmedCodePointMaxLength": 64,
};

const RESULT_NOTE_SCHEMA: TrimmedTextSchema<2_048> = {
  type: "string",
  minLength: 1,
  pattern:
    "^\\s*\\S(?:[\\s\\S]{0,2046}\\S)?\\s*$",
  "x-recall-trimmedCodePointMinLength": 1,
  "x-recall-trimmedCodePointMaxLength": 2_048,
};

const REGULAR_RELATIONS: readonly [
  "uses",
  "rejects",
  "contains",
  "describes",
] = [
  "uses",
  "rejects",
  "contains",
  "describes",
] as const;

const ALIAS_ARRAY_SCHEMA: ArraySchema<
  typeof LABEL_OR_ALIAS_SCHEMA,
  0,
  20
> = {
  type: "array",
  items: LABEL_OR_ALIAS_SCHEMA,
  minItems: 0,
  maxItems: 20,
};

type CommonDraftProperties = Readonly<{
  subject: typeof CLAIM_TEXT_SCHEMA;
  subject_kind: typeof ENTITY_KIND_SCHEMA;
  relation_label: typeof LABEL_OR_ALIAS_SCHEMA;
  subject_aliases: typeof ALIAS_ARRAY_SCHEMA;
}>;

const COMMON_DRAFT_PROPERTIES: CommonDraftProperties = {
  subject: CLAIM_TEXT_SCHEMA,
  subject_kind: ENTITY_KIND_SCHEMA,
  relation_label: LABEL_OR_ALIAS_SCHEMA,
  subject_aliases: ALIAS_ARRAY_SCHEMA,
};

type EntityDraftProperties = CommonDraftProperties &
  Readonly<{
    object: typeof CLAIM_TEXT_SCHEMA;
    object_kind: typeof ENTITY_KIND_SCHEMA;
    object_aliases: typeof ALIAS_ARRAY_SCHEMA;
  }>;

const ENTITY_DRAFT_PROPERTIES: EntityDraftProperties = {
  ...COMMON_DRAFT_PROPERTIES,
  object: CLAIM_TEXT_SCHEMA,
  object_kind: ENTITY_KIND_SCHEMA,
  object_aliases: ALIAS_ARRAY_SCHEMA,
};

type LiteralDraftProperties = CommonDraftProperties &
  Readonly<{
    object_value: typeof CLAIM_TEXT_SCHEMA;
  }>;

const LITERAL_DRAFT_PROPERTIES: LiteralDraftProperties = {
  ...COMMON_DRAFT_PROPERTIES,
  object_value: CLAIM_TEXT_SCHEMA,
};

type EntityRegularDraftProperties = EntityDraftProperties &
  Readonly<{ relation: EnumSchema<typeof REGULAR_RELATIONS> }>;
type EntityRelatedDraftProperties = EntityDraftProperties &
  Readonly<{ relation: ConstSchema<"relates_to"> }>;
type LiteralRegularDraftProperties = LiteralDraftProperties &
  Readonly<{ relation: EnumSchema<typeof REGULAR_RELATIONS> }>;
type LiteralRelatedDraftProperties = LiteralDraftProperties &
  Readonly<{ relation: ConstSchema<"relates_to"> }>;

type ClaimDraftObjectSchema = OneOfSchema<
  readonly [
    ClosedObjectSchema<
      EntityRegularDraftProperties,
      readonly ["subject", "relation", "object"]
    >,
    ClosedObjectSchema<
      EntityRelatedDraftProperties,
      readonly ["subject", "relation", "relation_label", "object"]
    >,
    ClosedObjectSchema<
      LiteralRegularDraftProperties,
      readonly ["subject", "relation", "object_value"]
    >,
    ClosedObjectSchema<
      LiteralRelatedDraftProperties,
      readonly ["subject", "relation", "relation_label", "object_value"]
    >,
  ]
>;

const CLAIM_DRAFT_OBJECT_SCHEMA: ClaimDraftObjectSchema = {
  oneOf: [
    {
      type: "object",
      properties: {
        ...ENTITY_DRAFT_PROPERTIES,
        relation: { enum: REGULAR_RELATIONS },
      },
      required: ["subject", "relation", "object"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        ...ENTITY_DRAFT_PROPERTIES,
        relation: { const: "relates_to" },
      },
      required: ["subject", "relation", "relation_label", "object"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        ...LITERAL_DRAFT_PROPERTIES,
        relation: { enum: REGULAR_RELATIONS },
      },
      required: ["subject", "relation", "object_value"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        ...LITERAL_DRAFT_PROPERTIES,
        relation: { const: "relates_to" },
      },
      required: ["subject", "relation", "relation_label", "object_value"],
      additionalProperties: false,
    },
  ],
};

type ClaimDraftSchemaSource = NormativeSchemaSource<
  "urn:recall:memory-record:claim-draft",
  ClaimDraftObjectSchema
>;

const CLAIM_DRAFT_SCHEMA_SOURCE: ClaimDraftSchemaSource = {
  $schema: JSON_SCHEMA_DIALECT_2020_12,
  $id: "urn:recall:memory-record:claim-draft",
  ...CLAIM_DRAFT_OBJECT_SCHEMA,
};

const CLAIMS_ARRAY_SCHEMA: ArraySchema<
  typeof CLAIM_DRAFT_OBJECT_SCHEMA,
  0,
  100
> = {
  type: "array",
  items: CLAIM_DRAFT_OBJECT_SCHEMA,
  minItems: 0,
  maxItems: 100,
};

type CommonRecordInputProperties = Readonly<{
  raw_text: typeof RAW_TEXT_SCHEMA;
  claims: typeof CLAIMS_ARRAY_SCHEMA;
  provenance: EnumSchema<
    readonly ["user_stated", "observed", "inferred"]
  >;
  ttl: EnumSchema<readonly ["session", "weeks", "permanent"]>;
}>;

const COMMON_RECORD_INPUT_PROPERTIES: CommonRecordInputProperties = {
  raw_text: RAW_TEXT_SCHEMA,
  claims: CLAIMS_ARRAY_SCHEMA,
  provenance: {
    enum: ["user_stated", "observed", "inferred"],
  },
  ttl: {
    enum: ["session", "weeks", "permanent"],
  },
};

type NormalRecordInputSchema = ClosedObjectSchema<
  CommonRecordInputProperties,
  readonly ["raw_text", "claims"]
>;
type ReinterpretRecordInputProperties = CommonRecordInputProperties &
  Readonly<{
    supersedes: PatternStringSchema<29, 29>;
    reinterpret_approval: PatternStringSchema<46, 46>;
  }>;
type ReinterpretRecordInputSchema = ClosedObjectSchema<
  ReinterpretRecordInputProperties,
  readonly [
    "raw_text",
    "claims",
    "supersedes",
    "reinterpret_approval",
  ]
>;
type MemoryRecordInputSchemaSource = NormativeSchemaSource<
  "urn:recall:memory-record:input",
  OneOfSchema<
    readonly [NormalRecordInputSchema, ReinterpretRecordInputSchema]
  >
>;

const MEMORY_RECORD_INPUT_SCHEMA_SOURCE: MemoryRecordInputSchemaSource = {
  $schema: JSON_SCHEMA_DIALECT_2020_12,
  $id: "urn:recall:memory-record:input",
  oneOf: [
    {
      type: "object",
      properties: COMMON_RECORD_INPUT_PROPERTIES,
      required: ["raw_text", "claims"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        ...COMMON_RECORD_INPUT_PROPERTIES,
        supersedes: {
          type: "string",
          minLength: 29,
          maxLength: 29,
          pattern: EVENT_ID_PATTERN,
        },
        reinterpret_approval: {
          type: "string",
          minLength: 46,
          maxLength: 46,
          pattern: REINTERPRET_APPROVAL_PATTERN,
        },
      },
      required: [
        "raw_text",
        "claims",
        "supersedes",
        "reinterpret_approval",
      ],
      additionalProperties: false,
    },
  ],
};

type ResultIndexSchema = Readonly<{
  type: "integer";
  minimum: 0;
  maximum: 99;
}>;

const RESULT_INDEX_SCHEMA: ResultIndexSchema = {
  type: "integer",
  minimum: 0,
  maximum: 99,
};

type AcceptedResultProperties = Readonly<{
  index: typeof RESULT_INDEX_SCHEMA;
  status: EnumSchema<
    readonly ["created", "reinforced", "superseded_previous"]
  >;
  claim_id: PatternStringSchema<4>;
  note: typeof RESULT_NOTE_SCHEMA;
}>;
type RejectedResultProperties = Readonly<{
  index: typeof RESULT_INDEX_SCHEMA;
  status: ConstSchema<"rejected">;
  note: typeof RESULT_NOTE_SCHEMA;
}>;
type AcceptedResultSchema = ClosedObjectSchema<
  AcceptedResultProperties,
  readonly ["index", "status", "claim_id"]
>;
type RejectedResultSchema = ClosedObjectSchema<
  RejectedResultProperties,
  readonly ["index", "status", "note"]
>;

const ACCEPTED_RESULT_SCHEMA: AcceptedResultSchema = {
  type: "object",
  properties: {
    index: RESULT_INDEX_SCHEMA,
    status: {
      enum: ["created", "reinforced", "superseded_previous"],
    },
    claim_id: {
      type: "string",
      minLength: 4,
      pattern: CLAIM_ID_PATTERN,
    },
    note: RESULT_NOTE_SCHEMA,
  },
  required: ["index", "status", "claim_id"],
  additionalProperties: false,
};

const REJECTED_RESULT_SCHEMA: RejectedResultSchema = {
  type: "object",
  properties: {
    index: RESULT_INDEX_SCHEMA,
    status: { const: "rejected" },
    note: RESULT_NOTE_SCHEMA,
  },
  required: ["index", "status", "note"],
  additionalProperties: false,
};

type RecordResultProperties = Readonly<{
  event_id: PatternStringSchema<29, 29>;
  claims: ArraySchema<
    OneOfSchema<readonly [AcceptedResultSchema, RejectedResultSchema]>,
    0,
    100
  >;
}>;
type RecordResultSchemaSource = NormativeSchemaSource<
  "urn:recall:memory-record:result",
  ClosedObjectSchema<
    RecordResultProperties,
    readonly ["event_id", "claims"]
  >
>;

const RECORD_RESULT_SCHEMA_SOURCE: RecordResultSchemaSource = {
  $schema: JSON_SCHEMA_DIALECT_2020_12,
  $id: "urn:recall:memory-record:result",
  type: "object",
  properties: {
    event_id: {
      type: "string",
      minLength: 29,
      maxLength: 29,
      pattern: EVENT_ID_PATTERN,
    },
    claims: {
      type: "array",
      minItems: 0,
      maxItems: 100,
      items: {
        oneOf: [ACCEPTED_RESULT_SCHEMA, REJECTED_RESULT_SCHEMA],
      },
    },
  },
  required: ["event_id", "claims"],
  additionalProperties: false,
};

export const claimDraftSchemaDefinition: DefinedJsonSchema<
  typeof CLAIM_DRAFT_SCHEMA_SOURCE
> = defineJsonSchema(CLAIM_DRAFT_SCHEMA_SOURCE);

export const memoryRecordInputSchemaDefinition: DefinedJsonSchema<
  typeof MEMORY_RECORD_INPUT_SCHEMA_SOURCE
> = defineJsonSchema(MEMORY_RECORD_INPUT_SCHEMA_SOURCE);

export const recordResultSchemaDefinition: DefinedJsonSchema<
  typeof RECORD_RESULT_SCHEMA_SOURCE
> = defineJsonSchema(RECORD_RESULT_SCHEMA_SOURCE);

export type ClaimDraft = InferJsonSchema<typeof CLAIM_DRAFT_SCHEMA_SOURCE>;
export type MemoryRecordInput = InferJsonSchema<
  typeof MEMORY_RECORD_INPUT_SCHEMA_SOURCE
>;
export type RecordResult = InferJsonSchema<typeof RECORD_RESULT_SCHEMA_SOURCE>;
export type RecordClaimResult = RecordResult["claims"][number];
export type RecordClaimStatus = RecordClaimResult["status"];
export type AcceptedRecordClaimStatus = Exclude<RecordClaimStatus, "rejected">;

export interface AcceptedRecordClaimStatusFacts {
  readonly supersededPrevious: boolean;
  readonly identityCreated: boolean;
}

export type RecordContractErrorCode =
  | "TRIMMED_TEXT_BOUNDS"
  | "INVALID_ACCEPTED_STATUS_FACTS"
  | "RESULT_INDEX_COVERAGE_MISMATCH";

const RECORD_CONTRACT_ERROR_MESSAGES: Readonly<
  Record<RecordContractErrorCode, string>
> = Object.freeze({
  TRIMMED_TEXT_BOUNDS:
    "record text violates a trimmed Unicode code-point bound",
  INVALID_ACCEPTED_STATUS_FACTS:
    "accepted record status facts must be explicit booleans",
  RESULT_INDEX_COVERAGE_MISMATCH:
    "record result must contain exactly one entry for every input index",
});

export class RecordContractError extends TypeError {
  public override readonly name: string = "RecordContractError";
  public readonly code: RecordContractErrorCode;

  public constructor(code: RecordContractErrorCode) {
    super(RECORD_CONTRACT_ERROR_MESSAGES[code]);
    this.code = code;
  }
}

function reject(code: RecordContractErrorCode): never {
  throw new RecordContractError(code);
}

function assertTrimmedCodePointBound(value: string, maximum: number): void {
  const length = Array.from(value.trim()).length;
  if (length < 1 || length > maximum) {
    reject("TRIMMED_TEXT_BOUNDS");
  }
}

function assertInputTextCodePointBound(value: string, maximum: number): void {
  if (!value.isWellFormed()) {
    reject("TRIMMED_TEXT_BOUNDS");
  }
  assertTrimmedCodePointBound(value, maximum);
}

export function assertClaimDraftStructuralContract(draft: ClaimDraft): void {
  assertInputTextCodePointBound(draft.subject, 1_024);
  if (draft.subject_kind !== undefined) {
    assertInputTextCodePointBound(draft.subject_kind, 64);
  }
  if (draft.relation_label !== undefined) {
    assertInputTextCodePointBound(draft.relation_label, 256);
  }
  for (const alias of draft.subject_aliases ?? []) {
    assertInputTextCodePointBound(alias, 256);
  }

  if ("object" in draft) {
    assertInputTextCodePointBound(draft.object, 1_024);
    if (draft.object_kind !== undefined) {
      assertInputTextCodePointBound(draft.object_kind, 64);
    }
    for (const alias of draft.object_aliases ?? []) {
      assertInputTextCodePointBound(alias, 256);
    }
  } else {
    assertInputTextCodePointBound(draft.object_value, 1_024);
  }
}

export function assertMemoryRecordInputStructuralContract(
  input: MemoryRecordInput,
): void {
  assertInputTextCodePointBound(input.raw_text, 32_768);
  for (const draft of input.claims) {
    assertClaimDraftStructuralContract(draft);
  }
}

export function assertRecordResultStructuralContract(
  result: RecordResult,
): void {
  for (const claim of result.claims) {
    if (claim.note !== undefined) {
      assertTrimmedCodePointBound(claim.note, 2_048);
    }
  }
}

export function assertRecordResultIndexCoverage(
  input: MemoryRecordInput,
  result: RecordResult,
): void {
  if (result.claims.length !== input.claims.length) {
    reject("RESULT_INDEX_COVERAGE_MISMATCH");
  }
  const seen = new Set<number>();
  for (const claim of result.claims) {
    if (
      !Number.isSafeInteger(claim.index) ||
      claim.index < 0 ||
      claim.index >= input.claims.length ||
      seen.has(claim.index)
    ) {
      reject("RESULT_INDEX_COVERAGE_MISMATCH");
    }
    seen.add(claim.index);
  }
  if (seen.size !== input.claims.length) {
    reject("RESULT_INDEX_COVERAGE_MISMATCH");
  }
}

export function resolveAcceptedRecordClaimStatus(
  facts: AcceptedRecordClaimStatusFacts,
): AcceptedRecordClaimStatus {
  if (
    facts === null ||
    typeof facts !== "object" ||
    typeof facts.supersededPrevious !== "boolean" ||
    typeof facts.identityCreated !== "boolean"
  ) {
    return reject("INVALID_ACCEPTED_STATUS_FACTS");
  }
  if (facts.supersededPrevious) {
    return "superseded_previous";
  }
  return facts.identityCreated ? "created" : "reinforced";
}
