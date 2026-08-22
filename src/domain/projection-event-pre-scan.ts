import {
  createProjectionReplayInput,
  type ProjectionReplayInput,
  type ProjectionReplayJournalEvent,
} from "./projection-replay.js";
import {
  ProjectionIdentifierError,
  enumerateOccurrenceCandidates,
  isCanonicalIdentifier,
  type OccurrenceCandidates,
} from "./projection-identifiers.js";

type StatementState = "live" | "retracted" | "superseded";
type StatementProvenance = "user_stated" | "observed" | "inferred";
type StatementTtl = "session" | "weeks" | "permanent";

export type ProjectionPreScanErrorCode =
  | "INVALID_EVENT_BODY"
  | "DUPLICATE_EVENT_ID"
  | "EVENT_TARGET_NOT_FOUND"
  | "EVENT_TARGET_NOT_PAST"
  | "EVENT_TARGET_KIND_MISMATCH"
  | "SUPERSEDES_TARGET_NOT_FOUND"
  | "SUPERSEDES_TARGET_NOT_PAST"
  | "SUPERSEDES_TARGET_KIND_MISMATCH"
  | "SUPERSEDES_TARGET_NOT_LIVE"
  | "SUPERSEDES_CYCLE"
  | "MULTIPLE_LIVE_LEAVES"
  | "SUPERSEDES_CONTENT_MISMATCH";

const ERROR_MESSAGES: Readonly<Record<ProjectionPreScanErrorCode, string>> =
  Object.freeze({
    INVALID_EVENT_BODY:
      "projection pre-scan requires a canonical stored event body",
    DUPLICATE_EVENT_ID: "projection pre-scan found a duplicate event anchor",
    EVENT_TARGET_NOT_FOUND:
      "event retraction target is absent from the trusted scope journal",
    EVENT_TARGET_NOT_PAST:
      "event retraction target must precede the retraction event",
    EVENT_TARGET_KIND_MISMATCH:
      "event retraction target is not a statement, merge, or alias event",
    SUPERSEDES_TARGET_NOT_FOUND:
      "supersedes target is absent from the trusted scope journal",
    SUPERSEDES_TARGET_NOT_PAST:
      "supersedes target must precede the successor statement",
    SUPERSEDES_TARGET_KIND_MISMATCH:
      "supersedes target is not a statement event",
    SUPERSEDES_TARGET_NOT_LIVE:
      "supersedes target is not live at the successor position",
    SUPERSEDES_CYCLE: "supersedes graph contains a cycle",
    MULTIPLE_LIVE_LEAVES:
      "supersedes graph would contain multiple live leaves",
    SUPERSEDES_CONTENT_MISMATCH:
      "successor statement changed inherited source metadata",
  });

export class ProjectionPreScanError extends TypeError {
  public override readonly name: string = "ProjectionPreScanError";
  public readonly code: ProjectionPreScanErrorCode;

  public constructor(code: ProjectionPreScanErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.code = code;
  }
}

function reject(code: ProjectionPreScanErrorCode): never {
  throw new ProjectionPreScanError(code);
}

interface ParsedStatementBody {
  readonly rawText: string;
  readonly parsed: readonly unknown[];
  readonly provenance: StatementProvenance;
  readonly ttl: StatementTtl;
  readonly supersedes: string | null;
  readonly candidates: readonly OccurrenceCandidates[];
}

interface ParsedClaimRetraction {
  readonly kind: "claim";
  readonly claimId: string;
}

interface ParsedEventRetraction {
  readonly kind: "event";
  readonly eventId: string;
  readonly cascade: boolean | undefined;
}

type ParsedRetraction = ParsedClaimRetraction | ParsedEventRetraction;

export interface PreScannedStatement {
  readonly eventId: string;
  readonly actualSeq: number;
  readonly rootEventId: string;
  readonly supersedes: string | null;
  readonly state: StatementState;
  readonly orderSeq: number;
  readonly recordedAt: number;
  readonly createdAt: number;
  readonly provenance: StatementProvenance;
  readonly ttl: StatementTtl;
}

