import {
  ProjectionDecisionError,
  parseProjectionAliasBody,
  parseProjectionMergeBody,
  parseProjectionStoredDraft,
  projectionClaimIdentityKey,
  type ProjectionStoredDraft,
} from "./projection-decisions.js";
import { planProjectionDispatch } from "./projection-dispatch.js";
import { preScanProjectionEvents } from "./projection-event-pre-scan.js";
import {
  ProjectionIdentifierError,
  assertCanonicalIdentifier,
  compareOccurrenceIdentifiers,
  enumerateOccurrenceCandidates,
  isCanonicalIdentifier,
} from "./projection-identifiers.js";
import {
  ProjectionRuleError,
  normalizeV1,
  type CanonicalRelation,
} from "./projection-rules.js";
import {
  createProjectionReplayInput,
  runProjectionReplayReducer,
  type ClaimProjectionRow,
  type ClaimSupportProjectionRow,
  type EntityProjectionRow,
  type IdRedirectProjectionRow,
  type ProjectionReplayJournalEvent,
  type ProjectionSnapshot,
  type StatementProjectionRow,
  type SurfaceFormProjectionRow,
} from "./projection-replay.js";
import { resolveEffectiveStatementLifetime } from "./projection-validity.js";
import { strongestSurfaceOrigin } from "./projection-entities.js";

export type ProjectionIncrementalErrorCode =
  | "INVALID_INCREMENTAL_INPUT"
  | "INVALID_INCREMENTAL_STATE";

const ERROR_MESSAGES: Readonly<Record<ProjectionIncrementalErrorCode, string>> =
  Object.freeze({
    INVALID_INCREMENTAL_INPUT:
      "incremental projection requires a canonical safe journal suffix",
    INVALID_INCREMENTAL_STATE:
      "incremental projection state violates a replay invariant",
  });

export class ProjectionIncrementalError extends TypeError {
  public override readonly name: string = "ProjectionIncrementalError";
  public readonly code: ProjectionIncrementalErrorCode;

  public constructor(code: ProjectionIncrementalErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.code = code;
  }
}

function reject(code: ProjectionIncrementalErrorCode): never {
  throw new ProjectionIncrementalError(code);
}

