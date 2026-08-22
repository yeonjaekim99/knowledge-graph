import {
  SECRET_SIGNATURE_REGISTRY,
  assertCanonicalIdentifier,
  compareOccurrenceIdentifiers,
  getRelationDefinition,
  normalizeLiteralIdentity,
  normalizeRelationLabel,
} from "../domain/index.js";
import type { ClaimDraft } from "./memory-record-contract.js";

export type RecordDraftPlanningErrorCode =
  | "INVALID_RECORD_DRAFT_PLAN_INPUT"
  | "INVALID_RECORD_DRAFT_FINALIZATION";

const ERROR_MESSAGES: Readonly<Record<RecordDraftPlanningErrorCode, string>> =
  Object.freeze({
    INVALID_RECORD_DRAFT_PLAN_INPUT:
      "record draft planning requires canonical sanitized and resolved drafts",
    INVALID_RECORD_DRAFT_FINALIZATION:
      "record draft finalization requires the exact compact survivor result",
  });

const DUPLICATE_NOTE =
  "duplicate draft folded into the first stored draft";
const AMBIGUITY_NOTES = Object.freeze({
  subject:
    "subject matches multiple entities; retry with an exact canonical name or confirm an alias or merge",
  object:
    "object matches multiple entities; retry with an exact canonical name or confirm an alias or merge",
});
const SECRET_CLASSES: ReadonlySet<string> = new Set([
  ...SECRET_SIGNATURE_REGISTRY.map(({ secretClass }) => secretClass),
  "high-entropy",
]);
const SECRET_NOTE_PATTERN =
  /^Secret detected at claims\[([0-9]+)\]\.(subject|subject_kind|object|object_kind|object_value|relation_label|subject_aliases\[([0-9]+)\]|object_aliases\[([0-9]+)\]) \(class=([a-z0-9-]+)\); remove the secret and retry\.$/u;
const DRAFT_KEYS: ReadonlySet<string> = new Set([
  "subject",
  "subject_kind",
  "relation",
  "relation_label",
  "object",
  "object_kind",
  "object_value",
  "subject_aliases",
  "object_aliases",
]);

export class RecordDraftPlanningError extends TypeError {
  public override readonly name: string = "RecordDraftPlanningError";
  public readonly code: RecordDraftPlanningErrorCode;

  public constructor(code: RecordDraftPlanningErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.code = code;
  }
}

export interface StoredRecordDraft {
  readonly inputIndex: number;
  readonly storedIndex: number;
  readonly draft: ClaimDraft;
}

export interface AcceptedRecordDraftPlanOutcome {
  readonly index: number;
  readonly status: "accepted";
  readonly storedIndex: number;
}

export interface DuplicateRecordDraftPlanOutcome {
  readonly index: number;
  readonly status: "reinforced";
  readonly storedIndex: number;
  readonly duplicateOfIndex: number;
  readonly note: string;
}

export interface RejectedRecordDraftPlanOutcome {
  readonly index: number;
  readonly status: "rejected";
  readonly note: string;
}

export type RecordDraftPlanOutcome =
  | AcceptedRecordDraftPlanOutcome
  | DuplicateRecordDraftPlanOutcome
  | RejectedRecordDraftPlanOutcome;

export interface RecordDraftSurvivorPlan {
  readonly storedDrafts: readonly StoredRecordDraft[];
  readonly survivorDraftIndexes: readonly number[];
  readonly outcomes: readonly RecordDraftPlanOutcome[];
}

export interface RecordEntityOccurrenceMapping {
  readonly position: number;
  readonly candidateId: string;
  readonly canonicalId: string;
}

export interface FinalizedRecordDraftMapping {
  readonly inputIndex: number;
  readonly storedIndex: number;
  readonly claimCandidateId: string;
  readonly subjectOccurrence: RecordEntityOccurrenceMapping;
  readonly objectOccurrence: RecordEntityOccurrenceMapping | null;
}

export type FinalizedRecordDraftPlanOutcome =
  | (AcceptedRecordDraftPlanOutcome &
      Readonly<{ claimCandidateId: string }>)
  | (DuplicateRecordDraftPlanOutcome &
      Readonly<{ claimCandidateId: string }>)
  | RejectedRecordDraftPlanOutcome;