export interface StatementCandidateRegistration {
  readonly eventId: string;
  readonly actualSeq: number;
  readonly candidates: readonly OccurrenceCandidates[];
}

export interface EffectiveStatementEvent {
  readonly kind: "statement";
  readonly eventId: string;
  readonly actualSeq: number;
  readonly orderSeq: number;
  readonly rootEventId: string;
  readonly recordedAt: number;
  readonly createdAt: number;
  readonly provenance: StatementProvenance;
  readonly ttl: StatementTtl;
  readonly parsed: readonly unknown[];
  readonly candidates: readonly OccurrenceCandidates[];
}

export interface EffectiveClaimRetractionEvent {
  readonly kind: "retraction";
  readonly eventId: string;
  readonly actualSeq: number;
  readonly orderSeq: number;
  readonly target: Readonly<{
    kind: "claim";
    claimId: string;
  }>;
}

export interface EffectiveEventRetractionEvent {
  readonly kind: "retraction";
  readonly eventId: string;
  readonly actualSeq: number;
  readonly orderSeq: number;
  readonly target: Readonly<{
    kind: "event";
    eventId: string;
    cascade: boolean;
    affectedEventIds: readonly string[];
  }>;
}

export interface EffectiveDecisionEvent {
  readonly kind: "merge" | "alias";
  readonly eventId: string;
  readonly actualSeq: number;
  readonly orderSeq: number;
  readonly bodyJson: string;
}

export type EffectiveProjectionEvent =
  | EffectiveStatementEvent
  | EffectiveClaimRetractionEvent
  | EffectiveEventRetractionEvent
  | EffectiveDecisionEvent;

export interface ProjectionPreScanResult {
  readonly scopeKey: string;
  readonly rulesVersion: string;
  readonly statements: readonly PreScannedStatement[];
  readonly statementCandidates: readonly StatementCandidateRegistration[];
  readonly events: readonly EffectiveProjectionEvent[];
}

function isDataRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactJsonRecord(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): Readonly<Record<string, unknown>> {
  if (!isDataRecord(value)) {
    return reject("INVALID_EVENT_BODY");
  }
  const keys = Object.keys(value);
  const required = new Set(requiredKeys);
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  if (
    requiredKeys.some((key) => !Object.hasOwn(value, key)) ||
    keys.some((key) => !allowed.has(key)) ||
    keys.length < required.size
  ) {
    return reject("INVALID_EVENT_BODY");
  }
  return value;
}

function parseJsonObject(bodyJson: string): Readonly<Record<string, unknown>> {
  let value: unknown;
  try {
    value = JSON.parse(bodyJson) as unknown;
  } catch {
    return reject("INVALID_EVENT_BODY");
  }
  if (!isDataRecord(value)) {
    return reject("INVALID_EVENT_BODY");
  }
  return value;
}

function deepFreezeJson(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      deepFreezeJson(item);
    }
    return Object.freeze(value);
  }
  if (!isDataRecord(value)) {
    return reject("INVALID_EVENT_BODY");
  }
  for (const item of Object.values(value)) {
    deepFreezeJson(item);
  }
  return Object.freeze(value);
}