function dataRecord(
  value: unknown,
  code: ProjectionIncrementalErrorCode,
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

function exactInput(value: unknown): Readonly<Record<string, unknown>> {
  const source = dataRecord(value, "INVALID_INCREMENTAL_INPUT");
  const expected = ["current", "events", "history", "rulesVersion", "scopeKey"].sort();
  const keys = Object.keys(source).sort();
  if (
    keys.length !== expected.length ||
    !keys.every((key, index) => key === expected[index])
  ) {
    return reject("INVALID_INCREMENTAL_INPUT");
  }
  return source;
}

function compareIds(left: string, right: string, kind: "entity" | "claim"): number {
  try {
    return compareOccurrenceIdentifiers(left, right, kind);
  } catch (error: unknown) {
    if (error instanceof ProjectionIdentifierError) {
      return reject("INVALID_INCREMENTAL_STATE");
    }
    throw error;
  }
}

function canonicalId(value: unknown, kind: "entity" | "claim"): string {
  try {
    return assertCanonicalIdentifier(value, kind);
  } catch (error: unknown) {
    if (error instanceof ProjectionIdentifierError) {
      return reject("INVALID_INCREMENTAL_STATE");
    }
    throw error;
  }
}

function eventEquals(
  left: ProjectionReplayJournalEvent,
  right: ProjectionReplayJournalEvent,
): boolean {
  return (
    left.seq === right.seq &&
    left.eventId === right.eventId &&
    left.scopeKey === right.scopeKey &&
    left.kind === right.kind &&
    left.bodyJson === right.bodyJson &&
    left.actor === right.actor &&
    left.branch === right.branch &&
    left.session === right.session &&
    left.createdAt === right.createdAt
  );
}

interface Activation {
  readonly orderSeq: number;
  readonly actualSeq: number;
  readonly draftIndex: number;
}

interface MutableEntity {
  readonly id: string;
  readonly scopeKey: string;
  readonly name: string;
  readonly normalName: string;
  kind: string | null;
  mergedInto: string | null;
  readonly originSeq: number;
}

interface MutableClaim {
  readonly id: string;
  readonly scopeKey: string;
  subjectId: string;
  readonly relation: CanonicalRelation;
  objectId: string | null;
  readonly objectValue: string | null;
  state: ClaimProjectionRow["state"];
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
  readonly expiresAt: number | null;
}

interface MutableRedirect {
  readonly oldId: string;
  newId: string;
  readonly kind: "entity" | "claim";
  readonly reason: IdRedirectProjectionRow["reason"];
}

interface AnchoredOccurrence {
  readonly event: ProjectionReplayJournalEvent;
  readonly draftIndex: number;
  readonly draft: ProjectionStoredDraft;
  readonly subjectCandidate: string;
  readonly objectCandidate: string | null;
  readonly claimCandidate: string;
}

interface MutableProjectionState {
  readonly scopeKey: string;
  readonly rulesVersion: string;
  readonly eventSeq: ReadonlyMap<string, number>;
  readonly eventById: ReadonlyMap<string, ProjectionReplayJournalEvent>;
  readonly statements: Map<string, StatementProjectionRow>;
  readonly entities: Map<string, MutableEntity>;
  readonly surfaces: Map<string, SurfaceFormProjectionRow>;
  readonly claims: Map<string, MutableClaim>;
  readonly supports: Map<string, MutableSupport>;
  readonly redirects: Map<string, MutableRedirect>;
  readonly occurrences: Map<string, AnchoredOccurrence>;
}

function surfaceKey(surfaceNorm: string, entityId: string): string {
  return JSON.stringify([surfaceNorm, entityId]);
}

function occurrenceKey(eventId: string, draftIndex: number): string {
  return JSON.stringify([eventId, draftIndex]);
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

function strongestClaimState(
  values: readonly ClaimProjectionRow["state"][],
): ClaimProjectionRow["state"] {
  return values.includes("active")
    ? "active"
    : values.includes("superseded")
      ? "superseded"
      : "retracted";
}

function initializeState(
  scopeKey: string,
  rulesVersion: string,
  current: ProjectionSnapshot,
  history: readonly ProjectionReplayJournalEvent[],
): MutableProjectionState {
  const eventSeq = new Map(history.map((event) => [event.eventId, event.seq]));
  const eventById = new Map(history.map((event) => [event.eventId, event]));
  if (eventSeq.size !== history.length) {
    return reject("INVALID_INCREMENTAL_INPUT");
  }
  const statements = new Map(
    current.statements.map((row) => [row.eventId, Object.freeze({ ...row })]),
  );
  const entities = new Map(
    current.entities.map((row) => [
      row.id,
      {
        id: row.id,
        scopeKey: row.scopeKey,
        name: row.name,
        normalName: row.normalName,
        kind: row.kind,
        mergedInto: row.mergedInto,
        originSeq: row.originSeq,
      },
    ]),
  );
  const surfaces = new Map(
    current.surfaceForms.map((row) => [
      surfaceKey(row.surfaceNorm, row.entityId),
      Object.freeze({ ...row }),
    ]),
  );
  const redirects = new Map(
    current.idRedirects.map((row) => [
      row.oldId,
      {
        oldId: row.oldId,
        newId: row.newId,
        kind: row.kind,
        reason: row.reason,
      },
    ]),
  );
  const supports = new Map(
    current.claimSupport.map((row) => [
      occurrenceKey(row.eventId, row.draftIndex),
      {
        claimId: row.claimId,
        eventId: row.eventId,
        draftIndex: row.draftIndex,
        live: row.live,
        expiresAt: row.expiresAt,
      },
    ]),
  );
  if (supports.size !== current.claimSupport.length) {
    return reject("INVALID_INCREMENTAL_STATE");
  }
  const claims = new Map<string, MutableClaim>();
  for (const row of current.claims) {
    const activations = [...supports.values()]
      .filter((support) => support.claimId === row.id && support.live === 1)
      .map((support): Activation | null => {
        const statement = statements.get(support.eventId);
        const actualSeq = eventSeq.get(support.eventId);
        return statement === undefined || actualSeq === undefined
          ? null
          : Object.freeze({
              orderSeq: statement.orderSeq,
              actualSeq,
              draftIndex: support.draftIndex,
            });
      });
    claims.set(row.id, {
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
      activation: maxActivation(activations),
    });
  }
  return {
    scopeKey,
    rulesVersion,
    eventSeq,
    eventById,
    statements,
    entities,
    surfaces,
    claims,
    supports,
    redirects,
    occurrences: new Map(),
  };
}

function resolveId(
  state: MutableProjectionState,
  value: string,
  kind: "entity" | "claim",
): string {
  let current = canonicalId(value, kind);
  const path: string[] = [];
  const seen = new Set<string>();
  while (state.redirects.has(current)) {
    if (seen.has(current) || path.length >= 32) {
      return reject("INVALID_INCREMENTAL_STATE");
    }
    seen.add(current);
    path.push(current);
    const redirect = state.redirects.get(current);
    if (redirect === undefined || redirect.kind !== kind) {
      return reject("INVALID_INCREMENTAL_STATE");
    }
    current = canonicalId(redirect.newId, kind);
  }
  const targetExists =
    kind === "entity" ? state.entities.has(current) : state.claims.has(current);
  if (!targetExists) {
    return reject("INVALID_INCREMENTAL_STATE");
  }
  for (const oldId of path) {
    const redirect = state.redirects.get(oldId);
    if (redirect === undefined) {
      return reject("INVALID_INCREMENTAL_STATE");
    }
    redirect.newId = current;
  }
  return current;
}

function isAnchor(
  state: MutableProjectionState,
  value: string,
  kind: "entity" | "claim",
): boolean {
  return kind === "entity"
    ? state.entities.has(value) ||
        (state.redirects.get(value)?.kind === "entity")
    : state.claims.has(value) || state.redirects.get(value)?.kind === "claim";
}

function setRedirect(
  state: MutableProjectionState,
  oldIdValue: string,
  newIdValue: string,
  kind: "entity" | "claim",
  reason: IdRedirectProjectionRow["reason"],
): void {
  const oldId = canonicalId(oldIdValue, kind);
  const newId = resolveId(state, newIdValue, kind);
  if (oldId === newId || state.redirects.has(oldId)) {
    return reject("INVALID_INCREMENTAL_STATE");
  }
  state.redirects.set(oldId, { oldId, newId, kind, reason });
}

function canonicalEntityByNormal(
  state: MutableProjectionState,
): Map<string, string> {
  const result = new Map<string, string>();
  for (const row of state.entities.values()) {
    const canonical = resolveId(state, row.id, "entity");
    if (canonical !== row.id) {
      continue;
    }
    if (result.has(row.normalName)) {
      return reject("INVALID_INCREMENTAL_STATE");
    }
    result.set(row.normalName, row.id);
  }
  return result;
}

function upsertSurface(
  state: MutableProjectionState,
  surfaceValue: string,
  entityIdValue: string,
  origin: SurfaceFormProjectionRow["origin"],
): void {
  let surfaceNorm: string;
  try {
    surfaceNorm = normalizeV1(surfaceValue);
  } catch (error: unknown) {
    if (error instanceof ProjectionRuleError) {
      return reject("INVALID_INCREMENTAL_STATE");
    }
    throw error;
  }
  const entityId = resolveId(state, entityIdValue, "entity");
  const key = surfaceKey(surfaceNorm, entityId);
  const existing = state.surfaces.get(key);
  state.surfaces.set(
    key,
    Object.freeze({
      scopeKey: state.scopeKey,
      surfaceNorm,
      entityId,
      origin:
        existing === undefined
          ? origin
          : strongestSurfaceOrigin(existing.origin, origin),
    }),
  );
}

function moveSurfaces(
  state: MutableProjectionState,
  oldId: string,
  newId: string,
): void {
  for (const [key, surface] of [...state.surfaces]) {
    if (surface.entityId !== oldId) {
      continue;
    }
    state.surfaces.delete(key);
    upsertSurface(state, surface.surfaceNorm, newId, surface.origin);
  }
}

function claimIdentityIndex(state: MutableProjectionState): Map<string, string> {
  const result = new Map<string, string>();
  for (const claim of state.claims.values()) {
    const canonical = resolveId(state, claim.id, "claim");
    if (canonical !== claim.id) {
      continue;
    }
    claim.subjectId = resolveId(state, claim.subjectId, "entity");
    claim.objectId =
      claim.objectId === null
        ? null
        : resolveId(state, claim.objectId, "entity");
    const identity = projectionClaimIdentityKey(
      state.scopeKey,
      claim.subjectId,
      claim.relation,
      claim.objectId,
      claim.objectValue,
    );
    if (result.has(identity)) {
      return reject("INVALID_INCREMENTAL_STATE");
    }
    result.set(identity, claim.id);
  }
  return result;
}

function supportActivation(
  state: MutableProjectionState,
  support: MutableSupport,
): Activation {
  const statement = state.statements.get(support.eventId);
  const actualSeq = state.eventSeq.get(support.eventId);
  if (statement === undefined || actualSeq === undefined) {
    return reject("INVALID_INCREMENTAL_STATE");
  }
  return Object.freeze({
    orderSeq: statement.orderSeq,
    actualSeq,
    draftIndex: support.draftIndex,
  });
}

function moveClaimSupports(
  state: MutableProjectionState,
  oldId: string,
  newId: string,
): void {
  for (const support of state.supports.values()) {
    if (support.claimId === oldId) {
      support.claimId = newId;
    }
  }
}

function redirectClaim(
  state: MutableProjectionState,
  oldIdValue: string,
  newIdValue: string,
  reason: "merge" | "deduplicated",
): void {
  const oldId = resolveId(state, oldIdValue, "claim");
  const newId = resolveId(state, newIdValue, "claim");
  if (oldId === newId) {
    return;
  }
  const oldRow = state.claims.get(oldId);
  if (oldRow === undefined || !state.claims.has(newId)) {
    return reject("INVALID_INCREMENTAL_STATE");
  }
  moveClaimSupports(state, oldId, newId);
  oldRow.state = "superseded";
  setRedirect(state, oldId, newId, "claim", reason);
  if (reason === "deduplicated") {
    state.claims.delete(oldId);
  }
}

function reconcileDescribes(state: MutableProjectionState): void {
  const groups = new Map<string, MutableClaim[]>();
  for (const claim of state.claims.values()) {
    if (
      resolveId(state, claim.id, "claim") !== claim.id ||
      claim.state !== "active" ||
      claim.relation !== "describes"
    ) {
      continue;
    }
    const group = groups.get(claim.subjectId) ?? [];
    group.push(claim);
    groups.set(claim.subjectId, group);
  }
  for (const rows of groups.values()) {
    let winner = rows[0] ?? reject("INVALID_INCREMENTAL_STATE");
    if (winner.activation === null) {
      return reject("INVALID_INCREMENTAL_STATE");
    }
    for (const row of rows.slice(1)) {
      const winnerActivation = winner.activation;
      if (row.activation === null || winnerActivation === null) {
        return reject("INVALID_INCREMENTAL_STATE");
      }
      if (compareActivation(row.activation, winnerActivation) > 0) {
        winner = row;
      }
    }
    for (const row of rows) {
      if (row.id !== winner.id) {
        row.state = "superseded";
      }
    }
  }
}

function dedupeClaimIdentities(
  state: MutableProjectionState,
  reason: "merge" | "deduplicated",
): void {
  const groups = new Map<string, string[]>();
  for (const claim of state.claims.values()) {
    if (resolveId(state, claim.id, "claim") !== claim.id) {
      continue;
    }
    claim.subjectId = resolveId(state, claim.subjectId, "entity");
    claim.objectId =
      claim.objectId === null
        ? null
        : resolveId(state, claim.objectId, "entity");
    const identity = projectionClaimIdentityKey(
      state.scopeKey,
      claim.subjectId,
      claim.relation,
      claim.objectId,
      claim.objectValue,
    );
    const group = groups.get(identity) ?? [];
    group.push(claim.id);
    groups.set(identity, group);
  }
  for (const ids of groups.values()) {
    if (ids.length < 2) {
      continue;
    }
    ids.sort((left, right) => compareIds(left, right, "claim"));
    const survivorId = ids[0] ?? reject("INVALID_INCREMENTAL_STATE");
    const rows = ids.map(
      (id) => state.claims.get(id) ?? reject("INVALID_INCREMENTAL_STATE"),
    );
    const stateValue = strongestClaimState(rows.map((row) => row.state));
    const activation = maxActivation(
      rows
        .filter((row) => row.state === stateValue)
        .map((row) => row.activation),
    );
    if (stateValue === "active" && activation === null) {
      return reject("INVALID_INCREMENTAL_STATE");
    }
    for (const losingId of ids.slice(1)) {
      redirectClaim(state, losingId, survivorId, reason);
    }
    const survivor =
      state.claims.get(survivorId) ?? reject("INVALID_INCREMENTAL_STATE");
    survivor.state = stateValue;
    survivor.activation = activation;
  }
  claimIdentityIndex(state);
  reconcileDescribes(state);
}

function statementRegistrations(
  state: MutableProjectionState,
  events: readonly ProjectionReplayJournalEvent[],
): readonly AnchoredOccurrence[] {
  const occurrences: AnchoredOccurrence[] = [];
  for (const event of events) {
    if (event.kind !== "statement") {
      continue;
    }
    const preScan = preScanProjectionEvents({
      scopeKey: state.scopeKey,
      rulesVersion: state.rulesVersion,
      events: [event],
    });
    const statement = preScan.statements[0];
    const registration = preScan.statementCandidates[0];
    if (
      statement === undefined ||
      registration === undefined ||
      statement.eventId !== event.eventId ||
      registration.eventId !== event.eventId ||
      statement.state !== "live" ||
      registration.parsed.length !== registration.candidates.length
    ) {
      return reject("INVALID_INCREMENTAL_INPUT");
    }
    const lifetime = resolveEffectiveStatementLifetime({
      createdAt: statement.createdAt,
      provenance: statement.provenance,
      ttl: statement.ttl,
    });
    if (state.statements.has(event.eventId)) {
      return reject("INVALID_INCREMENTAL_STATE");
    }
    state.statements.set(
      event.eventId,
      Object.freeze({
        eventId: event.eventId,
        scopeKey: state.scopeKey,
        state: "live",
        orderSeq: statement.orderSeq,
        createdAt: statement.createdAt,
        provenance: statement.provenance,
        expiresAt: lifetime.expiresAt,
      }),
    );
    for (let draftIndex = 0; draftIndex < registration.parsed.length; draftIndex += 1) {
      const candidate = registration.candidates[draftIndex];
      if (candidate === undefined) {
        return reject("INVALID_INCREMENTAL_STATE");
      }
      let draft: ProjectionStoredDraft;
      try {
        draft = parseProjectionStoredDraft(registration.parsed[draftIndex]);
      } catch (error: unknown) {
        if (error instanceof ProjectionDecisionError) {
          return reject("INVALID_INCREMENTAL_INPUT");
        }
        throw error;
      }
      occurrences.push(
        Object.freeze({
          event,
          draftIndex,
          draft,
          subjectCandidate: candidate.subjectId,
          objectCandidate: candidate.objectId,
          claimCandidate: candidate.claimId,
        }),
      );
    }
  }
  return Object.freeze(occurrences);
}

function preAnchorOccurrences(
  state: MutableProjectionState,
  occurrences: readonly AnchoredOccurrence[],
): void {
  const byNormal = canonicalEntityByNormal(state);
  const anchorEntity = (
    candidateId: string,
    name: string,
    normalName: string,
    actualSeq: number,
  ): void => {
    if (isAnchor(state, candidateId, "entity")) {
      return reject("INVALID_INCREMENTAL_STATE");
    }
    const existing = byNormal.get(normalName);
    if (existing !== undefined) {
      setRedirect(state, candidateId, existing, "entity", "deduplicated");
      return;
    }
    state.entities.set(candidateId, {
      id: candidateId,
      scopeKey: state.scopeKey,
      name,
      normalName,
      kind: null,
      mergedInto: null,
      originSeq: actualSeq,
    });
    byNormal.set(normalName, candidateId);
  };

  for (const occurrence of occurrences) {
    anchorEntity(
      occurrence.subjectCandidate,
      occurrence.draft.subject,
      occurrence.draft.subjectNormal,
      occurrence.event.seq,
    );
    if (
      occurrence.objectCandidate !== null &&
      occurrence.draft.object !== null &&
      occurrence.draft.objectNormal !== null
    ) {
      anchorEntity(
        occurrence.objectCandidate,
        occurrence.draft.object,
        occurrence.draft.objectNormal,
        occurrence.event.seq,
      );
    }
  }

  let identities = claimIdentityIndex(state);
  const statementIdentities = new Map<string, Set<string>>();
  for (const occurrence of occurrences) {
    if (isAnchor(state, occurrence.claimCandidate, "claim")) {
      return reject("INVALID_INCREMENTAL_STATE");
    }
    const subjectId = resolveId(state, occurrence.subjectCandidate, "entity");
    const objectId =
      occurrence.objectCandidate === null
        ? null
        : resolveId(state, occurrence.objectCandidate, "entity");
    const identity = projectionClaimIdentityKey(
      state.scopeKey,
      subjectId,
      occurrence.draft.relation,
      objectId,
      occurrence.draft.objectValue,
    );
    const seen = statementIdentities.get(occurrence.event.eventId) ?? new Set<string>();
    if (seen.has(identity)) {
      return reject("INVALID_INCREMENTAL_STATE");
    }
    seen.add(identity);
    statementIdentities.set(occurrence.event.eventId, seen);
    const existing = identities.get(identity);
    let claimId: string;
    if (existing !== undefined) {
      setRedirect(
        state,
        occurrence.claimCandidate,
        existing,
        "claim",
        "deduplicated",
      );
      claimId = existing;
    } else {
      const statement = state.statements.get(occurrence.event.eventId);
      if (statement === undefined) {
        return reject("INVALID_INCREMENTAL_STATE");
      }
      state.claims.set(occurrence.claimCandidate, {
        id: occurrence.claimCandidate,
        scopeKey: state.scopeKey,
        subjectId,
        relation: occurrence.draft.relation,
        objectId,
        objectValue: occurrence.draft.objectValue,
        state: "retracted",
        originSeq: occurrence.event.seq,
        firstSeenAt: statement.createdAt,
        lastSeenAt: statement.createdAt,
        activation: null,
      });
      identities = claimIdentityIndex(state);
      claimId = occurrence.claimCandidate;
    }
    const statement = state.statements.get(occurrence.event.eventId);
    if (statement === undefined) {
      return reject("INVALID_INCREMENTAL_STATE");
    }
    const key = occurrenceKey(occurrence.event.eventId, occurrence.draftIndex);
    if (state.supports.has(key) || state.occurrences.has(key)) {
      return reject("INVALID_INCREMENTAL_STATE");
    }
    state.supports.set(key, {
      claimId,
      eventId: occurrence.event.eventId,
      draftIndex: occurrence.draftIndex,
      live: 0,
      expiresAt: statement.expiresAt,
    });
    state.occurrences.set(key, occurrence);
  }
}

function surfaceCandidates(
  state: MutableProjectionState,
  surfaceNorm: string,
): readonly string[] {
  const result = new Set<string>();
  for (const surface of state.surfaces.values()) {
    if (surface.surfaceNorm === surfaceNorm) {
      result.add(resolveId(state, surface.entityId, "entity"));
    }
  }
  return Object.freeze(
    [...result].sort((left, right) => compareIds(left, right, "entity")),
  );
}

function resolveOccurrenceEntity(
  state: MutableProjectionState,
  candidateId: string,
  normalName: string,
): string {
  const current = resolveId(state, candidateId, "entity");
  const mapped = surfaceCandidates(state, normalName);
  let chosen: string;
  if (mapped.length === 1) {
    chosen = mapped[0] ?? reject("INVALID_INCREMENTAL_STATE");
  } else if (mapped.length > 1) {
    const exact = mapped.filter(
      (id) => state.entities.get(id)?.normalName === normalName,
    );
    if (exact.length !== 1) {
      return reject("INVALID_INCREMENTAL_STATE");
    }
    chosen = exact[0] ?? reject("INVALID_INCREMENTAL_STATE");
  } else {
    chosen =
      canonicalEntityByNormal(state).get(normalName) ??
      reject("INVALID_INCREMENTAL_STATE");
  }
  if (chosen !== current) {
    const row = state.entities.get(current);
    setRedirect(state, current, chosen, "entity", "deduplicated");
    if (row !== undefined) {
      row.mergedInto = chosen;
      row.kind = null;
    }
    moveSurfaces(state, current, chosen);
    dedupeClaimIdentities(state, "deduplicated");
  }
  return resolveId(state, chosen, "entity");
}

function applyStatement(
  state: MutableProjectionState,
  event: ProjectionReplayJournalEvent,
): void {
  const statement =
    state.statements.get(event.eventId) ?? reject("INVALID_INCREMENTAL_STATE");
  const seen = new Set<string>();
  for (const [key, occurrence] of state.occurrences) {
    if (occurrence.event.eventId !== event.eventId) {
      continue;
    }
    const subjectId = resolveOccurrenceEntity(
      state,
      occurrence.subjectCandidate,
      occurrence.draft.subjectNormal,
    );
    const objectId =
      occurrence.objectCandidate === null || occurrence.draft.objectNormal === null
        ? null
        : resolveOccurrenceEntity(
            state,
            occurrence.objectCandidate,
            occurrence.draft.objectNormal,
          );
    const subjectOwnsName =
      subjectId === occurrence.subjectCandidate &&
      state.entities.get(subjectId)?.originSeq === event.seq;
    upsertSurface(
      state,
      occurrence.draft.subject,
      subjectId,
      subjectOwnsName ? "name" : "agent_supplied",
    );
    for (const alias of occurrence.draft.subjectAliases) {
      upsertSurface(state, alias, subjectId, "agent_supplied");
    }
    if (objectId !== null && occurrence.draft.object !== null) {
      const objectOwnsName =
        objectId === occurrence.objectCandidate &&
        state.entities.get(objectId)?.originSeq === event.seq;
      upsertSurface(
        state,
        occurrence.draft.object,
        objectId,
        objectOwnsName ? "name" : "agent_supplied",
      );
      for (const alias of occurrence.draft.objectAliases) {
        upsertSurface(state, alias, objectId, "agent_supplied");
      }
    }
    const subject =
      state.entities.get(subjectId) ?? reject("INVALID_INCREMENTAL_STATE");
    if (subject.kind === null && occurrence.draft.subjectKind !== null) {
      subject.kind = occurrence.draft.subjectKind;
    }
    if (objectId !== null && occurrence.draft.objectKind !== null) {
      const object =
        state.entities.get(objectId) ?? reject("INVALID_INCREMENTAL_STATE");
      if (object.kind === null) {
        object.kind = occurrence.draft.objectKind;
      }
    }

    const identity = projectionClaimIdentityKey(
      state.scopeKey,
      subjectId,
      occurrence.draft.relation,
      objectId,
      occurrence.draft.objectValue,
    );
    if (seen.has(identity)) {
      return reject("INVALID_INCREMENTAL_STATE");
    }
    seen.add(identity);
    let target = claimIdentityIndex(state).get(identity);
    let candidate = resolveId(state, occurrence.claimCandidate, "claim");
    if (target === undefined) {
      const row =
        state.claims.get(candidate) ?? reject("INVALID_INCREMENTAL_STATE");
      row.subjectId = subjectId;
      row.objectId = objectId;
      target = claimIdentityIndex(state).get(identity);
      if (target === undefined) {
        return reject("INVALID_INCREMENTAL_STATE");
      }
    } else if (candidate !== target) {
      const row =
        state.claims.get(candidate) ?? reject("INVALID_INCREMENTAL_STATE");
      row.subjectId = subjectId;
      row.objectId = objectId;
      dedupeClaimIdentities(state, "deduplicated");
      target =
        claimIdentityIndex(state).get(identity) ??
        reject("INVALID_INCREMENTAL_STATE");
      candidate = resolveId(state, occurrence.claimCandidate, "claim");
      if (candidate !== target) {
        return reject("INVALID_INCREMENTAL_STATE");
      }
    }
    const claim = state.claims.get(target) ?? reject("INVALID_INCREMENTAL_STATE");
    if (claim.relation === "describes") {
      for (const previous of state.claims.values()) {
        if (
          previous.id !== claim.id &&
          resolveId(state, previous.id, "claim") === previous.id &&
          previous.subjectId === claim.subjectId &&
          previous.relation === "describes" &&
          previous.state === "active"
        ) {
          previous.state = "superseded";
        }
      }
    }
    claim.state = "active";
    claim.activation = Object.freeze({
      orderSeq: statement.orderSeq,
      actualSeq: event.seq,
      draftIndex: occurrence.draftIndex,
    });
    const support = state.supports.get(key) ?? reject("INVALID_INCREMENTAL_STATE");
    support.claimId = claim.id;
    support.live = 1;
  }
}

function parseClaimRetraction(bodyJson: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyJson) as unknown;
  } catch {
    return reject("INVALID_INCREMENTAL_INPUT");
  }
  const body = dataRecord(parsed, "INVALID_INCREMENTAL_INPUT");
  const keys = Object.keys(body);
  if (
    !Object.hasOwn(body, "target") ||
    keys.some((key) => key !== "target" && key !== "note") ||
    (Object.hasOwn(body, "note") && typeof body["note"] !== "string")
  ) {
    return reject("INVALID_INCREMENTAL_INPUT");
  }
  const target = dataRecord(body["target"], "INVALID_INCREMENTAL_INPUT");
  if (
    Object.keys(target).length !== 1 ||
    !Object.hasOwn(target, "claim_id") ||
    !isCanonicalIdentifier(target["claim_id"], "claim")
  ) {
    return reject("INVALID_INCREMENTAL_INPUT");
  }
  return target["claim_id"] as string;
}