export interface FinalizedRecordDraftPlan {
  readonly expectedJournalSeq: number;
  readonly storedDrafts: readonly StoredRecordDraft[];
  readonly survivorDraftIndexes: readonly number[];
  readonly mappings: readonly FinalizedRecordDraftMapping[];
  readonly outcomes: readonly FinalizedRecordDraftPlanOutcome[];
}

interface ResolvedDraft {
  readonly draftIndex: number;
  readonly status: "resolved";
  readonly subjectId: string;
  readonly objectId: string | null;
}

interface RejectedResolution {
  readonly draftIndex: number;
  readonly status: "rejected";
  readonly field: "subject" | "object";
  readonly note: string;
}

type DraftResolution = ResolvedDraft | RejectedResolution;

interface SelectedDraftIdentity {
  readonly key: string;
  readonly resolution: ResolvedDraft;
}

const survivorPlans = new WeakSet<object>();

function fail(code: RecordDraftPlanningErrorCode): never {
  throw new RecordDraftPlanningError(code);
}

function exactDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
  code: RecordDraftPlanningErrorCode,
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail(code);
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return fail(code);
  }
  const keys = Reflect.ownKeys(value);
  const expected = new Set(expectedKeys);
  if (
    keys.length !== expected.size ||
    keys.some((key) => typeof key !== "string" || !expected.has(key))
  ) {
    return fail(code);
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
      return fail(code);
    }
    result[key] = descriptor.value;
  }
  return Object.freeze(result);
}

function allowedDataRecord(
  value: unknown,
  allowedKeys: ReadonlySet<string>,
  code: RecordDraftPlanningErrorCode,
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail(code);
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return fail(code);
  }
  const result: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowedKeys.has(key)) {
      return fail(code);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !("value" in descriptor)
    ) {
      return fail(code);
    }
    result[key] = descriptor.value;
  }
  return Object.freeze(result);
}

function plainDataArray(
  value: unknown,
  maximumLength: number,
  code: RecordDraftPlanningErrorCode,
): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    return fail(code);
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (
    lengthDescriptor === undefined ||
    !("value" in lengthDescriptor) ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    Number(lengthDescriptor.value) < 0 ||
    Number(lengthDescriptor.value) > maximumLength
  ) {
    return fail(code);
  }
  const length = Number(lengthDescriptor.value);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== length + 1 || !keys.includes("length")) {
    return fail(code);
  }
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const key = String(index);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !("value" in descriptor)
    ) {
      return fail(code);
    }
    result.push(descriptor.value);
  }
  return Object.freeze(result);
}

function boundedText(
  value: unknown,
  maximumCodePoints: number,
  code: RecordDraftPlanningErrorCode,
): string {
  if (typeof value !== "string" || !value.isWellFormed()) {
    return fail(code);
  }
  const length = Array.from(value.trim()).length;
  if (length < 1 || length > maximumCodePoints) {
    return fail(code);
  }
  return value;
}

function nonNegativeIndex(
  value: unknown,
  code: RecordDraftPlanningErrorCode,
): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) >= 100) {
    return fail(code);
  }
  return Number(value);
}

function aliasArray(
  value: unknown,
  code: RecordDraftPlanningErrorCode,
): readonly string[] {
  return Object.freeze(
    plainDataArray(value, 20, code).map((alias) =>
      boundedText(alias, 256, code),
    ),
  );
}