function parseStatementBody(
  event: ProjectionReplayJournalEvent,
): ParsedStatementBody {
  const source = parseJsonObject(event.bodyJson);
  const hasSupersedes = Object.hasOwn(source, "supersedes");
  const body = exactJsonRecord(
    source,
    ["parsed", "provenance", "raw_text", "ttl"],
    ["supersedes"],
  );
  const rawText = body["raw_text"];
  const parsedValue = body["parsed"];
  const provenance = body["provenance"];
  const ttl = body["ttl"];
  if (
    typeof rawText !== "string" ||
    rawText.trim().length === 0 ||
    !Array.isArray(parsedValue) ||
    parsedValue.length > 100 ||
    (provenance !== "user_stated" &&
      provenance !== "observed" &&
      provenance !== "inferred") ||
    (ttl !== "session" && ttl !== "weeks" && ttl !== "permanent")
  ) {
    return reject("INVALID_EVENT_BODY");
  }
  let supersedes: string | null = null;
  if (hasSupersedes) {
    const value = body["supersedes"];
    if (!isCanonicalIdentifier(value, "event")) {
      return reject("INVALID_EVENT_BODY");
    }
    supersedes = value;
  }
  let candidates: readonly OccurrenceCandidates[];
  try {
    candidates = enumerateOccurrenceCandidates({
      seq: event.seq,
      parsed: parsedValue,
    });
  } catch (error: unknown) {
    if (error instanceof ProjectionIdentifierError) {
      return reject("INVALID_EVENT_BODY");
    }
    throw error;
  }
  const parsed = deepFreezeJson(parsedValue) as readonly unknown[];
  return Object.freeze({
    rawText,
    parsed,
    provenance,
    ttl,
    supersedes,
    candidates,
  });
}

function optionalNote(body: Readonly<Record<string, unknown>>): void {
  if (Object.hasOwn(body, "note") && typeof body["note"] !== "string") {
    reject("INVALID_EVENT_BODY");
  }
}

function parseRetractionBody(
  event: ProjectionReplayJournalEvent,
): ParsedRetraction {
  const body = exactJsonRecord(
    parseJsonObject(event.bodyJson),
    ["target"],
    ["note"],
  );
  optionalNote(body);
  const target = body["target"];
  if (!isDataRecord(target)) {
    return reject("INVALID_EVENT_BODY");
  }
  if (Object.hasOwn(target, "claim_id")) {
    const claimTarget = exactJsonRecord(target, ["claim_id"]);
    const claimId = claimTarget["claim_id"];
    if (!isCanonicalIdentifier(claimId, "claim")) {
      return reject("INVALID_EVENT_BODY");
    }
    return Object.freeze({ kind: "claim", claimId });
  }
  const eventTarget = exactJsonRecord(target, ["event_id"], ["cascade"]);
  const eventId = eventTarget["event_id"];
  if (!isCanonicalIdentifier(eventId, "event")) {
    return reject("INVALID_EVENT_BODY");
  }
  const cascade = eventTarget["cascade"];
  if (cascade !== undefined && typeof cascade !== "boolean") {
    return reject("INVALID_EVENT_BODY");
  }
  return Object.freeze({ kind: "event", eventId, cascade });
}

function detectSupersedesCycle(
  statements: ReadonlyMap<string, ParsedStatementBody>,
): void {
  const state = new Map<string, "visiting" | "visited">();
  for (const startEventId of statements.keys()) {
    if (state.get(startEventId) === "visited") {
      continue;
    }
    const path: string[] = [];
    let eventId = startEventId;
    while (true) {
      const current = state.get(eventId);
      if (current === "visiting") {
        return reject("SUPERSEDES_CYCLE");
      }
      if (current === "visited") {
        break;
      }
      state.set(eventId, "visiting");
      path.push(eventId);
      const parent = statements.get(eventId)?.supersedes;
      if (parent === null || parent === undefined || !statements.has(parent)) {
        break;
      }
      eventId = parent;
    }
    for (const pathEventId of path) {
      state.set(pathEventId, "visited");
    }
  }
}

function hasLiveChild(
  eventId: string,
  children: ReadonlyMap<string, readonly string[]>,
  retracted: ReadonlySet<string>,
): boolean {
  return (children.get(eventId) ?? []).some(
    (child) => !retracted.has(child),
  );
}

function buildRootRegistry(
  events: readonly ProjectionReplayJournalEvent[],
  parentById: ReadonlyMap<string, string>,
): ReadonlyMap<string, string> {
  const rootById = new Map<string, string>();
  for (const event of events) {
    if (event.kind !== "statement") {
      continue;
    }
    const parentId = parentById.get(event.eventId);
    if (parentId === undefined) {
      rootById.set(event.eventId, event.eventId);
      continue;
    }
    const rootId = rootById.get(parentId);
    if (rootId === undefined) {
      return reject("SUPERSEDES_TARGET_NOT_PAST");
    }
    rootById.set(event.eventId, rootId);
  }
  return rootById;
}

