import type { RecallValidClaimSource } from "./ports/recall-read-port.js";
import {
  RecallRankingError,
  compareRecallRankedClaimStates,
  formatRecallClaimBrief,
  validateRecallRankedClaimState,
  validateRecallRankingInput,
  type RecallRankedClaimCandidate,
  type RecallRankedClaimState,
  type RecallRankingInput,
} from "../domain/recall-ranking.js";

interface RankingReaderBinding {
  readonly receiver: object;
  readonly read: (
    candidates: unknown,
    probeLimit: unknown,
  ) => unknown;
}

function invalidState(): never {
  throw new RecallRankingError("INVALID_RANKING_STATE");
}

function bindRankingReader(source: unknown): RankingReaderBinding {
  try {
    if (source === null || typeof source !== "object") {
      return invalidState();
    }
    const read: unknown = Reflect.get(source, "selectRankedClaims");
    if (typeof read !== "function") {
      return invalidState();
    }
    return Object.freeze({
      receiver: source,
      read: read as RankingReaderBinding["read"],
    });
  } catch {
    return invalidState();
  }
}

function snapshotRankedStates(
  value: unknown,
  expectedCount: number,
  totalCount: number,
  expectedDepths: ReadonlyMap<string, number>,
): readonly RecallRankedClaimState[] {
  if (!Array.isArray(value) || value.length !== expectedCount) {
    return invalidState();
  }
  const result: RecallRankedClaimState[] = [];
  const seen = new Set<string>();
  try {
    for (const candidate of value) {
      const state = validateRecallRankedClaimState(candidate);
      if (
        state.totalCount !== totalCount ||
        expectedDepths.get(state.claimId) !== state.depth ||
        seen.has(state.claimId)
      ) {
        return invalidState();
      }
      seen.add(state.claimId);
      result.push(state);
    }
  } catch {
    return invalidState();
  }
  for (let index = 1; index < result.length; index += 1) {
    const previous = result[index - 1];
    const current = result[index];
    if (
      previous === undefined ||
      current === undefined ||
      compareRecallRankedClaimStates(previous, current) >= 0
    ) {
      return invalidState();
    }
  }
  return Object.freeze(result);
}

export async function rankRecallClaims(
  source: RecallValidClaimSource,
  suppliedInput: RecallRankingInput,
): Promise<readonly RecallRankedClaimCandidate[]> {
  const input = validateRecallRankingInput(suppliedInput);
  const reader = bindRankingReader(source);
  if (input.reached.length === 0) {
    return Object.freeze([]);
  }
  const probeLimit = input.limit + 1;
  const expectedDepths = new Map(
    input.readCandidates.map(({ claimId, depth }) => [claimId, depth]),
  );
  let states: readonly RecallRankedClaimState[];
  try {
    states = snapshotRankedStates(
      await Reflect.apply(reader.read, reader.receiver, [
        input.readCandidates,
        probeLimit,
      ]),
      Math.min(input.reached.length, probeLimit),
      input.reached.length,
      expectedDepths,
    );
  } catch {
    return invalidState();
  }
  const reachedByClaim = new Map(
    input.reached.map((candidate) => [candidate.claimId, candidate]),
  );
  return Object.freeze(
    states.map((state) => {
      const reached = reachedByClaim.get(state.claimId);
      if (reached === undefined) {
        return invalidState();
      }
      return Object.freeze({
        claimId: state.claimId,
        score: state.score,
        depth: state.depth,
        seedOrder: reached.seedOrder,
        anchorId: reached.anchorId,
        text: formatRecallClaimBrief({
          subjectName: state.subjectName,
          relation: state.relation,
          relationLabel: state.relationLabel,
          objectName: state.objectName,
          objectValue: state.objectValue,
        }),
        path: reached.path,
        hops: reached.hops,
        contested: state.contested,
        supportCount: state.supportCount,
        strongestRank: state.strongestRank,
        lastSeenAt: state.lastSeenAt,
      });
    }),
  );
}

export { RecallRankingError, formatRecallClaimBrief } from "../domain/recall-ranking.js";
