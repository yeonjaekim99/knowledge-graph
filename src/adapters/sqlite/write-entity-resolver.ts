import {
  ProjectionIdentifierError,
  assertCanonicalIdentifier,
  compareOccurrenceIdentifiers,
} from "../../domain/projection-identifiers.js";
import {
  ProjectionRuleError,
  normalizeV1,
} from "../../domain/projection-rules.js";
import type { SqliteProjectionDispatchSession } from "./connection-factory.js";
import {
  SqliteConnectionError,
  connectionErrorFromCode,
} from "./connection-protocol.js";
import type {
  SqliteConnectionErrorCode,
  SqliteWriteEntityDraftInput,
  SqliteWriteEntityDraftResolution,
  SqliteWriteEntityFinalizationResult,
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

const AMBIGUITY_NOTES = Object.freeze({
  subject:
    "subject matches multiple entities; retry with an exact canonical name or confirm an alias or merge",
  object:
    "object matches multiple entities; retry with an exact canonical name or confirm an alias or merge",
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

function rejected<T>(code: WriteEntityResolutionErrorCode): Promise<T> {
  return Promise.reject(new WriteEntityResolutionError(code));
}

const CONNECTION_ERROR_CODES: ReadonlySet<string> = new Set<
  SqliteConnectionErrorCode
>([
  "WAL_MODE_REQUIRED",
  "WAL_MODE_UNAVAILABLE",
  "CONNECTION_POLICY_UNAVAILABLE",
  "SQLITE_CONNECTION_FAILED",
  "SQLITE_TRANSACTION_FAILED",
  "SQLITE_QUERY_FAILED",
  "SQLITE_SIDECAR_UNSAFE",
  "SQLITE_WORKER_FAILED",
  "INVALID_TRANSACTION_PROGRAM",
  "WRITER_ALREADY_ACTIVE",
  "CONNECTION_FACTORY_CLOSED",
  "CONNECTION_CLOSED",
  "RECALL_SNAPSHOT_FAILED",
  "SQLITE_BUSY",
]);

function reconstructedConnectionError(
  error: unknown,
): SqliteConnectionError | null {
  try {
    if (error === null || typeof error !== "object") {
      return null;
    }
    const codeDescriptor = Object.getOwnPropertyDescriptor(error, "code");
    if (
      codeDescriptor === undefined ||
      !("value" in codeDescriptor) ||
      typeof codeDescriptor.value !== "string" ||
      !CONNECTION_ERROR_CODES.has(codeDescriptor.value)
    ) {
      return null;
    }
    const canonical = connectionErrorFromCode(
      codeDescriptor.value as SqliteConnectionErrorCode,
    );
    if (!(canonical instanceof SqliteConnectionError)) {
      return null;
    }
    const actualKeys = Reflect.ownKeys(error);
    const canonicalKeys = Reflect.ownKeys(canonical);
    if (
      actualKeys.length !== canonicalKeys.length ||
      actualKeys.some((key) => !canonicalKeys.includes(key))
    ) {
      return null;
    }
    for (const key of canonicalKeys) {
      const actual = Object.getOwnPropertyDescriptor(error, key);
      const expected = Object.getOwnPropertyDescriptor(canonical, key);
      if (
        actual === undefined ||
        expected === undefined ||
        actual.configurable !== expected.configurable ||
        actual.enumerable !== expected.enumerable ||
        ("value" in actual) !== ("value" in expected)
      ) {
        return null;
      }
      if ("value" in actual && "value" in expected) {
        if (
          actual.value !== expected.value ||
          actual.writable !== expected.writable
        ) {
          return null;
        }
      } else if (
        !("value" in actual) &&
        !("value" in expected) &&
        (actual.get !== expected.get || actual.set !== expected.set)
      ) {
        return null;
      }
    }
    return canonical;
  } catch {
    return null;
  }
}

async function invokeSessionOperation<T>(
  operation: () => unknown,
  snapshotResult: (value: unknown) => T,
): Promise<T> {
  let operationResult: Promise<unknown>;
  try {
    const candidate = operation();
    if (!(candidate instanceof Promise)) {
      return reject("INVALID_WRITE_ENTITY_RESOLUTION_RESULT");
    }
    operationResult = candidate;
  } catch {
    return reject("INVALID_WRITE_ENTITY_RESOLUTION_RESULT");
  }

  let settledResult: unknown;
  try {
    settledResult = await new Promise<unknown>((resolve, rejectSettlement) => {
      try {
        void Promise.prototype.then.call(
          operationResult,
          resolve,
          rejectSettlement,
        );
      } catch (error: unknown) {
        rejectSettlement(error);
      }
    });
  } catch (error: unknown) {
    const connectionError = reconstructedConnectionError(error);
    if (connectionError !== null) {
      throw connectionError;
    }
    return reject("INVALID_WRITE_ENTITY_RESOLUTION_RESULT");
  }

  try {
    return snapshotResult(settledResult);
  } catch {
    return reject("INVALID_WRITE_ENTITY_RESOLUTION_RESULT");
  }
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
  const keys = Reflect.ownKeys(value);
  const expected = new Set(expectedKeys);
  if (
    keys.length !== expected.size ||
    keys.some((key) => typeof key !== "string" || !expected.has(key))
  ) {
    return reject(code);
  }
  const result: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const key of expectedKeys) {
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
}

function plainDataArray(
  value: unknown,
  maximumLength: number,
  code: WriteEntityResolutionErrorCode,
): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
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
  const keys = Reflect.ownKeys(value);
  if (keys.length !== length + 1 || !keys.includes("length")) {
    return reject(code);
  }
  const result: unknown[] = [];
  result.length = length;
  for (const key of keys) {
    if (key === "length") {
      continue;
    }
    if (typeof key !== "string") {
      return reject(code);
    }
    const index = Number(key);
    if (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= length ||
      String(index) !== key
    ) {
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
    result[index] = descriptor.value;
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

function boundedKind(
  value: unknown,
  code: WriteEntityResolutionErrorCode,
): string {
  if (typeof value !== "string" || !value.isWellFormed()) {
    return reject(code);
  }
  const result = value.trim().normalize("NFKC").toLowerCase();
  const length = Array.from(result).length;
  if (length === 0 || length > 64) {
    return reject(code);
  }
  return result;
}

function snapshotReference(
  value: unknown,
): SqliteWriteEntityReferenceInput {
  const input = plainDataRecord(
    value,
    ["aliases", "kind", "name"],
    "INVALID_WRITE_ENTITY_RESOLUTION_INPUT",
  );
  const name = boundedText(
    input["name"],
    1_024,
    "INVALID_WRITE_ENTITY_RESOLUTION_INPUT",
  );
  const kindValue = input["kind"];
  const kind =
    kindValue === null
      ? null
      : boundedKind(kindValue, "INVALID_WRITE_ENTITY_RESOLUTION_INPUT");
  const aliases = plainDataArray(
    input["aliases"],
    20,
    "INVALID_WRITE_ENTITY_RESOLUTION_INPUT",
  ).map((alias) =>
    boundedText(alias, 256, "INVALID_WRITE_ENTITY_RESOLUTION_INPUT"),
  );
  return Object.freeze({
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
  let previousIndex = -1;
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
        Number(draft["draftIndex"]) <= previousIndex
      ) {
        return reject("INVALID_WRITE_ENTITY_RESOLUTION_INPUT");
      }
      const draftIndex = Number(draft["draftIndex"]);
      previousIndex = draftIndex;
      return Object.freeze({
        draftIndex,
        subject: snapshotReference(draft["subject"]),
        object:
          draft["object"] === null
            ? null
            : snapshotReference(draft["object"]),
      });
    }),
  );
}

function freezeResolution(
  value: unknown,
  expectedDraft: SqliteWriteEntityDraftInput | null,
): SqliteWriteEntityDraftResolution {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return reject("INVALID_WRITE_ENTITY_RESOLUTION_RESULT");
  }
  const statusDescriptor = Object.getOwnPropertyDescriptor(value, "status");
  if (
    statusDescriptor === undefined ||
    statusDescriptor.enumerable !== true ||
    !("value" in statusDescriptor)
  ) {
    return reject("INVALID_WRITE_ENTITY_RESOLUTION_RESULT");
  }
  const status = statusDescriptor.value;
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
    const draftIndex = Number(result["draftIndex"]);
    if (
      expectedDraft !== null &&
      (draftIndex !== expectedDraft.draftIndex ||
        (objectId !== null) !== (expectedDraft.object !== null))
    ) {
      return reject("INVALID_WRITE_ENTITY_RESOLUTION_RESULT");
    }
    return Object.freeze({
      draftIndex,
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
  const field = result["field"];
  if (
    result["status"] !== "rejected" ||
    result["reason"] !== "ambiguous_entity" ||
    (field !== "subject" && field !== "object") ||
    !Number.isSafeInteger(result["draftIndex"]) ||
    Number(result["draftIndex"]) < 0 ||
    result["note"] !== AMBIGUITY_NOTES[field]
  ) {
    return reject("INVALID_WRITE_ENTITY_RESOLUTION_RESULT");
  }
  const draftIndex = Number(result["draftIndex"]);
  if (
    expectedDraft !== null &&
    (draftIndex !== expectedDraft.draftIndex ||
      (field === "object" && expectedDraft.object === null))
  ) {
    return reject("INVALID_WRITE_ENTITY_RESOLUTION_RESULT");
  }
  const seenCandidates = new Set<string>();
  let previousCandidate: string | null = null;
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
    if (seenCandidates.has(entityId)) {
      return reject("INVALID_WRITE_ENTITY_RESOLUTION_RESULT");
    }
    if (
      previousCandidate !== null &&
      compareOccurrenceIdentifiers(previousCandidate, entityId, "entity") >= 0
    ) {
      return reject("INVALID_WRITE_ENTITY_RESOLUTION_RESULT");
    }
    const name = boundedText(
      candidate["name"],
      1_024,
      "INVALID_WRITE_ENTITY_RESOLUTION_RESULT",
    );
    seenCandidates.add(entityId);
    previousCandidate = entityId;
    return Object.freeze({ entityId, name });
  });
  if (candidates.length < 2) {
    return reject("INVALID_WRITE_ENTITY_RESOLUTION_RESULT");
  }
  return Object.freeze({
    draftIndex,
    status: "rejected",
    reason: "ambiguous_entity",
    field,
    candidates: Object.freeze(candidates),
    note: AMBIGUITY_NOTES[field],
  });
}

function snapshotSurvivorDraftIndexes(value: unknown): readonly number[] {
  const values = plainDataArray(
    value,
    100,
    "INVALID_WRITE_ENTITY_RESOLUTION_INPUT",
  );
  let previous = -1;
  return Object.freeze(
    values.map((item) => {
      if (!Number.isSafeInteger(item) || Number(item) <= previous) {
        return reject("INVALID_WRITE_ENTITY_RESOLUTION_INPUT");
      }
      previous = Number(item);
      return previous;
    }),
  );
}

function freezeFinalizationResult(
  value: unknown,
  survivorDraftIndexes: readonly number[],
): SqliteWriteEntityFinalizationResult {
  const result = plainDataRecord(
    value,
    ["drafts", "expectedJournalSeq"],
    "INVALID_WRITE_ENTITY_RESOLUTION_RESULT",
  );
  if (
    !Number.isSafeInteger(result["expectedJournalSeq"]) ||
    Number(result["expectedJournalSeq"]) <= 0
  ) {
    return reject("INVALID_WRITE_ENTITY_RESOLUTION_RESULT");
  }
  const draftValues = plainDataArray(
    result["drafts"],
    100,
    "INVALID_WRITE_ENTITY_RESOLUTION_RESULT",
  );
  if (draftValues.length !== survivorDraftIndexes.length) {
    return reject("INVALID_WRITE_ENTITY_RESOLUTION_RESULT");
  }
  const drafts = draftValues.map((draftValue, index) => {
    const draft = freezeResolution(draftValue, null);
    if (
      draft.status !== "resolved" ||
      draft.draftIndex !== survivorDraftIndexes[index]
    ) {
      return reject("INVALID_WRITE_ENTITY_RESOLUTION_RESULT");
    }
    return draft;
  });
  return Object.freeze({
    expectedJournalSeq: Number(result["expectedJournalSeq"]),
    drafts: Object.freeze(drafts),
  });
}

function freezeResults(
  values: unknown,
  expectedDrafts: readonly SqliteWriteEntityDraftInput[],
): readonly SqliteWriteEntityDraftResolution[] {
  const resultValues = plainDataArray(
    values,
    expectedDrafts.length,
    "INVALID_WRITE_ENTITY_RESOLUTION_RESULT",
  );
  if (resultValues.length !== expectedDrafts.length) {
    return reject("INVALID_WRITE_ENTITY_RESOLUTION_RESULT");
  }
  const results = resultValues.map((resultValue, index) => {
    const expectedDraft = expectedDrafts[index];
    if (expectedDraft === undefined) {
      return reject("INVALID_WRITE_ENTITY_RESOLUTION_RESULT");
    }
    return freezeResolution(resultValue, expectedDraft);
  });
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
  let resolveEntities: SqliteProjectionDispatchSession["resolveEntities"];
  try {
    const input = plainDataRecord(
      value,
      ["dispatchId", "drafts"],
      "INVALID_WRITE_ENTITY_RESOLUTION_INPUT",
    );
    const sessionMethod =
      session === null || typeof session !== "object"
        ? null
        : session.resolveEntities;
    if (
      !Number.isSafeInteger(input["dispatchId"]) ||
      Number(input["dispatchId"]) <= 0 ||
      typeof sessionMethod !== "function"
    ) {
      return rejected("INVALID_WRITE_ENTITY_RESOLUTION_INPUT");
    }
    dispatchId = Number(input["dispatchId"]);
    drafts = snapshotDrafts(input["drafts"]);
    resolveEntities = sessionMethod;
  } catch {
    return rejected("INVALID_WRITE_ENTITY_RESOLUTION_INPUT");
  }
  return invokeSessionOperation(
    () => Reflect.apply(resolveEntities, session, [dispatchId, drafts]),
    (results) => freezeResults(results, drafts),
  );
}

/**
 * Replays only caller-selected survivor drafts inside the same writer lock.
 * REC-005 owns survivor selection; the worker owns compact occurrence IDs.
 */
export function finalizeSqliteWriteEntityDrafts(
  session: SqliteProjectionDispatchSession,
  value: unknown,
): Promise<SqliteWriteEntityFinalizationResult> {
  let dispatchId: number;
  let survivorDraftIndexes: readonly number[];
  let statementBodyJson: string;
  let finalizeEntities: SqliteProjectionDispatchSession["finalizeEntities"];
  try {
    const input = plainDataRecord(
      value,
      ["dispatchId", "statementBodyJson", "survivorDraftIndexes"],
      "INVALID_WRITE_ENTITY_RESOLUTION_INPUT",
    );
    const sessionMethod =
      session === null || typeof session !== "object"
        ? null
        : session.finalizeEntities;
    if (
      !Number.isSafeInteger(input["dispatchId"]) ||
      Number(input["dispatchId"]) <= 0 ||
      typeof sessionMethod !== "function"
    ) {
      return rejected("INVALID_WRITE_ENTITY_RESOLUTION_INPUT");
    }
    dispatchId = Number(input["dispatchId"]);
    survivorDraftIndexes = snapshotSurvivorDraftIndexes(
      input["survivorDraftIndexes"],
    );
    if (
      typeof input["statementBodyJson"] !== "string" ||
      input["statementBodyJson"].length === 0
    ) {
      return rejected("INVALID_WRITE_ENTITY_RESOLUTION_INPUT");
    }
    statementBodyJson = input["statementBodyJson"];
    finalizeEntities = sessionMethod;
  } catch {
    return rejected("INVALID_WRITE_ENTITY_RESOLUTION_INPUT");
  }
  return invokeSessionOperation(
    () =>
      Reflect.apply(finalizeEntities, session, [
        dispatchId,
        survivorDraftIndexes,
        statementBodyJson,
      ]),
    (result) =>
      freezeFinalizationResult(result, survivorDraftIndexes),
  );
}

export type {
  SqliteWriteEntityDraftInput as WriteEntityDraftResolutionInput,
  SqliteWriteEntityDraftResolution as WriteEntityDraftResolution,
  SqliteWriteEntityFinalizationResult as WriteEntityFinalizationResult,
  SqliteWriteEntityReferenceInput as WriteEntityReferenceResolutionInput,
};
