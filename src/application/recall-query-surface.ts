import type { RecallValidClaimSource } from "./ports/recall-read-port.js";
import {
  extractRecallQueryTerms,
  type RecallQuerySurfaceSelection,
} from "../domain/recall-query-surface.js";

export interface RecallQuerySurfaceInput {
  readonly query: string;
  readonly terms?: readonly string[];
}

/** Runs inside RecallSnapshotService.withSnapshot so later stages share it. */
export function resolveRecallQuerySurface(
  source: RecallValidClaimSource,
  input: RecallQuerySurfaceInput,
): Promise<RecallQuerySurfaceSelection> {
  const terms = extractRecallQueryTerms(input);
  return source.resolveSurfaceSeeds(terms);
}
