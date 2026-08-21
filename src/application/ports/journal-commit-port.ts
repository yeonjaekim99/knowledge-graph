export type NonEmptyReadonlyArray<Value> = readonly [Value, ...Value[]];

/**
 * The sole outbound write capability available to application services.
 * Implementations must append the journal batch and apply its projection in one
 * atomic transaction. A projection-only method is intentionally absent.
 */
export interface JournalCommitPort<Intent, Receipt> {
  appendAndProject(events: NonEmptyReadonlyArray<Intent>): Promise<Receipt>;
}
