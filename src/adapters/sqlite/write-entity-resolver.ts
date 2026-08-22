import {
  ProjectionIdentifierError,
  assertCanonicalIdentifier,
} from "../../domain/projection-identifiers.js";
import {
  ProjectionRuleError,
  normalizeV1,
} from "../../domain/projection-rules.js";
import type { SqliteProjectionDispatchSession } from "./connection-factory.js";
import type {
  SqliteWriteEntityDraftInput,
  SqliteWriteEntityDraftResolution,
  SqliteWriteEntityReferenceInput,
} from "./connection-protocol.js";

export type WriteEntityResolutionErrorCode =
  | "INVALID_WRITE_ENTITY_RESOLUTION_INPUT"
  | "INVALID_WRITE_ENTITY_RESOLUTION_RESULT";

const ERROR_MESSAGES: Readonly<Record<WriteEntityResolutionErrorCode, string>> =
  Object.freeze({
    INVALID_WRITE_ENTITY_RESOLUTION_INPUT:
      "write entity resolution requires canonical transaction-bound drafts",
    INVALID_WRITE_ENTITY_RESOLUTION_RESULT:
      "write entity resolution returned an invalid transaction result",
  });

export class WriteEntityResolutionError extends TypeError {
  public override readonly name: string = "WriteEntityResolutionError";
  public readonly code: WriteEntityResolutionErrorCode;

  public constructor(code: WriteEntityResolutionErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.code = code;
  }
}

function reject(code: WriteEntityResolutionErrorCode): never {
  throw new WriteEntityResolutionError(code);
}

function plainDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
  code: WriteEntityResolutionErrorCode,
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
  code: WriteEntityResolutionErrorCode,
): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximumLength) {
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

function boundedText(
  value: unknown,
  maximumCodePoints: number,
  code: WriteEntityResolutionErrorCode,
): string {
  if (typeof value !== "string") {
    return reject(code);
  }
  const result = value.trim();
  const length = Array.from(result).length;
  if (length === 0 || length > maximumCodePoints) {
    return reject(code);
  }
  try {
    normalizeV1(result);
  } catch (error: unknown) {
    if (error instanceof ProjectionRuleError) {
      return reject(code);
    }
    throw error;
  }
  return result;
}

function snapshotReference(
  value: unknown,
  seenCandidates: Set<string>,
): SqliteWriteEntityReferenceInput {
  const input = plainDataRecord(
    value,
    ["aliases", "candidateId", "kind", "name"],
    "INVALID_WRITE_ENTITY_RESOLUTION_INPUT",
  );
  let candidateId: string;
  try {
    candidateId = assertCanonicalIdentifier(input["candidateId"], "entity");
  } catch (error: unknown) {
    if (error instanceof ProjectionIdentifierError) {
      return reject("INVALID_WRITE_ENTITY_RESOLUTION_INPUT");
    }
    throw error;
  }
  if (seenCandidates.has(candidateId)) {
    return reject("INVALID_WRITE_ENTITY_RESOLUTION_INPUT");
  }
  seenCandidates.add(candidateId);
  const name = boundedText(
    input["name"],
    1_024,
    "INVALID_WRITE_ENTITY_RESOLUTION_INPUT",
  );
  const kindValue = input["kind"];
  const kind =
    kindValue === null
      ? null
      : boundedText(
          kindValue,
          64,
          "INVALID_WRITE_ENTITY_RESOLUTION_INPUT",
        );
  const aliases = plainDataArray(
    input["aliases"],
    20,
    "INVALID_WRITE_ENTITY_RESOLUTION_INPUT",
  ).map((alias) =>
    boundedText(alias, 256, "INVALID_WRITE_ENTITY_RESOLUTION_INPUT"),
  );
  return Object.freeze({
    candidateId,
    name,
    kind,
    aliases: Object.freeze(aliases),
  });
}

function snapshotDrafts(value: unknown): readonly SqliteWriteEntityDraftInput[] {
  const drafts = plainDataArray(
    value,
    100,
    "INVALID_WRITE_ENTITY_RESOLUTION_INPUT",
  );
  const seenCandidates = new Set<string>();
  const seenIndexes = new Set<number>();
  return Object.freeze(
    drafts.map((draftValue) => {
      const draft = plainDataRecord(
        draftValue,
        ["draftIndex", "object", "subject"],
        "INVALID_WRITE_ENTITY_RESOLUTION_INPUT",
      );
      if (
        !Number.isSafeInteger(draft["draftIndex"]) ||
        Number(draft["draftIndex"]) < 0 ||
        seenIndexes.has(Number(draft["draftIndex"]))
      ) {
        return reject("INVALID_WRITE_ENTITY_RESOLUTION_INPUT");
      }
      const draftIndex = Number(draft["draftIndex"]);
      seenIndexes.add(draftIndex);
      return Object.freeze({
        draftIndex,
        subject: snapshotReference(draft["subject"], seenCandidates),
        object:
          draft["object"] === null
            ? null
            : snapshotReference(draft["object"], seenCandidates),
      });
    }),
  );
}

function freezeResolution(
  value: unknown,
): SqliteWriteEntityDraftResolution {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return reject("INVALID_WRITE_ENTITY_RESOLUTION_RESULT");
  }
  const status = (value as Readonly<Record<string, unknown>>)["status"];
  if (status === "resolved") {
    const result = plainDataRecord(
      value,
      ["draftIndex", "objectId", "status", "subjectId"],
      "INVALID_WRITE_ENTITY_RESOLUTION_RESULT",
    );
    if (
      !Number.isSafeInteger(result["draftIndex"]) ||
      Number(result["draftIndex"]) < 0
    ) {
      return reject("INVALID_WRITE_ENTITY_RESOLUTION_RESULT");
    }
    let subjectId: string;
    let objectId: string | null;
    try {
      subjectId = assertCanonicalIdentifier(result["subjectId"], "entity");
      objectId =
        result["objectId"] === null
          ? null
          : assertCanonicalIdentifier(result["objectId"], "entity");
    } catch (error: unknown) {
      if (error instanceof ProjectionIdentifierError) {
        return reject("INVALID_WRITE_ENTITY_RESOLUTION_RESULT");
      }
      throw error;
    }
    return Object.freeze({
      draftIndex: Number(result["draftIndex"]),
      status: "resolved",
      subjectId,
      objectId,
    });
  }

  const result = plainDataRecord(
    value,
    ["candidates", "draftIndex", "field", "note", "reason", "status"],
    "INVALID_WRITE_ENTITY_RESOLUTION_RESULT",
  );
  if (
    result["status"] !== "rejected" ||
    result["reason"] !== "ambiguous_entity" ||
    (result["field"] !== "subject" && result["field"] !== "object") ||
    !Number.isSafeInteger(result["draftIndex"]) ||
    Number(result["draftIndex"]) < 0 ||
    typeof result["note"] !== "string" ||
    result["note"].length === 0
  ) {
    return reject("INVALID_WRITE_ENTITY_RESOLUTION_RESULT");
  }
  const candidates = plainDataArray(
    result["candidates"],
    Number.MAX_SAFE_INTEGER,
    "INVALID_WRITE_ENTITY_RESOLUTION_RESULT",
  ).map((candidateValue) => {
    const candidate = plainDataRecord(
      candidateValue,
      ["entityId", "name"],
      "INVALID_WRITE_ENTITY_RESOLUTION_RESULT",
    );
    let entityId: string;
    try {
      entityId = assertCanonicalIdentifier(candidate["entityId"], "entity");
    } catch (error: unknown) {
      if (error instanceof ProjectionIdentifierError) {
        return reject("INVALID_WRITE_ENTITY_RESOLUTION_RESULT");
      }
      throw error;
    }
    if (typeof candidate["name"] !== "string") {
      return reject("INVALID_WRITE_ENTITY_RESOLUTION_RESULT");
    }
    return Object.freeze({ entityId, name: candidate["name"] });
  });
  if (candidates.length < 2) {
    return reject("INVALID_WRITE_ENTITY_RESOLUTION_RESULT");
  }
  return Object.freeze({
    draftIndex: Number(result["draftIndex"]),
    status: "rejected",
    reason: "ambiguous_entity",
    field: result["field"],
    candidates: Object.freeze(candidates),
    note: result["note"],
  });
}

