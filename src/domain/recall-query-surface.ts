import {
  ProjectionIdentifierError,
  createIdentifierRedirectRegistry,
  type IdentifierAnchor,
  type IdentifierRedirectRow,
} from "./projection-identifiers.js";
import { ProjectionRuleError, normalizeV1 } from "./projection-rules.js";

const SCOPE_KEY_PATTERN =
  /^u:[A-Za-z0-9._-]{1,64}\/p:[A-Za-z0-9._-]{1,64}$/u;
const LETTER_NUMBER_RUN_PATTERN = /[\p{L}\p{N}]+/gu;
const MAX_QUERY_CODE_POINTS = 4_096;
const MAX_EXPLICIT_TERM_CODE_POINTS = 256;
const MAX_QUERY_TERMS = 10;
const MAX_SURFACE_SEEDS = 50;

export type RecallQuerySurfaceErrorCode =
  | "INVALID_QUERY_TERM_INPUT"
  | "INVALID_SURFACE_SEED_STATE";

const ERROR_MESSAGES: Readonly<Record<RecallQuerySurfaceErrorCode, string>> =
  Object.freeze({
    INVALID_QUERY_TERM_INPUT:
      "recall query terms do not satisfy the deterministic v1 contract",
    INVALID_SURFACE_SEED_STATE:
      "recall surface state does not satisfy canonical scope invariants",
  });

export class RecallQuerySurfaceError extends TypeError {
  public override readonly name: string = "RecallQuerySurfaceError";
  public readonly code: RecallQuerySurfaceErrorCode;

  public constructor(code: RecallQuerySurfaceErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.code = code;
  }
}

function reject(code: RecallQuerySurfaceErrorCode): never {
  throw new RecallQuerySurfaceError(code);
}

function plainDataRecord(
  value: unknown,
  code: RecallQuerySurfaceErrorCode,
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return reject(code);
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return reject(code);
  }
  const result: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      return reject(code);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !("value" in descriptor)
    ) {
      return reject(code);
    }
    result[key] = descriptor.value;
  }
  return result;
}

function exactDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
  code: RecallQuerySurfaceErrorCode,
): Readonly<Record<string, unknown>> {
  const result = plainDataRecord(value, code);
  const keys = Object.keys(result).sort();
  const expected = expectedKeys.slice().sort();
  if (
    keys.length !== expected.length ||
    !keys.every((key, index) => key === expected[index])
  ) {
    return reject(code);
  }
  return result;
}

function plainDataArray(
  value: unknown,
  code: RecallQuerySurfaceErrorCode,
): readonly unknown[] {
  if (!Array.isArray(value)) {
    return reject(code);
  }
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !("value" in descriptor)
    ) {
      return reject(code);
    }
    result.push(descriptor.value);
  }
  const expectedKeys = new Set([
    "length",
    ...Array.from({ length: value.length }, (_, index) => String(index)),
  ]);
  if (
    Reflect.ownKeys(value).some(
      (key) => typeof key !== "string" || !expectedKeys.has(key),
    )
  ) {
    return reject(code);
  }
  return Object.freeze(result);
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function normalizedCandidate(value: string): string | null {
  try {
    const normalized = normalizeV1(value);
    return codePointLength(normalized) < 2 ? null : normalized;
  } catch (error: unknown) {
    if (
      error instanceof ProjectionRuleError &&
      error.code === "EMPTY_NORMALIZED_VALUE"
    ) {
      return null;
    }
    if (error instanceof ProjectionRuleError) {
      return reject("INVALID_QUERY_TERM_INPUT");
    }
    throw error;
  }
}

export interface RecallQueryTerm {
  readonly text: string;
  readonly surfaceNorm: string;
}

interface CandidateTerm extends RecallQueryTerm {
  readonly appearanceOrder: number;
  readonly normalizedLength: number;
}

function frozenTerm(text: string, surfaceNorm: string): RecallQueryTerm {
  return Object.freeze({ text, surfaceNorm });
}

function cappedTermsInOrder(
  candidates: readonly CandidateTerm[],
): readonly RecallQueryTerm[] {
  const result: RecallQueryTerm[] = [];
  for (const candidate of candidates) {
    result.push(frozenTerm(candidate.text, candidate.surfaceNorm));
    if (result.length === MAX_QUERY_TERMS) {
      break;
    }
  }
  return Object.freeze(result);
}

function candidateTerm(
  textValue: string,
  appearanceOrder: number,
): CandidateTerm | null {
  const text = textValue.trim();
  const surfaceNorm = normalizedCandidate(text);
  return surfaceNorm === null
    ? null
    : Object.freeze({
        text,
        surfaceNorm,
        appearanceOrder,
        normalizedLength: codePointLength(surfaceNorm),
      });
}

