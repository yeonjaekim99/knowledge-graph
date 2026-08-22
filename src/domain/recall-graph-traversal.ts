import {
  ProjectionIdentifierError,
  assertCanonicalIdentifier,
  compareOccurrenceIdentifiers,
} from "./projection-identifiers.js";

const CLAIM_ID_PARTS = /^c([1-9][0-9]*)\.([0-9]+)$/u;
const MAX_TRAVERSAL_SEEDS = 50;
const MAX_NEIGHBORHOOD_ROWS = 31;
const MAX_DISPLAY_CODE_POINTS = 4_096;

export type RecallGraphTraversalErrorCode =
  | "INVALID_TRAVERSAL_INPUT"
  | "INVALID_TRAVERSAL_STATE";

const ERROR_MESSAGES: Readonly<Record<RecallGraphTraversalErrorCode, string>> =
  Object.freeze({
    INVALID_TRAVERSAL_INPUT:
      "recall traversal input does not satisfy the bounded graph contract",
    INVALID_TRAVERSAL_STATE:
      "recall traversal state does not satisfy canonical graph invariants",
  });

export class RecallGraphTraversalError extends TypeError {
  public override readonly name: string = "RecallGraphTraversalError";
  public readonly code: RecallGraphTraversalErrorCode;

  public constructor(code: RecallGraphTraversalErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.code = code;
  }
}

function reject(code: RecallGraphTraversalErrorCode): never {
  throw new RecallGraphTraversalError(code);
}

function plainDataRecord(
  value: unknown,
  code: RecallGraphTraversalErrorCode,
): Readonly<Record<string, unknown>> {
  try {
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
    return Object.freeze(result);
  } catch {
    return reject(code);
  }
}

function exactDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
  code: RecallGraphTraversalErrorCode,
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
  maximumLength: number,
  code: RecallGraphTraversalErrorCode,
): readonly unknown[] {
  try {
    if (!Array.isArray(value)) {
      return reject(code);
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (
      lengthDescriptor === undefined ||
      !("value" in lengthDescriptor) ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      Number(lengthDescriptor.value) < 0 ||
      Number(lengthDescriptor.value) > maximumLength
    ) {
      return reject(code);
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
      return reject(code);
    }
    const result: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
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
    return Object.freeze(result);
  } catch {
    return reject(code);
  }
}

function canonicalIdentifier(
  value: unknown,
  kind: "entity" | "claim",
  code: RecallGraphTraversalErrorCode,
): string {
  try {
    return assertCanonicalIdentifier(value, kind);
  } catch (error: unknown) {
    if (error instanceof ProjectionIdentifierError) {
      return reject(code);
    }
    throw error;
  }
}

function scalarText(
  value: unknown,
  code: RecallGraphTraversalErrorCode,
): string {
  if (
    typeof value !== "string" ||
    !value.isWellFormed() ||
    value.length === 0 ||
    value.trim() !== value ||
    Array.from(value).length > MAX_DISPLAY_CODE_POINTS
  ) {
    return reject(code);
  }
  return value;
}

function positiveSafeInteger(
  value: unknown,
  code: RecallGraphTraversalErrorCode,
): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    return reject(code);
  }
  return Number(value);
}

function epoch(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    return reject("INVALID_TRAVERSAL_STATE");
  }
  return Number(value);
}

export interface RecallGraphSeed {
  readonly entityId: string;
  readonly display: string;
}

export type RecallGraphTraversalInput =
  | {
      readonly entry: "surface" | "fts";
      readonly depth: 1 | 2 | 3;
      readonly seeds: readonly RecallGraphSeed[];
    }
  | {
      readonly entry: "overview";
      readonly seeds: readonly RecallGraphSeed[];
    };

export interface ValidatedRecallGraphTraversalInput {
  readonly entry: "surface" | "fts" | "overview";
  readonly depth: 0 | 1 | 2 | 3;
  readonly seeds: readonly RecallGraphSeed[];
}

function validatedSeed(value: unknown): RecallGraphSeed {
  const row = exactDataRecord(
    value,
    ["display", "entityId"],
    "INVALID_TRAVERSAL_INPUT",
  );
  return Object.freeze({
    entityId: canonicalIdentifier(
      row["entityId"],
      "entity",
      "INVALID_TRAVERSAL_INPUT",
    ),
    display: scalarText(row["display"], "INVALID_TRAVERSAL_INPUT"),
  });
}

