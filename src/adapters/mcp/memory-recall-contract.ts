import {
  memoryRecallInputDefinition,
  recallResultDefinition,
  type MemoryRecallInput,
  type RecallResult,
} from "../../application/index.js";

import {
  createMcpJsonSchemaContract,
  JsonSchemaValidationError,
  type McpJsonSchemaContract,
  type SchemaValidationBoundary,
} from "./json-schema-contract.js";
import type {
  DefinedJsonSchema,
  NormativeJsonSchema,
} from "../../schema/index.js";

const createUntypedContract = createMcpJsonSchemaContract as (
  definition: DefinedJsonSchema<NormativeJsonSchema>,
) => McpJsonSchemaContract<NormativeJsonSchema, unknown>;

const schemaMemoryRecallInputContract = createUntypedContract(
  memoryRecallInputDefinition as DefinedJsonSchema<NormativeJsonSchema>,
);
const typedSchemaMemoryRecallInputContract =
  schemaMemoryRecallInputContract as McpJsonSchemaContract<
    typeof memoryRecallInputDefinition.schema,
    MemoryRecallInput
  >;

function withTrimmedQuery(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const query = (value as Readonly<Record<string, unknown>>)["query"];
  return typeof query === "string"
    ? { ...value, query: query.trim() }
    : value;
}

const schemaStandardProperties =
  typedSchemaMemoryRecallInputContract.standardSchema["~standard"];
const INVALID_QUERY_BOUNDS_RESULT = Object.freeze({
  issues: Object.freeze([
    Object.freeze({
      message: "query violates a trimmed Unicode code-point bound",
    }),
  ]),
});

async function validateCanonicalMemoryRecallInput(
  value: unknown,
  options?: Parameters<typeof schemaStandardProperties.validate>[1],
) {
  const result = await schemaStandardProperties.validate(
    withTrimmedQuery(value),
    options,
  );
  if ("issues" in result) {
    return result;
  }
  const input = withInputDefaults(result.value);
  if (input.mode === "search") {
    const queryLength = Array.from(input.query).length;
    if (queryLength < 1 || queryLength > 4_096) {
      return INVALID_QUERY_BOUNDS_RESULT;
    }
  }
  return Object.freeze({ value: input });
}

const normalizedMemoryRecallStandardSchema: McpJsonSchemaContract<
  typeof memoryRecallInputDefinition.schema,
  MemoryRecallInput
>["standardSchema"] = Object.freeze({
  "~standard": Object.freeze({
    ...schemaStandardProperties,
    validate: validateCanonicalMemoryRecallInput,
  }),
});

export const memoryRecallInputContract: McpJsonSchemaContract<
  typeof memoryRecallInputDefinition.schema,
  MemoryRecallInput
> = Object.freeze({
  definition: memoryRecallInputDefinition,
  standardSchema: normalizedMemoryRecallStandardSchema,
  async validate(value: unknown, boundary: SchemaValidationBoundary) {
    const result = await validateCanonicalMemoryRecallInput(value);
    if ("issues" in result) {
      throw new JsonSchemaValidationError(boundary, result.issues.length);
    }
    return result.value;
  },
});

export const recallResultContract: McpJsonSchemaContract<
  typeof recallResultDefinition.schema,
  RecallResult
> = createUntypedContract(
  recallResultDefinition as DefinedJsonSchema<NormativeJsonSchema>,
) as McpJsonSchemaContract<typeof recallResultDefinition.schema, RecallResult>;

function withInputDefaults(input: MemoryRecallInput): MemoryRecallInput {
  if (input.mode === "overview") {
    return Object.freeze({
      mode: "overview",
      limit: input.limit ?? 10,
      detail: input.detail ?? "brief",
    });
  }

  const terms = input.terms;
  return Object.freeze({
    mode: "search",
    query: input.query,
    ...(terms === undefined ? {} : { terms: [...terms] }),
    depth: input.depth ?? 2,
    limit: input.limit ?? 10,
    detail: input.detail ?? "brief",
  });
}

export async function validateMemoryRecallInput(
  value: unknown,
): Promise<MemoryRecallInput> {
  return memoryRecallInputContract.validate(value, "input");
}

export function validateRecallResult(value: unknown): Promise<RecallResult> {
  return recallResultContract.validate(value, "output");
}
