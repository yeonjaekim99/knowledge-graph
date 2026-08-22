import type { RuntimeProvider } from "./ports/runtime-provider.js";
import {
  createRecallReadContext,
  type RecallReadPort,
  type RecallSnapshotOperation,
} from "./ports/recall-read-port.js";

/**
 * Captures trusted request context once, then delegates lifecycle ownership to
 * the read port. Search/overview policy is intentionally outside RCL-001.
 */
export class RecallSnapshotService {
  readonly #runtime: RuntimeProvider;
  readonly #readPort: RecallReadPort;

  public constructor(runtime: RuntimeProvider, readPort: RecallReadPort) {
    this.#runtime = runtime;
    this.#readPort = readPort;
  }

  public async withSnapshot<Result>(
    operation: RecallSnapshotOperation<Result>,
  ): Promise<Result> {
    const snapshot = await this.#runtime.capture();
    const context = createRecallReadContext(
      snapshot.scope.scopeKey,
      snapshot.evaluationNow,
    );
    return this.#readPort.withSnapshot(context, operation);
  }
}