/**
 * ADR-012's deliberately conservative term policy. No morphology, stemming,
 * synonym expansion, translation, or model call occurs here.
 */
export function extractRecallQueryTerms(
  value: unknown,
): readonly RecallQueryTerm[] {
  const input = plainDataRecord(value, "INVALID_QUERY_TERM_INPUT");
  const queryValue = input["query"];
  if (typeof queryValue !== "string") {
    return reject("INVALID_QUERY_TERM_INPUT");
  }
  const query = queryValue.trim();
  const queryLength = codePointLength(query);
  if (queryLength < 1 || queryLength > MAX_QUERY_CODE_POINTS) {
    return reject("INVALID_QUERY_TERM_INPUT");
  }

  if (input["terms"] !== undefined) {
    const values = plainDataArray(input["terms"], "INVALID_QUERY_TERM_INPUT");
    if (values.length > MAX_QUERY_TERMS) {
      return reject("INVALID_QUERY_TERM_INPUT");
    }
    const candidates: CandidateTerm[] = [];
    for (let index = 0; index < values.length; index += 1) {
      const item = values[index];
      if (
        typeof item !== "string" ||
        codePointLength(item) < 1 ||
        codePointLength(item) > MAX_EXPLICIT_TERM_CODE_POINTS
      ) {
        return reject("INVALID_QUERY_TERM_INPUT");
      }
      const candidate = candidateTerm(item, index);
      if (candidate !== null) {
        candidates.push(candidate);
      }
    }
    return cappedTermsInOrder(candidates);
  }

  const candidates: CandidateTerm[] = [];
  const whole = candidateTerm(query, 0);
  if (whole !== null) {
    candidates.push(whole);
  }
  let appearanceOrder = 1;
  for (const match of query.matchAll(LETTER_NUMBER_RUN_PATTERN)) {
    const run = match[0];
    if (match.index === 0 && run === query) {
      continue;
    }
    const candidate = candidateTerm(run, appearanceOrder);
    appearanceOrder += 1;
    if (candidate !== null) {
      candidates.push(candidate);
    }
  }
  candidates.sort((left, right) => {
    if (left.normalizedLength !== right.normalizedLength) {
      return right.normalizedLength - left.normalizedLength;
    }
    return left.appearanceOrder - right.appearanceOrder;
  });
  return cappedTermsInOrder(candidates);
}

export interface RecallSurfaceCandidateState {
  readonly termOrder: number;
  readonly scopeKey: string;
  readonly surfaceNorm: string;
  readonly entityId: string;
}

export interface RecallSurfaceEntityState {
  readonly id: string;
  readonly scopeKey: string;
  readonly mergedInto: string | null;
}

export interface RecallSurfaceSeedState {
  readonly scopeKey: string;
  readonly terms: readonly RecallQueryTerm[];
  readonly candidates: readonly RecallSurfaceCandidateState[];
  readonly entities: readonly RecallSurfaceEntityState[];
  readonly idRedirects: readonly IdentifierRedirectRow[];
}

export interface RecallSurfaceSeed {
  readonly entityId: string;
  readonly matchedTerm: string;
  readonly surfaceNorm: string;
}

export interface RecallQuerySurfaceSelection {
  readonly terms: readonly RecallQueryTerm[];
  readonly seeds: readonly RecallSurfaceSeed[];
  readonly truncated: boolean;
}

function canonicalScope(value: unknown): string {
  if (typeof value !== "string" || !SCOPE_KEY_PATTERN.test(value)) {
    return reject("INVALID_SURFACE_SEED_STATE");
  }
  return value;
}

function validatedTerms(value: unknown): readonly RecallQueryTerm[] {
  const values = plainDataArray(value, "INVALID_SURFACE_SEED_STATE");
  if (values.length > MAX_QUERY_TERMS) {
    return reject("INVALID_SURFACE_SEED_STATE");
  }
  const result: RecallQueryTerm[] = [];
  for (const valueTerm of values) {
    const row = exactDataRecord(
      valueTerm,
      ["surfaceNorm", "text"],
      "INVALID_SURFACE_SEED_STATE",
    );
    const text = row["text"];
    const surfaceNorm = row["surfaceNorm"];
    if (
      typeof text !== "string" ||
      text.length === 0 ||
      text.trim() !== text ||
      typeof surfaceNorm !== "string" ||
      codePointLength(surfaceNorm) < 2
    ) {
      return reject("INVALID_SURFACE_SEED_STATE");
    }
    try {
      if (
        normalizeV1(text) !== surfaceNorm ||
        normalizeV1(surfaceNorm) !== surfaceNorm
      ) {
        return reject("INVALID_SURFACE_SEED_STATE");
      }
    } catch (error: unknown) {
      if (error instanceof ProjectionRuleError) {
        return reject("INVALID_SURFACE_SEED_STATE");
      }
      throw error;
    }
    result.push(frozenTerm(text, surfaceNorm));
  }
  return Object.freeze(result);
}