function freezeResults(
  values: readonly SqliteWriteEntityDraftResolution[],
  expectedDrafts: readonly SqliteWriteEntityDraftInput[],
): readonly SqliteWriteEntityDraftResolution[] {
  if (!Array.isArray(values) || values.length !== expectedDrafts.length) {
    return reject("INVALID_WRITE_ENTITY_RESOLUTION_RESULT");
  }
  const results = values.map(freezeResolution);
  for (let index = 0; index < results.length; index += 1) {
    if (results[index]?.draftIndex !== expectedDrafts[index]?.draftIndex) {
      return reject("INVALID_WRITE_ENTITY_RESOLUTION_RESULT");
    }
  }
  return Object.freeze(results);
}

/**
 * Resolves draft entities only inside a prepared writer dispatch transaction.
 * This helper has no commit capability. The session rolls all staged entity,
 * surface and redirect rows back before a journal append can begin.
 */
export function resolveSqliteWriteEntityDrafts(
  session: SqliteProjectionDispatchSession,
  value: unknown,
): Promise<readonly SqliteWriteEntityDraftResolution[]> {
  let dispatchId: number;
  let drafts: readonly SqliteWriteEntityDraftInput[];
  try {
    const input = plainDataRecord(
      value,
      ["dispatchId", "drafts"],
      "INVALID_WRITE_ENTITY_RESOLUTION_INPUT",
    );
    if (
      !Number.isSafeInteger(input["dispatchId"]) ||
      Number(input["dispatchId"]) <= 0 ||
      session === null ||
      typeof session !== "object" ||
      typeof session.resolveEntities !== "function"
    ) {
      return Promise.reject(
        new WriteEntityResolutionError(
          "INVALID_WRITE_ENTITY_RESOLUTION_INPUT",
        ),
      );
    }
    dispatchId = Number(input["dispatchId"]);
    drafts = snapshotDrafts(input["drafts"]);
  } catch (error: unknown) {
    return Promise.reject(error);
  }
  return session
    .resolveEntities(dispatchId, drafts)
    .then((results) => freezeResults(results, drafts));
}

export type {
  SqliteWriteEntityDraftInput as WriteEntityDraftResolutionInput,
  SqliteWriteEntityDraftResolution as WriteEntityDraftResolution,
  SqliteWriteEntityReferenceInput as WriteEntityReferenceResolutionInput,
};
