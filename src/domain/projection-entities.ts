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
  type EffectiveStatementEvent,
  type ProjectionPreScanResult,
  type StatementCandidateRegistration,
} from "./projection-event-pre-scan.js";
import {
  ProjectionRuleError,
  normalizeV1,
} from "./projection-rules.js";
import type {
  EntityProjectionRow,
  SurfaceFormProjectionRow,
} from "./projection-replay.js";

const SCOPE_KEY_PATTERN =
  /^u:[A-Za-z0-9._-]{1,64}\/p:[A-Za-z0-9._-]{1,64}$/u;
const KIND_MAX_CODE_POINTS = 64;
const ORIGIN_PRIORITY = Object.freeze({
  agent_supplied: 1,
  name: 2,
  confirmed: 3,
} as const);

export type EntityProjectionErrorCode =
  | "INVALID_ENTITY_DRAFT"
  | "INVALID_ENTITY_KIND"
  | "INVALID_ENTITY_REFERENCE"
  | "INVALID_ENTITY_STATE"
  | "INVALID_SURFACE_ORIGIN"
  | "AMBIGUOUS_ENTITY";

const ERROR_MESSAGES: Readonly<Record<EntityProjectionErrorCode, string>> =
  Object.freeze({
    INVALID_ENTITY_DRAFT:
      "entity projection requires a canonical stored statement draft",
    INVALID_ENTITY_KIND:
      "entity kind must be normalized non-empty text within the v1 limit",
    INVALID_ENTITY_REFERENCE:
      "entity resolution requires a canonical scope-bound reference",
    INVALID_ENTITY_STATE:
      "entity resolution state violates scope, anchor, or redirect invariants",
    INVALID_SURFACE_ORIGIN:
      "surface origin must be agent_supplied, name, or confirmed",
    AMBIGUOUS_ENTITY:
      "stored entity reference resolves to multiple canonical candidates",
  });

export class EntityProjectionError extends TypeError {
  public override readonly name: string = "EntityProjectionError";
  public readonly code: EntityProjectionErrorCode;

  public constructor(code: EntityProjectionErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.code = code;
  }
}

function reject(code: EntityProjectionErrorCode): never {
  throw new EntityProjectionError(code);
}

type SurfaceOrigin = SurfaceFormProjectionRow["origin"];

function surfaceOrigin(value: unknown): SurfaceOrigin {
  if (
    value !== "agent_supplied" &&
    value !== "name" &&
    value !== "confirmed"
  ) {
    return reject("INVALID_SURFACE_ORIGIN");
  }
  return value;
}

export function strongestSurfaceOrigin(
  currentValue: unknown,
  incomingValue: unknown,
): SurfaceOrigin {
  const current = surfaceOrigin(currentValue);
  const incoming = surfaceOrigin(incomingValue);
  return ORIGIN_PRIORITY[incoming] > ORIGIN_PRIORITY[current]
    ? incoming
    : current;
}

function plainDataRecord(
  value: unknown,
  code: EntityProjectionErrorCode,
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
  code: EntityProjectionErrorCode,
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
  code: EntityProjectionErrorCode,
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
  return result;
}

function canonicalScope(
  value: unknown,
  code: EntityProjectionErrorCode,
): string {
  if (typeof value !== "string" || !SCOPE_KEY_PATTERN.test(value)) {
    return reject(code);
  }
  return value;
}

function displayName(value: unknown): string {
  if (typeof value !== "string") {
    return reject("INVALID_ENTITY_DRAFT");
  }
  const result = value.trim();
  try {
    normalizeV1(result);
  } catch (error: unknown) {
    if (error instanceof ProjectionRuleError) {
      return reject("INVALID_ENTITY_DRAFT");
    }
    throw error;
  }
  return result;
}

function normalizedName(value: string): string {
  try {
    return normalizeV1(value);
  } catch (error: unknown) {
    if (error instanceof ProjectionRuleError) {
      return reject("INVALID_ENTITY_DRAFT");
    }
    throw error;
  }
}

