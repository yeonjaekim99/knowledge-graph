import {
  ProjectionIdentifierError,
  assertCanonicalIdentifier,
  compareOccurrenceIdentifiers,
  createIdentifierRedirectRegistry,
  type IdentifierAnchor,
  type IdentifierRedirectReason,
  type IdentifierRedirectRow,
  type OccurrenceCandidates,
} from "./projection-identifiers.js";
import {
  preScanProjectionEvents,
  type EffectiveAliasEvent,
  type EffectiveClaimRetractionEvent,
  type EffectiveMergeEvent,
  type EffectiveStatementEvent,
  type ProjectionPreScanResult,
} from "./projection-event-pre-scan.js";
import {
  strongestSurfaceOrigin,
  type EntityKindMaintenanceCandidate,
  type EntityOccurrenceProjection,
} from "./projection-entities.js";
import {
  ProjectionRuleError,
  getRelationDefinition,
  normalizeLiteralIdentity,
  normalizeRelationLabel,
  normalizeV1,
  type CanonicalRelation,
} from "./projection-rules.js";
import type {
  ClaimProjectionRow,
  EntityProjectionRow,
  SurfaceFormProjectionRow,
} from "./projection-replay.js";
import type {
  ClaimOccurrenceProjection,
  StructuralClaimSupportProjectionRow,
} from "./projection-claims.js";

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
const KIND_MAX_CODE_POINTS = 64;
const ALIAS_MAX_CODE_POINTS = 256;
const NOTE_MAX_CODE_POINTS = 2_048;

export type ProjectionDecisionErrorCode =
  | "INVALID_PROJECTION_STATE"
  | "INVALID_STORED_DRAFT"
  | "INVALID_DECISION_BODY"
  | "DECISION_TARGET_NOT_PAST"
  | "MERGE_TARGET_NOT_FOUND"
  | "ALIAS_TARGET_NOT_FOUND"
  | "MERGE_CYCLE"
  | "AMBIGUOUS_ENTITY"
  | "DUPLICATE_STATEMENT_CLAIM"
  | "CLAIM_RETRACTION_TARGET_NOT_FOUND"
  | "CLAIM_RETRACTION_TARGET_NOT_PAST";

const ERROR_MESSAGES: Readonly<Record<ProjectionDecisionErrorCode, string>> =
  Object.freeze({
    INVALID_PROJECTION_STATE:
      "decision projection input or reduced state violates structural invariants",
    INVALID_STORED_DRAFT:
      "decision projection requires a canonical stored statement draft",
    INVALID_DECISION_BODY:
      "decision projection requires a canonical stored merge or alias body",
    DECISION_TARGET_NOT_PAST:
      "merge and alias targets must precede their decision event",
    MERGE_TARGET_NOT_FOUND:
      "merge target is absent from the trusted scope journal",
    ALIAS_TARGET_NOT_FOUND:
      "alias target is absent from the trusted scope journal",
    MERGE_CYCLE: "merge would create a cycle or repeat an existing identity",
    AMBIGUOUS_ENTITY:
      "stored entity reference resolves to multiple canonical candidates",
    DUPLICATE_STATEMENT_CLAIM:
      "one stored statement cannot support the same canonical claim twice",
    CLAIM_RETRACTION_TARGET_NOT_FOUND:
      "claim retraction target is absent from the trusted scope journal",
    CLAIM_RETRACTION_TARGET_NOT_PAST:
      "claim retraction target must precede the retraction event",
  });

export class ProjectionDecisionError extends TypeError {
  public override readonly name: string = "ProjectionDecisionError";
  public readonly code: ProjectionDecisionErrorCode;

  public constructor(code: ProjectionDecisionErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.code = code;
  }
}

function reject(code: ProjectionDecisionErrorCode): never {
  throw new ProjectionDecisionError(code);
}

type SurfaceOrigin = SurfaceFormProjectionRow["origin"];
type ClaimState = ClaimProjectionRow["state"];

export interface ProjectionStoredDraft {
  readonly subject: string;
  readonly subjectNormal: string;
  readonly subjectKind: string | null;
  readonly subjectAliases: readonly string[];
  readonly relation: CanonicalRelation;
  readonly object: string | null;
  readonly objectNormal: string | null;
  readonly objectKind: string | null;
  readonly objectAliases: readonly string[];
  readonly objectValue: string | null;
}

interface AnchoredDraft {
  readonly eventId: string;
  readonly actualSeq: number;
  readonly draftIndex: number;
  readonly candidate: OccurrenceCandidates;
  readonly draft: ProjectionStoredDraft;
  readonly initialSubjectId: string;
  readonly initialObjectId: string | null;
  readonly initialClaimId: string;
}

interface MutableEntityRow {
  readonly id: string;
  readonly scopeKey: string;
  readonly name: string;
  readonly normalName: string;
  kind: string | null;
  mergedInto: string | null;
  readonly originSeq: number;
}

interface Activation {
  readonly orderSeq: number;
  readonly actualSeq: number;
  readonly draftIndex: number;
}

interface MutableClaimRow {
  readonly id: string;
  readonly scopeKey: string;
  subjectId: string;
  readonly relation: CanonicalRelation;
  objectId: string | null;
  readonly objectValue: string | null;
  state: ClaimState;
  readonly originSeq: number;
  firstSeenAt: number;
  lastSeenAt: number;
  activation: Activation | null;
}

interface MutableSupport {
  claimId: string;
  readonly eventId: string;
  readonly draftIndex: number;
  live: 0 | 1;
}

interface KindContribution {
  readonly entityId: string;
  readonly kind: string;
  readonly eventId: string;
  readonly orderSeq: number;
  readonly actualSeq: number;
  readonly draftIndex: number;
  readonly position: 0 | 1;
}

export interface ProjectionMergeBody {
  readonly keep: string;
  readonly absorb: string;
}

export interface ProjectionAliasBody {
  readonly surface: string;
  readonly entityId: string;
}

export interface MergeAliasStateProjection {
  readonly scopeKey: string;
  readonly rulesVersion: string;
  readonly entityAnchors: readonly IdentifierAnchor[];
  readonly entities: readonly EntityProjectionRow[];
  readonly surfaceForms: readonly SurfaceFormProjectionRow[];
  readonly claimAnchors: readonly IdentifierAnchor[];
  readonly claims: readonly ClaimProjectionRow[];
  readonly claimSupport: readonly StructuralClaimSupportProjectionRow[];
  readonly idRedirects: readonly IdentifierRedirectRow[];
  readonly entityOccurrences: readonly EntityOccurrenceProjection[];
  readonly claimOccurrences: readonly ClaimOccurrenceProjection[];
  readonly kindMaintenance: readonly EntityKindMaintenanceCandidate[];
}