function snapshotDraft(
  value: unknown,
  code: RecordDraftPlanningErrorCode,
): ClaimDraft {
  const source = allowedDataRecord(value, DRAFT_KEYS, code);
  if (!Object.hasOwn(source, "subject") || !Object.hasOwn(source, "relation")) {
    return fail(code);
  }
  const subject = boundedText(source["subject"], 1_024, code);
  const relation = getRelationDefinition(source["relation"]).relation;
  const hasObject = Object.hasOwn(source, "object");
  const hasObjectValue = Object.hasOwn(source, "object_value");
  if (hasObject === hasObjectValue) {
    return fail(code);
  }
  const relationLabel = Object.hasOwn(source, "relation_label")
    ? boundedText(source["relation_label"], 256, code)
    : undefined;
  normalizeRelationLabel(relation, relationLabel);
  const common = {
    subject,
    relation,
    ...(Object.hasOwn(source, "subject_kind")
      ? { subject_kind: boundedText(source["subject_kind"], 64, code) }
      : {}),
    ...(relationLabel === undefined ? {} : { relation_label: relationLabel }),
    ...(Object.hasOwn(source, "subject_aliases")
      ? { subject_aliases: aliasArray(source["subject_aliases"], code) }
      : {}),
  };
  if (hasObject) {
    const object = boundedText(source["object"], 1_024, code);
    return Object.freeze({
      ...common,
      object,
      ...(Object.hasOwn(source, "object_kind")
        ? { object_kind: boundedText(source["object_kind"], 64, code) }
        : {}),
      ...(Object.hasOwn(source, "object_aliases")
        ? { object_aliases: aliasArray(source["object_aliases"], code) }
        : {}),
    }) as ClaimDraft;
  }
  if (
    Object.hasOwn(source, "object_kind") ||
    Object.hasOwn(source, "object_aliases")
  ) {
    return fail(code);
  }
  return Object.freeze({
    ...common,
    object_value: boundedText(source["object_value"], 1_024, code),
  }) as ClaimDraft;
}

function sanitizerNote(value: unknown, index: number): string {
  const note = boundedText(value, 2_048, "INVALID_RECORD_DRAFT_PLAN_INPUT");
  const match = SECRET_NOTE_PATTERN.exec(note);
  if (
    match === null ||
    Number(match[1]) !== index ||
    match[2] === undefined ||
    match[5] === undefined ||
    !SECRET_CLASSES.has(match[5])
  ) {
    return fail("INVALID_RECORD_DRAFT_PLAN_INPUT");
  }
  const aliasIndex = match[3] ?? match[4];
  if (
    aliasIndex !== undefined &&
    (!Number.isSafeInteger(Number(aliasIndex)) || Number(aliasIndex) >= 20)
  ) {
    return fail("INVALID_RECORD_DRAFT_PLAN_INPUT");
  }
  return `Secret detected at claims[${index}].${match[2]} (class=${match[5]}); remove the secret and retry.`;
}

function snapshotApprovedDrafts(value: unknown): readonly StoredRecordDraft[] {
  const result: StoredRecordDraft[] = [];
  let previousIndex = -1;
  for (const item of plainDataArray(
    value,
    100,
    "INVALID_RECORD_DRAFT_PLAN_INPUT",
  )) {
    const source = exactDataRecord(
      item,
      ["inputIndex", "draft"],
      "INVALID_RECORD_DRAFT_PLAN_INPUT",
    );
    const inputIndex = nonNegativeIndex(
      source["inputIndex"],
      "INVALID_RECORD_DRAFT_PLAN_INPUT",
    );
    if (inputIndex <= previousIndex) {
      return fail("INVALID_RECORD_DRAFT_PLAN_INPUT");
    }
    previousIndex = inputIndex;
    result.push(
      Object.freeze({
        inputIndex,
        storedIndex: -1,
        draft: snapshotDraft(
          source["draft"],
          "INVALID_RECORD_DRAFT_PLAN_INPUT",
        ),
      }),
    );
  }
  return Object.freeze(result);
}

function snapshotSanitizerRejections(
  value: unknown,
): readonly RejectedRecordDraftPlanOutcome[] {
  return Object.freeze(
    plainDataArray(value, 100, "INVALID_RECORD_DRAFT_PLAN_INPUT").map(
      (item) => {
        const source = exactDataRecord(
          item,
          ["index", "status", "note"],
          "INVALID_RECORD_DRAFT_PLAN_INPUT",
        );
        const index = nonNegativeIndex(
          source["index"],
          "INVALID_RECORD_DRAFT_PLAN_INPUT",
        );
        if (source["status"] !== "rejected") {
          return fail("INVALID_RECORD_DRAFT_PLAN_INPUT");
        }
        return Object.freeze({
          index,
          status: "rejected" as const,
          note: sanitizerNote(source["note"], index),
        });
      },
    ),
  );
}