export function validateRecallGraphTraversalInput(
  value: unknown,
): ValidatedRecallGraphTraversalInput {
  const loose = plainDataRecord(value, "INVALID_TRAVERSAL_INPUT");
  const entry = loose["entry"];
  const expectedKeys =
    entry === "overview" ? ["entry", "seeds"] : ["depth", "entry", "seeds"];
  const input = exactDataRecord(
    value,
    expectedKeys,
    "INVALID_TRAVERSAL_INPUT",
  );
  if (entry !== "surface" && entry !== "fts" && entry !== "overview") {
    return reject("INVALID_TRAVERSAL_INPUT");
  }
  const rawSeeds = plainDataArray(
    input["seeds"],
    MAX_TRAVERSAL_SEEDS,
    "INVALID_TRAVERSAL_INPUT",
  );
  const seeds = Object.freeze(rawSeeds.map(validatedSeed));
  if (entry === "overview") {
    return Object.freeze({ entry, depth: 0, seeds });
  }
  const depth = input["depth"];
  if (depth !== 1 && depth !== 2 && depth !== 3) {
    return reject("INVALID_TRAVERSAL_INPUT");
  }
  return Object.freeze({ entry, depth, seeds });
}

export interface RecallTraversalEntity {
  readonly entityId: string;
  readonly entityName: string;
}

export interface RecallTraversalClaimReference {
  readonly claimId: string;
  readonly subjectId: string;
  readonly subjectName: string;
  readonly objectId: string | null;
  readonly objectName: string | null;
  readonly supportCount: number;
  readonly strongestRank: 1 | 2 | 3;
  readonly lastSeenAt: number;
  readonly originSeq: number;
}

export interface RecallTraversalLink extends RecallTraversalClaimReference {
  readonly fromId: string;
  readonly toId: string;
}

export interface RecallTraversalNeighborhood {
  readonly entity: RecallTraversalEntity;
  readonly links: readonly RecallTraversalLink[];
  readonly incidents: readonly RecallTraversalClaimReference[];
}

const CLAIM_KEYS = Object.freeze([
  "claimId",
  "lastSeenAt",
  "objectId",
  "objectName",
  "originSeq",
  "strongestRank",
  "subjectId",
  "subjectName",
  "supportCount",
]);

function validatedClaim(
  value: unknown,
  expectedKeys: readonly string[] = CLAIM_KEYS,
): RecallTraversalClaimReference {
  const row = exactDataRecord(value, expectedKeys, "INVALID_TRAVERSAL_STATE");
  const claimId = canonicalIdentifier(
    row["claimId"],
    "claim",
    "INVALID_TRAVERSAL_STATE",
  );
  const subjectId = canonicalIdentifier(
    row["subjectId"],
    "entity",
    "INVALID_TRAVERSAL_STATE",
  );
  const subjectName = scalarText(
    row["subjectName"],
    "INVALID_TRAVERSAL_STATE",
  );
  const objectIdValue = row["objectId"];
  const objectNameValue = row["objectName"];
  const objectId =
    objectIdValue === null
      ? null
      : canonicalIdentifier(
          objectIdValue,
          "entity",
          "INVALID_TRAVERSAL_STATE",
        );
  const objectName =
    objectNameValue === null
      ? null
      : scalarText(objectNameValue, "INVALID_TRAVERSAL_STATE");
  if ((objectId === null) !== (objectName === null)) {
    return reject("INVALID_TRAVERSAL_STATE");
  }
  const supportCount = positiveSafeInteger(
    row["supportCount"],
    "INVALID_TRAVERSAL_STATE",
  );
  const strongestRank = row["strongestRank"];
  if (strongestRank !== 1 && strongestRank !== 2 && strongestRank !== 3) {
    return reject("INVALID_TRAVERSAL_STATE");
  }
  const originSeq = positiveSafeInteger(
    row["originSeq"],
    "INVALID_TRAVERSAL_STATE",
  );
  const parts = CLAIM_ID_PARTS.exec(claimId);
  if (parts?.[1] === undefined || BigInt(parts[1]) !== BigInt(originSeq)) {
    return reject("INVALID_TRAVERSAL_STATE");
  }
  return Object.freeze({
    claimId,
    subjectId,
    subjectName,
    objectId,
    objectName,
    supportCount,
    strongestRank,
    lastSeenAt: epoch(row["lastSeenAt"]),
    originSeq,
  });
}

