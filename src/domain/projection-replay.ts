const EVENT_ID_PATTERN = /^ev_[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
const SCOPE_KEY_PATTERN = /^u:[A-Za-z0-9._-]{1,64}\/p:[A-Za-z0-9._-]{1,64}$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
const EVENT_KINDS: ReadonlySet<string> = new Set([
  "statement",
  "retraction",
  "merge",
  "alias",
]);
const STATEMENT_STATES: ReadonlySet<string> = new Set([
  "live",
  "retracted",
  "superseded",
]);
const PROVENANCE_VALUES: ReadonlySet<string> = new Set([
  "user_stated",
  "observed",
  "inferred",
]);
const SURFACE_ORIGINS: ReadonlySet<string> = new Set([
  "name",
  "agent_supplied",
  "confirmed",
]);
const RELATIONS: ReadonlySet<string> = new Set([
  "uses",
  "rejects",
  "contains",
  "describes",
  "relates_to",
]);
const CLAIM_STATES: ReadonlySet<string> = new Set([
  "active",
  "superseded",
  "retracted",
]);
const REDIRECT_KINDS: ReadonlySet<string> = new Set(["entity", "claim"]);
const REDIRECT_REASONS: ReadonlySet<string> = new Set([
  "merge",
  "rule_change",
  "deduplicated",
]);

export type ProjectionJournalEventKind =
  | "statement"
  | "retraction"
  | "merge"
  | "alias";

export interface ProjectionReplayJournalEvent {
  readonly seq: number;
  readonly eventId: string;
  readonly scopeKey: string;
  readonly kind: ProjectionJournalEventKind;
  readonly bodyJson: string;
  readonly actor: string | null;
  readonly branch: string | null;
  readonly session: string | null;
  readonly createdAt: number;
}

export interface ProjectionReplayInput {
  readonly scopeKey: string;
  readonly rulesVersion: string;
  readonly events: readonly ProjectionReplayJournalEvent[];
}

export interface StatementProjectionRow {
  readonly eventId: string;
  readonly scopeKey: string;
  readonly state: "live" | "retracted" | "superseded";
  readonly orderSeq: number;
  readonly createdAt: number;
  readonly provenance: "user_stated" | "observed" | "inferred";
  readonly expiresAt: number | null;
}

export interface EntityProjectionRow {
  readonly id: string;
  readonly scopeKey: string;
  readonly name: string;
  readonly normalName: string;
  readonly kind: string | null;
  readonly mergedInto: string | null;
  readonly originSeq: number;
}

export interface SurfaceFormProjectionRow {
  readonly scopeKey: string;
  readonly surfaceNorm: string;
  readonly entityId: string;
  readonly origin: "name" | "agent_supplied" | "confirmed";
}

export interface ClaimProjectionRow {
  readonly id: string;
  readonly scopeKey: string;
  readonly subjectId: string;
  readonly relation:
    | "uses"
    | "rejects"
    | "contains"
    | "describes"
    | "relates_to";
  readonly objectId: string | null;
  readonly objectValue: string | null;
  readonly state: "active" | "superseded" | "retracted";
  readonly originSeq: number;
  readonly firstSeenAt: number;
  readonly lastSeenAt: number;
}

export interface ClaimSupportProjectionRow {
  readonly claimId: string;
  readonly eventId: string;
  readonly draftIndex: number;
  readonly live: 0 | 1;
  readonly expiresAt: number | null;
}

export interface IdRedirectProjectionRow {
  readonly oldId: string;
  readonly newId: string;
  readonly kind: "entity" | "claim";
  readonly reason: "merge" | "rule_change" | "deduplicated";
}

export interface ProjectionSnapshot {
  readonly statements: readonly StatementProjectionRow[];
  readonly entities: readonly EntityProjectionRow[];
  readonly surfaceForms: readonly SurfaceFormProjectionRow[];
  readonly claims: readonly ClaimProjectionRow[];
  readonly claimSupport: readonly ClaimSupportProjectionRow[];
  readonly idRedirects: readonly IdRedirectProjectionRow[];
}

export type ProjectionReplayReducer = (
  input: ProjectionReplayInput,
) => unknown;

export type ProjectionReplayContractErrorCode =
  | "INVALID_REPLAY_INPUT"
  | "INVALID_EVENT_ORDER"
  | "INVALID_RULES_VERSION"
  | "SCOPE_MISMATCH"
  | "INVALID_REDUCER"
  | "INVALID_PROJECTION_SNAPSHOT";

const CONTRACT_ERROR_MESSAGES: Readonly<
  Record<ProjectionReplayContractErrorCode, string>
> = Object.freeze({
  INVALID_REPLAY_INPUT:
    "projection replay requires validated scope-bound journal input",
  INVALID_EVENT_ORDER:
    "projection replay journal events must be strictly ordered by seq",
  INVALID_RULES_VERSION:
    "projection replay requires a canonical rules version",
  SCOPE_MISMATCH:
    "projection replay input and output must stay inside one scope",
  INVALID_REDUCER: "projection replay requires one pure reducer",
  INVALID_PROJECTION_SNAPSHOT:
    "projection reducer returned an invalid or cross-scope snapshot",
});

export class ProjectionReplayContractError extends TypeError {
  public override readonly name: string = "ProjectionReplayContractError";
  public readonly code: ProjectionReplayContractErrorCode;

  public constructor(code: ProjectionReplayContractErrorCode) {
    super(CONTRACT_ERROR_MESSAGES[code]);
    this.code = code;
  }
}

function reject(code: ProjectionReplayContractErrorCode): never {
  throw new ProjectionReplayContractError(code);
}

function exactDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
  code: ProjectionReplayContractErrorCode,
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return reject(code);
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return reject(code);
  }
  const keys = Reflect.ownKeys(value);
  const sortedExpectedKeys = expectedKeys.slice().sort();
  if (
    keys.some((key) => typeof key !== "string") ||
    keys.length !== expectedKeys.length ||
    !(keys as string[])
      .slice()
      .sort()
      .every((key, index) => key === sortedExpectedKeys[index])
  ) {
    return reject(code);
  }
  const result: Record<string, unknown> = {};
  for (const key of keys as string[]) {
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

function canonicalScope(value: unknown): string {
  if (typeof value !== "string" || !SCOPE_KEY_PATTERN.test(value)) {
    return reject("INVALID_REPLAY_INPUT");
  }
  return value;
}

function canonicalRulesVersion(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 128 ||
    value.trim() !== value ||
    CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    return reject("INVALID_RULES_VERSION");
  }
  return value;
}