function canonicalEntityId(
  value: unknown,
  code: RecordDraftPlanningErrorCode,
): string {
  try {
    return assertCanonicalIdentifier(value, "entity");
  } catch {
    return fail(code);
  }
}

function snapshotAmbiguityCandidates(value: unknown): void {
  const candidates = plainDataArray(
    value,
    Number.MAX_SAFE_INTEGER,
    "INVALID_RECORD_DRAFT_PLAN_INPUT",
  );
  if (candidates.length < 2) {
    return fail("INVALID_RECORD_DRAFT_PLAN_INPUT");
  }
  let previous: string | null = null;
  const seen = new Set<string>();
  for (const item of candidates) {
    const source = exactDataRecord(
      item,
      ["entityId", "name"],
      "INVALID_RECORD_DRAFT_PLAN_INPUT",
    );
    const entityId = canonicalEntityId(
      source["entityId"],
      "INVALID_RECORD_DRAFT_PLAN_INPUT",
    );
    boundedText(source["name"], 1_024, "INVALID_RECORD_DRAFT_PLAN_INPUT");
    if (
      seen.has(entityId) ||
      (previous !== null &&
        compareOccurrenceIdentifiers(previous, entityId, "entity") >= 0)
    ) {
      return fail("INVALID_RECORD_DRAFT_PLAN_INPUT");
    }
    seen.add(entityId);
    previous = entityId;
  }
}

function snapshotResolution(
  value: unknown,
  expected: StoredRecordDraft,
  code: RecordDraftPlanningErrorCode,
): DraftResolution {
  const statusRecord = allowedDataRecord(
    value,
    new Set([
      "draftIndex",
      "status",
      "subjectId",
      "objectId",
      "reason",
      "field",
      "candidates",
      "note",
    ]),
    code,
  );
  if (statusRecord["status"] === "resolved") {
    const source = exactDataRecord(
      value,
      ["draftIndex", "status", "subjectId", "objectId"],
      code,
    );
    const draftIndex = nonNegativeIndex(source["draftIndex"], code);
    const subjectId = canonicalEntityId(source["subjectId"], code);
    const objectId =
      source["objectId"] === null
        ? null
        : canonicalEntityId(source["objectId"], code);
    if (
      draftIndex !== expected.inputIndex ||
      (objectId !== null) !== ("object" in expected.draft)
    ) {
      return fail(code);
    }
    return Object.freeze({
      draftIndex,
      status: "resolved",
      subjectId,
      objectId,
    });
  }
  const source = exactDataRecord(
    value,
    ["draftIndex", "status", "reason", "field", "candidates", "note"],
    code,
  );
  const draftIndex = nonNegativeIndex(source["draftIndex"], code);
  const field = source["field"];
  if (
    draftIndex !== expected.inputIndex ||
    source["status"] !== "rejected" ||
    source["reason"] !== "ambiguous_entity" ||
    (field !== "subject" && field !== "object") ||
    (field === "object" && !("object" in expected.draft)) ||
    source["note"] !== AMBIGUITY_NOTES[field]
  ) {
    return fail(code);
  }
  snapshotAmbiguityCandidates(source["candidates"]);
  return Object.freeze({
    draftIndex,
    status: "rejected",
    field,
    note: AMBIGUITY_NOTES[field],
  });
}

function assertCoverage(
  approved: readonly StoredRecordDraft[],
  rejected: readonly RejectedRecordDraftPlanOutcome[],
): void {
  const indexes = [
    ...approved.map(({ inputIndex }) => inputIndex),
    ...rejected.map(({ index }) => index),
  ].sort((left, right) => left - right);
  if (
    indexes.length > 100 ||
    indexes.some((index, position) => index !== position)
  ) {
    return fail("INVALID_RECORD_DRAFT_PLAN_INPUT");
  }
}

function claimIdentity(
  draft: ClaimDraft,
  resolution: ResolvedDraft,
): string {
  return JSON.stringify([
    resolution.subjectId,
    draft.relation,
    "object" in draft ? "entity" : "value",
    "object" in draft
      ? resolution.objectId
      : normalizeLiteralIdentity(draft.object_value),
  ]);
}

