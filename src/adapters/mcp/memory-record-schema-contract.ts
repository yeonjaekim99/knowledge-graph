import {
  RecordContractError,
  assertClaimDraftStructuralContract,
  assertMemoryRecordInputStructuralContract,
  assertRecordResultIndexCoverage,
  assertRecordResultStructuralContract,
  claimDraftSchemaDefinition,
  memoryRecordInputSchemaDefinition,
  recordResultSchemaDefinition,
} from "../../application/index.js";
import type {
  ClaimDraft,
  MemoryRecordInput,
  RecordResult,
} from "../../application/index.js";
import type { NormativeJsonSchema } from "../../schema/index.js";
import {
  JsonSchemaValidationError,
  createMcpJsonSchemaContract,
} from "./json-schema-contract.js";
import type {
  McpJsonSchemaContract,
  SchemaValidationBoundary,
} from "./json-schema-contract.js";

function withStructuralValidation<
  Schema extends NormativeJsonSchema,
  Value,
>(
  base: McpJsonSchemaContract<Schema, Value>,
  assertValue: (value: Value) => void,
): McpJsonSchemaContract<Schema, Value> {
  return Object.freeze({
    definition: base.definition,
    standardSchema: base.standardSchema,
    async validate(
      value: unknown,
      boundary: SchemaValidationBoundary,
    ): Promise<Value> {
      const validated = await base.validate(value, boundary);
      try {
        assertValue(validated);
      } catch (error: unknown) {
        if (
          error instanceof RecordContractError &&
          error.code === "TRIMMED_TEXT_BOUNDS"
        ) {
          throw new JsonSchemaValidationError(boundary, 1);
        }
        throw error;
      }
      return validated;
    },
  });
}

const baseClaimDraftContract = createMcpJsonSchemaContract(
  claimDraftSchemaDefinition,
);
const baseMemoryRecordInputContract = createMcpJsonSchemaContract(
  memoryRecordInputSchemaDefinition,
);
const baseRecordResultContract = createMcpJsonSchemaContract(
  recordResultSchemaDefinition,
);

export const claimDraftContract: McpJsonSchemaContract<
  typeof claimDraftSchemaDefinition.schema,
  ClaimDraft
> = withStructuralValidation(
  baseClaimDraftContract,
  assertClaimDraftStructuralContract,
);

export const memoryRecordInputContract: McpJsonSchemaContract<
  typeof memoryRecordInputSchemaDefinition.schema,
  MemoryRecordInput
> = withStructuralValidation(
  baseMemoryRecordInputContract,
  assertMemoryRecordInputStructuralContract,
);

export const recordResultContract: McpJsonSchemaContract<
  typeof recordResultSchemaDefinition.schema,
  RecordResult
> = withStructuralValidation(
  baseRecordResultContract,
  assertRecordResultStructuralContract,
);

export async function validateRecordResultForInput(
  input: MemoryRecordInput,
  value: unknown,
): Promise<RecordResult> {
  const result = await recordResultContract.validate(value, "output");
  assertRecordResultIndexCoverage(input, result);
  return result;
}
