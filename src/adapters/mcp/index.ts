import type { UseCase } from "../../application/index.js";

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
