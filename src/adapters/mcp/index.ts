import type { UseCase } from "../../application/index.js";

export {
  JsonSchemaValidationError,
  createMcpJsonSchemaContract,
} from "./json-schema-contract.js";
export type {
  McpJsonSchemaContract,
  SchemaValidationBoundary,
} from "./json-schema-contract.js";
export {
  claimDraftContract,
  memoryRecordInputContract,
  recordResultContract,
  validateRecordResultForInput,
} from "./memory-record-schema-contract.js";

/**
 * Inbound MCP wiring depends on application use cases only. FND-004 and MCP-003
 * replace these generic slots with the normative request and result schemas.
 */
export interface McpApplicationPorts<
  RecordInput,
  RecordOutput,
  RecallInput,
  RecallOutput,
  ReviseInput,
  ReviseOutput,
> {
  readonly record: UseCase<RecordInput, RecordOutput>;
  readonly recall: UseCase<RecallInput, RecallOutput>;
  readonly revise: UseCase<ReviseInput, ReviseOutput>;
}