function validatedCandidate(
  value: unknown,
  scopeKey: string,
  terms: readonly RecallQueryTerm[],
): RecallSurfaceCandidateState {
  const row = exactDataRecord(
    value,
    ["entityId", "scopeKey", "surfaceNorm", "termOrder"],
    "INVALID_SURFACE_SEED_STATE",
  );
  const termOrder = row["termOrder"];
  const entityId = row["entityId"];
  const surfaceNorm = row["surfaceNorm"];
  if (
    !Number.isSafeInteger(termOrder) ||
    Number(termOrder) < 0 ||
    Number(termOrder) >= terms.length ||
    row["scopeKey"] !== scopeKey ||
    typeof entityId !== "string" ||
    typeof surfaceNorm !== "string" ||
    terms[Number(termOrder)]?.surfaceNorm !== surfaceNorm
  ) {
    return reject("INVALID_SURFACE_SEED_STATE");
  }
  return Object.freeze({
    termOrder: Number(termOrder),
    scopeKey,
    surfaceNorm,
    entityId,
  });
}

function validatedEntity(value: unknown): RecallSurfaceEntityState {
  const row = exactDataRecord(
    value,
    ["id", "mergedInto", "scopeKey"],
    "INVALID_SURFACE_SEED_STATE",
  );
  if (
    typeof row["id"] !== "string" ||
    (row["mergedInto"] !== null && typeof row["mergedInto"] !== "string")
  ) {
    return reject("INVALID_SURFACE_SEED_STATE");
  }
  return Object.freeze({
    id: row["id"],
    scopeKey: canonicalScope(row["scopeKey"]),
    mergedInto: row["mergedInto"] as string | null,
  });
}

function validatedRedirect(value: unknown): IdentifierRedirectRow {
  const row = exactDataRecord(
    value,
    ["kind", "newId", "oldId", "reason"],
    "INVALID_SURFACE_SEED_STATE",
  );
  if (
    typeof row["oldId"] !== "string" ||
    typeof row["newId"] !== "string" ||
    (row["kind"] !== "entity" && row["kind"] !== "claim") ||
    (row["reason"] !== "merge" &&
      row["reason"] !== "rule_change" &&
      row["reason"] !== "deduplicated")
  ) {
    return reject("INVALID_SURFACE_SEED_STATE");
  }
  return Object.freeze({
    oldId: row["oldId"],
    newId: row["newId"],
    kind: row["kind"],
    reason: row["reason"],
  });
}