function normalizedKind(value: unknown): string | null {
  if (value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    return reject("INVALID_ENTITY_KIND");
  }
  const result = value.trim().normalize("NFKC").toLowerCase();
  const length = Array.from(result).length;
  if (length === 0 || length > KIND_MAX_CODE_POINTS) {
    return reject("INVALID_ENTITY_KIND");
  }
  return result;
}

function aliases(value: unknown): readonly string[] {
  if (value === undefined) {
    return Object.freeze([]);
  }
  const values = plainDataArray(value, "INVALID_ENTITY_DRAFT");
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of values) {
    const name = displayName(item);
    const normal = normalizedName(name);
    if (!seen.has(normal)) {
      seen.add(normal);
      result.push(name);
    }
  }
  return Object.freeze(result);
}

interface ParsedEntityDraft {
  readonly subject: string;
  readonly subjectNormal: string;
  readonly subjectAliases: readonly string[];
  readonly subjectKind: string | null;
  readonly object: string | null;
  readonly objectNormal: string | null;
  readonly objectAliases: readonly string[];
  readonly objectKind: string | null;
}

function parseEntityDraft(value: unknown): ParsedEntityDraft {
  const source = plainDataRecord(value, "INVALID_ENTITY_DRAFT");
  if (!Object.hasOwn(source, "subject")) {
    return reject("INVALID_ENTITY_DRAFT");
  }
  const hasObject = Object.hasOwn(source, "object");
  const hasObjectValue = Object.hasOwn(source, "object_value");
  if (hasObject === hasObjectValue) {
    return reject("INVALID_ENTITY_DRAFT");
  }
  if (
    !hasObject &&
    (Object.hasOwn(source, "object_aliases") ||
      Object.hasOwn(source, "object_kind"))
  ) {
    return reject("INVALID_ENTITY_DRAFT");
  }
  const subject = displayName(source["subject"]);
  const object = hasObject ? displayName(source["object"]) : null;
  return Object.freeze({
    subject,
    subjectNormal: normalizedName(subject),
    subjectAliases: aliases(source["subject_aliases"]),
    subjectKind: normalizedKind(source["subject_kind"]),
    object,
    objectNormal: object === null ? null : normalizedName(object),
    objectAliases: hasObject
      ? aliases(source["object_aliases"])
      : Object.freeze([]),
    objectKind: hasObject ? normalizedKind(source["object_kind"]) : null,
  });
}