function validatedLink(
  value: unknown,
  rootId: string,
): RecallTraversalLink {
  const row = exactDataRecord(
    value,
    [...CLAIM_KEYS, "fromId", "toId"],
    "INVALID_TRAVERSAL_STATE",
  );
  const claimReference = validatedClaim(row, [
    ...CLAIM_KEYS,
    "fromId",
    "toId",
  ]);
  const fromId = canonicalIdentifier(
    row["fromId"],
    "entity",
    "INVALID_TRAVERSAL_STATE",
  );
  const toId = canonicalIdentifier(
    row["toId"],
    "entity",
    "INVALID_TRAVERSAL_STATE",
  );
  if (
    fromId !== rootId ||
    claimReference.objectId === null ||
    !(
      (claimReference.subjectId === fromId && claimReference.objectId === toId) ||
      (claimReference.objectId === fromId && claimReference.subjectId === toId)
    )
  ) {
    return reject("INVALID_TRAVERSAL_STATE");
  }
  return Object.freeze({ ...claimReference, fromId, toId });
}

function compareNumbers(left: number, right: number): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

/** ADR-012's complete link/incident ordering, including numeric claim suffix. */
export function compareRecallTraversalClaims(
  left: RecallTraversalClaimReference,
  right: RecallTraversalClaimReference,
): number {
  return (
    compareNumbers(right.supportCount, left.supportCount) ||
    compareNumbers(right.strongestRank, left.strongestRank) ||
    compareNumbers(right.lastSeenAt, left.lastSeenAt) ||
    compareNumbers(left.originSeq, right.originSeq) ||
    compareOccurrenceIdentifiers(left.claimId, right.claimId, "claim")
  );
}

function assertOrdered(
  rows: readonly RecallTraversalClaimReference[],
): void {
  for (let index = 1; index < rows.length; index += 1) {
    const previous = rows[index - 1];
    const current = rows[index];
    if (
      previous === undefined ||
      current === undefined ||
      compareRecallTraversalClaims(previous, current) >= 0
    ) {
      reject("INVALID_TRAVERSAL_STATE");
    }
  }
}

export function validateRecallTraversalNeighborhood(
  value: unknown,
  expectedEntityId: unknown,
): RecallTraversalNeighborhood {
  const rootId = canonicalIdentifier(
    expectedEntityId,
    "entity",
    "INVALID_TRAVERSAL_STATE",
  );
  const input = exactDataRecord(
    value,
    ["entity", "incidents", "links"],
    "INVALID_TRAVERSAL_STATE",
  );
  const entityRow = exactDataRecord(
    input["entity"],
    ["entityId", "entityName"],
    "INVALID_TRAVERSAL_STATE",
  );
  const entityId = canonicalIdentifier(
    entityRow["entityId"],
    "entity",
    "INVALID_TRAVERSAL_STATE",
  );
  if (entityId !== rootId) {
    return reject("INVALID_TRAVERSAL_STATE");
  }
  const entity = Object.freeze({
    entityId,
    entityName: scalarText(
      entityRow["entityName"],
      "INVALID_TRAVERSAL_STATE",
    ),
  });
  const rawLinks = plainDataArray(
    input["links"],
    MAX_NEIGHBORHOOD_ROWS,
    "INVALID_TRAVERSAL_STATE",
  );
  const rawIncidents = plainDataArray(
    input["incidents"],
    MAX_NEIGHBORHOOD_ROWS,
    "INVALID_TRAVERSAL_STATE",
  );
  const links = Object.freeze(rawLinks.map((row) => validatedLink(row, rootId)));
  const incidents = Object.freeze(
    rawIncidents.map((row) => {
      const reference = validatedClaim(row);
      if (
        reference.subjectId !== rootId &&
        reference.objectId !== rootId
      ) {
        return reject("INVALID_TRAVERSAL_STATE");
      }
      return reference;
    }),
  );
  assertOrdered(links);
  assertOrdered(incidents);
  return Object.freeze({ entity, links, incidents });
}

export interface RecallTraversalParent {
  readonly entityId: string;
  readonly entityName: string;
  readonly parentId: string | null;
  readonly viaClaimId: string | null;
  readonly depth: number;
  readonly seedOrder: number;
}

export interface RecallReachedClaim {
  readonly claimId: string;
  readonly depth: number;
  readonly seedOrder: number;
  readonly anchorId: string;
  readonly path: string;
  readonly hops: number;
}

export interface RecallGraphTraversalResult {
  readonly parents: readonly RecallTraversalParent[];
  readonly reached: readonly RecallReachedClaim[];
  readonly truncation: Readonly<{
    readonly links: boolean;
    readonly incidents: boolean;
  }>;
}

export function truncateRecallSeedDisplay(value: string): string {
  const points = [...value];
  return points.length <= 80 ? value : `${points.slice(0, 79).join("")}…`;
}