function requiredRoot(
  eventId: string,
  rootById: ReadonlyMap<string, string>,
): string {
  return rootById.get(eventId) ?? reject("SUPERSEDES_TARGET_NOT_FOUND");
}

function sortedStatementComponent(
  eventId: string,
  rootById: ReadonlyMap<string, string>,
  children: ReadonlyMap<string, readonly string[]>,
  eventById: ReadonlyMap<string, ProjectionReplayJournalEvent>,
): readonly string[] {
  const root = requiredRoot(eventId, rootById);
  const result: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop() ?? reject("SUPERSEDES_TARGET_NOT_FOUND");
    result.push(current);
    const currentChildren = children.get(current) ?? [];
    for (let index = currentChildren.length - 1; index >= 0; index -= 1) {
      const child = currentChildren[index];
      if (child === undefined) {
        return reject("SUPERSEDES_TARGET_NOT_FOUND");
      }
      pending.push(child);
    }
  }
  result.sort((left, right) => {
    const leftSeq = eventById.get(left)?.seq ?? 0;
    const rightSeq = eventById.get(right)?.seq ?? 0;
    return leftSeq - rightSeq;
  });
  return Object.freeze(result);
}

function freezeStatement(
  value: PreScannedStatement,
): PreScannedStatement {
  return Object.freeze(value);
}

function compareEffectiveEvents(
  left: EffectiveProjectionEvent,
  right: EffectiveProjectionEvent,
): number {
  if (left.orderSeq !== right.orderSeq) {
    return left.orderSeq - right.orderSeq;
  }
  if (left.actualSeq !== right.actualSeq) {
    return left.actualSeq - right.actualSeq;
  }
  return left.eventId < right.eventId ? -1 : left.eventId === right.eventId ? 0 : 1;
}

