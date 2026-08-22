import {
  defineJsonSchema,
  type DefinedJsonSchema,
  type InferJsonSchema,
} from "../schema/index.js";

type SearchInputSchema = Readonly<{
  type: "object";
  properties: Readonly<{
    mode: Readonly<{ const: "search"; default: "search" }>;
    query: Readonly<{
      type: "string";
      minLength: 1;
      pattern: string;
      "x-recall-trimmedCodePointMinLength": 1;
      "x-recall-trimmedCodePointMaxLength": 4096;
    }>;
    terms: Readonly<{
      type: "array";
      items: Readonly<{
        type: "string";
        minLength: 1;
        maxLength: 256;
      }>;
      maxItems: 10;
    }>;
    depth: Readonly<{
      type: "integer";
      enum: readonly [1, 2, 3];
      default: 2;
    }>;
    limit: Readonly<{
      type: "integer";
      minimum: 1;
      maximum: 50;
      default: 10;
    }>;
    detail: Readonly<{
      type: "string";
      enum: readonly ["brief", "full"];
      default: "brief";
    }>;
  }>;
  required: readonly ["query"];
  additionalProperties: false;
}>;

type OverviewInputSchema = Readonly<{
  type: "object";
  properties: Readonly<{
    mode: Readonly<{ const: "overview" }>;
    limit: Readonly<{
      type: "integer";
      minimum: 1;
      maximum: 50;
      default: 10;
    }>;
    detail: Readonly<{
      type: "string";
      enum: readonly ["brief", "full"];
      default: "brief";
    }>;
  }>;
  required: readonly ["mode"];
  additionalProperties: false;
}>;

type MemoryRecallInputSchema = Readonly<{
  $schema: "https://json-schema.org/draft/2020-12/schema";
  $id: "urn:recall:memory-recall:input:v1";
  oneOf: readonly [SearchInputSchema, OverviewInputSchema];
}>;

type WithoutDefaultAnnotations<Value> = Value extends readonly unknown[]
  ? { readonly [Index in keyof Value]: WithoutDefaultAnnotations<Value[Index]> }
  : Value extends Readonly<Record<string, unknown>>
    ? {
        readonly [Key in keyof Value as Key extends "default"
          ? never
          : Key]: WithoutDefaultAnnotations<Value[Key]>;
      }
    : Value;

const memoryRecallInputSchema: MemoryRecallInputSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "urn:recall:memory-recall:input:v1",
  oneOf: [
    {
      type: "object",
      properties: {
        mode: { const: "search", default: "search" },
        query: {
          type: "string",
          minLength: 1,
          pattern: "^\\s*\\S(?:[\\s\\S]{0,4094}\\S)?\\s*$",
          "x-recall-trimmedCodePointMinLength": 1,
          "x-recall-trimmedCodePointMaxLength": 4_096,
        },
        terms: {
          type: "array",
          items: { type: "string", minLength: 1, maxLength: 256 },
          maxItems: 10,
        },
        depth: { type: "integer", enum: [1, 2, 3], default: 2 },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 50,
          default: 10,
        },
        detail: {
          type: "string",
          enum: ["brief", "full"],
          default: "brief",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        mode: { const: "overview" },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 50,
          default: 10,
        },
        detail: {
          type: "string",
          enum: ["brief", "full"],
          default: "brief",
        },
      },
      required: ["mode"],
      additionalProperties: false,
    },
  ],
};

type ProvenanceSchema = Readonly<{
  type: "string";
  enum: readonly ["user_stated", "observed", "inferred"];
}>;
type UtcSecondsSchema = Readonly<{
  type: "string";
  format: "date-time";
  pattern: string;
}>;
type EventIdSchema = Readonly<{ type: "string"; pattern: string }>;
type ClaimIdSchema = Readonly<{ type: "string"; pattern: string }>;

const provenanceSchema: ProvenanceSchema = {
  type: "string",
  enum: ["user_stated", "observed", "inferred"],
};
const utcSecondsSchema: UtcSecondsSchema = {
  type: "string",
  format: "date-time",
  pattern:
    "^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]Z$",
};
const eventIdSchema: EventIdSchema = {
  type: "string",
  pattern: "^ev_[0-7][0-9A-HJKMNP-TV-Z]{25}$",
};
const claimIdSchema: ClaimIdSchema = {
  type: "string",
  pattern: "^c[1-9][0-9]*\\.[0-9]+$",
};

type SupportSchema = Readonly<{
  type: "object";
  properties: Readonly<{
    count: Readonly<{ type: "integer"; minimum: 1 }>;
    strongest: ProvenanceSchema;
    last_seen: UtcSecondsSchema;
  }>;
  required: readonly ["count", "strongest", "last_seen"];
  additionalProperties: false;
}>;

type DetailStatementSchema = Readonly<{
  type: "object";
  properties: Readonly<{
    event_id: EventIdSchema;
    raw_text: Readonly<{ type: "string" }>;
    provenance: ProvenanceSchema;
    created_at: UtcSecondsSchema;
    recorded_at: UtcSecondsSchema;
    actor: Readonly<{
      type: "string";
      minLength: 1;
      maxLength: 128;
    }>;
    branch: Readonly<{ type: "string"; minLength: 1 }>;
  }>;
  required: readonly [
    "event_id",
    "raw_text",
    "provenance",
    "created_at",
    "recorded_at",
  ];
  additionalProperties: false;
}>;

type DetailSchema = Readonly<{
  type: "object";
  properties: Readonly<{
    statements: Readonly<{
      type: "array";
      items: Readonly<{ $ref: "#/$defs/detailStatement" }>;
      maxItems: 100;
    }>;
    more_available: Readonly<{ type: "boolean" }>;
  }>;
  required: readonly ["statements", "more_available"];
  additionalProperties: false;
}>;

