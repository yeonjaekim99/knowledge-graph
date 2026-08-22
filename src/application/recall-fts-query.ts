import {
  RecallReadError,
  type RecallFtsCandidateResult,
  type RecallFtsCandidateSource,
  type RecallFtsNote,
  type RecallFtsNoteCode,
  type RecallFtsTerm,
} from "./ports/recall-read-port.js";
import type { RecallQuerySurfaceSelection } from "../domain/recall-query-surface.js";

const FTS_CANDIDATE_LIMIT = 10;
const FTS_CANDIDATE_MAX_CODE_POINTS = 4_096;
const FTS_MINIMUM_DISPLAY_CODE_POINTS = 3;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/gu;
const EMPTY_TERMS: readonly RecallFtsTerm[] = Object.freeze([]);

export const RECALL_FTS_NOTE_TEXT: Readonly<
  Record<RecallFtsNoteCode, string>
> = Object.freeze({
  fts_terms_too_short:
    "FTS 검색은 제어 문자 제거 후 세 글자 이상의 표현이 필요합니다. 더 긴 query 또는 terms로 다시 검색하세요.",
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

/**
 * Preserves the ordered user-facing terms selected by RCL-002 when a later
 * search stage chooses the FTS fallback. surfaceNorm is only an exact surface
 * lookup key and must never replace the phrase SQLite actually matches.
 */
export function searchRecallFtsFallback(
  source: RecallFtsCandidateSource,
  selection: RecallQuerySurfaceSelection,
): Promise<RecallFtsCandidateResult> {
  return source.searchFtsCandidates(
    selection.terms.map((term) => term.text),
  );
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

function hasAtMostCodePoints(value: string, maximum: number): boolean {
  let length = 0;
  for (const _codePoint of value) {
    length += 1;
    if (length > maximum) {
      return false;
    }
  }
  return true;
}

function snapshotCandidateStrings(value: unknown): readonly string[] {
  try {
    if (!Array.isArray(value)) {
      return invalidRequest();
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (
      lengthDescriptor === undefined ||
      !("value" in lengthDescriptor) ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      Number(lengthDescriptor.value) < 0 ||
      Number(lengthDescriptor.value) > FTS_CANDIDATE_LIMIT
    ) {
      return invalidRequest();
    }
    const length = Number(lengthDescriptor.value);
    const expectedKeys = new Set([
      "length",
      ...Array.from({ length }, (_, index) => String(index)),
    ]);
    if (
      Reflect.ownKeys(value).some(
        (key) => typeof key !== "string" || !expectedKeys.has(key),
      )
    ) {
      return invalidRequest();
    }

    const candidates: string[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (
        descriptor === undefined ||
        descriptor.enumerable !== true ||
        !("value" in descriptor) ||
        typeof descriptor.value !== "string" ||
        !hasAtMostCodePoints(
          descriptor.value,
          FTS_CANDIDATE_MAX_CODE_POINTS,
        )
      ) {
        return invalidRequest();
      }
      candidates.push(descriptor.value);
    }
    return Object.freeze(candidates);
  } catch {
    return invalidRequest();
  }
}

/**
 * Converts bounded user-controlled candidates into FTS5 phrase literals.
 * The trigram gate measures the sanitized display phrase that is actually
 * bound to MATCH. Compatibility-equivalent display strings remain distinct
 * because SQLite's trigram tokenizer does not apply normalize_v1.
 */
export function prepareRecallFtsQuery(value: unknown): RecallFtsPlan {
  const candidates = snapshotCandidateStrings(value);

  const terms: RecallFtsTerm[] = [];
  for (const candidate of candidates) {
    const display = sanitizeDisplay(candidate);
    if (
      Array.from(display).length < FTS_MINIMUM_DISPLAY_CODE_POINTS
    ) {
      continue;
    }
    terms.push(
      Object.freeze({
        display,
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
