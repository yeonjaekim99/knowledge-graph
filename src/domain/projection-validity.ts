import {
  ProjectionIdentifierError,
  assertCanonicalIdentifier,
  compareOccurrenceIdentifiers,
} from "./projection-identifiers.js";
import type { StructuralClaimSupportProjectionRow } from "./projection-claims.js";
import type { ProjectionPreScanResult } from "./projection-event-pre-scan.js";
import type {
  ClaimProjectionRow,
  ClaimSupportProjectionRow,
  StatementProjectionRow,
} from "./projection-replay.js";

export type StatementProvenance = "user_stated" | "observed" | "inferred";
export type StatementTtl = "session" | "weeks" | "permanent";

export interface StatementTtlSeconds {
  readonly session: 43_200;
  readonly weeks: 2_592_000;
  readonly permanent: null;
}

export interface DefaultStatementTtl {
  readonly user_stated: "permanent";
  readonly observed: "permanent";
  readonly inferred: "weeks";
}

export const STATEMENT_TTL_SECONDS: StatementTtlSeconds = Object.freeze({
  session: 43_200,
  weeks: 2_592_000,
  permanent: null,
});

export const DEFAULT_STATEMENT_TTL: DefaultStatementTtl = Object.freeze({
  user_stated: "permanent",
  observed: "permanent",
  inferred: "weeks",
});

export interface EffectiveStatementLifetime {
  readonly ttl: StatementTtl;
  readonly expiresAt: number | null;
}

export type ProjectionValidityErrorCode =
  | "INVALID_TTL_INPUT"
  | "TTL_EXPIRY_OUT_OF_RANGE"
  | "INVALID_VALIDITY_STATE";

const ERROR_MESSAGES: Readonly<Record<ProjectionValidityErrorCode, string>> =
  Object.freeze({
    INVALID_TTL_INPUT:
      "statement lifetime requires canonical effective metadata",
    TTL_EXPIRY_OUT_OF_RANGE:
      "statement lifetime exceeds the supported epoch range",
    INVALID_VALIDITY_STATE:
      "claim validity projection input violates structural invariants",
  });

export class ProjectionValidityError extends TypeError {
  public override readonly name: string = "ProjectionValidityError";
  public readonly code: ProjectionValidityErrorCode;

  public constructor(code: ProjectionValidityErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.code = code;
  }
}

function reject(code: ProjectionValidityErrorCode): never {
  throw new ProjectionValidityError(code);
}

function plainDataRecord(
  value: unknown,
  code: ProjectionValidityErrorCode,
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
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
  code: ProjectionValidityErrorCode,
): Readonly<Record<string, unknown>> {
  const source = plainDataRecord(value, code);
  const keys = Object.keys(source);
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  if (
    requiredKeys.some((key) => !Object.hasOwn(source, key)) ||
    keys.some((key) => !allowed.has(key))
  ) {
    return reject(code);
  }
  return source;
}

function plainDataArray(
  value: unknown,
  code: ProjectionValidityErrorCode,
): readonly unknown[] {
  if (!Array.isArray(value)) {
    return reject(code);
  }
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      return reject(code);
    }
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

function statementProvenance(
  value: unknown,
  code: ProjectionValidityErrorCode = "INVALID_TTL_INPUT",
): StatementProvenance {
  if (
    value !== "user_stated" &&
    value !== "observed" &&
    value !== "inferred"
  ) {
    return reject(code);
  }
  return value;
}

function statementTtl(
  value: unknown,
  code: ProjectionValidityErrorCode = "INVALID_TTL_INPUT",
): StatementTtl {
  if (value !== "session" && value !== "weeks" && value !== "permanent") {
    return reject(code);
  }
  return value;
}

export function resolveEffectiveStatementLifetime(
  value: unknown,
): EffectiveStatementLifetime {
  const source = exactDataRecord(
    value,
    ["createdAt", "provenance"],
    ["ttl"],
    "INVALID_TTL_INPUT",
  );
  const createdAt = source["createdAt"];
  if (!Number.isSafeInteger(createdAt) || Number(createdAt) < 0) {
    return reject("INVALID_TTL_INPUT");
  }
  const provenance = statementProvenance(source["provenance"]);
  const ttl = Object.hasOwn(source, "ttl")
    ? statementTtl(source["ttl"])
    : DEFAULT_STATEMENT_TTL[provenance];
  const seconds = STATEMENT_TTL_SECONDS[ttl];
  if (seconds === null) {
    return Object.freeze({ ttl, expiresAt: null });
  }
  if (Number(createdAt) > Number.MAX_SAFE_INTEGER - seconds) {
    return reject("TTL_EXPIRY_OUT_OF_RANGE");
  }
  return Object.freeze({ ttl, expiresAt: Number(createdAt) + seconds });
}