function applyClaimRetraction(
  state: MutableProjectionState,
  event: ProjectionReplayJournalEvent,
): void {
  const target = parseClaimRetraction(event.bodyJson);
  try {
    if (compareOccurrenceIdentifiers(target, `c${event.seq}.0`, "claim") >= 0) {
      return reject("INVALID_INCREMENTAL_STATE");
    }
  } catch (error: unknown) {
    if (error instanceof ProjectionIdentifierError) {
      return reject("INVALID_INCREMENTAL_STATE");
    }
    throw error;
  }
  if (!isAnchor(state, target, "claim")) {
    return reject("INVALID_INCREMENTAL_STATE");
  }
  const claimId = resolveId(state, target, "claim");
  const claim = state.claims.get(claimId);
  if (claim === undefined) {
    return reject("INVALID_INCREMENTAL_STATE");
  }
  for (const support of state.supports.values()) {
    if (support.claimId !== claimId) {
      continue;
    }
    const statement = state.statements.get(support.eventId);
    if (statement === undefined) {
      return reject("INVALID_INCREMENTAL_STATE");
    }
    if (statement.orderSeq < event.seq) {
      support.live = 0;
    }
  }
  claim.state = "retracted";
}

function applyAlias(
  state: MutableProjectionState,
  event: ProjectionReplayJournalEvent,
): void {
  let body;
  try {
    body = parseProjectionAliasBody(event.bodyJson);
  } catch (error: unknown) {
    if (error instanceof ProjectionDecisionError) {
      return reject("INVALID_INCREMENTAL_INPUT");
    }
    throw error;
  }
  if (!isAnchor(state, body.entityId, "entity")) {
    return reject("INVALID_INCREMENTAL_STATE");
  }
  try {
    if (
      compareOccurrenceIdentifiers(body.entityId, `e${event.seq}.0`, "entity") >= 0
    ) {
      return reject("INVALID_INCREMENTAL_STATE");
    }
  } catch (error: unknown) {
    if (error instanceof ProjectionIdentifierError) {
      return reject("INVALID_INCREMENTAL_STATE");
    }
    throw error;
  }
  upsertSurface(
    state,
    body.surface,
    resolveId(state, body.entityId, "entity"),
    "confirmed",
  );
}