function plainDataRecord(
  value: unknown,
  code: ProjectionDecisionErrorCode,
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
  code: ProjectionDecisionErrorCode,
): Readonly<Record<string, unknown>> {
  const source = plainDataRecord(value, code);
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  const keys = Object.keys(source);
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
  code: ProjectionDecisionErrorCode,
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

function compareText(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function compareEntityIds(left: string, right: string): number {
  try {
    return compareOccurrenceIdentifiers(left, right, "entity");
  } catch (error: unknown) {
    if (error instanceof ProjectionIdentifierError) {
      return reject("INVALID_PROJECTION_STATE");
    }
    throw error;
  }
}

function compareClaimIds(left: string, right: string): number {
  try {
    return compareOccurrenceIdentifiers(left, right, "claim");
  } catch (error: unknown) {
    if (error instanceof ProjectionIdentifierError) {
      return reject("INVALID_PROJECTION_STATE");
    }
    throw error;
  }
}

function canonicalIdentifier(
  value: unknown,
  kind: "entity" | "claim",
  code: ProjectionDecisionErrorCode,
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

function normalizeStoredName(value: unknown): Readonly<{
  display: string;
  normal: string;
}> {
  if (typeof value !== "string") {
    return reject("INVALID_STORED_DRAFT");
  }
  const display = value.trim();
  try {
    return Object.freeze({ display, normal: normalizeV1(display) });
  } catch (error: unknown) {
    if (error instanceof ProjectionRuleError) {
      return reject("INVALID_STORED_DRAFT");
    }
    throw error;
  }
}

function normalizeKind(value: unknown): string | null {
  if (value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    return reject("INVALID_STORED_DRAFT");
  }
  const result = value.trim().normalize("NFKC").toLowerCase();
  const length = Array.from(result).length;
  if (length === 0 || length > KIND_MAX_CODE_POINTS) {
    return reject("INVALID_STORED_DRAFT");
  }
  return result;
}

function parseAliases(value: unknown): readonly string[] {
  if (value === undefined) {
    return Object.freeze([]);
  }
  const result: string[] = [];
  const normals = new Set<string>();
  for (const item of plainDataArray(value, "INVALID_STORED_DRAFT")) {
    const alias = normalizeStoredName(item);
    if (!normals.has(alias.normal)) {
      normals.add(alias.normal);
      result.push(alias.display);
    }
  }
  return Object.freeze(result);
}

export function parseProjectionStoredDraft(value: unknown): ProjectionStoredDraft {
  const source = plainDataRecord(value, "INVALID_STORED_DRAFT");
  if (
    Object.keys(source).some((key) => !DRAFT_KEYS.has(key)) ||
    !Object.hasOwn(source, "subject") ||
    !Object.hasOwn(source, "relation")
  ) {
    return reject("INVALID_STORED_DRAFT");
  }
  const hasObject = Object.hasOwn(source, "object");
  const hasValue = Object.hasOwn(source, "object_value");
  if (hasObject === hasValue) {
    return reject("INVALID_STORED_DRAFT");
  }
  if (
    !hasObject &&
    (Object.hasOwn(source, "object_kind") ||
      Object.hasOwn(source, "object_aliases"))
  ) {
    return reject("INVALID_STORED_DRAFT");
  }

  const subject = normalizeStoredName(source["subject"]);
  let relation: CanonicalRelation;
  try {
    relation = getRelationDefinition(source["relation"]).relation;
    normalizeRelationLabel(relation, source["relation_label"]);
  } catch (error: unknown) {
    if (error instanceof ProjectionRuleError) {
      return reject("INVALID_STORED_DRAFT");
    }
    throw error;
  }

  let object: string | null = null;
  let objectNormal: string | null = null;
  let objectValue: string | null = null;
  if (hasObject) {
    const normalized = normalizeStoredName(source["object"]);
    object = normalized.display;
    objectNormal = normalized.normal;
  } else {
    try {
      objectValue = normalizeLiteralIdentity(source["object_value"]);
    } catch (error: unknown) {
      if (error instanceof ProjectionRuleError) {
        return reject("INVALID_STORED_DRAFT");
      }
      throw error;
    }
  }

  return Object.freeze({
    subject: subject.display,
    subjectNormal: subject.normal,
    subjectKind: normalizeKind(source["subject_kind"]),
    subjectAliases: parseAliases(source["subject_aliases"]),
    relation,
    object,
    objectNormal,
    objectKind: hasObject ? normalizeKind(source["object_kind"]) : null,
    objectAliases: hasObject
      ? parseAliases(source["object_aliases"])
      : Object.freeze([]),
    objectValue,
  });
}

function parseJsonBody(bodyJson: unknown): Readonly<Record<string, unknown>> {
  if (typeof bodyJson !== "string") {
    return reject("INVALID_DECISION_BODY");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyJson) as unknown;
  } catch {
    return reject("INVALID_DECISION_BODY");
  }
  return plainDataRecord(parsed, "INVALID_DECISION_BODY");
}

function validateDecisionNote(value: unknown): void {
  if (
    value !== undefined &&
    (typeof value !== "string" || Array.from(value).length > NOTE_MAX_CODE_POINTS)
  ) {
    reject("INVALID_DECISION_BODY");
  }
}

export function parseProjectionMergeBody(bodyJson: unknown): ProjectionMergeBody {
  const body = exactDataRecord(
    parseJsonBody(bodyJson),
    ["keep", "absorb"],
    ["note"],
    "INVALID_DECISION_BODY",
  );
  validateDecisionNote(body["note"]);
  return Object.freeze({
    keep: canonicalIdentifier(body["keep"], "entity", "INVALID_DECISION_BODY"),
    absorb: canonicalIdentifier(
      body["absorb"],
      "entity",
      "INVALID_DECISION_BODY",
    ),
  });
}

export function parseProjectionAliasBody(bodyJson: unknown): ProjectionAliasBody {
  const body = exactDataRecord(
    parseJsonBody(bodyJson),
    ["surface", "entity_id"],
    ["note"],
    "INVALID_DECISION_BODY",
  );
  validateDecisionNote(body["note"]);
  if (typeof body["surface"] !== "string") {
    return reject("INVALID_DECISION_BODY");
  }
  const surface = body["surface"].trim();
  const length = Array.from(surface).length;
  if (length === 0 || length > ALIAS_MAX_CODE_POINTS) {
    return reject("INVALID_DECISION_BODY");
  }
  try {
    normalizeV1(surface);
  } catch (error: unknown) {
    if (error instanceof ProjectionRuleError) {
      return reject("INVALID_DECISION_BODY");
    }
    throw error;
  }
  return Object.freeze({
    surface,
    entityId: canonicalIdentifier(
      body["entity_id"],
      "entity",
      "INVALID_DECISION_BODY",
    ),
  });
}

function occurrenceKey(eventId: string, draftIndex: number): string {
  return JSON.stringify([eventId, draftIndex]);
}

export function projectionClaimIdentityKey(
  scopeKey: string,
  subjectId: string,
  relation: CanonicalRelation,
  objectId: string | null,
  objectValue: string | null,
): string {
  return JSON.stringify([
    scopeKey,
    subjectId,
    relation,
    objectId === null ? "value" : "entity",
    objectId ?? objectValue,
  ]);
}

function compareActivation(left: Activation, right: Activation): number {
  return left.orderSeq !== right.orderSeq
    ? left.orderSeq - right.orderSeq
    : left.actualSeq !== right.actualSeq
      ? left.actualSeq - right.actualSeq
      : left.draftIndex - right.draftIndex;
}

function maxActivation(values: readonly (Activation | null)[]): Activation | null {
  let result: Activation | null = null;
  for (const value of values) {
    if (value !== null && (result === null || compareActivation(value, result) > 0)) {
      result = value;
    }
  }
  return result;
}

function strongestClaimState(values: readonly ClaimState[]): ClaimState {
  return values.includes("active")
    ? "active"
    : values.includes("superseded")
      ? "superseded"
      : "retracted";
}

function freezeEntityRow(row: MutableEntityRow): EntityProjectionRow {
  return Object.freeze({
    id: row.id,
    scopeKey: row.scopeKey,
    name: row.name,
    normalName: row.normalName,
    kind: row.kind,
    mergedInto: row.mergedInto,
    originSeq: row.originSeq,
  });
}

function freezeClaimRow(row: MutableClaimRow): ClaimProjectionRow {
  return Object.freeze({
    id: row.id,
    scopeKey: row.scopeKey,
    subjectId: row.subjectId,
    relation: row.relation,
    objectId: row.objectId,
    objectValue: row.objectValue,
    state: row.state,
    originSeq: row.originSeq,
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
  });
}

export function projectMergeAliasState(value: unknown): MergeAliasStateProjection {
  return reduceMergeAliasState(preScanProjectionEvents(value));
}

/**
 * Replays statement, merge, alias, and claim-retraction semantics in one pure
 * stream. PRJ-004 already removes event-retracted decisions, so undo is the
 * absence of a decision rather than a reverse mutation.
 */
export function reduceMergeAliasState(
  preScan: ProjectionPreScanResult,
): MergeAliasStateProjection {
  if (
    preScan === null ||
    typeof preScan !== "object" ||
    typeof preScan.scopeKey !== "string" ||
    typeof preScan.rulesVersion !== "string" ||
    !Array.isArray(preScan.statements) ||
    !Array.isArray(preScan.statementCandidates) ||
    !Array.isArray(preScan.events)
  ) {
    return reject("INVALID_PROJECTION_STATE");
  }
  const scopeKey = preScan.scopeKey;
  const statementMetadata = new Map<
    string,
    Readonly<{ actualSeq: number; orderSeq: number; createdAt: number }>
  >();
  for (const statement of preScan.statements) {
    if (
      statementMetadata.has(statement.eventId) ||
      !Number.isSafeInteger(statement.actualSeq) ||
      statement.actualSeq <= 0 ||
      !Number.isSafeInteger(statement.orderSeq) ||
      statement.orderSeq <= 0 ||
      !Number.isSafeInteger(statement.createdAt) ||
      statement.createdAt < 0
    ) {
      return reject("INVALID_PROJECTION_STATE");
    }
    statementMetadata.set(
      statement.eventId,
      Object.freeze({
        actualSeq: statement.actualSeq,
        orderSeq: statement.orderSeq,
        createdAt: statement.createdAt,
      }),
    );
  }

  const entityAnchors: IdentifierAnchor[] = [];
  const entityAnchorIds = new Set<string>();
  const entityRows = new Map<string, MutableEntityRow>();
  const canonicalEntityByNormal = new Map<string, string>();
  const entityRedirects = new Map<
    string,
    Readonly<{ newId: string; reason: IdentifierRedirectReason }>
  >();

  const resolveEntity = (identifier: string): string => {
    if (!entityAnchorIds.has(identifier)) {
      return reject("INVALID_PROJECTION_STATE");
    }
    const path: string[] = [];
    const seen = new Set<string>();
    let current = identifier;
    while (entityRedirects.has(current)) {
      if (seen.has(current)) {
        return reject("INVALID_PROJECTION_STATE");
      }
      seen.add(current);
      path.push(current);
      current =
        entityRedirects.get(current)?.newId ??
        reject("INVALID_PROJECTION_STATE");
      if (!entityAnchorIds.has(current)) {
        return reject("INVALID_PROJECTION_STATE");
      }
    }
    for (const oldId of path) {
      const redirect =
        entityRedirects.get(oldId) ?? reject("INVALID_PROJECTION_STATE");
      entityRedirects.set(
        oldId,
        Object.freeze({ newId: current, reason: redirect.reason }),
      );
    }
    return current;
  };

  const partiallyAnchored: Array<Omit<AnchoredDraft, "initialClaimId">> = [];
  const registrations = [...preScan.statementCandidates].sort((left, right) =>
    left.actualSeq !== right.actualSeq
      ? left.actualSeq - right.actualSeq
      : compareText(left.eventId, right.eventId),
  );
  for (const registration of registrations) {
    const metadata = statementMetadata.get(registration.eventId);
    if (
      metadata === undefined ||
      metadata.actualSeq !== registration.actualSeq ||
      !Array.isArray(registration.parsed) ||
      !Array.isArray(registration.candidates) ||
      registration.parsed.length !== registration.candidates.length
    ) {
      return reject("INVALID_PROJECTION_STATE");
    }
    for (let draftIndex = 0; draftIndex < registration.parsed.length; draftIndex += 1) {
      const candidate = registration.candidates[draftIndex];
      if (
        candidate === undefined ||
        candidate.draftIndex !== draftIndex ||
        candidate.claimId !== `c${registration.actualSeq}.${draftIndex}`
      ) {
        return reject("INVALID_PROJECTION_STATE");
      }
      const draft = parseProjectionStoredDraft(registration.parsed[draftIndex]);
      const anchorEntity = (
        candidateIdValue: unknown,
        name: string,
        normalName: string,
      ): string => {
        const candidateId = canonicalIdentifier(
          candidateIdValue,
          "entity",
          "INVALID_PROJECTION_STATE",
        );
        if (entityAnchorIds.has(candidateId)) {
          return reject("INVALID_PROJECTION_STATE");
        }
        entityAnchorIds.add(candidateId);
        entityAnchors.push(
          Object.freeze({ id: candidateId, kind: "entity", scopeKey }),
        );
        const existing = canonicalEntityByNormal.get(normalName);
        if (existing !== undefined) {
          entityRedirects.set(
            candidateId,
            Object.freeze({ newId: existing, reason: "deduplicated" }),
          );
          return existing;
        }
        canonicalEntityByNormal.set(normalName, candidateId);
        entityRows.set(candidateId, {
          id: candidateId,
          scopeKey,
          name,
          normalName,
          kind: null,
          mergedInto: null,
          originSeq: registration.actualSeq,
        });
        return candidateId;
      };

      const initialSubjectId = anchorEntity(
        candidate.subjectId,
        draft.subject,
        draft.subjectNormal,
      );
      let initialObjectId: string | null = null;
      if (draft.object !== null && draft.objectNormal !== null) {
        if (candidate.objectId === null) {
          return reject("INVALID_PROJECTION_STATE");
        }
        initialObjectId = anchorEntity(
          candidate.objectId,
          draft.object,
          draft.objectNormal,
        );
      } else if (candidate.objectId !== null) {
        return reject("INVALID_PROJECTION_STATE");
      }
      partiallyAnchored.push(
        Object.freeze({
          eventId: registration.eventId,
          actualSeq: registration.actualSeq,
          draftIndex,
          candidate,
          draft,
          initialSubjectId: resolveEntity(initialSubjectId),
          initialObjectId:
            initialObjectId === null ? null : resolveEntity(initialObjectId),
        }),
      );
    }
  }

  const claimAnchors: IdentifierAnchor[] = [];
  const claimAnchorIds = new Set<string>();
  const claimRedirects = new Map<
    string,
    Readonly<{ newId: string; reason: IdentifierRedirectReason }>
  >();
  const claimRows = new Map<string, MutableClaimRow>();
  const initialClaimByCandidate = new Map<string, string>();
  const claimGroups = new Map<
    string,
    Array<Omit<AnchoredDraft, "initialClaimId">>
  >();
  const statementIdentities = new Map<string, Set<string>>();
  for (const occurrence of partiallyAnchored) {
    const claimCandidateId = canonicalIdentifier(
      occurrence.candidate.claimId,
      "claim",
      "INVALID_PROJECTION_STATE",
    );
    if (claimAnchorIds.has(claimCandidateId)) {
      return reject("INVALID_PROJECTION_STATE");
    }
    claimAnchorIds.add(claimCandidateId);
    claimAnchors.push(
      Object.freeze({ id: claimCandidateId, kind: "claim", scopeKey }),
    );
    const identity = projectionClaimIdentityKey(
      scopeKey,
      occurrence.initialSubjectId,
      occurrence.draft.relation,
      occurrence.initialObjectId,
      occurrence.draft.objectValue,
    );
    const seen = statementIdentities.get(occurrence.eventId) ?? new Set<string>();
    if (seen.has(identity)) {
      return reject("DUPLICATE_STATEMENT_CLAIM");
    }
    seen.add(identity);
    statementIdentities.set(occurrence.eventId, seen);
    const group = claimGroups.get(identity) ?? [];
    group.push(occurrence);
    claimGroups.set(identity, group);
  }

  for (const group of claimGroups.values()) {
    group.sort((left, right) =>
      compareClaimIds(left.candidate.claimId, right.candidate.claimId),
    );
    const first = group[0] ?? reject("INVALID_PROJECTION_STATE");
    const firstId = first.candidate.claimId;
    const metadata =
      statementMetadata.get(first.eventId) ??
      reject("INVALID_PROJECTION_STATE");
    claimRows.set(firstId, {
      id: firstId,
      scopeKey,
      subjectId: first.initialSubjectId,
      relation: first.draft.relation,
      objectId: first.initialObjectId,
      objectValue: first.draft.objectValue,
      state: "retracted",
      originSeq: first.actualSeq,
      firstSeenAt: metadata.createdAt,
      lastSeenAt: metadata.createdAt,
      activation: null,
    });
    for (const occurrence of group) {
      const candidateId = occurrence.candidate.claimId;
      initialClaimByCandidate.set(candidateId, firstId);
      if (candidateId !== firstId) {
        claimRedirects.set(
          candidateId,
          Object.freeze({ newId: firstId, reason: "deduplicated" }),
        );
      }
    }
  }

  const anchoredDrafts: AnchoredDraft[] = partiallyAnchored.map((occurrence) =>
    Object.freeze({
      ...occurrence,
      initialClaimId:
        initialClaimByCandidate.get(occurrence.candidate.claimId) ??
        reject("INVALID_PROJECTION_STATE"),
    }),
  );
  const anchoredByKey = new Map(
    anchoredDrafts.map((occurrence) => [
      occurrenceKey(occurrence.eventId, occurrence.draftIndex),
      occurrence,
    ]),
  );

  const resolveClaim = (identifier: string): string => {
    if (!claimAnchorIds.has(identifier)) {
      return reject("INVALID_PROJECTION_STATE");
    }
    const path: string[] = [];
    const seen = new Set<string>();
    let current = identifier;
    while (claimRedirects.has(current)) {
      if (seen.has(current)) {
        return reject("INVALID_PROJECTION_STATE");
      }
      seen.add(current);
      path.push(current);
      current =
        claimRedirects.get(current)?.newId ??
        reject("INVALID_PROJECTION_STATE");
      if (!claimAnchorIds.has(current)) {
        return reject("INVALID_PROJECTION_STATE");
      }
    }
    for (const oldId of path) {
      const redirect =
        claimRedirects.get(oldId) ?? reject("INVALID_PROJECTION_STATE");
      claimRedirects.set(
        oldId,
        Object.freeze({ newId: current, reason: redirect.reason }),
      );
    }
    return current;
  };

  const supports = new Map<string, MutableSupport>();
  const supportKeysByClaim = new Map<string, Set<string>>();
  const assignSupport = (key: string, newClaimIdValue: string): void => {
    const support = supports.get(key) ?? reject("INVALID_PROJECTION_STATE");
    const oldClaimId = support.claimId;
    const newClaimId = resolveClaim(newClaimIdValue);
    if (oldClaimId === newClaimId) {
      return;
    }
    supportKeysByClaim.get(oldClaimId)?.delete(key);
    const keys = supportKeysByClaim.get(newClaimId) ?? new Set<string>();
    keys.add(key);
    supportKeysByClaim.set(newClaimId, keys);
    support.claimId = newClaimId;
  };
  for (const occurrence of anchoredDrafts) {
    const key = occurrenceKey(occurrence.eventId, occurrence.draftIndex);
    const claimId = resolveClaim(occurrence.initialClaimId);
    supports.set(key, {
      claimId,
      eventId: occurrence.eventId,
      draftIndex: occurrence.draftIndex,
      live: 0,
    });
    const keys = supportKeysByClaim.get(claimId) ?? new Set<string>();
    keys.add(key);
    supportKeysByClaim.set(claimId, keys);
  }

  const surfacesByEntity = new Map<string, Map<string, SurfaceOrigin>>();
  const surfaceEntities = new Map<string, Set<string>>();
  const upsertNormalizedSurface = (
    surfaceNorm: string,
    entityIdValue: string,
    origin: SurfaceOrigin,
  ): void => {
    const entityId = resolveEntity(entityIdValue);
    const entitySurfaces =
      surfacesByEntity.get(entityId) ?? new Map<string, SurfaceOrigin>();
    const existing = entitySurfaces.get(surfaceNorm);
    entitySurfaces.set(
      surfaceNorm,
      existing === undefined ? origin : strongestSurfaceOrigin(existing, origin),
    );
    surfacesByEntity.set(entityId, entitySurfaces);
    const mapped = surfaceEntities.get(surfaceNorm) ?? new Set<string>();
    mapped.add(entityId);
    surfaceEntities.set(surfaceNorm, mapped);
  };
  const upsertSurface = (
    surfaceValue: string,
    entityIdValue: string,
    origin: SurfaceOrigin,
  ): void => {
    let surfaceNorm: string;
    try {
      surfaceNorm = normalizeV1(surfaceValue);
    } catch (error: unknown) {
      if (error instanceof ProjectionRuleError) {
        return reject("INVALID_PROJECTION_STATE");
      }
      throw error;
    }
    upsertNormalizedSurface(surfaceNorm, entityIdValue, origin);
  };

  const moveSurfaces = (oldId: string, newId: string): void => {
    const source = surfacesByEntity.get(oldId);
    if (source === undefined) {
      return;
    }
    surfacesByEntity.delete(oldId);
    for (const [surfaceNorm, origin] of source) {
      const mapped = surfaceEntities.get(surfaceNorm);
      mapped?.delete(oldId);
      if (mapped !== undefined && mapped.size === 0) {
        surfaceEntities.delete(surfaceNorm);
      }
      upsertNormalizedSurface(surfaceNorm, newId, origin);
    }
  };

  const setEntityRedirect = (
    oldIdValue: string,
    newIdValue: string,
    reason: IdentifierRedirectReason,
  ): void => {
    const oldId = resolveEntity(oldIdValue);
    const newId = resolveEntity(newIdValue);
    if (oldId === newId) {
      return reject("MERGE_CYCLE");
    }
    entityRedirects.set(oldId, Object.freeze({ newId, reason }));
    const row = entityRows.get(oldId);
    if (row !== undefined) {
      row.mergedInto = newId;
      row.kind = null;
    }
    moveSurfaces(oldId, newId);
  };

  const entityRedirectPathContains = (
    startId: string,
    targetId: string,
  ): boolean => {
    const seen = new Set<string>();
    let current = startId;
    while (entityRedirects.has(current)) {
      if (seen.has(current)) {
        return reject("INVALID_PROJECTION_STATE");
      }
      seen.add(current);
      current =
        entityRedirects.get(current)?.newId ??
        reject("INVALID_PROJECTION_STATE");
      if (current === targetId) {
        return true;
      }
    }
    return false;
  };

  let claimIdentityIndex = new Map<string, string>();
  const rebuildClaimIdentityIndex = (): void => {
    const next = new Map<string, string>();
    for (const [claimId, claim] of claimRows) {
      if (resolveClaim(claimId) !== claimId) {
        continue;
      }
      claim.subjectId = resolveEntity(claim.subjectId);
      claim.objectId =
        claim.objectId === null ? null : resolveEntity(claim.objectId);
      const identity = projectionClaimIdentityKey(
        scopeKey,
        claim.subjectId,
        claim.relation,
        claim.objectId,
        claim.objectValue,
      );
      if (next.has(identity)) {
        return reject("INVALID_PROJECTION_STATE");
      }
      next.set(identity, claimId);
    }
    claimIdentityIndex = next;
  };

  const redirectClaim = (
    oldIdValue: string,
    newIdValue: string,
    reason: "merge" | "deduplicated",
  ): void => {
    const oldId = resolveClaim(oldIdValue);
    const newId = resolveClaim(newIdValue);
    if (oldId === newId) {
      return;
    }
    const oldRow = claimRows.get(oldId) ?? reject("INVALID_PROJECTION_STATE");
    if (!claimRows.has(newId)) {
      return reject("INVALID_PROJECTION_STATE");
    }
    for (const key of [...(supportKeysByClaim.get(oldId) ?? [])]) {
      assignSupport(key, newId);
    }
    supportKeysByClaim.delete(oldId);
    oldRow.state = "superseded";
    claimRedirects.set(oldId, Object.freeze({ newId, reason }));
    if (reason === "deduplicated") {
      claimRows.delete(oldId);
    }
  };

  const dedupeClaimIdentities = (
    reason: "merge" | "deduplicated",
  ): void => {
    const groups = new Map<string, string[]>();
    for (const [claimId, claim] of claimRows) {
      if (resolveClaim(claimId) !== claimId) {
        continue;
      }
      claim.subjectId = resolveEntity(claim.subjectId);
      claim.objectId =
        claim.objectId === null ? null : resolveEntity(claim.objectId);
      const identity = projectionClaimIdentityKey(
        scopeKey,
        claim.subjectId,
        claim.relation,
        claim.objectId,
        claim.objectValue,
      );
      const group = groups.get(identity) ?? [];
      group.push(claimId);
      groups.set(identity, group);
    }
    for (const ids of groups.values()) {
      if (ids.length < 2) {
        continue;
      }
      ids.sort(compareClaimIds);
      const survivorId = ids[0] ?? reject("INVALID_PROJECTION_STATE");
      const rows = ids.map(
        (claimId) => claimRows.get(claimId) ?? reject("INVALID_PROJECTION_STATE"),
      );
      const survivor =
        claimRows.get(survivorId) ?? reject("INVALID_PROJECTION_STATE");
      const state = strongestClaimState(rows.map((row) => row.state));
      const activation = maxActivation(
        rows
          .filter((row) => row.state === state)
          .map((row) => row.activation),
      );
      if (state === "active" && activation === null) {
        return reject("INVALID_PROJECTION_STATE");
      }
      for (const losingId of ids.slice(1)) {
        redirectClaim(losingId, survivorId, reason);
      }
      survivor.state = state;
      survivor.activation = activation;
    }
    rebuildClaimIdentityIndex();
  };

  const activeDescribes = new Map<string, string>();
  const reconcileDescribes = (): void => {
    activeDescribes.clear();
    const groups = new Map<string, MutableClaimRow[]>();
    for (const [claimId, claim] of claimRows) {
      if (
        resolveClaim(claimId) !== claimId ||
        claim.state !== "active" ||
        claim.relation !== "describes"
      ) {
        continue;
      }
      const subjectId = resolveEntity(claim.subjectId);
      claim.subjectId = subjectId;
      const group = groups.get(subjectId) ?? [];
      group.push(claim);
      groups.set(subjectId, group);
    }
    for (const [subjectId, rows] of groups) {
      let winner = rows[0] ?? reject("INVALID_PROJECTION_STATE");
      if (winner.activation === null) {
        return reject("INVALID_PROJECTION_STATE");
      }
      let winnerActivation = winner.activation;
      for (const row of rows.slice(1)) {
        if (row.activation === null) {
          return reject("INVALID_PROJECTION_STATE");
        }
        if (compareActivation(row.activation, winnerActivation) > 0) {
          winner = row;
          winnerActivation = row.activation;
        }
      }
      for (const row of rows) {
        if (row.id !== winner.id) {
          row.state = "superseded";
        }
      }
      activeDescribes.set(subjectId, winner.id);
    }
  };

  rebuildClaimIdentityIndex();

  const kindContributions: KindContribution[] = [];
  const resolveOccurrenceEntity = (
    candidateId: string,
    normalName: string,
  ): Readonly<{ entityId: string; nameOrigin: SurfaceOrigin }> => {
    const ownedBefore =
      entityRows.has(candidateId) && resolveEntity(candidateId) === candidateId;
    const currentId = resolveEntity(candidateId);
    const mapped = [...(surfaceEntities.get(normalName) ?? [])]
      .map(resolveEntity)
      .filter((item, index, values) => values.indexOf(item) === index)
      .sort(compareEntityIds);
    let chosenId: string;
    if (mapped.length === 1) {
      chosenId = mapped[0] ?? reject("INVALID_PROJECTION_STATE");
    } else if (mapped.length > 1) {
      const exact = mapped.filter((entityId) => {
        const row = entityRows.get(entityId);
        return row !== undefined && row.normalName === normalName;
      });
      if (exact.length !== 1) {
        return reject("AMBIGUOUS_ENTITY");
      }
      chosenId = exact[0] ?? reject("INVALID_PROJECTION_STATE");
    } else {
      const normalAnchor = canonicalEntityByNormal.get(normalName);
      if (normalAnchor === undefined) {
        return reject("INVALID_PROJECTION_STATE");
      }
      chosenId = resolveEntity(normalAnchor);
    }
    if (chosenId !== currentId) {
      setEntityRedirect(currentId, chosenId, "deduplicated");
      dedupeClaimIdentities("deduplicated");
      reconcileDescribes();
    }
    const entityId = resolveEntity(chosenId);
    return Object.freeze({
      entityId,
      nameOrigin:
        ownedBefore && entityId === candidateId ? "name" : "agent_supplied",
    });
  };

  const applyStatement = (event: EffectiveStatementEvent): void => {
    const metadata =
      statementMetadata.get(event.eventId) ??
      reject("INVALID_PROJECTION_STATE");
    const seenIdentities = new Set<string>();
    for (let draftIndex = 0; draftIndex < event.parsed.length; draftIndex += 1) {
      const key = occurrenceKey(event.eventId, draftIndex);
      const occurrence = anchoredByKey.get(key);
      const support = supports.get(key);
      if (occurrence === undefined || support === undefined) {
        return reject("INVALID_PROJECTION_STATE");
      }
      const subject = resolveOccurrenceEntity(
        occurrence.candidate.subjectId,
        occurrence.draft.subjectNormal,
      );
      const object =
        occurrence.candidate.objectId === null ||
        occurrence.draft.object === null ||
        occurrence.draft.objectNormal === null
          ? null
          : resolveOccurrenceEntity(
              occurrence.candidate.objectId,
              occurrence.draft.objectNormal,
            );

      upsertSurface(
        occurrence.draft.subject,
        subject.entityId,
        subject.nameOrigin,
      );
      for (const alias of occurrence.draft.subjectAliases) {
        upsertSurface(alias, subject.entityId, "agent_supplied");
      }
      if (object !== null && occurrence.draft.object !== null) {
        upsertSurface(
          occurrence.draft.object,
          object.entityId,
          object.nameOrigin,
        );
        for (const alias of occurrence.draft.objectAliases) {
          upsertSurface(alias, object.entityId, "agent_supplied");
        }
      }

      if (occurrence.draft.subjectKind !== null) {
        kindContributions.push(
          Object.freeze({
            entityId: subject.entityId,
            kind: occurrence.draft.subjectKind,
            eventId: event.eventId,
            orderSeq: event.orderSeq,
            actualSeq: event.actualSeq,
            draftIndex,
            position: 0,
          }),
        );
      }
      if (object !== null && occurrence.draft.objectKind !== null) {
        kindContributions.push(
          Object.freeze({
            entityId: object.entityId,
            kind: occurrence.draft.objectKind,
            eventId: event.eventId,
            orderSeq: event.orderSeq,
            actualSeq: event.actualSeq,
            draftIndex,
            position: 1,
          }),
        );
      }

      const desiredIdentity = projectionClaimIdentityKey(
        scopeKey,
        subject.entityId,
        occurrence.draft.relation,
        object?.entityId ?? null,
        occurrence.draft.objectValue,
      );
      if (seenIdentities.has(desiredIdentity)) {
        return reject("DUPLICATE_STATEMENT_CLAIM");
      }
      seenIdentities.add(desiredIdentity);

      let targetClaimId = claimIdentityIndex.get(desiredIdentity);
      const candidateClaimId = resolveClaim(occurrence.candidate.claimId);
      if (targetClaimId === undefined) {
        const candidate =
          claimRows.get(candidateClaimId) ??
          reject("INVALID_PROJECTION_STATE");
        if (
          candidate.activation !== null ||
          [...(supportKeysByClaim.get(candidateClaimId) ?? [])].some(
            (supportKey) => supports.get(supportKey)?.live === 1,
          )
        ) {
          return reject("INVALID_PROJECTION_STATE");
        }
        candidate.subjectId = subject.entityId;
        candidate.objectId = object?.entityId ?? null;
        rebuildClaimIdentityIndex();
        targetClaimId =
          claimIdentityIndex.get(desiredIdentity) ??
          reject("INVALID_PROJECTION_STATE");
      } else if (candidateClaimId !== targetClaimId) {
        const candidate =
          claimRows.get(candidateClaimId) ??
          reject("INVALID_PROJECTION_STATE");
        candidate.subjectId = subject.entityId;
        candidate.objectId = object?.entityId ?? null;
        dedupeClaimIdentities("deduplicated");
        reconcileDescribes();
        targetClaimId =
          claimIdentityIndex.get(desiredIdentity) ??
          reject("INVALID_PROJECTION_STATE");
      }
      targetClaimId = resolveClaim(targetClaimId);
      const claim =
        claimRows.get(targetClaimId) ?? reject("INVALID_PROJECTION_STATE");
      if (claim.relation === "describes") {
        const previousId = activeDescribes.get(claim.subjectId);
        if (previousId !== undefined && previousId !== claim.id) {
          const previous =
            claimRows.get(previousId) ?? reject("INVALID_PROJECTION_STATE");
          if (previous.state !== "active") {
            return reject("INVALID_PROJECTION_STATE");
          }
          previous.state = "superseded";
        }
        activeDescribes.set(claim.subjectId, claim.id);
      }
      claim.state = "active";
      claim.activation = Object.freeze({
        orderSeq: metadata.orderSeq,
        actualSeq: event.actualSeq,
        draftIndex,
      });
      assignSupport(key, claim.id);
      support.live = 1;
    }
  };

  const assertDecisionTargetPast = (
    entityId: string,
    actualSeq: number,
  ): void => {
    try {
      if (
        compareOccurrenceIdentifiers(
          entityId,
          `e${actualSeq}.0`,
          "entity",
        ) >= 0
      ) {
        reject("DECISION_TARGET_NOT_PAST");
      }
    } catch (error: unknown) {
      if (error instanceof ProjectionIdentifierError) {
        return reject("INVALID_DECISION_BODY");
      }
      throw error;
    }
  };

  const applyMerge = (event: EffectiveMergeEvent): void => {
    const body = parseProjectionMergeBody(event.bodyJson);
    assertDecisionTargetPast(body.keep, event.actualSeq);
    assertDecisionTargetPast(body.absorb, event.actualSeq);
    if (!entityAnchorIds.has(body.keep) || !entityAnchorIds.has(body.absorb)) {
      return reject("MERGE_TARGET_NOT_FOUND");
    }
    const keep = resolveEntity(body.keep);
    const absorb = resolveEntity(body.absorb);
    if (!entityRows.has(keep) || !entityRows.has(absorb)) {
      return reject("MERGE_TARGET_NOT_FOUND");
    }
    if (keep === absorb) {
      if (
        body.keep === body.absorb ||
        entityRedirectPathContains(body.keep, body.absorb)
      ) {
        return reject("MERGE_CYCLE");
      }
      return;
    }
    setEntityRedirect(absorb, keep, "merge");
    dedupeClaimIdentities("merge");
    reconcileDescribes();
  };

  const applyAlias = (event: EffectiveAliasEvent): void => {
    const body = parseProjectionAliasBody(event.bodyJson);
    assertDecisionTargetPast(body.entityId, event.actualSeq);
    if (!entityAnchorIds.has(body.entityId)) {
      return reject("ALIAS_TARGET_NOT_FOUND");
    }
    const entityId = resolveEntity(body.entityId);
    if (!entityRows.has(entityId)) {
      return reject("ALIAS_TARGET_NOT_FOUND");
    }
    upsertSurface(body.surface, entityId, "confirmed");
  };

  const applyClaimRetraction = (
    event: EffectiveClaimRetractionEvent,
  ): void => {
    try {
      if (
        compareOccurrenceIdentifiers(
          event.target.claimId,
          `c${event.actualSeq}.0`,
          "claim",
        ) >= 0
      ) {
        reject("CLAIM_RETRACTION_TARGET_NOT_PAST");
      }
    } catch (error: unknown) {
      if (error instanceof ProjectionIdentifierError) {
        return reject("INVALID_PROJECTION_STATE");
      }
      throw error;
    }
    if (!claimAnchorIds.has(event.target.claimId)) {
      return reject("CLAIM_RETRACTION_TARGET_NOT_FOUND");
    }
    const claimId = resolveClaim(event.target.claimId);
    const claim = claimRows.get(claimId);
    if (claim === undefined) {
      return reject("CLAIM_RETRACTION_TARGET_NOT_FOUND");
    }
    for (const key of supportKeysByClaim.get(claimId) ?? []) {
      const support = supports.get(key) ?? reject("INVALID_PROJECTION_STATE");
      const metadata =
        statementMetadata.get(support.eventId) ??
        reject("INVALID_PROJECTION_STATE");
      if (metadata.orderSeq < event.actualSeq) {
        support.live = 0;
      }
    }
    if (
      claim.relation === "describes" &&
      activeDescribes.get(claim.subjectId) === claim.id
    ) {
      activeDescribes.delete(claim.subjectId);
    }
    claim.state = "retracted";
  };

  for (const event of preScan.events) {
    if (event.kind === "statement") {
      applyStatement(event);
    } else if (event.kind === "merge") {
      applyMerge(event);
    } else if (event.kind === "alias") {
      applyAlias(event);
    } else if (
      event.kind === "retraction" &&
      event.target.kind === "claim"
    ) {
      applyClaimRetraction(event);
    }
  }

  const deduplicatedSupports = new Map<string, MutableSupport>();
  for (const support of supports.values()) {
    support.claimId = resolveClaim(support.claimId);
    const key = JSON.stringify([support.claimId, support.eventId]);
    const existing = deduplicatedSupports.get(key);
    if (existing === undefined) {
      deduplicatedSupports.set(key, support);
      continue;
    }
    const live: 0 | 1 = existing.live === 1 || support.live === 1 ? 1 : 0;
    if (support.draftIndex < existing.draftIndex) {
      support.live = live;
      deduplicatedSupports.set(key, support);
    } else {
      existing.live = live;
    }
  }

  const liveSupportsByClaim = new Map<string, MutableSupport[]>();
  for (const support of deduplicatedSupports.values()) {
    if (support.live === 0) {
      continue;
    }
    const rows = liveSupportsByClaim.get(support.claimId) ?? [];
    rows.push(support);
    liveSupportsByClaim.set(support.claimId, rows);
  }
  for (const [claimId, claim] of claimRows) {
    claim.subjectId = resolveEntity(claim.subjectId);
    claim.objectId = claim.objectId === null ? null : resolveEntity(claim.objectId);
    if (resolveClaim(claimId) !== claimId) {
      claim.state = "superseded";
      continue;
    }
    const liveSupports = liveSupportsByClaim.get(claimId) ?? [];
    if (claim.state === "active" && liveSupports.length === 0) {
      claim.state = "retracted";
      if (activeDescribes.get(claim.subjectId) === claim.id) {
        activeDescribes.delete(claim.subjectId);
      }
    }
    if (liveSupports.length > 0) {
      let firstSeenAt = Number.POSITIVE_INFINITY;
      let lastSeenAt = Number.NEGATIVE_INFINITY;
      for (const support of liveSupports) {
        const createdAt =
          statementMetadata.get(support.eventId)?.createdAt ??
          reject("INVALID_PROJECTION_STATE");
        firstSeenAt = Math.min(firstSeenAt, createdAt);
        lastSeenAt = Math.max(lastSeenAt, createdAt);
      }
      claim.firstSeenAt = firstSeenAt;
      claim.lastSeenAt = lastSeenAt;
    }
  }
  reconcileDescribes();

  kindContributions.sort((left, right) =>
    left.orderSeq !== right.orderSeq
      ? left.orderSeq - right.orderSeq
      : left.actualSeq !== right.actualSeq
        ? left.actualSeq - right.actualSeq
        : left.draftIndex !== right.draftIndex
          ? left.draftIndex - right.draftIndex
          : left.position - right.position,
  );
  const selectedKind = new Map<string, string>();
  const kindMaintenance: EntityKindMaintenanceCandidate[] = [];
  for (const contribution of kindContributions) {
    const entityId = resolveEntity(contribution.entityId);
    const existingKind = selectedKind.get(entityId);
    if (existingKind === undefined) {
      selectedKind.set(entityId, contribution.kind);
    } else if (existingKind !== contribution.kind) {
      kindMaintenance.push(
        Object.freeze({
          entityId,
          existingKind,
          observedKind: contribution.kind,
          eventId: contribution.eventId,
        }),
      );
    }
  }
  for (const entityRow of entityRows.values()) {
    const canonicalId = resolveEntity(entityRow.id);
    entityRow.mergedInto = canonicalId === entityRow.id ? null : canonicalId;
    entityRow.kind =
      canonicalId === entityRow.id ? (selectedKind.get(canonicalId) ?? null) : null;
  }

  const compressedEntityRedirects: IdentifierRedirectRow[] = [];
  for (const [oldId, redirect] of entityRedirects) {
    compressedEntityRedirects.push(
      Object.freeze({
        oldId,
        newId: resolveEntity(redirect.newId),
        kind: "entity",
        reason: redirect.reason,
      }),
    );
  }
  const compressedClaimRedirects: IdentifierRedirectRow[] = [];
  for (const [oldId, redirect] of claimRedirects) {
    compressedClaimRedirects.push(
      Object.freeze({
        oldId,
        newId: resolveClaim(redirect.newId),
        kind: "claim",
        reason: redirect.reason,
      }),
    );
  }
  let entityRegistry: ReturnType<typeof createIdentifierRedirectRegistry>;
  let claimRegistry: ReturnType<typeof createIdentifierRedirectRegistry>;
  try {
    entityRegistry = createIdentifierRedirectRegistry({
      anchors: entityAnchors,
      redirects: compressedEntityRedirects,
    });
    claimRegistry = createIdentifierRedirectRegistry({
      anchors: claimAnchors,
      redirects: compressedClaimRedirects,
    });
  } catch (error: unknown) {
    if (error instanceof ProjectionIdentifierError) {
      return reject("INVALID_PROJECTION_STATE");
    }
    throw error;
  }

  const entityRowsOutput = [...entityRows.values()]
    .sort((left, right) => compareEntityIds(left.id, right.id))
    .map(freezeEntityRow);
  const claimRowsOutput = [...claimRows.values()]
    .sort((left, right) => compareClaimIds(left.id, right.id))
    .map(freezeClaimRow);
  const surfaceRows: SurfaceFormProjectionRow[] = [];
  for (const [entityIdValue, values] of surfacesByEntity) {
    const entityId = resolveEntity(entityIdValue);
    if (entityId !== entityIdValue) {
      return reject("INVALID_PROJECTION_STATE");
    }
    for (const [surfaceNorm, origin] of values) {
      surfaceRows.push(
        Object.freeze({ scopeKey, surfaceNorm, entityId, origin }),
      );
    }
  }
  surfaceRows.sort((left, right) => {
    const surfaceOrder = compareText(left.surfaceNorm, right.surfaceNorm);
    return surfaceOrder !== 0
      ? surfaceOrder
      : compareEntityIds(left.entityId, right.entityId);
  });
  const supportRows = [...deduplicatedSupports.values()]
    .sort((left, right) => {
      const claimOrder = compareClaimIds(left.claimId, right.claimId);
      if (claimOrder !== 0) {
        return claimOrder;
      }
      const leftSeq = statementMetadata.get(left.eventId)?.actualSeq ?? 0;
      const rightSeq = statementMetadata.get(right.eventId)?.actualSeq ?? 0;
      return leftSeq !== rightSeq
        ? leftSeq - rightSeq
        : left.draftIndex - right.draftIndex;
    })
    .map((support) =>
      Object.freeze({
        claimId: support.claimId,
        eventId: support.eventId,
        draftIndex: support.draftIndex,
        live: support.live,
      }),
    );
  const entityOccurrences = anchoredDrafts
    .map((occurrence) =>
      Object.freeze({
        eventId: occurrence.eventId,
        draftIndex: occurrence.draftIndex,
        subjectId: resolveEntity(occurrence.candidate.subjectId),
        objectId:
          occurrence.candidate.objectId === null
            ? null
            : resolveEntity(occurrence.candidate.objectId),
      }),
    )
    .sort((left, right) => {
      const leftSeq = statementMetadata.get(left.eventId)?.actualSeq ?? 0;
      const rightSeq = statementMetadata.get(right.eventId)?.actualSeq ?? 0;
      return leftSeq !== rightSeq
        ? leftSeq - rightSeq
        : left.draftIndex - right.draftIndex;
    });
  const claimOccurrences = anchoredDrafts
    .map((occurrence) =>
      Object.freeze({
        eventId: occurrence.eventId,
        draftIndex: occurrence.draftIndex,
        claimId: resolveClaim(occurrence.candidate.claimId),
      }),
    )
    .sort((left, right) => {
      const leftSeq = statementMetadata.get(left.eventId)?.actualSeq ?? 0;
      const rightSeq = statementMetadata.get(right.eventId)?.actualSeq ?? 0;
      return leftSeq !== rightSeq
        ? leftSeq - rightSeq
        : left.draftIndex - right.draftIndex;
    });
  const idRedirects = [
    ...claimRegistry.redirects,
    ...entityRegistry.redirects,
  ].sort((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind === "claim" ? -1 : 1;
    }
    return left.kind === "claim"
      ? compareClaimIds(left.oldId, right.oldId)
      : compareEntityIds(left.oldId, right.oldId);
  });

  return Object.freeze({
    scopeKey,
    rulesVersion: preScan.rulesVersion,
    entityAnchors: Object.freeze(
      [...entityRegistry.anchors].sort((left, right) =>
        compareEntityIds(left.id, right.id),
      ),
    ),
    entities: Object.freeze(entityRowsOutput),
    surfaceForms: Object.freeze(surfaceRows),
    claimAnchors: Object.freeze(
      [...claimRegistry.anchors].sort((left, right) =>
        compareClaimIds(left.id, right.id),
      ),
    ),
    claims: Object.freeze(claimRowsOutput),
    claimSupport: Object.freeze(supportRows),
    idRedirects: Object.freeze(idRedirects),
    entityOccurrences: Object.freeze(entityOccurrences),
    claimOccurrences: Object.freeze(claimOccurrences),
    kindMaintenance: Object.freeze(kindMaintenance),
  });
}