export interface ClaimValidityStructuralInput {
  readonly scopeKey: string;
  readonly rulesVersion: string;
  readonly claims: readonly ClaimProjectionRow[];
  readonly claimSupport: readonly StructuralClaimSupportProjectionRow[];
}

export interface ClaimValidityProjection {
  readonly scopeKey: string;
  readonly rulesVersion: string;
  readonly statements: readonly StatementProjectionRow[];
  readonly claimSupport: readonly ClaimSupportProjectionRow[];
}

interface StatementMetadata {
  readonly actualSeq: number;
  readonly draftCount: number;
  readonly expiresAt: number | null;
}

function canonicalIdentifier(
  value: unknown,
  kind: "event" | "claim",
): string {
  try {
    return assertCanonicalIdentifier(value, kind);
  } catch (error: unknown) {
    if (error instanceof ProjectionIdentifierError) {
      return reject("INVALID_VALIDITY_STATE");
    }
    throw error;
  }
}

function compareClaimIds(left: string, right: string): number {
  try {
    return compareOccurrenceIdentifiers(left, right, "claim");
  } catch (error: unknown) {
    if (error instanceof ProjectionIdentifierError) {
      return reject("INVALID_VALIDITY_STATE");
    }
    throw error;
  }
}

function projectionStatementRows(
  preScanSource: Readonly<Record<string, unknown>>,
): Readonly<{
  rows: readonly StatementProjectionRow[];
  metadata: ReadonlyMap<string, StatementMetadata>;
}> {
  const scopeKey = preScanSource["scopeKey"];
  if (typeof scopeKey !== "string" || scopeKey.length === 0) {
    return reject("INVALID_VALIDITY_STATE");
  }
  const statements = plainDataArray(
    preScanSource["statements"],
    "INVALID_VALIDITY_STATE",
  );
  const rows: Array<StatementProjectionRow & { readonly actualSeq: number }> = [];
  const metadata = new Map<string, StatementMetadata>();
  const actualSequences = new Set<number>();
  for (const value of statements) {
    const statement = exactDataRecord(
      value,
      [
        "actualSeq",
        "createdAt",
        "eventId",
        "orderSeq",
        "provenance",
        "recordedAt",
        "rootEventId",
        "state",
        "supersedes",
        "ttl",
      ],
      [],
      "INVALID_VALIDITY_STATE",
    );
    const eventId = canonicalIdentifier(statement["eventId"], "event");
    const actualSeq = statement["actualSeq"];
    const orderSeq = statement["orderSeq"];
    const createdAt = statement["createdAt"];
    const state = statement["state"];
    if (
      metadata.has(eventId) ||
      !Number.isSafeInteger(actualSeq) ||
      Number(actualSeq) <= 0 ||
      actualSequences.has(Number(actualSeq)) ||
      !Number.isSafeInteger(orderSeq) ||
      Number(orderSeq) <= 0 ||
      !Number.isSafeInteger(createdAt) ||
      Number(createdAt) < 0 ||
      (state !== "live" && state !== "retracted" && state !== "superseded")
    ) {
      return reject("INVALID_VALIDITY_STATE");
    }
    const provenance = statementProvenance(
      statement["provenance"],
      "INVALID_VALIDITY_STATE",
    );
    const ttl = statementTtl(statement["ttl"], "INVALID_VALIDITY_STATE");
    const lifetime = resolveEffectiveStatementLifetime({
      createdAt: Number(createdAt),
      provenance,
      ttl,
    });
    actualSequences.add(Number(actualSeq));
    metadata.set(
      eventId,
      Object.freeze({
        actualSeq: Number(actualSeq),
        draftCount: -1,
        expiresAt: lifetime.expiresAt,
      }),
    );
    rows.push(
      Object.freeze({
        eventId,
        scopeKey,
        state,
        orderSeq: Number(orderSeq),
        createdAt: Number(createdAt),
        provenance,
        expiresAt: lifetime.expiresAt,
        actualSeq: Number(actualSeq),
      }),
    );
  }

  const candidates = plainDataArray(
    preScanSource["statementCandidates"],
    "INVALID_VALIDITY_STATE",
  );
  for (const value of candidates) {
    const candidate = plainDataRecord(value, "INVALID_VALIDITY_STATE");
    const eventId = canonicalIdentifier(candidate["eventId"], "event");
    const actualSeq = candidate["actualSeq"];
    const parsed = plainDataArray(candidate["parsed"], "INVALID_VALIDITY_STATE");
    const current = metadata.get(eventId);
    if (
      current === undefined ||
      current.draftCount !== -1 ||
      actualSeq !== current.actualSeq
    ) {
      return reject("INVALID_VALIDITY_STATE");
    }
    metadata.set(
      eventId,
      Object.freeze({
        actualSeq: current.actualSeq,
        draftCount: parsed.length,
        expiresAt: current.expiresAt,
      }),
    );
  }
  if (
    candidates.length !== metadata.size ||
    [...metadata.values()].some(({ draftCount }) => draftCount < 0)
  ) {
    return reject("INVALID_VALIDITY_STATE");
  }

  rows.sort((left, right) =>
    left.actualSeq !== right.actualSeq
      ? left.actualSeq - right.actualSeq
      : left.eventId < right.eventId
        ? -1
        : left.eventId === right.eventId
          ? 0
          : 1,
  );
  const projected = rows.map(({ actualSeq: _actualSeq, ...row }) =>
    Object.freeze(row),
  );
  return Object.freeze({
    rows: Object.freeze(projected),
    metadata,
  });
}