function deduplicateSupports(state: MutableProjectionState): void {
  const groups = new Map<string, Array<[string, MutableSupport]>>();
  for (const entry of state.supports) {
    const support = entry[1];
    support.claimId = resolveId(state, support.claimId, "claim");
    const groupKey = JSON.stringify([support.claimId, support.eventId]);
    const group = groups.get(groupKey) ?? [];
    group.push(entry);
    groups.set(groupKey, group);
  }
  for (const group of groups.values()) {
    if (group.length < 2) {
      continue;
    }
    group.sort((left, right) => left[1].draftIndex - right[1].draftIndex);
    const survivor = group[0]?.[1] ?? reject("INVALID_INCREMENTAL_STATE");
    survivor.live = group.some((entry) => entry[1].live === 1) ? 1 : 0;
    for (const [key] of group.slice(1)) {
      state.supports.delete(key);
    }
  }
}

function applyMerge(
  state: MutableProjectionState,
  event: ProjectionReplayJournalEvent,
): void {
  let body;
  try {
    body = parseProjectionMergeBody(event.bodyJson);
  } catch (error: unknown) {
    if (error instanceof ProjectionDecisionError) {
      return reject("INVALID_INCREMENTAL_INPUT");
    }
    throw error;
  }
  if (
    !isAnchor(state, body.keep, "entity") ||
    !isAnchor(state, body.absorb, "entity")
  ) {
    return reject("INVALID_INCREMENTAL_STATE");
  }
  for (const target of [body.keep, body.absorb]) {
    try {
      if (compareOccurrenceIdentifiers(target, `e${event.seq}.0`, "entity") >= 0) {
        return reject("INVALID_INCREMENTAL_STATE");
      }
    } catch (error: unknown) {
      if (error instanceof ProjectionIdentifierError) {
        return reject("INVALID_INCREMENTAL_STATE");
      }
      throw error;
    }
  }
  const keep = resolveId(state, body.keep, "entity");
  const absorb = resolveId(state, body.absorb, "entity");
  if (keep === absorb) {
    return reject("INVALID_INCREMENTAL_STATE");
  }
  const absorbed =
    state.entities.get(absorb) ?? reject("INVALID_INCREMENTAL_STATE");
  setRedirect(state, absorb, keep, "entity", "merge");
  absorbed.mergedInto = keep;
  absorbed.kind = null;
  moveSurfaces(state, absorb, keep);
  for (const claim of state.claims.values()) {
    if (resolveId(state, claim.id, "claim") !== claim.id) {
      continue;
    }
    claim.subjectId = resolveId(state, claim.subjectId, "entity");
    claim.objectId =
      claim.objectId === null
        ? null
        : resolveId(state, claim.objectId, "entity");
  }
  dedupeClaimIdentities(state, "merge");
  deduplicateSupports(state);
  reconcileDescribes(state);
}