function positiveInteger(
  value: unknown,
  code: ProjectionReplayContractErrorCode,
): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    return reject(code);
  }
  return Number(value);
}

function nonNegativeInteger(
  value: unknown,
  code: ProjectionReplayContractErrorCode,
): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    return reject(code);
  }
  return Number(value);
}

function nonEmptyString(
  value: unknown,
  code: ProjectionReplayContractErrorCode,
): string {
  if (typeof value !== "string" || value.length === 0) {
    return reject(code);
  }
  return value;
}

function nullableString(
  value: unknown,
  code: ProjectionReplayContractErrorCode,
): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string" || CONTROL_CHARACTER_PATTERN.test(value)) {
    return reject(code);
  }
  return value;
}

function nullableNonNegativeInteger(
  value: unknown,
  code: ProjectionReplayContractErrorCode,
): number | null {
  return value === null ? null : nonNegativeInteger(value, code);
}

function jsonObjectText(value: unknown): string {
  if (typeof value !== "string") {
    return reject("INVALID_REPLAY_INPUT");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return reject("INVALID_REPLAY_INPUT");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return reject("INVALID_REPLAY_INPUT");
  }
  return value;
}

function snapshotEvent(value: unknown): ProjectionReplayJournalEvent {
  const row = exactDataRecord(
    value,
    [
      "actor",
      "bodyJson",
      "branch",
      "createdAt",
      "eventId",
      "kind",
      "scopeKey",
      "seq",
      "session",
    ],
    "INVALID_REPLAY_INPUT",
  );
  const eventId = row["eventId"];
  const kind = row["kind"];
  if (
    typeof eventId !== "string" ||
    !EVENT_ID_PATTERN.test(eventId) ||
    typeof kind !== "string" ||
    !EVENT_KINDS.has(kind)
  ) {
    return reject("INVALID_REPLAY_INPUT");
  }
  return Object.freeze({
    seq: positiveInteger(row["seq"], "INVALID_REPLAY_INPUT"),
    eventId,
    scopeKey: canonicalScope(row["scopeKey"]),
    kind: kind as ProjectionJournalEventKind,
    bodyJson: jsonObjectText(row["bodyJson"]),
    actor: nullableString(row["actor"], "INVALID_REPLAY_INPUT"),
    branch: nullableString(row["branch"], "INVALID_REPLAY_INPUT"),
    session: nullableString(row["session"], "INVALID_REPLAY_INPUT"),
    createdAt: nonNegativeInteger(row["createdAt"], "INVALID_REPLAY_INPUT"),
  });
}

