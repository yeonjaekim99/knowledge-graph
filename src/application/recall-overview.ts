import {
  RecallReadError,
  type RecallOverviewCandidateResult,
  type RecallOverviewCandidateSource,
  type RecallOverviewNote,
  type RecallOverviewNoteCode,
} from "./ports/recall-read-port.js";

export const RECALL_OVERVIEW_NOTE_TEXT: Readonly<
  Record<RecallOverviewNoteCode, string>
> = Object.freeze({
  overview_seed_limit:
    "overview seed가 최대 10개로 잘렸습니다. 더 구체적인 검색으로 기억을 확인하세요.",
  overview_raw_limit:
    "overview raw 후보가 요청 limit으로 잘렸습니다. limit을 늘리거나 더 구체적으로 검색하세요.",
});

export function createRecallOverviewNote(
  code: RecallOverviewNoteCode,
): RecallOverviewNote {
  return Object.freeze({ code, text: RECALL_OVERVIEW_NOTE_TEXT[code] });
}

function invalidOverviewRequest(): never {
  throw new RecallReadError("INVALID_RECALL_OVERVIEW_REQUEST");
}

function snapshotOverviewMethod(
  value: unknown,
): RecallOverviewCandidateSource["selectOverviewCandidates"] {
  try {
    if (value === null || typeof value !== "object") {
      return invalidOverviewRequest();
    }
    const descriptor = Object.getOwnPropertyDescriptor(
      value,
      "selectOverviewCandidates",
    );
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      typeof descriptor.value !== "function"
    ) {
      return invalidOverviewRequest();
    }
    return descriptor.value as RecallOverviewCandidateSource["selectOverviewCandidates"];
  } catch {
    return invalidOverviewRequest();
  }
}

/**
 * Runs inside RecallSnapshotService.withSnapshot. It selects depth-zero seeds
 * and raw candidates only; RCL-005~007 own traversal, ranking, and Answer
 * assembly.
 */
export async function selectRecallOverviewCandidates(
  source: RecallOverviewCandidateSource,
  limit: number,
): Promise<RecallOverviewCandidateResult> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    return invalidOverviewRequest();
  }
  const method = snapshotOverviewMethod(source);
  return Reflect.apply(method, source, [limit]) as Promise<RecallOverviewCandidateResult>;
}