export function reduceClaimValidityState(
  preScan: ProjectionPreScanResult,
  structuralProjection: ClaimValidityStructuralInput,
): ClaimValidityProjection {
  const preScanSource = plainDataRecord(preScan, "INVALID_VALIDITY_STATE");
  const structuralSource = plainDataRecord(
    structuralProjection,
    "INVALID_VALIDITY_STATE",
  );
  const scopeKey = preScanSource["scopeKey"];
  const rulesVersion = preScanSource["rulesVersion"];
  if (
    typeof scopeKey !== "string" ||
    typeof rulesVersion !== "string" ||
    structuralSource["scopeKey"] !== scopeKey ||
    structuralSource["rulesVersion"] !== rulesVersion
  ) {
    return reject("INVALID_VALIDITY_STATE");
  }
  const statementProjection = projectionStatementRows(preScanSource);

  const claimIds = new Set<string>();
  for (const value of plainDataArray(
    structuralSource["claims"],
    "INVALID_VALIDITY_STATE",
  )) {
    const claim = plainDataRecord(value, "INVALID_VALIDITY_STATE");
    const id = canonicalIdentifier(claim["id"], "claim");
    if (claim["scopeKey"] !== scopeKey || claimIds.has(id)) {
      return reject("INVALID_VALIDITY_STATE");
    }
    claimIds.add(id);
  }

  const supports: Array<
    ClaimSupportProjectionRow & { readonly actualSeq: number }
  > = [];
  const claimEventKeys = new Set<string>();
  const eventDraftKeys = new Set<string>();
  for (const value of plainDataArray(
    structuralSource["claimSupport"],
    "INVALID_VALIDITY_STATE",
  )) {
    const support = exactDataRecord(
      value,
      ["claimId", "draftIndex", "eventId", "live"],
      [],
      "INVALID_VALIDITY_STATE",
    );
    const claimId = canonicalIdentifier(support["claimId"], "claim");
    const eventId = canonicalIdentifier(support["eventId"], "event");
    const draftIndex = support["draftIndex"];
    const live = support["live"];
    const statement = statementProjection.metadata.get(eventId);
    const claimEventKey = JSON.stringify([claimId, eventId]);
    const eventDraftKey = JSON.stringify([eventId, draftIndex]);
    if (
      !claimIds.has(claimId) ||
      statement === undefined ||
      !Number.isSafeInteger(draftIndex) ||
      Number(draftIndex) < 0 ||
      Number(draftIndex) >= statement.draftCount ||
      (live !== 0 && live !== 1) ||
      claimEventKeys.has(claimEventKey) ||
      eventDraftKeys.has(eventDraftKey)
    ) {
      return reject("INVALID_VALIDITY_STATE");
    }
    claimEventKeys.add(claimEventKey);
    eventDraftKeys.add(eventDraftKey);
    supports.push(
      Object.freeze({
        claimId,
        eventId,
        draftIndex: Number(draftIndex),
        live,
        expiresAt: statement.expiresAt,
        actualSeq: statement.actualSeq,
      }),
    );
  }
  supports.sort((left, right) => {
    const claimOrder = compareClaimIds(left.claimId, right.claimId);
    if (claimOrder !== 0) {
      return claimOrder;
    }
    return left.actualSeq !== right.actualSeq
      ? left.actualSeq - right.actualSeq
      : left.draftIndex - right.draftIndex;
  });
  const projectedSupport = supports.map(
    ({ actualSeq: _actualSeq, ...support }) => Object.freeze(support),
  );
  return Object.freeze({
    scopeKey,
    rulesVersion,
    statements: statementProjection.rows,
    claimSupport: Object.freeze(projectedSupport),
  });
}