export function createProjectionReplayInput(
  value: unknown,
): ProjectionReplayInput {
  const input = exactDataRecord(
    value,
    ["events", "rulesVersion", "scopeKey"],
    "INVALID_REPLAY_INPUT",
  );
  const scopeKey = canonicalScope(input["scopeKey"]);
  const rulesVersion = canonicalRulesVersion(input["rulesVersion"]);
  if (!Array.isArray(input["events"])) {
    return reject("INVALID_REPLAY_INPUT");
  }
  const events = input["events"].map((event) => snapshotEvent(event));
  let previousSeq = 0;
  for (const event of events) {
    if (event.scopeKey !== scopeKey) {
      return reject("SCOPE_MISMATCH");
    }
    if (event.seq <= previousSeq) {
      return reject("INVALID_EVENT_ORDER");
    }
    previousSeq = event.seq;
  }
  return Object.freeze({
    scopeKey,
    rulesVersion,
    events: Object.freeze(events),
  });
}

function enumString<Value extends string>(
  value: unknown,
  values: ReadonlySet<string>,
): Value {
  if (typeof value !== "string" || !values.has(value)) {
    return reject("INVALID_PROJECTION_SNAPSHOT");
  }
  return value as Value;
}

function statementRow(value: unknown, scopeKey: string): StatementProjectionRow {
  const row = exactDataRecord(
    value,
    [
      "createdAt",
      "eventId",
      "expiresAt",
      "orderSeq",
      "provenance",
      "scopeKey",
      "state",
    ],
    "INVALID_PROJECTION_SNAPSHOT",
  );
  if (row["scopeKey"] !== scopeKey) {
    return reject("SCOPE_MISMATCH");
  }
  return Object.freeze({
    eventId: nonEmptyString(row["eventId"], "INVALID_PROJECTION_SNAPSHOT"),
    scopeKey,
    state: enumString<StatementProjectionRow["state"]>(
      row["state"],
      STATEMENT_STATES,
    ),
    orderSeq: positiveInteger(row["orderSeq"], "INVALID_PROJECTION_SNAPSHOT"),
    createdAt: nonNegativeInteger(
      row["createdAt"],
      "INVALID_PROJECTION_SNAPSHOT",
    ),
    provenance: enumString<StatementProjectionRow["provenance"]>(
      row["provenance"],
      PROVENANCE_VALUES,
    ),
    expiresAt: nullableNonNegativeInteger(
      row["expiresAt"],
      "INVALID_PROJECTION_SNAPSHOT",
    ),
  });
}

function entityRow(value: unknown, scopeKey: string): EntityProjectionRow {
  const row = exactDataRecord(
    value,
    ["id", "kind", "mergedInto", "name", "normalName", "originSeq", "scopeKey"],
    "INVALID_PROJECTION_SNAPSHOT",
  );
  if (row["scopeKey"] !== scopeKey) {
    return reject("SCOPE_MISMATCH");
  }
  return Object.freeze({
    id: nonEmptyString(row["id"], "INVALID_PROJECTION_SNAPSHOT"),
    scopeKey,
    name: nonEmptyString(row["name"], "INVALID_PROJECTION_SNAPSHOT"),
    normalName: nonEmptyString(
      row["normalName"],
      "INVALID_PROJECTION_SNAPSHOT",
    ),
    kind: nullableString(row["kind"], "INVALID_PROJECTION_SNAPSHOT"),
    mergedInto: nullableString(
      row["mergedInto"],
      "INVALID_PROJECTION_SNAPSHOT",
    ),
    originSeq: positiveInteger(
      row["originSeq"],
      "INVALID_PROJECTION_SNAPSHOT",
    ),
  });
}

function surfaceRow(
  value: unknown,
  scopeKey: string,
): SurfaceFormProjectionRow {
  const row = exactDataRecord(
    value,
    ["entityId", "origin", "scopeKey", "surfaceNorm"],
    "INVALID_PROJECTION_SNAPSHOT",
  );
  if (row["scopeKey"] !== scopeKey) {
    return reject("SCOPE_MISMATCH");
  }
  return Object.freeze({
    scopeKey,
    surfaceNorm: nonEmptyString(
      row["surfaceNorm"],
      "INVALID_PROJECTION_SNAPSHOT",
    ),
    entityId: nonEmptyString(
      row["entityId"],
      "INVALID_PROJECTION_SNAPSHOT",
    ),
    origin: enumString<SurfaceFormProjectionRow["origin"]>(
      row["origin"],
      SURFACE_ORIGINS,
    ),
  });
}

