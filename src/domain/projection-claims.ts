import {
  ProjectionIdentifierError,
  assertCanonicalIdentifier,
  compareOccurrenceIdentifiers,
  createIdentifierRedirectRegistry,
  type IdentifierAnchor,
  type IdentifierRedirectRow,
  type OccurrenceCandidates,
} from "./projection-identifiers.js";
import {
  preScanProjectionEvents,
  type EffectiveClaimRetractionEvent,
  type EffectiveStatementEvent,
  type ProjectionPreScanResult,
} from "./projection-event-pre-scan.js";
import {
  reduceEntitySurfaceKinds,
  type EntityOccurrenceProjection,
  type EntitySurfaceKindProjection,
} from "./projection-entities.js";
import {
  ProjectionRuleError,
  getRelationDefinition,
  normalizeLiteralIdentity,
  normalizeRelationLabel,
  type CanonicalRelation,
} from "./projection-rules.js";
import type { ClaimProjectionRow } from "./projection-replay.js";

export type ClaimProjectionErrorCode =
  | "INVALID_CLAIM_DRAFT"
  | "INVALID_CLAIM_STATE"
  | "DUPLICATE_STATEMENT_CLAIM"
  | "CLAIM_RETRACTION_TARGET_NOT_FOUND"
  | "CLAIM_RETRACTION_TARGET_NOT_PAST";

const ERROR_MESSAGES: Readonly<Record<ClaimProjectionErrorCode, string>> =
  Object.freeze({
    INVALID_CLAIM_DRAFT:
      "claim projection requires a canonical stored statement draft",
    INVALID_CLAIM_STATE:
      "claim projection input or reduced state violates structural invariants",
    DUPLICATE_STATEMENT_CLAIM:
      "one stored statement cannot support the same canonical claim twice",
    CLAIM_RETRACTION_TARGET_NOT_FOUND:
      "claim retraction target is absent from the trusted scope journal",
    CLAIM_RETRACTION_TARGET_NOT_PAST:
      "claim retraction target must precede the retraction event",
  });