function recomputeClaims(state: MutableProjectionState): void {
  deduplicateSupports(state);
  for (const claim of state.claims.values()) {
    claim.subjectId = resolveId(state, claim.subjectId, "entity");
    claim.objectId =
      claim.objectId === null
        ? null
        : resolveId(state, claim.objectId, "entity");
    if (resolveId(state, claim.id, "claim") !== claim.id) {
      claim.state = "superseded";
      continue;
    }
    const live = [...state.supports.values()].filter(
      (support) => support.claimId === claim.id && support.live === 1,
    );
    if (claim.state === "active" && live.length === 0) {
      claim.state = "retracted";
    }
    if (live.length > 0) {
      claim.firstSeenAt = Math.min(
        ...live.map(
          (support) =>
            state.statements.get(support.eventId)?.createdAt ??
            reject("INVALID_INCREMENTAL_STATE"),
        ),
      );
      claim.lastSeenAt = Math.max(
        ...live.map(
          (support) =>
            state.statements.get(support.eventId)?.createdAt ??
            reject("INVALID_INCREMENTAL_STATE"),
        ),
      );
      claim.activation = maxActivation(live.map((support) => supportActivation(state, support)));
    }
  }
  reconcileDescribes(state);
}

function recomputeKinds(state: MutableProjectionState): void {
  interface Contribution {
    readonly entityId: string;
    readonly kind: string;
    readonly orderSeq: number;
    readonly actualSeq: number;
    readonly draftIndex: number;
    readonly position: 0 | 1;
  }
  const contributions: Contribution[] = [];
  for (const statement of state.statements.values()) {
    if (statement.state !== "live") {
      continue;
    }
    const event = state.eventById.get(statement.eventId);
    if (event === undefined || event.kind !== "statement") {
      return reject("INVALID_INCREMENTAL_STATE");
    }
    let body: unknown;
    try {
      body = JSON.parse(event.bodyJson) as unknown;
    } catch {
      return reject("INVALID_INCREMENTAL_STATE");
    }
    const bodyRecord = dataRecord(body, "INVALID_INCREMENTAL_STATE");
    const parsed = bodyRecord["parsed"];
    if (!Array.isArray(parsed)) {
      return reject("INVALID_INCREMENTAL_STATE");
    }
    let candidates;
    try {
      candidates = enumerateOccurrenceCandidates({ seq: event.seq, parsed });
    } catch (error: unknown) {
      if (error instanceof ProjectionIdentifierError) {
        return reject("INVALID_INCREMENTAL_STATE");
      }
      throw error;
    }
    for (let draftIndex = 0; draftIndex < parsed.length; draftIndex += 1) {
      const candidate = candidates[draftIndex];
      if (candidate === undefined) {
        return reject("INVALID_INCREMENTAL_STATE");
      }
      let draft: ProjectionStoredDraft;
      try {
        draft = parseProjectionStoredDraft(parsed[draftIndex]);
      } catch (error: unknown) {
        if (error instanceof ProjectionDecisionError) {
          return reject("INVALID_INCREMENTAL_STATE");
        }
        throw error;
      }
      if (draft.subjectKind !== null) {
        contributions.push({
          entityId: resolveId(state, candidate.subjectId, "entity"),
          kind: draft.subjectKind,
          orderSeq: statement.orderSeq,
          actualSeq: event.seq,
          draftIndex,
          position: 0,
        });
      }
      if (candidate.objectId !== null && draft.objectKind !== null) {
        contributions.push({
          entityId: resolveId(state, candidate.objectId, "entity"),
          kind: draft.objectKind,
          orderSeq: statement.orderSeq,
          actualSeq: event.seq,
          draftIndex,
          position: 1,
        });
      }
    }
  }
  contributions.sort((left, right) =>
    left.orderSeq !== right.orderSeq
      ? left.orderSeq - right.orderSeq
      : left.actualSeq !== right.actualSeq
        ? left.actualSeq - right.actualSeq
        : left.draftIndex !== right.draftIndex
          ? left.draftIndex - right.draftIndex
          : left.position - right.position,
  );
  const selected = new Map<string, string>();
  for (const contribution of contributions) {
    if (!selected.has(contribution.entityId)) {
      selected.set(contribution.entityId, contribution.kind);
    }
  }
  for (const entity of state.entities.values()) {
    const canonical = resolveId(state, entity.id, "entity");
    entity.mergedInto = canonical === entity.id ? null : canonical;
    entity.kind = canonical === entity.id ? (selected.get(canonical) ?? null) : null;
  }
}