function claimRow(value: unknown, scopeKey: string): ClaimProjectionRow {
  const row = exactDataRecord(
    value,
    [
      "firstSeenAt",
      "id",
      "lastSeenAt",
      "objectId",
      "objectValue",
      "originSeq",
      "relation",
      "scopeKey",
      "state",
      "subjectId",
    ],
    "INVALID_PROJECTION_SNAPSHOT",
  );
  if (row["scopeKey"] !== scopeKey) {
    return reject("SCOPE_MISMATCH");
  }
  const objectId = nullableString(
    row["objectId"],
    "INVALID_PROJECTION_SNAPSHOT",
  );
  const objectValue = nullableString(
    row["objectValue"],
    "INVALID_PROJECTION_SNAPSHOT",
  );
  if ((objectId === null) === (objectValue === null)) {
    return reject("INVALID_PROJECTION_SNAPSHOT");
  }
  return Object.freeze({
    id: nonEmptyString(row["id"], "INVALID_PROJECTION_SNAPSHOT"),
    scopeKey,
    subjectId: nonEmptyString(
      row["subjectId"],
      "INVALID_PROJECTION_SNAPSHOT",
    ),
    relation: enumString<ClaimProjectionRow["relation"]>(
      row["relation"],
      RELATIONS,
    ),
    objectId,
    objectValue,
    state: enumString<ClaimProjectionRow["state"]>(
      row["state"],
      CLAIM_STATES,
    ),
    originSeq: positiveInteger(
      row["originSeq"],
      "INVALID_PROJECTION_SNAPSHOT",
    ),
    firstSeenAt: nonNegativeInteger(
      row["firstSeenAt"],
      "INVALID_PROJECTION_SNAPSHOT",
    ),
    lastSeenAt: nonNegativeInteger(
      row["lastSeenAt"],
      "INVALID_PROJECTION_SNAPSHOT",
    ),
  });
}

function supportRow(value: unknown): ClaimSupportProjectionRow {
  const row = exactDataRecord(
    value,
    ["claimId", "draftIndex", "eventId", "expiresAt", "live"],
    "INVALID_PROJECTION_SNAPSHOT",
  );
  const live = row["live"];
  if (live !== 0 && live !== 1) {
    return reject("INVALID_PROJECTION_SNAPSHOT");
  }
  return Object.freeze({
    claimId: nonEmptyString(row["claimId"], "INVALID_PROJECTION_SNAPSHOT"),
    eventId: nonEmptyString(row["eventId"], "INVALID_PROJECTION_SNAPSHOT"),
    draftIndex: nonNegativeInteger(
      row["draftIndex"],
      "INVALID_PROJECTION_SNAPSHOT",
    ),
    live,
    expiresAt: nullableNonNegativeInteger(
      row["expiresAt"],
      "INVALID_PROJECTION_SNAPSHOT",
    ),
  });
}