function selectRecordDraftSurvivorsUnsafe(
  value: unknown,
): RecordDraftSurvivorPlan {
  const source = exactDataRecord(
    value,
    ["approvedDrafts", "rejectedClaims", "resolutions"],
    "INVALID_RECORD_DRAFT_PLAN_INPUT",
  );
  const approved = snapshotApprovedDrafts(source["approvedDrafts"]);
  const rejected = snapshotSanitizerRejections(source["rejectedClaims"]);
  assertCoverage(approved, rejected);
  const resolutionValues = plainDataArray(
    source["resolutions"],
    100,
    "INVALID_RECORD_DRAFT_PLAN_INPUT",
  );
  if (resolutionValues.length !== approved.length) {
    return fail("INVALID_RECORD_DRAFT_PLAN_INPUT");
  }
  const resolutions = resolutionValues.map((resolution, index) => {
    const expected = approved[index];
    if (expected === undefined) {
      return fail("INVALID_RECORD_DRAFT_PLAN_INPUT");
    }
    return snapshotResolution(
      resolution,
      expected,
      "INVALID_RECORD_DRAFT_PLAN_INPUT",
    );
  });

  const storedDrafts: StoredRecordDraft[] = [];
  const outcomes: RecordDraftPlanOutcome[] = [...rejected];
  const identitySurvivors = new Map<
    string,
    Readonly<{ inputIndex: number; storedIndex: number }>
  >();
  for (const [position, item] of approved.entries()) {
    const resolution = resolutions[position];
    if (resolution === undefined) {
      return fail("INVALID_RECORD_DRAFT_PLAN_INPUT");
    }
    if (resolution.status === "rejected") {
      outcomes.push(
        Object.freeze({
          index: item.inputIndex,
          status: "rejected",
          note: resolution.note,
        }),
      );
      continue;
    }
    const identity: SelectedDraftIdentity = Object.freeze({
      key: claimIdentity(item.draft, resolution),
      resolution,
    });
    const survivor = identitySurvivors.get(identity.key);
    if (survivor !== undefined) {
      outcomes.push(
        Object.freeze({
          index: item.inputIndex,
          status: "reinforced",
          storedIndex: survivor.storedIndex,
          duplicateOfIndex: survivor.inputIndex,
          note: DUPLICATE_NOTE,
        }),
      );
      continue;
    }
    const storedIndex = storedDrafts.length;
    identitySurvivors.set(
      identity.key,
      Object.freeze({ inputIndex: item.inputIndex, storedIndex }),
    );
    storedDrafts.push(
      Object.freeze({
        inputIndex: item.inputIndex,
        storedIndex,
        draft: item.draft,
      }),
    );
    outcomes.push(
      Object.freeze({
        index: item.inputIndex,
        status: "accepted",
        storedIndex,
      }),
    );
  }
  outcomes.sort((left, right) => left.index - right.index);
  const plan = Object.freeze({
    storedDrafts: Object.freeze(storedDrafts),
    survivorDraftIndexes: Object.freeze(
      storedDrafts.map(({ inputIndex }) => inputIndex),
    ),
    outcomes: Object.freeze(outcomes),
  });
  survivorPlans.add(plan);
  return plan;
}

export function selectRecordDraftSurvivors(
  value: unknown,
): RecordDraftSurvivorPlan {
  try {
    return selectRecordDraftSurvivorsUnsafe(value);
  } catch {
    throw new RecordDraftPlanningError("INVALID_RECORD_DRAFT_PLAN_INPUT");
  }
}

function positiveJournalSeq(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    return fail("INVALID_RECORD_DRAFT_FINALIZATION");
  }
  return Number(value);
}

function occurrence(
  seq: number,
  position: number,
  canonicalId: string,
): RecordEntityOccurrenceMapping {
  return Object.freeze({
    position,
    candidateId: `e${seq}.${position}`,
    canonicalId,
  });
}