function freezeSnapshot(state: MutableProjectionState): ProjectionSnapshot {
  const statements = [...state.statements.values()].sort((left, right) => {
    const leftSeq = state.eventSeq.get(left.eventId) ?? 0;
    const rightSeq = state.eventSeq.get(right.eventId) ?? 0;
    return leftSeq !== rightSeq
      ? leftSeq - rightSeq
      : left.eventId < right.eventId
        ? -1
        : left.eventId === right.eventId
          ? 0
          : 1;
  });
  const entities: EntityProjectionRow[] = [...state.entities.values()]
    .sort((left, right) => compareIds(left.id, right.id, "entity"))
    .map((row) =>
      Object.freeze({
        id: row.id,
        scopeKey: row.scopeKey,
        name: row.name,
        normalName: row.normalName,
        kind: row.kind,
        mergedInto: row.mergedInto,
        originSeq: row.originSeq,
      }),
    );
  const surfaces = [...state.surfaces.values()].sort((left, right) =>
    left.surfaceNorm !== right.surfaceNorm
      ? left.surfaceNorm < right.surfaceNorm
        ? -1
        : 1
      : compareIds(left.entityId, right.entityId, "entity"),
  );
  const claims: ClaimProjectionRow[] = [...state.claims.values()]
    .sort((left, right) => compareIds(left.id, right.id, "claim"))
    .map((row) =>
      Object.freeze({
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
      }),
    );
  const supports: ClaimSupportProjectionRow[] = [...state.supports.values()]
    .sort((left, right) => {
      const claimOrder = compareIds(left.claimId, right.claimId, "claim");
      if (claimOrder !== 0) {
        return claimOrder;
      }
      const leftSeq = state.eventSeq.get(left.eventId) ?? 0;
      const rightSeq = state.eventSeq.get(right.eventId) ?? 0;
      return leftSeq !== rightSeq
        ? leftSeq - rightSeq
        : left.draftIndex - right.draftIndex;
    })
    .map((row) => Object.freeze({ ...row }));
  for (const redirect of state.redirects.values()) {
    redirect.newId = resolveId(state, redirect.newId, redirect.kind);
    if (redirect.kind === "entity") {
      const entity = state.entities.get(redirect.oldId);
      if (entity !== undefined) {
        entity.mergedInto = redirect.newId;
      }
    }
  }
  const redirects: IdRedirectProjectionRow[] = [...state.redirects.values()]
    .sort((left, right) => {
      if (left.kind !== right.kind) {
        return left.kind === "claim" ? -1 : 1;
      }
      return compareIds(left.oldId, right.oldId, left.kind);
    })
    .map((row) => Object.freeze({ ...row }));
  return runProjectionReplayReducer(
    {
      scopeKey: state.scopeKey,
      rulesVersion: state.rulesVersion,
      events: [...state.eventById.values()].sort((left, right) => left.seq - right.seq),
    },
    () =>
      Object.freeze({
        statements: Object.freeze(statements),
        entities: Object.freeze(entities),
        surfaceForms: Object.freeze(surfaces),
        claims: Object.freeze(claims),
        claimSupport: Object.freeze(supports),
        idRedirects: Object.freeze(redirects),
      }),
  );
}