function redirectRow(value: unknown): IdRedirectProjectionRow {
  const row = exactDataRecord(
    value,
    ["kind", "newId", "oldId", "reason"],
    "INVALID_PROJECTION_SNAPSHOT",
  );
  const oldId = nonEmptyString(row["oldId"], "INVALID_PROJECTION_SNAPSHOT");
  const newId = nonEmptyString(row["newId"], "INVALID_PROJECTION_SNAPSHOT");
  if (oldId === newId) {
    return reject("INVALID_PROJECTION_SNAPSHOT");
  }
  return Object.freeze({
    oldId,
    newId,
    kind: enumString<IdRedirectProjectionRow["kind"]>(
      row["kind"],
      REDIRECT_KINDS,
    ),
    reason: enumString<IdRedirectProjectionRow["reason"]>(
      row["reason"],
      REDIRECT_REASONS,
    ),
  });
}

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function validateSnapshotReferences(
  snapshot: ProjectionSnapshot,
  input: ProjectionReplayInput,
): void {
  const statementEvents = new Set(
    input.events
      .filter((event) => event.kind === "statement")
      .map((event) => event.eventId),
  );
  const statementIds = new Set(snapshot.statements.map((row) => row.eventId));
  const entityIds = new Set(snapshot.entities.map((row) => row.id));
  const claimIds = new Set(snapshot.claims.map((row) => row.id));

  if (
    !unique(snapshot.statements.map((row) => row.eventId)) ||
    !unique(snapshot.entities.map((row) => row.id)) ||
    !unique(
      snapshot.surfaceForms.map(
        (row) => `${row.scopeKey}\u0000${row.surfaceNorm}\u0000${row.entityId}`,
      ),
    ) ||
    !unique(snapshot.claims.map((row) => row.id)) ||
    !unique(
      snapshot.claimSupport.map((row) => `${row.claimId}\u0000${row.eventId}`),
    ) ||
    !unique(
      snapshot.claimSupport.map((row) => `${row.eventId}\u0000${row.draftIndex}`),
    ) ||
    !unique(snapshot.idRedirects.map((row) => row.oldId))
  ) {
    reject("INVALID_PROJECTION_SNAPSHOT");
  }

  for (const row of snapshot.statements) {
    if (!statementEvents.has(row.eventId)) {
      reject("INVALID_PROJECTION_SNAPSHOT");
    }
  }
  for (const row of snapshot.entities) {
    if (row.mergedInto !== null && !entityIds.has(row.mergedInto)) {
      reject("INVALID_PROJECTION_SNAPSHOT");
    }
  }
  for (const row of snapshot.surfaceForms) {
    if (!entityIds.has(row.entityId)) {
      reject("INVALID_PROJECTION_SNAPSHOT");
    }
  }
  for (const row of snapshot.claims) {
    if (
      !entityIds.has(row.subjectId) ||
      (row.objectId !== null && !entityIds.has(row.objectId))
    ) {
      reject("INVALID_PROJECTION_SNAPSHOT");
    }
  }
  for (const row of snapshot.claimSupport) {
    if (!claimIds.has(row.claimId) || !statementIds.has(row.eventId)) {
      reject("INVALID_PROJECTION_SNAPSHOT");
    }
  }
  for (const row of snapshot.idRedirects) {
    const targets = row.kind === "entity" ? entityIds : claimIds;
    if (!targets.has(row.newId)) {
      reject("INVALID_PROJECTION_SNAPSHOT");
    }
  }
}

function createProjectionSnapshot(
  value: unknown,
  input: ProjectionReplayInput,
): ProjectionSnapshot {
  const source = exactDataRecord(
    value,
    [
      "claimSupport",
      "claims",
      "entities",
      "idRedirects",
      "statements",
      "surfaceForms",
    ],
    "INVALID_PROJECTION_SNAPSHOT",
  );
  for (const key of [
    "statements",
    "entities",
    "surfaceForms",
    "claims",
    "claimSupport",
    "idRedirects",
  ] as const) {
    if (!Array.isArray(source[key])) {
      return reject("INVALID_PROJECTION_SNAPSHOT");
    }
  }
  const snapshot: ProjectionSnapshot = Object.freeze({
    statements: Object.freeze(
      (source["statements"] as unknown[]).map((row) =>
        statementRow(row, input.scopeKey),
      ),
    ),
    entities: Object.freeze(
      (source["entities"] as unknown[]).map((row) =>
        entityRow(row, input.scopeKey),
      ),
    ),
    surfaceForms: Object.freeze(
      (source["surfaceForms"] as unknown[]).map((row) =>
        surfaceRow(row, input.scopeKey),
      ),
    ),
    claims: Object.freeze(
      (source["claims"] as unknown[]).map((row) =>
        claimRow(row, input.scopeKey),
      ),
    ),
    claimSupport: Object.freeze(
      (source["claimSupport"] as unknown[]).map((row) => supportRow(row)),
    ),
    idRedirects: Object.freeze(
      (source["idRedirects"] as unknown[]).map((row) => redirectRow(row)),
    ),
  });
  validateSnapshotReferences(snapshot, input);
  return snapshot;
}

export function runProjectionReplayReducer(
  value: unknown,
  reducer: unknown,
): ProjectionSnapshot {
  if (typeof reducer !== "function") {
    return reject("INVALID_REDUCER");
  }
  const input = createProjectionReplayInput(value);
  return createProjectionSnapshot(
    (reducer as ProjectionReplayReducer)(input),
    input,
  );
}

export function projectionSnapshotRowCount(
  snapshot: ProjectionSnapshot,
): number {
  return (
    snapshot.statements.length +
    snapshot.entities.length +
    snapshot.surfaceForms.length +
    snapshot.claims.length +
    snapshot.claimSupport.length +
    snapshot.idRedirects.length
  );
}
