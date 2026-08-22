import { normalizeV1 } from "../domain/projection-rules.js";
import {
  RecallReadError,
  type RecallFtsNote,
  type RecallFtsNoteCode,
  type RecallFtsTerm,
} from "./ports/recall-read-port.js";

const FTS_CANDIDATE_LIMIT = 10;
const FTS_CANDIDATE_MAX_CODE_POINTS = 4_096;
const FTS_MINIMUM_NORMALIZED_CODE_POINTS = 3;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/gu;
const EMPTY_TERMS: readonly RecallFtsTerm[] = Object.freeze([]);

export const RECALL_FTS_NOTE_TEXT: Readonly<
  Record<RecallFtsNoteCode, string>
> = Object.freeze({
  fts_terms_too_short:
    "FTS 검색은 정규화 후 세 글자 이상의 표현이 필요합니다. 더 긴 query 또는 terms로 다시 검색하세요.",
  fts_candidate_limit:
    "FTS 후보가 20개로 잘렸습니다. 더 구체적인 query 또는 terms로 다시 검색하세요.",
  fts_query_unavailable:
    "FTS 검색식을 처리할 수 없습니다. 제어 문자나 따옴표를 제거하거나 더 단순한 terms로 다시 검색하세요.",
});

export interface RecallFtsSkipPlan {
  readonly kind: "skip";
  readonly terms: readonly RecallFtsTerm[];
  readonly matchExpression: null;
  readonly notes: readonly RecallFtsNote[];
}

export interface RecallFtsQueryPlan {
  readonly kind: "query";
  readonly terms: readonly RecallFtsTerm[];
  readonly matchExpression: string;
  readonly notes: readonly RecallFtsNote[];
}

export type RecallFtsPlan = RecallFtsSkipPlan | RecallFtsQueryPlan;

export function createRecallFtsNote(code: RecallFtsNoteCode): RecallFtsNote {
  return Object.freeze({ code, text: RECALL_FTS_NOTE_TEXT[code] });
}

function invalidRequest(): never {
  throw new RecallReadError("INVALID_RECALL_FTS_REQUEST");
}

function sanitizeDisplay(value: string): string {
  return value.replace(CONTROL_CHARACTER_PATTERN, "").trim();
}

function quotedPhraseLiteral(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function codePointLength(value: string): number {
  return [...value].length;
}

/**
 * Converts bounded user-controlled candidates into FTS5 phrase literals.
 * Display text remains distinct from normalize_v1, which is used only for the
 * trigram length gate and deterministic duplicate removal.
 */
export function prepareRecallFtsQuery(value: unknown): RecallFtsPlan {
  if (
    !Array.isArray(value) ||
    value.length > FTS_CANDIDATE_LIMIT ||
    !value.every(
      (candidate) =>
        typeof candidate === "string" &&
        codePointLength(candidate) <= FTS_CANDIDATE_MAX_CODE_POINTS,
    )
  ) {
    return invalidRequest();
  }

  const seenNormalized: Set<string> = new Set();
  const terms: RecallFtsTerm[] = [];
  for (const candidate of value as readonly string[]) {
    const display = sanitizeDisplay(candidate);
    let normalized: string;
    try {
      normalized = normalizeV1(display);
    } catch {
      continue;
    }
    if (
      Array.from(normalized).length < FTS_MINIMUM_NORMALIZED_CODE_POINTS ||
      seenNormalized.has(normalized)
    ) {
      continue;
    }
    seenNormalized.add(normalized);
    terms.push(
      Object.freeze({
        display,
        normalized,
        phraseLiteral: quotedPhraseLiteral(display),
      }),
    );
  }

  if (terms.length === 0) {
    return Object.freeze({
      kind: "skip",
      terms: EMPTY_TERMS,
      matchExpression: null,
      notes: Object.freeze([createRecallFtsNote("fts_terms_too_short")]),
    });
  }

  const frozenTerms: readonly RecallFtsTerm[] = Object.freeze(terms);
  return Object.freeze({
    kind: "query",
    terms: frozenTerms,
    matchExpression: frozenTerms
      .map((term) => term.phraseLiteral)
      .join(" OR "),
    notes: Object.freeze([]),
  });
}