function finalizeRecordDraftPlanUnsafe(
  plan: RecordDraftSurvivorPlan,
  value: unknown,
): FinalizedRecordDraftPlan {
  if (
    plan === null ||
    typeof plan !== "object" ||
    !survivorPlans.has(plan)
  ) {
    return fail("INVALID_RECORD_DRAFT_FINALIZATION");
  }
  const source = exactDataRecord(
    value,
    ["expectedJournalSeq", "drafts"],
    "INVALID_RECORD_DRAFT_FINALIZATION",
  );
  const expectedJournalSeq = positiveJournalSeq(source["expectedJournalSeq"]);
  const draftValues = plainDataArray(
    source["drafts"],
    100,
    "INVALID_RECORD_DRAFT_FINALIZATION",
  );
  if (draftValues.length !== plan.storedDrafts.length) {
    return fail("INVALID_RECORD_DRAFT_FINALIZATION");
  }
  let entityPosition = 0;
  const mappings: FinalizedRecordDraftMapping[] = [];
  for (const [storedIndex, stored] of plan.storedDrafts.entries()) {
    const resolutionValue = draftValues[storedIndex];
    if (resolutionValue === undefined) {
      return fail("INVALID_RECORD_DRAFT_FINALIZATION");
    }
    const resolution = snapshotResolution(
      resolutionValue,
      stored,
      "INVALID_RECORD_DRAFT_FINALIZATION",
    );
    if (resolution.status !== "resolved") {
      return fail("INVALID_RECORD_DRAFT_FINALIZATION");
    }
    const subjectOccurrence = occurrence(
      expectedJournalSeq,
      entityPosition,
      resolution.subjectId,
    );
    entityPosition += 1;
    const objectOccurrence =
      resolution.objectId === null
        ? null
        : occurrence(
            expectedJournalSeq,
            entityPosition,
            resolution.objectId,
          );
    if (objectOccurrence !== null) {
      entityPosition += 1;
    }
    mappings.push(
      Object.freeze({
        inputIndex: stored.inputIndex,
        storedIndex,
        claimCandidateId: `c${expectedJournalSeq}.${storedIndex}`,
        subjectOccurrence,
        objectOccurrence,
      }),
    );
  }
  const outcomes: FinalizedRecordDraftPlanOutcome[] = plan.outcomes.map(
    (outcome) => {
      if (outcome.status === "rejected") {
        return outcome;
      }
      const mapping = mappings[outcome.storedIndex];
      if (mapping === undefined) {
        return fail("INVALID_RECORD_DRAFT_FINALIZATION");
      }
      return outcome.status === "accepted"
        ? Object.freeze({
            index: outcome.index,
            status: "accepted" as const,
            storedIndex: outcome.storedIndex,
            claimCandidateId: mapping.claimCandidateId,
          })
        : Object.freeze({
            index: outcome.index,
            status: "reinforced" as const,
            storedIndex: outcome.storedIndex,
            duplicateOfIndex: outcome.duplicateOfIndex,
            claimCandidateId: mapping.claimCandidateId,
            note: DUPLICATE_NOTE,
          });
    },
  );
  return Object.freeze({
    expectedJournalSeq,
    storedDrafts: plan.storedDrafts,
    survivorDraftIndexes: plan.survivorDraftIndexes,
    mappings: Object.freeze(mappings),
    outcomes: Object.freeze(outcomes),
  });
}

export function finalizeRecordDraftPlan(
  plan: RecordDraftSurvivorPlan,
  value: unknown,
): FinalizedRecordDraftPlan {
  try {
    return finalizeRecordDraftPlanUnsafe(plan, value);
  } catch {
    throw new RecordDraftPlanningError("INVALID_RECORD_DRAFT_FINALIZATION");
  }
}

/** SQLite adapters use this only to feed the REC-004 finalizer. */
export function recordDraftSurvivorIndexes(
  plan: RecordDraftSurvivorPlan,
): readonly number[] {
  try {
    if (
      plan === null ||
      typeof plan !== "object" ||
      !survivorPlans.has(plan)
    ) {
      return fail("INVALID_RECORD_DRAFT_FINALIZATION");
    }
    return plan.survivorDraftIndexes;
  } catch {
    throw new RecordDraftPlanningError("INVALID_RECORD_DRAFT_FINALIZATION");
  }
}