function compareText(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function compareEntityIds(left: string, right: string): number {
  return compareOccurrenceIdentifiers(left, right, "entity");
}

interface ValidatedReferenceState {
  readonly scopeKey: string;
  readonly normalName: string;
  readonly canonicalById: ReadonlyMap<string, string>;
  readonly entities: ReadonlyMap<string, EntityProjectionRow>;
  readonly surfaceForms: readonly SurfaceFormProjectionRow[];
}

function validateEntityRow(
  value: unknown,
  scopeKey: string,
): EntityProjectionRow {
  const row = exactDataRecord(
    value,
    ["id", "kind", "mergedInto", "name", "normalName", "originSeq", "scopeKey"],
    "INVALID_ENTITY_STATE",
  );
  if (row["scopeKey"] !== scopeKey) {
    return reject("INVALID_ENTITY_STATE");
  }
  let id: string;
  let name: string;
  let normalName: string;
  try {
    id = assertCanonicalIdentifier(row["id"], "entity");
    name = displayName(row["name"]);
    normalName = normalizedName(name);
  } catch (error: unknown) {
    if (
      error instanceof ProjectionIdentifierError ||
      error instanceof EntityProjectionError
    ) {
      return reject("INVALID_ENTITY_STATE");
    }
    throw error;
  }
  if (row["normalName"] !== normalName) {
    return reject("INVALID_ENTITY_STATE");
  }
  const kind = row["kind"];
  if (kind !== null && (typeof kind !== "string" || normalizedKind(kind) !== kind)) {
    return reject("INVALID_ENTITY_STATE");
  }
  const mergedInto = row["mergedInto"];
  if (
    mergedInto !== null &&
    (typeof mergedInto !== "string" || mergedInto.length === 0)
  ) {
    return reject("INVALID_ENTITY_STATE");
  }
  const originSeq = row["originSeq"];
  if (!Number.isSafeInteger(originSeq) || Number(originSeq) <= 0) {
    return reject("INVALID_ENTITY_STATE");
  }
  return Object.freeze({
    id,
    scopeKey,
    name,
    normalName,
    kind: kind as string | null,
    mergedInto: mergedInto as string | null,
    originSeq: Number(originSeq),
  });
}

function validateSurfaceRow(
  value: unknown,
  scopeKey: string,
): SurfaceFormProjectionRow {
  const row = exactDataRecord(
    value,
    ["entityId", "origin", "scopeKey", "surfaceNorm"],
    "INVALID_ENTITY_STATE",
  );
  if (row["scopeKey"] !== scopeKey || typeof row["surfaceNorm"] !== "string") {
    return reject("INVALID_ENTITY_STATE");
  }
  let entityId: string;
  let normal: string;
  try {
    entityId = assertCanonicalIdentifier(row["entityId"], "entity");
    normal = normalizeV1(row["surfaceNorm"]);
  } catch (error: unknown) {
    if (
      error instanceof ProjectionIdentifierError ||
      error instanceof ProjectionRuleError
    ) {
      return reject("INVALID_ENTITY_STATE");
    }
    throw error;
  }
  if (normal !== row["surfaceNorm"]) {
    return reject("INVALID_ENTITY_STATE");
  }
  let origin: SurfaceOrigin;
  try {
    origin = surfaceOrigin(row["origin"]);
  } catch (error: unknown) {
    if (error instanceof EntityProjectionError) {
      return reject("INVALID_ENTITY_STATE");
    }
    throw error;
  }
  return Object.freeze({
    scopeKey,
    surfaceNorm: normal,
    entityId,
    origin,
  });
}

function validatedReferenceState(value: unknown): ValidatedReferenceState {
  const input = exactDataRecord(
    value,
    [
      "entityAnchors",
      "entities",
      "idRedirects",
      "name",
      "scopeKey",
      "surfaceForms",
    ],
    "INVALID_ENTITY_STATE",
  );
  const scopeKey = canonicalScope(input["scopeKey"], "INVALID_ENTITY_STATE");
  if (typeof input["name"] !== "string") {
    return reject("INVALID_ENTITY_REFERENCE");
  }
  let normalName: string;
  try {
    normalName = normalizeV1(input["name"]);
  } catch (error: unknown) {
    if (error instanceof ProjectionRuleError) {
      return reject("INVALID_ENTITY_REFERENCE");
    }
    throw error;
  }
  const entityAnchors = plainDataArray(
    input["entityAnchors"],
    "INVALID_ENTITY_STATE",
  );
  const idRedirects = plainDataArray(
    input["idRedirects"],
    "INVALID_ENTITY_STATE",
  );
  let registry: ReturnType<typeof createIdentifierRedirectRegistry>;
  try {
    registry = createIdentifierRedirectRegistry({
      anchors: entityAnchors,
      redirects: idRedirects,
    });
  } catch (error: unknown) {
    if (error instanceof ProjectionIdentifierError) {
      return reject("INVALID_ENTITY_STATE");
    }
    throw error;
  }
  if (
    registry.anchors.some(
      (anchor) => anchor.kind !== "entity" || anchor.scopeKey !== scopeKey,
    ) ||
    registry.redirects.some((redirect) => redirect.kind !== "entity")
  ) {
    return reject("INVALID_ENTITY_STATE");
  }
  const canonicalById = new Map(
    registry.anchors.map((anchor) => [anchor.id, anchor.id]),
  );
  for (const redirect of registry.redirects) {
    canonicalById.set(redirect.oldId, redirect.newId);
  }

  const entities = new Map<string, EntityProjectionRow>();
  for (const item of plainDataArray(input["entities"], "INVALID_ENTITY_STATE")) {
    const row = validateEntityRow(item, scopeKey);
    if (entities.has(row.id)) {
      return reject("INVALID_ENTITY_STATE");
    }
    entities.set(row.id, row);
  }
  const anchorIds = new Set(registry.anchors.map((anchor) => anchor.id));
  if ([...entities.keys()].some((id) => !anchorIds.has(id))) {
    return reject("INVALID_ENTITY_STATE");
  }

  const activeNormalNames = new Set<string>();
  for (const row of entities.values()) {
    const canonical = canonicalById.get(row.id);
    if (canonical === undefined || !entities.has(canonical)) {
      return reject("INVALID_ENTITY_STATE");
    }
    if (row.mergedInto === null && canonical === row.id) {
      if (activeNormalNames.has(row.normalName)) {
        return reject("INVALID_ENTITY_STATE");
      }
      activeNormalNames.add(row.normalName);
    }
  }

  const surfaceForms = plainDataArray(
    input["surfaceForms"],
    "INVALID_ENTITY_STATE",
  ).map((item) => validateSurfaceRow(item, scopeKey));
  const surfaceKeys = new Set<string>();
  for (const row of surfaceForms) {
    const canonical = canonicalById.get(row.entityId);
    const target = canonical === undefined ? undefined : entities.get(canonical);
    const key = surfaceKey(row.surfaceNorm, row.entityId);
    if (
      !anchorIds.has(row.entityId) ||
      canonical === undefined ||
      target === undefined ||
      target.mergedInto !== null ||
      surfaceKeys.has(key)
    ) {
      return reject("INVALID_ENTITY_STATE");
    }
    surfaceKeys.add(key);
  }

  for (const row of entities.values()) {
    const canonical = canonicalById.get(row.id);
    if (canonical === undefined) {
      return reject("INVALID_ENTITY_STATE");
    }
    if (
      (row.mergedInto === null && canonical !== row.id) ||
      (row.mergedInto !== null && canonical !== row.mergedInto)
    ) {
      return reject("INVALID_ENTITY_STATE");
    }
  }

  return Object.freeze({
    scopeKey,
    normalName,
    canonicalById,
    entities,
    surfaceForms: Object.freeze(surfaceForms),
  });
}

export interface ResolvedEntityReference {
  readonly status: "resolved";
  readonly normalName: string;
  readonly entityId: string;
}

export interface MissingEntityReference {
  readonly status: "not_found";
  readonly normalName: string;
}

export interface AmbiguousEntityCandidate {
  readonly entityId: string;
  readonly name: string;
}

export interface AmbiguousEntityReference {
  readonly status: "ambiguous";
  readonly normalName: string;
  readonly candidates: readonly AmbiguousEntityCandidate[];
}

export type EntityReferenceResolution =
  | ResolvedEntityReference
  | MissingEntityReference
  | AmbiguousEntityReference;

function resolveFromValidatedState(
  state: ValidatedReferenceState,
): EntityReferenceResolution {
  const canonical = (identifier: string): string =>
    state.canonicalById.get(identifier) ?? reject("INVALID_ENTITY_STATE");
  const activeEntity = (identifier: string): EntityProjectionRow => {
    const row = state.entities.get(identifier);
    if (row === undefined || row.mergedInto !== null || canonical(identifier) !== identifier) {
      return reject("INVALID_ENTITY_STATE");
    }
    return row;
  };

  const mapped = new Set<string>();
  for (const surface of state.surfaceForms) {
    if (surface.surfaceNorm === state.normalName) {
      mapped.add(canonical(surface.entityId));
    }
  }
  const candidates = [...mapped].sort(compareEntityIds);
  for (const candidate of candidates) {
    activeEntity(candidate);
  }
  if (candidates.length === 1) {
    return Object.freeze({
      status: "resolved",
      normalName: state.normalName,
      entityId: candidates[0] ?? reject("INVALID_ENTITY_STATE"),
    });
  }
  if (candidates.length > 1) {
    const exact = candidates.filter(
      (candidate) => activeEntity(candidate).normalName === state.normalName,
    );
    if (exact.length === 1) {
      return Object.freeze({
        status: "resolved",
        normalName: state.normalName,
        entityId: exact[0] ?? reject("INVALID_ENTITY_STATE"),
      });
    }
    return Object.freeze({
      status: "ambiguous",
      normalName: state.normalName,
      candidates: Object.freeze(
        candidates.map((candidate) =>
          Object.freeze({
            entityId: candidate,
            name: activeEntity(candidate).name,
          }),
        ),
      ),
    });
  }

  const exact = [...state.entities.values()]
    .filter(
      (entity) =>
        entity.mergedInto === null &&
        canonical(entity.id) === entity.id &&
        entity.normalName === state.normalName,
    )
    .sort((left, right) => compareEntityIds(left.id, right.id));
  if (exact.length > 1) {
    return reject("INVALID_ENTITY_STATE");
  }
  const entity = exact[0];
  return entity === undefined
    ? Object.freeze({ status: "not_found", normalName: state.normalName })
    : Object.freeze({
        status: "resolved",
        normalName: state.normalName,
        entityId: entity.id,
      });
}

export function resolveEntityReference(value: unknown): EntityReferenceResolution {
  return resolveFromValidatedState(validatedReferenceState(value));
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

interface AnchoredOccurrence {
  readonly eventId: string;
  readonly actualSeq: number;
  readonly draftIndex: number;
  readonly candidate: OccurrenceCandidates;
  readonly draft: ParsedEntityDraft;
}

interface SurfaceContribution {
  readonly surfaceNorm: string;
  readonly entityId: string;
  readonly origin: SurfaceOrigin;
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

export interface EntityOccurrenceProjection {
  readonly eventId: string;
  readonly draftIndex: number;
  readonly subjectId: string;
  readonly objectId: string | null;
}

export interface EntityKindMaintenanceCandidate {
  readonly entityId: string;
  readonly existingKind: string;
  readonly observedKind: string;
  readonly eventId: string;
}

export interface EntitySurfaceKindProjection {
  readonly scopeKey: string;
  readonly rulesVersion: string;
  readonly entityAnchors: readonly IdentifierAnchor[];
  readonly entities: readonly EntityProjectionRow[];
  readonly surfaceForms: readonly SurfaceFormProjectionRow[];
  readonly idRedirects: readonly IdentifierRedirectRow[];
  readonly occurrences: readonly EntityOccurrenceProjection[];
  readonly kindMaintenance: readonly EntityKindMaintenanceCandidate[];
}

function statementRegistrationMap(
  preScan: ProjectionPreScanResult,
): ReadonlyMap<string, StatementCandidateRegistration> {
  return new Map(
    preScan.statementCandidates.map((registration) => [
      registration.eventId,
      registration,
    ]),
  );
}

function statementEventMap(
  preScan: ProjectionPreScanResult,
): ReadonlyMap<string, EffectiveStatementEvent> {
  return new Map(
    preScan.events
      .filter((event): event is EffectiveStatementEvent => event.kind === "statement")
      .map((event) => [event.eventId, event]),
  );
}

function surfaceKey(surfaceNorm: string, entityId: string): string {
  return JSON.stringify([surfaceNorm, entityId]);
}

function occurrenceKey(eventId: string, draftIndex: number): string {
  return JSON.stringify([eventId, draftIndex]);
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

export function projectEntitySurfaceKinds(value: unknown): EntitySurfaceKindProjection {
  return reduceEntitySurfaceKinds(preScanProjectionEvents(value));
}

/** Reduces the trusted, scope-bound PRJ-004 pre-scan output without consulting IO. */
export function reduceEntitySurfaceKinds(
  preScan: ProjectionPreScanResult,
): EntitySurfaceKindProjection {
  const scopeKey = preScan.scopeKey;
  const anchors: IdentifierAnchor[] = [];
  const entities = new Map<string, MutableEntityRow>();
  const canonicalByNormal = new Map<string, string>();
  const redirects = new Map<string, IdentifierRedirectRow>();
  const occurrences: AnchoredOccurrence[] = [];

  const resolveInternal = (identifier: string): string => {
    let current = identifier;
    const seen = new Set<string>();
    while (redirects.has(current)) {
      if (seen.has(current)) {
        return reject("INVALID_ENTITY_STATE");
      }
      seen.add(current);
      current = redirects.get(current)?.newId ?? reject("INVALID_ENTITY_STATE");
    }
    return current;
  };

  const compressRedirects = (): void => {
    for (const [oldId, redirect] of redirects) {
      redirects.set(
        oldId,
        Object.freeze({
          oldId,
          newId: resolveInternal(redirect.newId),
          kind: "entity",
          reason: redirect.reason,
        }),
      );
    }
  };

  const addRedirect = (oldValue: string, newValue: string): void => {
    const oldId = resolveInternal(oldValue);
    const newId = resolveInternal(newValue);
    if (oldId === newId) {
      return;
    }
    redirects.set(
      oldId,
      Object.freeze({
        oldId,
        newId,
        kind: "entity",
        reason: "deduplicated",
      }),
    );
  };

  const anchorEntity = (
    candidateId: string,
    name: string,
    normalName: string,
    actualSeq: number,
  ): void => {
    anchors.push(Object.freeze({ id: candidateId, kind: "entity", scopeKey }));
    const existing = canonicalByNormal.get(normalName);
    if (existing !== undefined) {
      addRedirect(candidateId, existing);
      return;
    }
    canonicalByNormal.set(normalName, candidateId);
    entities.set(candidateId, {
      id: candidateId,
      scopeKey,
      name,
      normalName,
      kind: null,
      mergedInto: null,
      originSeq: actualSeq,
    });
  };

  for (const registration of preScan.statementCandidates) {
    if (registration.parsed.length !== registration.candidates.length) {
      return reject("INVALID_ENTITY_STATE");
    }
    for (let index = 0; index < registration.parsed.length; index += 1) {
      const candidate = registration.candidates[index];
      if (candidate === undefined || candidate.draftIndex !== index) {
        return reject("INVALID_ENTITY_STATE");
      }
      const draft = parseEntityDraft(registration.parsed[index]);
      anchorEntity(
        candidate.subjectId,
        draft.subject,
        draft.subjectNormal,
        registration.actualSeq,
      );
      if (
        candidate.objectId !== null &&
        draft.object !== null &&
        draft.objectNormal !== null
      ) {
        anchorEntity(
          candidate.objectId,
          draft.object,
          draft.objectNormal,
          registration.actualSeq,
        );
      } else if (candidate.objectId !== null || draft.object !== null) {
        return reject("INVALID_ENTITY_STATE");
      }
      occurrences.push(
        Object.freeze({
          eventId: registration.eventId,
          actualSeq: registration.actualSeq,
          draftIndex: index,
          candidate,
          draft,
        }),
      );
    }
  }

  const surfaceContributions = new Map<string, SurfaceContribution>();
  const surfaceEntities = new Map<string, Set<string>>();
  const upsertSurface = (
    surface: string,
    entityId: string,
    origin: SurfaceOrigin,
  ): void => {
    const surfaceNorm = normalizedName(surface);
    const canonicalId = resolveInternal(entityId);
    const key = surfaceKey(surfaceNorm, canonicalId);
    const existing = surfaceContributions.get(key);
    surfaceContributions.set(
      key,
      Object.freeze({
        surfaceNorm,
        entityId: canonicalId,
        origin:
          existing === undefined
            ? origin
            : strongestSurfaceOrigin(existing.origin, origin),
      }),
    );
    const mapped = surfaceEntities.get(surfaceNorm) ?? new Set<string>();
    mapped.add(canonicalId);
    surfaceEntities.set(surfaceNorm, mapped);
  };

  const currentReferenceState = (name: string): EntityReferenceResolution => {
    const normalName = normalizedName(name);
    const mapped = new Set(
      [...(surfaceEntities.get(normalName) ?? [])].map(resolveInternal),
    );
    const candidates = [...mapped].sort(compareEntityIds);
    const activeEntity = (entityId: string): MutableEntityRow => {
      const entity = entities.get(entityId);
      if (entity === undefined || resolveInternal(entityId) !== entityId) {
        return reject("INVALID_ENTITY_STATE");
      }
      return entity;
    };
    if (candidates.length === 1) {
      return Object.freeze({
        status: "resolved",
        normalName,
        entityId: candidates[0] ?? reject("INVALID_ENTITY_STATE"),
      });
    }
    if (candidates.length > 1) {
      const exact = candidates.filter(
        (candidate) => activeEntity(candidate).normalName === normalName,
      );
      if (exact.length === 1) {
        return Object.freeze({
          status: "resolved",
          normalName,
          entityId: exact[0] ?? reject("INVALID_ENTITY_STATE"),
        });
      }
      return Object.freeze({
        status: "ambiguous",
        normalName,
        candidates: Object.freeze(
          candidates.map((candidate) =>
            Object.freeze({
              entityId: candidate,
              name: activeEntity(candidate).name,
            }),
          ),
        ),
      });
    }

    const exactAnchor = canonicalByNormal.get(normalName);
    if (exactAnchor === undefined) {
      return Object.freeze({ status: "not_found", normalName });
    }
    const entityId = resolveInternal(exactAnchor);
    const entity = activeEntity(entityId);
    return entity.normalName === normalName
      ? Object.freeze({ status: "resolved", normalName, entityId })
      : Object.freeze({ status: "not_found", normalName });
  };

  const resolveOccurrence = (
    candidateId: string,
    name: string,
  ): Readonly<{ entityId: string; nameOrigin: SurfaceOrigin }> => {
    const ownEntityBeforeResolution =
      entities.has(candidateId) && resolveInternal(candidateId) === candidateId;
    const currentId = resolveInternal(candidateId);
    const resolution = currentReferenceState(name);
    if (resolution.status === "ambiguous") {
      return reject("AMBIGUOUS_ENTITY");
    }
    if (resolution.status === "not_found") {
      return reject("INVALID_ENTITY_STATE");
    }
    if (resolution.entityId !== currentId) {
      addRedirect(currentId, resolution.entityId);
    }
    const entityId = resolveInternal(resolution.entityId);
    return Object.freeze({
      entityId,
      nameOrigin:
        ownEntityBeforeResolution && entityId === candidateId
          ? "name"
          : "agent_supplied",
    });
  };

  const occurrenceByKey = new Map(
    occurrences.map((occurrence) => [
      occurrenceKey(occurrence.eventId, occurrence.draftIndex),
      occurrence,
    ]),
  );
  const kindContributions: KindContribution[] = [];
  const liveEvents = statementEventMap(preScan);
  const registrations = statementRegistrationMap(preScan);
  for (const event of preScan.events) {
    if (event.kind !== "statement") {
      continue;
    }
    if (!liveEvents.has(event.eventId) || !registrations.has(event.eventId)) {
      return reject("INVALID_ENTITY_STATE");
    }
    for (let draftIndex = 0; draftIndex < event.candidates.length; draftIndex += 1) {
      const occurrence = occurrenceByKey.get(
        occurrenceKey(event.eventId, draftIndex),
      );
      const candidate = event.candidates[draftIndex];
      if (occurrence === undefined || candidate === undefined) {
        return reject("INVALID_ENTITY_STATE");
      }
      const subject = resolveOccurrence(
        candidate.subjectId,
        occurrence.draft.subject,
      );
      const object =
        candidate.objectId === null || occurrence.draft.object === null
          ? null
          : resolveOccurrence(candidate.objectId, occurrence.draft.object);

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
    }
  }

  compressRedirects();
  const registry = createIdentifierRedirectRegistry({
    anchors,
    redirects: [...redirects.values()],
  });
  const finalCanonicalById = new Map(
    registry.anchors.map((anchor) => [anchor.id, anchor.id]),
  );
  for (const redirect of registry.redirects) {
    finalCanonicalById.set(redirect.oldId, redirect.newId);
  }
  const canonical = (identifier: string): string =>
    finalCanonicalById.get(identifier) ?? reject("INVALID_ENTITY_STATE");

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
    const entityId = canonical(contribution.entityId);
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

  for (const row of entities.values()) {
    const canonicalId = canonical(row.id);
    row.mergedInto = canonicalId === row.id ? null : canonicalId;
    row.kind = row.mergedInto === null ? (selectedKind.get(row.id) ?? null) : null;
  }

  const finalSurface = new Map<string, SurfaceFormProjectionRow>();
  for (const contribution of surfaceContributions.values()) {
    const entityId = canonical(contribution.entityId);
    const key = surfaceKey(contribution.surfaceNorm, entityId);
    const existing = finalSurface.get(key);
    finalSurface.set(
      key,
      Object.freeze({
        scopeKey,
        surfaceNorm: contribution.surfaceNorm,
        entityId,
        origin:
          existing === undefined
            ? contribution.origin
            : strongestSurfaceOrigin(existing.origin, contribution.origin),
      }),
    );
  }

  const finalOccurrences = occurrences
    .map((occurrence) =>
      Object.freeze({
        eventId: occurrence.eventId,
        draftIndex: occurrence.draftIndex,
        subjectId: canonical(occurrence.candidate.subjectId),
        objectId:
          occurrence.candidate.objectId === null
            ? null
            : canonical(occurrence.candidate.objectId),
      }),
    )
    .sort((left, right) => {
      const leftOccurrence = occurrenceByKey.get(
        occurrenceKey(left.eventId, left.draftIndex),
      );
      const rightOccurrence = occurrenceByKey.get(
        occurrenceKey(right.eventId, right.draftIndex),
      );
      if (leftOccurrence === undefined || rightOccurrence === undefined) {
        return 0;
      }
      return leftOccurrence.actualSeq !== rightOccurrence.actualSeq
        ? leftOccurrence.actualSeq - rightOccurrence.actualSeq
        : left.draftIndex - right.draftIndex;
    });

  const entityRows = [...entities.values()]
    .map(freezeEntityRow)
    .sort((left, right) => compareEntityIds(left.id, right.id));
  const surfaceRows = [...finalSurface.values()].sort((left, right) => {
    const surfaceOrder = compareText(left.surfaceNorm, right.surfaceNorm);
    return surfaceOrder !== 0
      ? surfaceOrder
      : compareEntityIds(left.entityId, right.entityId);
  });
  const sortedAnchors = [...registry.anchors].sort((left, right) =>
    compareEntityIds(left.id, right.id),
  );
  const sortedRedirects = [...registry.redirects].sort((left, right) =>
    compareEntityIds(left.oldId, right.oldId),
  );

  return Object.freeze({
    scopeKey,
    rulesVersion: preScan.rulesVersion,
    entityAnchors: Object.freeze(sortedAnchors),
    entities: Object.freeze(entityRows),
    surfaceForms: Object.freeze(surfaceRows),
    idRedirects: Object.freeze(sortedRedirects),
    occurrences: Object.freeze(finalOccurrences),
    kindMaintenance: Object.freeze(kindMaintenance),
  });
}