export function preScanProjectionEvents(value: unknown): ProjectionPreScanResult {
  const input: ProjectionReplayInput = createProjectionReplayInput(value);
  const eventById = new Map<string, ProjectionReplayJournalEvent>();
  const statementBodyById = new Map<string, ParsedStatementBody>();
  const retractionById = new Map<string, ParsedRetraction>();

  for (const event of input.events) {
    if (eventById.has(event.eventId)) {
      return reject("DUPLICATE_EVENT_ID");
    }
    eventById.set(event.eventId, event);
    if (event.kind === "statement") {
      statementBodyById.set(event.eventId, parseStatementBody(event));
    } else if (event.kind === "retraction") {
      retractionById.set(event.eventId, parseRetractionBody(event));
    }
  }

  detectSupersedesCycle(statementBodyById);

  const parentById = new Map<string, string>();
  for (const event of input.events) {
    if (event.kind !== "statement") {
      continue;
    }
    const statement = statementBodyById.get(event.eventId);
    if (statement === undefined) {
      return reject("INVALID_EVENT_BODY");
    }
    const parentId = statement.supersedes;
    if (parentId === null) {
      continue;
    }
    const targetEvent = eventById.get(parentId);
    if (targetEvent === undefined) {
      return reject("SUPERSEDES_TARGET_NOT_FOUND");
    }
    if (targetEvent.kind !== "statement") {
      return reject("SUPERSEDES_TARGET_KIND_MISMATCH");
    }
    if (targetEvent.seq >= event.seq) {
      return reject("SUPERSEDES_TARGET_NOT_PAST");
    }
    parentById.set(event.eventId, parentId);
  }
  const rootById = buildRootRegistry(input.events, parentById);

  for (const event of input.events) {
    if (event.kind !== "statement") {
      continue;
    }
    const statement = statementBodyById.get(event.eventId);
    if (statement === undefined || statement.supersedes === null) {
      continue;
    }
    const rootId = requiredRoot(event.eventId, rootById);
    const root = statementBodyById.get(rootId);
    if (
      root === undefined ||
      statement.rawText !== root.rawText ||
      statement.provenance !== root.provenance ||
      statement.ttl !== root.ttl
    ) {
      return reject("SUPERSEDES_CONTENT_MISMATCH");
    }
  }

  const processedChildren = new Map<string, string[]>();
  const retractedStatementIds = new Set<string>();
  const retractedDecisionIds = new Set<string>();
  const normalizedRetractions = new Map<
    string,
    EffectiveClaimRetractionEvent | EffectiveEventRetractionEvent
  >();

  for (const event of input.events) {
    if (event.kind === "statement") {
      const statement = statementBodyById.get(event.eventId);
      if (statement === undefined) {
        return reject("INVALID_EVENT_BODY");
      }
      if (statement.supersedes !== null) {
        if (retractedStatementIds.has(statement.supersedes)) {
          return reject("SUPERSEDES_TARGET_NOT_LIVE");
        }
        if (
          hasLiveChild(
            statement.supersedes,
            processedChildren,
            retractedStatementIds,
          )
        ) {
          return reject("MULTIPLE_LIVE_LEAVES");
        }
        const children = processedChildren.get(statement.supersedes) ?? [];
        children.push(event.eventId);
        processedChildren.set(statement.supersedes, children);
      }
      continue;
    }

    if (event.kind !== "retraction") {
      continue;
    }
    const retraction = retractionById.get(event.eventId);
    if (retraction === undefined) {
      return reject("INVALID_EVENT_BODY");
    }
    if (retraction.kind === "claim") {
      normalizedRetractions.set(
        event.eventId,
        Object.freeze({
          kind: "retraction",
          eventId: event.eventId,
          actualSeq: event.seq,
          orderSeq: event.seq,
          target: Object.freeze({
            kind: "claim",
            claimId: retraction.claimId,
          }),
        }),
      );
      continue;
    }

    const targetEvent = eventById.get(retraction.eventId);
    if (targetEvent === undefined) {
      return reject("EVENT_TARGET_NOT_FOUND");
    }
    if (targetEvent.seq >= event.seq) {
      return reject("EVENT_TARGET_NOT_PAST");
    }
    if (targetEvent.kind === "retraction") {
      return reject("EVENT_TARGET_KIND_MISMATCH");
    }
    let affectedEventIds: readonly string[];
    let cascade: boolean;
    if (targetEvent.kind === "statement") {
      if (typeof retraction.cascade !== "boolean") {
        return reject("INVALID_EVENT_BODY");
      }
      cascade = retraction.cascade;
      affectedEventIds = cascade
        ? sortedStatementComponent(
            targetEvent.eventId,
            rootById,
            processedChildren,
            eventById,
          )
        : Object.freeze([targetEvent.eventId]);
      if (
        !cascade &&
        !retractedStatementIds.has(targetEvent.eventId) &&
        hasLiveChild(
          targetEvent.eventId,
          processedChildren,
          retractedStatementIds,
        )
      ) {
        const parentId = parentById.get(targetEvent.eventId);
        if (parentId !== undefined && !retractedStatementIds.has(parentId)) {
          return reject("MULTIPLE_LIVE_LEAVES");
        }
      }
      for (const affectedId of affectedEventIds) {
        retractedStatementIds.add(affectedId);
      }
    } else {
      if (retraction.cascade !== undefined) {
        return reject("INVALID_EVENT_BODY");
      }
      cascade = false;
      affectedEventIds = Object.freeze([targetEvent.eventId]);
      retractedDecisionIds.add(targetEvent.eventId);
    }
    normalizedRetractions.set(
      event.eventId,
      Object.freeze({
        kind: "retraction",
        eventId: event.eventId,
        actualSeq: event.seq,
        orderSeq: event.seq,
        target: Object.freeze({
          kind: "event",
          eventId: targetEvent.eventId,
          cascade,
          affectedEventIds,
        }),
      }),
    );
  }

  const liveLeavesByRoot = new Map<string, string[]>();
  const statementStates = new Map<string, StatementState>();
  for (const event of input.events) {
    if (event.kind !== "statement") {
      continue;
    }
    const state: StatementState = retractedStatementIds.has(event.eventId)
      ? "retracted"
      : hasLiveChild(
            event.eventId,
            processedChildren,
            retractedStatementIds,
          )
        ? "superseded"
        : "live";
    statementStates.set(event.eventId, state);
    if (state === "live") {
      const root = requiredRoot(event.eventId, rootById);
      const leaves = liveLeavesByRoot.get(root) ?? [];
      leaves.push(event.eventId);
      liveLeavesByRoot.set(root, leaves);
    }
  }
  if ([...liveLeavesByRoot.values()].some((leaves) => leaves.length > 1)) {
    return reject("MULTIPLE_LIVE_LEAVES");
  }

  const statements: PreScannedStatement[] = [];
  const statementCandidates: StatementCandidateRegistration[] = [];
  for (const event of input.events) {
    if (event.kind !== "statement") {
      continue;
    }
    const body = statementBodyById.get(event.eventId);
    const state = statementStates.get(event.eventId);
    if (body === undefined || state === undefined) {
      return reject("INVALID_EVENT_BODY");
    }
    const rootId = requiredRoot(event.eventId, rootById);
    const rootEvent = eventById.get(rootId);
    const rootBody = statementBodyById.get(rootId);
    if (rootEvent === undefined || rootBody === undefined) {
      return reject("SUPERSEDES_TARGET_NOT_FOUND");
    }
    statements.push(
      freezeStatement({
        eventId: event.eventId,
        actualSeq: event.seq,
        rootEventId: rootId,
        supersedes: body.supersedes,
        state,
        orderSeq: rootEvent.seq,
        recordedAt: event.createdAt,
        createdAt: rootEvent.createdAt,
        provenance: rootBody.provenance,
        ttl: rootBody.ttl,
      }),
    );
    statementCandidates.push(
      Object.freeze({
        eventId: event.eventId,
        actualSeq: event.seq,
        candidates: body.candidates,
      }),
    );
  }

  const effectiveEvents: EffectiveProjectionEvent[] = [];
  for (const event of input.events) {
    if (event.kind === "statement") {
      if (statementStates.get(event.eventId) !== "live") {
        continue;
      }
      const body = statementBodyById.get(event.eventId);
      const rootId = requiredRoot(event.eventId, rootById);
      const rootEvent = eventById.get(rootId);
      const rootBody = statementBodyById.get(rootId);
      if (body === undefined || rootEvent === undefined || rootBody === undefined) {
        return reject("INVALID_EVENT_BODY");
      }
      effectiveEvents.push(
        Object.freeze({
          kind: "statement",
          eventId: event.eventId,
          actualSeq: event.seq,
          orderSeq: rootEvent.seq,
          rootEventId: rootId,
          recordedAt: event.createdAt,
          createdAt: rootEvent.createdAt,
          provenance: rootBody.provenance,
          ttl: rootBody.ttl,
          parsed: body.parsed,
          candidates: body.candidates,
        }),
      );
      continue;
    }
    if (event.kind === "retraction") {
      const normalized = normalizedRetractions.get(event.eventId);
      if (normalized === undefined) {
        return reject("INVALID_EVENT_BODY");
      }
      effectiveEvents.push(normalized);
      continue;
    }
    if (!retractedDecisionIds.has(event.eventId)) {
      effectiveEvents.push(
        Object.freeze({
          kind: event.kind,
          eventId: event.eventId,
          actualSeq: event.seq,
          orderSeq: event.seq,
          bodyJson: event.bodyJson,
        }),
      );
    }
  }
  effectiveEvents.sort(compareEffectiveEvents);

  return Object.freeze({
    scopeKey: input.scopeKey,
    rulesVersion: input.rulesVersion,
    statements: Object.freeze(statements),
    statementCandidates: Object.freeze(statementCandidates),
    events: Object.freeze(effectiveEvents),
  });
}