function asciiCompare(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function canonicalMap(
  anchors: readonly IdentifierAnchor[],
  redirects: readonly IdentifierRedirectRow[],
): ReadonlyMap<string, string> {
  try {
    const registry = createIdentifierRedirectRegistry({ anchors, redirects });
    return new Map(
      registry.redirects.map((redirect) => [redirect.oldId, redirect.newId]),
    );
  } catch (error: unknown) {
    if (error instanceof ProjectionIdentifierError) {
      return reject("INVALID_SURFACE_SEED_STATE");
    }
    throw error;
  }
}

function canonicalSurfaceState(value: unknown): RecallSurfaceSeedState {
  const input = exactDataRecord(
    value,
    ["candidates", "entities", "idRedirects", "scopeKey", "terms"],
    "INVALID_SURFACE_SEED_STATE",
  );
  const scopeKey = canonicalScope(input["scopeKey"]);
  const terms = validatedTerms(input["terms"]);
  const candidates = plainDataArray(
    input["candidates"],
    "INVALID_SURFACE_SEED_STATE",
  ).map((candidate) => validatedCandidate(candidate, scopeKey, terms));
  const entities = plainDataArray(
    input["entities"],
    "INVALID_SURFACE_SEED_STATE",
  ).map(validatedEntity);
  const idRedirects = plainDataArray(
    input["idRedirects"],
    "INVALID_SURFACE_SEED_STATE",
  ).map(validatedRedirect);
  return Object.freeze({
    scopeKey,
    terms,
    candidates: Object.freeze(candidates),
    entities: Object.freeze(entities),
    idRedirects: Object.freeze(idRedirects),
  });
}

/** Canonicalize every scoped surface candidate before ordering and capping. */
export function resolveRecallSurfaceSeeds(
  value: unknown,
): RecallQuerySurfaceSelection {
  const state = canonicalSurfaceState(value);
  const entityById = new Map<string, RecallSurfaceEntityState>();
  for (const entity of state.entities) {
    if (entityById.has(entity.id)) {
      return reject("INVALID_SURFACE_SEED_STATE");
    }
    entityById.set(entity.id, entity);
  }
  for (const candidate of state.candidates) {
    if (!entityById.has(candidate.entityId)) {
      return reject("INVALID_SURFACE_SEED_STATE");
    }
  }

  const redirectByOld = new Map<string, IdentifierRedirectRow>();
  const identifierIds = new Set<string>();
  for (const redirect of state.idRedirects) {
    if (redirectByOld.has(redirect.oldId)) {
      return reject("INVALID_SURFACE_SEED_STATE");
    }
    redirectByOld.set(redirect.oldId, redirect);
    identifierIds.add(redirect.oldId);
    identifierIds.add(redirect.newId);
  }
  for (const entity of state.entities) {
    identifierIds.add(entity.id);
  }
  const idAnchors: IdentifierAnchor[] = [];
  for (const id of identifierIds) {
    const entity = entityById.get(id);
    if (entity === undefined && !redirectByOld.has(id)) {
      return reject("INVALID_SURFACE_SEED_STATE");
    }
    idAnchors.push(
      Object.freeze({
        id,
        kind: "entity",
        scopeKey: entity?.scopeKey ?? state.scopeKey,
      }),
    );
  }
  const idCanonical = canonicalMap(idAnchors, state.idRedirects);

  const mergeAnchors: IdentifierAnchor[] = state.entities.map((entity) =>
    Object.freeze({
      id: entity.id,
      kind: "entity",
      scopeKey: entity.scopeKey,
    }),
  );
  const mergeRedirects: IdentifierRedirectRow[] = state.entities
    .filter(
      (entity): entity is RecallSurfaceEntityState & { readonly mergedInto: string } =>
        entity.mergedInto !== null,
    )
    .map((entity) =>
      Object.freeze({
        oldId: entity.id,
        newId: entity.mergedInto,
        kind: "entity",
        reason: "merge",
      }));
  const mergeCanonical = canonicalMap(mergeAnchors, mergeRedirects);

  for (const entity of state.entities) {
    const redirect = redirectByOld.get(entity.id);
    if (
      (entity.mergedInto === null && redirect !== undefined) ||
      (entity.mergedInto !== null &&
        (redirect === undefined ||
          redirect.kind !== "entity"))
    ) {
      return reject("INVALID_SURFACE_SEED_STATE");
    }
    const canonicalFromId = idCanonical.get(entity.id) ?? entity.id;
    const canonicalFromMerge = mergeCanonical.get(entity.id) ?? entity.id;
    if (canonicalFromId !== canonicalFromMerge) {
      return reject("INVALID_SURFACE_SEED_STATE");
    }
    const terminal = entityById.get(canonicalFromId);
    if (
      terminal === undefined ||
      terminal.scopeKey !== state.scopeKey ||
      terminal.mergedInto !== null
    ) {
      return reject("INVALID_SURFACE_SEED_STATE");
    }
  }

  const canonicalByTerm = state.terms.map(() => new Set<string>());
  for (const candidate of state.candidates) {
    const canonicalId = idCanonical.get(candidate.entityId) ?? candidate.entityId;
    const terminal = entityById.get(canonicalId);
    if (
      terminal === undefined ||
      terminal.scopeKey !== state.scopeKey ||
      terminal.mergedInto !== null
    ) {
      return reject("INVALID_SURFACE_SEED_STATE");
    }
    canonicalByTerm[candidate.termOrder]?.add(canonicalId);
  }

  const seen = new Set<string>();
  const selected: RecallSurfaceSeed[] = [];
  for (let termOrder = 0; termOrder < state.terms.length; termOrder += 1) {
    const queryTerm = state.terms[termOrder];
    const entityIds = [...(canonicalByTerm[termOrder] ?? [])].sort(asciiCompare);
    if (queryTerm === undefined) {
      return reject("INVALID_SURFACE_SEED_STATE");
    }
    for (const entityId of entityIds) {
      if (seen.has(entityId)) {
        continue;
      }
      seen.add(entityId);
      if (selected.length <= MAX_SURFACE_SEEDS) {
        selected.push(
          Object.freeze({
            entityId,
            matchedTerm: queryTerm.text,
            surfaceNorm: queryTerm.surfaceNorm,
          }),
        );
      }
    }
  }
  const truncated = selected.length > MAX_SURFACE_SEEDS;
  return Object.freeze({
    terms: state.terms,
    seeds: Object.freeze(selected.slice(0, MAX_SURFACE_SEEDS)),
    truncated,
  });
}