const CLAIM_DRAFT_KEYS: ReadonlySet<string> = new Set([
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

export class ClaimProjectionError extends TypeError {
  public override readonly name: string = "ClaimProjectionError";
  public readonly code: ClaimProjectionErrorCode;

  public constructor(code: ClaimProjectionErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.code = code;
  }
}

function reject(code: ClaimProjectionErrorCode): never {
  throw new ClaimProjectionError(code);
}

function plainDataRecord(
  value: unknown,
  code: ClaimProjectionErrorCode,
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
  code: ClaimProjectionErrorCode,
): Readonly<Record<string, unknown>> {
  const source = plainDataRecord(value, code);
  const keys = Object.keys(source).sort();
  const expected = expectedKeys.slice().sort();
  if (
    keys.length !== expected.length ||
    !keys.every((key, index) => key === expected[index])
  ) {
    return reject(code);
  }
  return source;
}

function plainDataArray(
  value: unknown,
  code: ClaimProjectionErrorCode,
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
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function compareClaimIds(left: string, right: string): number {
  try {
    return compareOccurrenceIdentifiers(left, right, "claim");
  } catch (error: unknown) {
    if (error instanceof ProjectionIdentifierError) {
      return reject("INVALID_CLAIM_STATE");
    }
    throw error;
  }
}

interface ParsedClaimDraft {
  readonly relation: CanonicalRelation;
  readonly objectKind: "entity" | "value";
  readonly objectValue: string | null;
}

function parseClaimDraft(value: unknown): ParsedClaimDraft {
  const source = plainDataRecord(value, "INVALID_CLAIM_DRAFT");
  if (
    Object.keys(source).some((key) => !CLAIM_DRAFT_KEYS.has(key)) ||
    !Object.hasOwn(source, "subject") ||
    !Object.hasOwn(source, "relation") ||
    typeof source["subject"] !== "string" ||
    source["subject"].trim().length === 0
  ) {
    return reject("INVALID_CLAIM_DRAFT");
  }
  const hasObject = Object.hasOwn(source, "object");
  const hasObjectValue = Object.hasOwn(source, "object_value");
  if (hasObject === hasObjectValue) {
    return reject("INVALID_CLAIM_DRAFT");
  }
  if (
    !hasObject &&
    (Object.hasOwn(source, "object_kind") ||
      Object.hasOwn(source, "object_aliases"))
  ) {
    return reject("INVALID_CLAIM_DRAFT");
  }

  try {
    const relation = getRelationDefinition(source["relation"]).relation;
    normalizeRelationLabel(relation, source["relation_label"]);
    if (hasObject) {
      if (
        typeof source["object"] !== "string" ||
        source["object"].trim().length === 0
      ) {
        return reject("INVALID_CLAIM_DRAFT");
      }
      return Object.freeze({
        relation,
        objectKind: "entity",
        objectValue: null,
      });
    }
    return Object.freeze({
      relation,
      objectKind: "value",
      objectValue: normalizeLiteralIdentity(source["object_value"]),
    });
  } catch (error: unknown) {
    if (error instanceof ProjectionRuleError) {
      return reject("INVALID_CLAIM_DRAFT");
    }
    throw error;
  }
}

function occurrenceKey(eventId: string, draftIndex: number): string {
  return JSON.stringify([eventId, draftIndex]);
}

function identityKey(
  scopeKey: string,
  subjectId: string,
  draft: ParsedClaimDraft,
  objectId: string | null,
): string {
  return JSON.stringify([
    scopeKey,
    subjectId,
    draft.relation,
    draft.objectKind,
    draft.objectKind === "entity" ? objectId : draft.objectValue,
  ]);
}

interface ValidatedEntityProjection {
  readonly occurrences: ReadonlyMap<string, EntityOccurrenceProjection>;
}

function validatedEntityProjection(
  preScan: ProjectionPreScanResult,
  value: EntitySurfaceKindProjection,
): ValidatedEntityProjection {
  const source = plainDataRecord(value, "INVALID_CLAIM_STATE");
  if (
    source["scopeKey"] !== preScan.scopeKey ||
    source["rulesVersion"] !== preScan.rulesVersion
  ) {
    return reject("INVALID_CLAIM_STATE");
  }
  const entityValues = plainDataArray(
    source["entities"],
    "INVALID_CLAIM_STATE",
  );
  const activeEntityIds = new Set<string>();
  for (const valueEntity of entityValues) {
    const entity = plainDataRecord(valueEntity, "INVALID_CLAIM_STATE");
    if (
      entity["scopeKey"] !== preScan.scopeKey ||
      entity["mergedInto"] !== null
    ) {
      return reject("INVALID_CLAIM_STATE");
    }
    try {
      const id = assertCanonicalIdentifier(entity["id"], "entity");
      if (activeEntityIds.has(id)) {
        return reject("INVALID_CLAIM_STATE");
      }
      activeEntityIds.add(id);
    } catch (error: unknown) {
      if (error instanceof ProjectionIdentifierError) {
        return reject("INVALID_CLAIM_STATE");
      }
      throw error;
    }
  }

  const occurrences = new Map<string, EntityOccurrenceProjection>();
  for (const valueOccurrence of plainDataArray(
    source["occurrences"],
    "INVALID_CLAIM_STATE",
  )) {
    const occurrence = exactDataRecord(
      valueOccurrence,
      ["draftIndex", "eventId", "objectId", "subjectId"],
      "INVALID_CLAIM_STATE",
    );
    if (
      typeof occurrence["eventId"] !== "string" ||
      !Number.isSafeInteger(occurrence["draftIndex"]) ||
      Number(occurrence["draftIndex"]) < 0
    ) {
      return reject("INVALID_CLAIM_STATE");
    }
    let subjectId: string;
    let objectId: string | null;
    try {
      subjectId = assertCanonicalIdentifier(occurrence["subjectId"], "entity");
      objectId =
        occurrence["objectId"] === null
          ? null
          : assertCanonicalIdentifier(occurrence["objectId"], "entity");
    } catch (error: unknown) {
      if (error instanceof ProjectionIdentifierError) {
        return reject("INVALID_CLAIM_STATE");
      }
      throw error;
    }
    if (
      !activeEntityIds.has(subjectId) ||
      (objectId !== null && !activeEntityIds.has(objectId))
    ) {
      return reject("INVALID_CLAIM_STATE");
    }
    const row: EntityOccurrenceProjection = Object.freeze({
      eventId: occurrence["eventId"],
      draftIndex: Number(occurrence["draftIndex"]),
      subjectId,
      objectId,
    });
    const key = occurrenceKey(row.eventId, row.draftIndex);
    if (occurrences.has(key)) {
      return reject("INVALID_CLAIM_STATE");
    }
    occurrences.set(key, row);
  }
  return Object.freeze({ occurrences });
}

interface AnchoredClaimOccurrence {
  readonly eventId: string;
  readonly actualSeq: number;
  readonly draftIndex: number;
  readonly candidate: OccurrenceCandidates;
  readonly claimCandidateId: string;
  readonly subjectId: string;
  readonly relation: CanonicalRelation;
  readonly objectId: string | null;
  readonly objectValue: string | null;
  readonly identity: string;
  readonly createdAt: number;
}

interface MutableClaimRow {
  readonly id: string;
  readonly scopeKey: string;
  readonly subjectId: string;
  readonly relation: CanonicalRelation;
  readonly objectId: string | null;
  readonly objectValue: string | null;
  state: ClaimProjectionRow["state"];
  readonly originSeq: number;
  firstSeenAt: number;
  lastSeenAt: number;
}

interface MutableStructuralSupport {
  claimId: string;
  readonly eventId: string;
  readonly draftIndex: number;
  live: 0 | 1;
}

export interface StructuralClaimSupportProjectionRow {
  readonly claimId: string;
  readonly eventId: string;
  readonly draftIndex: number;
  readonly live: 0 | 1;
}

export interface ClaimOccurrenceProjection {
  readonly eventId: string;
  readonly draftIndex: number;
  readonly claimId: string;
}

export interface ClaimSupportStateProjection {
  readonly scopeKey: string;
  readonly rulesVersion: string;
  readonly claimAnchors: readonly IdentifierAnchor[];
  readonly claims: readonly ClaimProjectionRow[];
  readonly claimSupport: readonly StructuralClaimSupportProjectionRow[];
  readonly idRedirects: readonly IdentifierRedirectRow[];
  readonly occurrences: readonly ClaimOccurrenceProjection[];
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

function statementMetadata(
  preScan: ProjectionPreScanResult,
): ReadonlyMap<
  string,
  Readonly<{ actualSeq: number; orderSeq: number; createdAt: number }>
> {
  const result = new Map<
    string,
    Readonly<{ actualSeq: number; orderSeq: number; createdAt: number }>
  >();
  for (const statement of preScan.statements) {
    if (
      result.has(statement.eventId) ||
      !Number.isSafeInteger(statement.actualSeq) ||
      statement.actualSeq <= 0 ||
      !Number.isSafeInteger(statement.orderSeq) ||
      statement.orderSeq <= 0 ||
      !Number.isSafeInteger(statement.createdAt) ||
      statement.createdAt < 0
    ) {
      return reject("INVALID_CLAIM_STATE");
    }
    result.set(
      statement.eventId,
      Object.freeze({
        actualSeq: statement.actualSeq,
        orderSeq: statement.orderSeq,
        createdAt: statement.createdAt,
      }),
    );
  }
  return result;
}

function ensurePastClaimTarget(
  event: EffectiveClaimRetractionEvent,
): void {
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
      return reject("INVALID_CLAIM_STATE");
    }
    throw error;
  }
}

export function projectClaimSupportState(
  value: unknown,
): ClaimSupportStateProjection {
  const preScan = preScanProjectionEvents(value);
  return reduceClaimSupportState(preScan, reduceEntitySurfaceKinds(preScan));
}

/**
 * Applies ADR-009's structural claim transitions to trusted PRJ-004/005 output.
 * TTL expiry and aggregate validity remain PRJ-008 concerns and are absent here.
 */
export function reduceClaimSupportState(
  preScan: ProjectionPreScanResult,
  entityProjection: EntitySurfaceKindProjection,
): ClaimSupportStateProjection {
  if (
    preScan === null ||
    typeof preScan !== "object" ||
    !Array.isArray(preScan.statementCandidates) ||
    !Array.isArray(preScan.statements) ||
    !Array.isArray(preScan.events)
  ) {
    return reject("INVALID_CLAIM_STATE");
  }
  const scopeKey = preScan.scopeKey;
  const metadata = statementMetadata(preScan);
  const entityState = validatedEntityProjection(preScan, entityProjection);
  const anchored: AnchoredClaimOccurrence[] = [];
  const anchors: IdentifierAnchor[] = [];
  const anchorIds = new Set<string>();
  const occurrenceIds = new Set<string>();
  const statementIdentity = new Map<string, Set<string>>();

  const registrations = [...preScan.statementCandidates].sort((left, right) =>
    left.actualSeq !== right.actualSeq
      ? left.actualSeq - right.actualSeq
      : compareText(left.eventId, right.eventId),
  );
  for (const registration of registrations) {
    const statement = metadata.get(registration.eventId);
    if (
      statement === undefined ||
      statement.actualSeq !== registration.actualSeq ||
      !Array.isArray(registration.parsed) ||
      !Array.isArray(registration.candidates) ||
      registration.parsed.length !== registration.candidates.length
    ) {
      return reject("INVALID_CLAIM_STATE");
    }
    const identities = statementIdentity.get(registration.eventId) ?? new Set<string>();
    for (let draftIndex = 0; draftIndex < registration.parsed.length; draftIndex += 1) {
      const candidate = registration.candidates[draftIndex];
      if (
        candidate === undefined ||
        candidate.draftIndex !== draftIndex ||
        candidate.claimId !== `c${registration.actualSeq}.${draftIndex}`
      ) {
        return reject("INVALID_CLAIM_STATE");
      }
      const key = occurrenceKey(registration.eventId, draftIndex);
      if (occurrenceIds.has(key)) {
        return reject("INVALID_CLAIM_STATE");
      }
      occurrenceIds.add(key);
      const entityOccurrence = entityState.occurrences.get(key);
      if (entityOccurrence === undefined) {
        return reject("INVALID_CLAIM_STATE");
      }
      const draft = parseClaimDraft(registration.parsed[draftIndex]);
      if (
        (draft.objectKind === "entity") !==
        (entityOccurrence.objectId !== null)
      ) {
        return reject("INVALID_CLAIM_STATE");
      }
      let claimCandidateId: string;
      try {
        claimCandidateId = assertCanonicalIdentifier(candidate.claimId, "claim");
      } catch (error: unknown) {
        if (error instanceof ProjectionIdentifierError) {
          return reject("INVALID_CLAIM_STATE");
        }
        throw error;
      }
      if (anchorIds.has(claimCandidateId)) {
        return reject("INVALID_CLAIM_STATE");
      }
      anchorIds.add(claimCandidateId);
      anchors.push(
        Object.freeze({ id: claimCandidateId, kind: "claim", scopeKey }),
      );
      const claimIdentity = identityKey(
        scopeKey,
        entityOccurrence.subjectId,
        draft,
        entityOccurrence.objectId,
      );
      if (identities.has(claimIdentity)) {
        return reject("DUPLICATE_STATEMENT_CLAIM");
      }
      identities.add(claimIdentity);
      anchored.push(
        Object.freeze({
          eventId: registration.eventId,
          actualSeq: registration.actualSeq,
          draftIndex,
          candidate,
          claimCandidateId,
          subjectId: entityOccurrence.subjectId,
          relation: draft.relation,
          objectId: entityOccurrence.objectId,
          objectValue: draft.objectValue,
          identity: claimIdentity,
          createdAt: statement.createdAt,
        }),
      );
    }
    statementIdentity.set(registration.eventId, identities);
  }
  if (entityState.occurrences.size !== anchored.length) {
    return reject("INVALID_CLAIM_STATE");
  }

  const groups = new Map<string, AnchoredClaimOccurrence[]>();
  for (const occurrence of anchored) {
    const group = groups.get(occurrence.identity) ?? [];
    group.push(occurrence);
    groups.set(occurrence.identity, group);
  }

  const claims = new Map<string, MutableClaimRow>();
  const canonicalByCandidate = new Map<string, string>();
  const redirects: IdentifierRedirectRow[] = [];
  for (const group of groups.values()) {
    group.sort((left, right) =>
      compareClaimIds(left.claimCandidateId, right.claimCandidateId),
    );
    const first = group[0] ?? reject("INVALID_CLAIM_STATE");
    claims.set(first.claimCandidateId, {
      id: first.claimCandidateId,
      scopeKey,
      subjectId: first.subjectId,
      relation: first.relation,
      objectId: first.objectId,
      objectValue: first.objectValue,
      state: "retracted",
      originSeq: first.actualSeq,
      firstSeenAt: first.createdAt,
      lastSeenAt: first.createdAt,
    });
    for (const occurrence of group) {
      canonicalByCandidate.set(
        occurrence.claimCandidateId,
        first.claimCandidateId,
      );
      if (occurrence.claimCandidateId !== first.claimCandidateId) {
        redirects.push(
          Object.freeze({
            oldId: occurrence.claimCandidateId,
            newId: first.claimCandidateId,
            kind: "claim",
            reason: "deduplicated",
          }),
        );
      }
    }
  }

  let registry: ReturnType<typeof createIdentifierRedirectRegistry>;
  try {
    registry = createIdentifierRedirectRegistry({ anchors, redirects });
  } catch (error: unknown) {
    if (error instanceof ProjectionIdentifierError) {
      return reject("INVALID_CLAIM_STATE");
    }
    throw error;
  }
  for (const anchor of registry.anchors) {
    canonicalByCandidate.set(anchor.id, anchor.id);
  }
  for (const redirect of registry.redirects) {
    canonicalByCandidate.set(redirect.oldId, redirect.newId);
  }

  const anchoredByKey = new Map(
    anchored.map((occurrence) => [
      occurrenceKey(occurrence.eventId, occurrence.draftIndex),
      occurrence,
    ]),
  );
  const supports = new Map<string, MutableStructuralSupport>();
  const supportsByClaim = new Map<string, MutableStructuralSupport[]>();
  for (const occurrence of anchored) {
    const claimId =
      canonicalByCandidate.get(occurrence.claimCandidateId) ??
      reject("INVALID_CLAIM_STATE");
    const support: MutableStructuralSupport = {
      claimId,
      eventId: occurrence.eventId,
      draftIndex: occurrence.draftIndex,
      live: 0,
    };
    supports.set(occurrenceKey(occurrence.eventId, occurrence.draftIndex), support);
    const claimSupports = supportsByClaim.get(claimId) ?? [];
    claimSupports.push(support);
    supportsByClaim.set(claimId, claimSupports);
  }

  const activeDescribesBySubject = new Map<string, string>();
  const describesKey = (subjectId: string): string =>
    JSON.stringify([scopeKey, subjectId]);

  const applyStatement = (event: EffectiveStatementEvent): void => {
    for (let draftIndex = 0; draftIndex < event.parsed.length; draftIndex += 1) {
      const key = occurrenceKey(event.eventId, draftIndex);
      const occurrence = anchoredByKey.get(key);
      const support = supports.get(key);
      if (occurrence === undefined || support === undefined) {
        return reject("INVALID_CLAIM_STATE");
      }
      const claimId =
        canonicalByCandidate.get(occurrence.claimCandidateId) ??
        reject("INVALID_CLAIM_STATE");
      const claim = claims.get(claimId) ?? reject("INVALID_CLAIM_STATE");
      if (claim.relation === "describes") {
        const slot = describesKey(claim.subjectId);
        const previousId = activeDescribesBySubject.get(slot);
        if (previousId !== undefined && previousId !== claim.id) {
          const previous = claims.get(previousId);
          if (previous === undefined || previous.state !== "active") {
            return reject("INVALID_CLAIM_STATE");
          }
          previous.state = "superseded";
        }
        activeDescribesBySubject.set(slot, claim.id);
      }
      claim.state = "active";
      support.live = 1;
    }
  };

  const applyClaimRetraction = (
    event: EffectiveClaimRetractionEvent,
  ): void => {
    ensurePastClaimTarget(event);
    const claimId = canonicalByCandidate.get(event.target.claimId);
    if (claimId === undefined) {
      return reject("CLAIM_RETRACTION_TARGET_NOT_FOUND");
    }
    const claim = claims.get(claimId);
    if (claim === undefined) {
      return reject("CLAIM_RETRACTION_TARGET_NOT_FOUND");
    }
    for (const support of supportsByClaim.get(claimId) ?? []) {
      const supportMetadata = metadata.get(support.eventId);
      if (supportMetadata === undefined) {
        return reject("INVALID_CLAIM_STATE");
      }
      if (supportMetadata.orderSeq < event.actualSeq) {
        support.live = 0;
      }
    }
    if (
      claim.relation === "describes" &&
      activeDescribesBySubject.get(describesKey(claim.subjectId)) === claim.id
    ) {
      activeDescribesBySubject.delete(describesKey(claim.subjectId));
    }
    claim.state = "retracted";
  };

  for (const event of preScan.events) {
    if (event.kind === "statement") {
      applyStatement(event);
    } else if (
      event.kind === "retraction" &&
      event.target.kind === "claim"
    ) {
      applyClaimRetraction(event);
    }
  }

  const liveSupportByClaim = new Map<string, MutableStructuralSupport[]>();
  for (const support of supports.values()) {
    if (support.live === 0) {
      continue;
    }
    const rows = liveSupportByClaim.get(support.claimId) ?? [];
    rows.push(support);
    liveSupportByClaim.set(support.claimId, rows);
  }
  for (const claim of claims.values()) {
    const liveSupports = liveSupportByClaim.get(claim.id) ?? [];
    if (claim.state === "active" && liveSupports.length === 0) {
      claim.state = "retracted";
      if (
        claim.relation === "describes" &&
        activeDescribesBySubject.get(describesKey(claim.subjectId)) === claim.id
      ) {
        activeDescribesBySubject.delete(describesKey(claim.subjectId));
      }
    }
    if (liveSupports.length > 0) {
      let firstSeenAt = Number.POSITIVE_INFINITY;
      let lastSeenAt = Number.NEGATIVE_INFINITY;
      for (const support of liveSupports) {
        const statement = metadata.get(support.eventId);
        const createdAt = statement?.createdAt ?? reject("INVALID_CLAIM_STATE");
        firstSeenAt = Math.min(firstSeenAt, createdAt);
        lastSeenAt = Math.max(lastSeenAt, createdAt);
      }
      claim.firstSeenAt = firstSeenAt;
      claim.lastSeenAt = lastSeenAt;
    }
  }

  const activeDescribesKeys = new Set<string>();
  for (const claim of claims.values()) {
    if (claim.state !== "active") {
      continue;
    }
    if ((liveSupportByClaim.get(claim.id) ?? []).length === 0) {
      return reject("INVALID_CLAIM_STATE");
    }
    if (claim.relation === "describes") {
      const key = describesKey(claim.subjectId);
      if (activeDescribesKeys.has(key)) {
        return reject("INVALID_CLAIM_STATE");
      }
      if (activeDescribesBySubject.get(key) !== claim.id) {
        return reject("INVALID_CLAIM_STATE");
      }
      activeDescribesKeys.add(key);
    }
  }
  if (activeDescribesKeys.size !== activeDescribesBySubject.size) {
    return reject("INVALID_CLAIM_STATE");
  }

  const claimRows = [...claims.values()]
    .sort((left, right) => compareClaimIds(left.id, right.id))
    .map(freezeClaimRow);
  const eventSeq = new Map(
    [...metadata.entries()].map(([eventId, item]) => [eventId, item.actualSeq]),
  );
  const supportRows = [...supports.values()]
    .sort((left, right) => {
      const claimOrder = compareClaimIds(left.claimId, right.claimId);
      if (claimOrder !== 0) {
        return claimOrder;
      }
      const leftSeq = eventSeq.get(left.eventId) ?? 0;
      const rightSeq = eventSeq.get(right.eventId) ?? 0;
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
  const occurrenceRows = anchored
    .slice()
    .sort((left, right) =>
      left.actualSeq !== right.actualSeq
        ? left.actualSeq - right.actualSeq
        : left.draftIndex - right.draftIndex,
    )
    .map((occurrence) =>
      Object.freeze({
        eventId: occurrence.eventId,
        draftIndex: occurrence.draftIndex,
        claimId:
          canonicalByCandidate.get(occurrence.claimCandidateId) ??
          reject("INVALID_CLAIM_STATE"),
      }),
    );
  const sortedAnchors = [...registry.anchors].sort((left, right) =>
    compareClaimIds(left.id, right.id),
  );
  const sortedRedirects = [...registry.redirects].sort((left, right) =>
    compareClaimIds(left.oldId, right.oldId),
  );

  return Object.freeze({
    scopeKey,
    rulesVersion: preScan.rulesVersion,
    claimAnchors: Object.freeze(sortedAnchors),
    claims: Object.freeze(claimRows),
    claimSupport: Object.freeze(supportRows),
    idRedirects: Object.freeze(sortedRedirects),
    occurrences: Object.freeze(occurrenceRows),
  });
}
