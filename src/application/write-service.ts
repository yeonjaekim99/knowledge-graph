import type {
  JournalCommitPort,
  NonEmptyReadonlyArray,
} from "./ports/journal-commit-port.js";
import type { UseCase } from "./use-case.js";

export class EmptyJournalBatchError extends Error {
  public override readonly name: string = "EmptyJournalBatchError";

  public constructor() {
    super("a journal write requires at least one event intent");
  }
}

/**
 * Thin application boundary for future record/revise services. It exposes one
 * atomic append-and-project capability and cannot request projection-only writes.
 */
export class JournalWriteService<Intent, Receipt>
  implements UseCase<readonly Intent[], Receipt>
{
  readonly #commitPort: JournalCommitPort<Intent, Receipt>;

  public constructor(commitPort: JournalCommitPort<Intent, Receipt>) {
    this.#commitPort = commitPort;
  }

  public execute(events: readonly Intent[]): Promise<Receipt> {
    if (events.length === 0) {
      return Promise.reject(new EmptyJournalBatchError());
    }

    return this.#commitPort.appendAndProject(
      events as NonEmptyReadonlyArray<Intent>,
    );
  }
}