export function reduceIncrementalProjection(value: unknown): ProjectionSnapshot {
  const input = exactInput(value);
  const scopeKey = input["scopeKey"];
  const rulesVersion = input["rulesVersion"];
  if (typeof scopeKey !== "string" || typeof rulesVersion !== "string") {
    return reject("INVALID_INCREMENTAL_INPUT");
  }
  let suffix;
  let history;
  let current;
  try {
    suffix = createProjectionReplayInput({
      scopeKey,
      rulesVersion,
      events: input["events"],
    }).events;
    history = createProjectionReplayInput({
      scopeKey,
      rulesVersion,
      events: input["history"],
    }).events;
    current = runProjectionReplayReducer(
      {
        scopeKey,
        rulesVersion,
        events: history.slice(0, history.length - suffix.length),
      },
      () => input["current"],
    );
  } catch {
    return reject("INVALID_INCREMENTAL_INPUT");
  }
  if (
    suffix.length === 0 ||
    suffix.length > history.length ||
    !suffix.every((event, index) =>
      eventEquals(event, history[history.length - suffix.length + index] as ProjectionReplayJournalEvent),
    )
  ) {
    return reject("INVALID_INCREMENTAL_INPUT");
  }
  let plan;
  try {
    plan = planProjectionDispatch(suffix);
  } catch {
    return reject("INVALID_INCREMENTAL_INPUT");
  }
  if (plan.mode !== "incremental") {
    return reject("INVALID_INCREMENTAL_INPUT");
  }

  const state = initializeState(scopeKey, rulesVersion, current, history);
  const occurrences = statementRegistrations(state, suffix);
  preAnchorOccurrences(state, occurrences);
  let merged = false;
  for (const event of suffix) {
    if (event.kind === "statement") {
      applyStatement(state, event);
    } else if (event.kind === "retraction") {
      applyClaimRetraction(state, event);
    } else if (event.kind === "alias") {
      applyAlias(state, event);
    } else if (event.kind === "merge") {
      applyMerge(state, event);
      merged = true;
    } else {
      return reject("INVALID_INCREMENTAL_INPUT");
    }
  }
  recomputeClaims(state);
  if (merged) {
    recomputeKinds(state);
  }
  return freezeSnapshot(state);
}
