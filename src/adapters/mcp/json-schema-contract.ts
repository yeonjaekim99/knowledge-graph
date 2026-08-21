import {
  fromJsonSchema,
  type JsonSchemaType,
  type StandardSchemaWithJSON,
} from "@modelcontextprotocol/server";

import type {
  DefinedJsonSchema,
  InferJsonSchema,
  NormativeJsonSchema,
} from "../../schema/index.js";

export type SchemaValidationBoundary = "input" | "output";

export class JsonSchemaValidationError extends Error {
  readonly code: "SCHEMA_VALIDATION_FAILED";
  readonly boundary: SchemaValidationBoundary;
  readonly issueCount: number;

  constructor(boundary: SchemaValidationBoundary, issueCount: number) {
    super(`${boundary} does not satisfy its JSON Schema contract`);
    this.name = "JsonSchemaValidationError";
    this.code = "SCHEMA_VALIDATION_FAILED";
    this.boundary = boundary;
    this.issueCount = issueCount;
  }
}

export interface McpJsonSchemaContract<
  Schema extends NormativeJsonSchema,
  Value,
> {
  readonly definition: DefinedJsonSchema<Schema>;
  readonly standardSchema: StandardSchemaWithJSON<Value, Value>;
  validate(
    value: unknown,
    boundary: SchemaValidationBoundary,
  ): Promise<Value>;
}

export function createMcpJsonSchemaContract<
  const Schema extends NormativeJsonSchema,
>(
  definition: DefinedJsonSchema<Schema>,
): McpJsonSchemaContract<Schema, InferJsonSchema<Schema>>;
export function createMcpJsonSchemaContract(
  definition: DefinedJsonSchema<NormativeJsonSchema>,
): McpJsonSchemaContract<NormativeJsonSchema, unknown> {
  const standardSchema = fromJsonSchema<unknown>(
    definition.schema as unknown as JsonSchemaType,
  );
  const contract: McpJsonSchemaContract<NormativeJsonSchema, unknown> = {
    definition,
    standardSchema,
    async validate(value, boundary) {
      const result = await standardSchema["~standard"].validate(value);
      if (result.issues !== undefined) {
        throw new JsonSchemaValidationError(boundary, result.issues.length);
      }
      return result.value;
    },
  };
  return Object.freeze(contract);
}