type ClaimAnswerSchema = Readonly<{
  type: "object";
  properties: Readonly<{
    kind: Readonly<{ const: "claim" }>;
    claim_id: ClaimIdSchema;
    text: Readonly<{ type: "string" }>;
    path: Readonly<{ type: "string" }>;
    hops: Readonly<{ type: "integer"; minimum: 0; maximum: 4 }>;
    contested: Readonly<{ type: "boolean" }>;
    support: Readonly<{ $ref: "#/$defs/support" }>;
    detail: Readonly<{ $ref: "#/$defs/detail" }>;
  }>;
  required: readonly [
    "kind",
    "claim_id",
    "text",
    "path",
    "hops",
    "contested",
    "support",
  ];
  additionalProperties: false;
}>;

type RawAnswerSchema = Readonly<{
  type: "object";
  properties: Readonly<{
    kind: Readonly<{ const: "raw" }>;
    event_id: EventIdSchema;
    text: Readonly<{ type: "string" }>;
    created_at: UtcSecondsSchema;
    recorded_at: UtcSecondsSchema;
    provenance: ProvenanceSchema;
  }>;
  required: readonly [
    "kind",
    "event_id",
    "text",
    "created_at",
    "recorded_at",
    "provenance",
  ];
  additionalProperties: false;
}>;

type RecallResultSchema = Readonly<{
  $schema: "https://json-schema.org/draft/2020-12/schema";
  $id: "urn:recall:memory-recall:result:v1";
  type: "object";
  $defs: Readonly<{
    support: SupportSchema;
    detailStatement: DetailStatementSchema;
    detail: DetailSchema;
    claimAnswer: ClaimAnswerSchema;
    rawAnswer: RawAnswerSchema;
  }>;
  properties: Readonly<{
    answers: Readonly<{
      type: "array";
      items: Readonly<{
        oneOf: readonly [
          Readonly<{ $ref: "#/$defs/claimAnswer" }>,
          Readonly<{ $ref: "#/$defs/rawAnswer" }>,
        ];
      }>;
      maxItems: 50;
    }>;
    entry: Readonly<{
      type: "string";
      enum: readonly ["surface", "fts", "overview", "none"];
    }>;
    more_available: Readonly<{ type: "boolean" }>;
    note: Readonly<{ type: "string"; minLength: 1 }>;
  }>;
  required: readonly ["answers", "entry", "more_available"];
  additionalProperties: false;
}>;

const recallResultSchema: RecallResultSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "urn:recall:memory-recall:result:v1",
  type: "object",
  $defs: {
    support: {
      type: "object",
      properties: {
        count: { type: "integer", minimum: 1 },
        strongest: provenanceSchema,
        last_seen: utcSecondsSchema,
      },
      required: ["count", "strongest", "last_seen"],
      additionalProperties: false,
    },
    detailStatement: {
      type: "object",
      properties: {
        event_id: eventIdSchema,
        raw_text: { type: "string" },
        provenance: provenanceSchema,
        created_at: utcSecondsSchema,
        recorded_at: utcSecondsSchema,
        actor: { type: "string", minLength: 1, maxLength: 128 },
        branch: { type: "string", minLength: 1 },
      },
      required: [
        "event_id",
        "raw_text",
        "provenance",
        "created_at",
        "recorded_at",
      ],
      additionalProperties: false,
    },
    detail: {
      type: "object",
      properties: {
        statements: {
          type: "array",
          items: { $ref: "#/$defs/detailStatement" },
          maxItems: 100,
        },
        more_available: { type: "boolean" },
      },
      required: ["statements", "more_available"],
      additionalProperties: false,
    },
    claimAnswer: {
      type: "object",
      properties: {
        kind: { const: "claim" },
        claim_id: claimIdSchema,
        text: { type: "string" },
        path: { type: "string" },
        hops: { type: "integer", minimum: 0, maximum: 4 },
        contested: { type: "boolean" },
        support: { $ref: "#/$defs/support" },
        detail: { $ref: "#/$defs/detail" },
      },
      required: [
        "kind",
        "claim_id",
        "text",
        "path",
        "hops",
        "contested",
        "support",
      ],
      additionalProperties: false,
    },
    rawAnswer: {
      type: "object",
      properties: {
        kind: { const: "raw" },
        event_id: eventIdSchema,
        text: { type: "string" },
        created_at: utcSecondsSchema,
        recorded_at: utcSecondsSchema,
        provenance: provenanceSchema,
      },
      required: [
        "kind",
        "event_id",
        "text",
        "created_at",
        "recorded_at",
        "provenance",
      ],
      additionalProperties: false,
    },
  },
  properties: {
    answers: {
      type: "array",
      items: {
        oneOf: [
          { $ref: "#/$defs/claimAnswer" },
          { $ref: "#/$defs/rawAnswer" },
        ],
      },
      maxItems: 50,
    },
    entry: {
      type: "string",
      enum: ["surface", "fts", "overview", "none"],
    },
    more_available: { type: "boolean" },
    note: { type: "string", minLength: 1 },
  },
  required: ["answers", "entry", "more_available"],
  additionalProperties: false,
};

export const memoryRecallInputDefinition: DefinedJsonSchema<
  MemoryRecallInputSchema
> = defineJsonSchema(memoryRecallInputSchema);

export const recallResultDefinition: DefinedJsonSchema<RecallResultSchema> =
  defineJsonSchema(recallResultSchema);

export type MemoryRecallInput = InferJsonSchema<
  WithoutDefaultAnnotations<MemoryRecallInputSchema>
>;
export type RecallResult = InferJsonSchema<RecallResultSchema>;
