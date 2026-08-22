const EVENT_ID_PATTERN = /^ev_[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
const ENTITY_ID_PATTERN = /^e([1-9][0-9]*)\.([0-9]+)$/u;
const CLAIM_ID_PATTERN = /^c([1-9][0-9]*)\.([0-9]+)$/u;
const SCOPE_KEY_PATTERN =
  /^u:[A-Za-z0-9._-]{1,64}\/p:[A-Za-z0-9._-]{1,64}$/u;
const MAX_REDIRECT_HOPS = 32;

export type IdentifierKind = "event" | "entity" | "claim";
export type RedirectKind = "entity" | "claim";
export type IdentifierRedirectReason =
  | "merge"
  | "rule_change"
  | "deduplicated";

export type ProjectionIdentifierErrorCode =
  | "INVALID_IDENTIFIER"
  | "INVALID_OCCURRENCE_INPUT"
  | "INVALID_CANONICAL_SELECTION"
  | "INVALID_REDIRECT_REGISTRY"
  | "REDIRECT_SELF_REFERENCE"
  | "REDIRECT_DANGLING_TARGET"
  | "REDIRECT_KIND_MISMATCH"
  | "REDIRECT_SCOPE_MISMATCH"
  | "REDIRECT_CYCLE"
  | "REDIRECT_TOO_DEEP"
  | "IDENTIFIER_NOT_FOUND"
  | "INVALID_RULES_DRY_RUN_INPUT";

const IDENTIFIER_ERROR_MESSAGES: Readonly<
  Record<ProjectionIdentifierErrorCode, string>
> = Object.freeze({
  INVALID_IDENTIFIER: "identifier is not canonical for the expected kind",
  INVALID_OCCURRENCE_INPUT:
    "occurrence allocation requires a stored statement draft sequence",
  INVALID_CANONICAL_SELECTION:
    "canonical identifier selection is inconsistent with its reason",
  INVALID_REDIRECT_REGISTRY:
    "identifier redirect registry has an invalid structure",
  REDIRECT_SELF_REFERENCE: "identifier redirect cannot target itself",
  REDIRECT_DANGLING_TARGET:
    "identifier redirect target has no occurrence anchor",
  REDIRECT_KIND_MISMATCH: "identifier redirect crosses identifier kinds",
  REDIRECT_SCOPE_MISMATCH: "identifier redirect crosses trusted scopes",
  REDIRECT_CYCLE: "identifier redirect registry contains a cycle",
  REDIRECT_TOO_DEEP: "identifier redirect registry exceeds the hop limit",
  IDENTIFIER_NOT_FOUND: "identifier has no occurrence anchor",
  INVALID_RULES_DRY_RUN_INPUT:
    "rules dry-run requires complete anchored identity occurrences",
});

export class ProjectionIdentifierError extends TypeError {
  public override readonly name: string = "ProjectionIdentifierError";
  public readonly code: ProjectionIdentifierErrorCode;

  public constructor(code: ProjectionIdentifierErrorCode) {
    super(IDENTIFIER_ERROR_MESSAGES[code]);
    this.code = code;
  }
}

function reject(code: ProjectionIdentifierErrorCode): never {
  throw new ProjectionIdentifierError(code);
}

function plainDataRecord(
  value: unknown,
  code: ProjectionIdentifierErrorCode,
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
  code: ProjectionIdentifierErrorCode,
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
  code: ProjectionIdentifierErrorCode,
): readonly unknown[] {
  if (!Array.isArray(value)) {
    return reject(code);
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (
    lengthDescriptor === undefined ||
    !("value" in lengthDescriptor) ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    Number(lengthDescriptor.value) < 0
  ) {
    return reject(code);
  }
  const length = Number(lengthDescriptor.value);
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
  return Object.freeze(result);
}

function canonicalRedirectKind(
  value: unknown,
  code: ProjectionIdentifierErrorCode,
): RedirectKind {
  if (value !== "entity" && value !== "claim") {
    return reject(code);
  }
  return value;
}

function canonicalRedirectReason(
  value: unknown,
  code: ProjectionIdentifierErrorCode,
): IdentifierRedirectReason {
  if (
    value !== "merge" &&
    value !== "rule_change" &&
    value !== "deduplicated"
  ) {
    return reject(code);
  }
  return value;
}

function canonicalScope(
  value: unknown,
  code: ProjectionIdentifierErrorCode,
): string {
  if (typeof value !== "string" || !SCOPE_KEY_PATTERN.test(value)) {
    return reject(code);
  }
  return value;
}

function patternFor(kind: IdentifierKind): RegExp {
  if (kind === "event") {
    return EVENT_ID_PATTERN;
  }
  return kind === "entity" ? ENTITY_ID_PATTERN : CLAIM_ID_PATTERN;
}

export function isCanonicalIdentifier(
  value: unknown,
  kind: unknown,
): value is string {
  if (kind !== "event" && kind !== "entity" && kind !== "claim") {
    return false;
  }
  return typeof value === "string" && patternFor(kind).test(value);
}

export function assertCanonicalIdentifier(
  value: unknown,
  kindValue: unknown,
): string {
  if (
    kindValue !== "event" &&
    kindValue !== "entity" &&
    kindValue !== "claim"
  ) {
    return reject("INVALID_IDENTIFIER");
  }
  if (!isCanonicalIdentifier(value, kindValue)) {
    return reject("INVALID_IDENTIFIER");
  }
  return value;
}

interface OccurrenceIdentifierParts {
  readonly seq: bigint;
  readonly position: bigint;
}

function occurrenceParts(
  value: unknown,
  kind: RedirectKind,
): OccurrenceIdentifierParts {
  const identifier = assertCanonicalIdentifier(value, kind);
  const match = (kind === "entity" ? ENTITY_ID_PATTERN : CLAIM_ID_PATTERN).exec(
    identifier,
  );
  if (match === null || match[1] === undefined || match[2] === undefined) {
    return reject("INVALID_IDENTIFIER");
  }
  return {
    seq: BigInt(match[1]),
    position: BigInt(match[2]),
  };
}

export function compareOccurrenceIdentifiers(
  leftValue: unknown,
  rightValue: unknown,
  kind: RedirectKind,
): number {
  const left = occurrenceParts(leftValue, kind);
  const right = occurrenceParts(rightValue, kind);
  if (left.seq !== right.seq) {
    return left.seq < right.seq ? -1 : 1;
  }
  if (left.position === right.position) {
    return 0;
  }
  return left.position < right.position ? -1 : 1;
}

function asciiCompare(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

export interface OccurrenceCandidates {
  readonly draftIndex: number;
  readonly claimId: string;
  readonly subjectId: string;
  readonly objectId: string | null;
}

export function enumerateOccurrenceCandidates(
  value: unknown,
): readonly OccurrenceCandidates[] {
  const input = exactDataRecord(
    value,
    ["parsed", "seq"],
    "INVALID_OCCURRENCE_INPUT",
  );
  const seq = input["seq"];
  if (!Number.isSafeInteger(seq) || Number(seq) <= 0) {
    return reject("INVALID_OCCURRENCE_INPUT");
  }
  const parsed = plainDataArray(
    input["parsed"],
    "INVALID_OCCURRENCE_INPUT",
  );

  let entityPosition = 0;
  const occurrences: OccurrenceCandidates[] = [];
  for (let draftIndex = 0; draftIndex < parsed.length; draftIndex += 1) {
    const draft = plainDataRecord(
      parsed[draftIndex],
      "INVALID_OCCURRENCE_INPUT",
    );
    if (!("subject" in draft)) {
      return reject("INVALID_OCCURRENCE_INPUT");
    }
    const hasObject = "object" in draft;
    const hasObjectValue = "object_value" in draft;
    if (hasObject === hasObjectValue) {
      return reject("INVALID_OCCURRENCE_INPUT");
    }
    const subjectId = `e${Number(seq)}.${entityPosition}`;
    entityPosition += 1;
    const objectId = hasObject
      ? `e${Number(seq)}.${entityPosition}`
      : null;
    if (hasObject) {
      entityPosition += 1;
    }
    occurrences.push(
      Object.freeze({
        draftIndex,
        claimId: `c${Number(seq)}.${draftIndex}`,
        subjectId,
        objectId,
      }),
    );
  }
  return Object.freeze(occurrences);
}

export interface IdentifierRedirectRow {
  readonly oldId: string;
  readonly newId: string;
  readonly kind: RedirectKind;
  readonly reason: IdentifierRedirectReason;
}

export interface CanonicalIdentifierSelection {
  readonly canonicalId: string;
  readonly redirects: readonly IdentifierRedirectRow[];
}

function frozenRedirect(
  oldId: string,
  newId: string,
  kind: RedirectKind,
  reason: IdentifierRedirectReason,
): IdentifierRedirectRow {
  return Object.freeze({ oldId, newId, kind, reason });
}

export function chooseCanonicalIdentifier(
  value: unknown,
): CanonicalIdentifierSelection {
  const input = exactDataRecord(
    value,
    ["candidates", "keepId", "kind", "reason"],
    "INVALID_CANONICAL_SELECTION",
  );
  const kind = canonicalRedirectKind(
    input["kind"],
    "INVALID_CANONICAL_SELECTION",
  );
  const reason = canonicalRedirectReason(
    input["reason"],
    "INVALID_CANONICAL_SELECTION",
  );
  const candidateValues = plainDataArray(
    input["candidates"],
    "INVALID_CANONICAL_SELECTION",
  );
  if (candidateValues.length === 0) {
    return reject("INVALID_CANONICAL_SELECTION");
  }
  const candidates: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidateValues) {
    if (!isCanonicalIdentifier(candidate, kind) || seen.has(candidate)) {
      return reject("INVALID_CANONICAL_SELECTION");
    }
    seen.add(candidate);
    candidates.push(candidate);
  }
  candidates.sort((left, right) =>
    compareOccurrenceIdentifiers(left, right, kind),
  );

  let canonicalId: string;
  if (reason === "merge") {
    const keepId = input["keepId"];
    if (
      typeof keepId !== "string" ||
      !isCanonicalIdentifier(keepId, kind) ||
      !seen.has(keepId)
    ) {
      return reject("INVALID_CANONICAL_SELECTION");
    }
    canonicalId = keepId;
  } else {
    if (input["keepId"] !== null) {
      return reject("INVALID_CANONICAL_SELECTION");
    }
    canonicalId = candidates[0] ?? reject("INVALID_CANONICAL_SELECTION");
  }

  const redirects = candidates
    .filter((candidate) => candidate !== canonicalId)
    .map((candidate) => frozenRedirect(candidate, canonicalId, kind, reason));
  return Object.freeze({
    canonicalId,
    redirects: Object.freeze(redirects),
  });
}

export interface IdentifierAnchor {
  readonly id: string;
  readonly kind: RedirectKind;
  readonly scopeKey: string;
}

export interface IdentifierRedirectRegistry {
  readonly anchors: readonly IdentifierAnchor[];
  readonly redirects: readonly IdentifierRedirectRow[];
}

function frozenAnchor(
  id: string,
  kind: RedirectKind,
  scopeKey: string,
): IdentifierAnchor {
  return Object.freeze({ id, kind, scopeKey });
}

function anyOccurrenceIdentifier(value: unknown): value is string {
  return (
    isCanonicalIdentifier(value, "entity") ||
    isCanonicalIdentifier(value, "claim")
  );
}

export function createIdentifierRedirectRegistry(
  value: unknown,
): IdentifierRedirectRegistry {
  const input = exactDataRecord(
    value,
    ["anchors", "redirects"],
    "INVALID_REDIRECT_REGISTRY",
  );
  const anchorValues = plainDataArray(
    input["anchors"],
    "INVALID_REDIRECT_REGISTRY",
  );
  const redirectValues = plainDataArray(
    input["redirects"],
    "INVALID_REDIRECT_REGISTRY",
  );

  const anchors: IdentifierAnchor[] = [];
  const anchorById = new Map<string, IdentifierAnchor>();
  for (const valueAnchor of anchorValues) {
    const source = exactDataRecord(
      valueAnchor,
      ["id", "kind", "scopeKey"],
      "INVALID_REDIRECT_REGISTRY",
    );
    const kind = canonicalRedirectKind(
      source["kind"],
      "INVALID_REDIRECT_REGISTRY",
    );
    const id = source["id"];
    if (!isCanonicalIdentifier(id, kind) || anchorById.has(id)) {
      return reject("INVALID_REDIRECT_REGISTRY");
    }
    const anchor = frozenAnchor(
      id,
      kind,
      canonicalScope(source["scopeKey"], "INVALID_REDIRECT_REGISTRY"),
    );
    anchors.push(anchor);
    anchorById.set(id, anchor);
  }

  const outgoing = new Map<string, IdentifierRedirectRow>();
  for (const valueRedirect of redirectValues) {
    const source = exactDataRecord(
      valueRedirect,
      ["kind", "newId", "oldId", "reason"],
      "INVALID_REDIRECT_REGISTRY",
    );
    const kind = canonicalRedirectKind(
      source["kind"],
      "INVALID_REDIRECT_REGISTRY",
    );
    const reason = canonicalRedirectReason(
      source["reason"],
      "INVALID_REDIRECT_REGISTRY",
    );
    const oldId = source["oldId"];
    const newId = source["newId"];
    if (
      !anyOccurrenceIdentifier(oldId) ||
      !anyOccurrenceIdentifier(newId) ||
      outgoing.has(oldId)
    ) {
      return reject("INVALID_REDIRECT_REGISTRY");
    }
    if (oldId === newId) {
      return reject("REDIRECT_SELF_REFERENCE");
    }
    const oldAnchor = anchorById.get(oldId);
    const newAnchor = anchorById.get(newId);
    if (oldAnchor === undefined || newAnchor === undefined) {
      return reject("REDIRECT_DANGLING_TARGET");
    }
    if (oldAnchor.kind !== kind || newAnchor.kind !== kind) {
      return reject("REDIRECT_KIND_MISMATCH");
    }
    if (oldAnchor.scopeKey !== newAnchor.scopeKey) {
      return reject("REDIRECT_SCOPE_MISMATCH");
    }
    outgoing.set(oldId, frozenRedirect(oldId, newId, kind, reason));
  }

  const compressed: IdentifierRedirectRow[] = [];
  for (const edge of outgoing.values()) {
    let current = edge.oldId;
    let hops = 0;
    const seen = new Set<string>();
    while (outgoing.has(current)) {
      if (seen.has(current)) {
        return reject("REDIRECT_CYCLE");
      }
      seen.add(current);
      const nextEdge = outgoing.get(current);
      if (nextEdge === undefined) {
        return reject("INVALID_REDIRECT_REGISTRY");
      }
      hops += 1;
      if (hops > MAX_REDIRECT_HOPS) {
        return reject("REDIRECT_TOO_DEEP");
      }
      current = nextEdge.newId;
    }
    const terminal = anchorById.get(current);
    const origin = anchorById.get(edge.oldId);
    if (terminal === undefined || origin === undefined) {
      return reject("REDIRECT_DANGLING_TARGET");
    }
    if (terminal.kind !== edge.kind || origin.kind !== edge.kind) {
      return reject("REDIRECT_KIND_MISMATCH");
    }
    if (terminal.scopeKey !== origin.scopeKey) {
      return reject("REDIRECT_SCOPE_MISMATCH");
    }
    compressed.push(
      frozenRedirect(edge.oldId, terminal.id, edge.kind, edge.reason),
    );
  }

  anchors.sort((left, right) => asciiCompare(left.id, right.id));
  compressed.sort((left, right) => asciiCompare(left.oldId, right.oldId));
  return Object.freeze({
    anchors: Object.freeze(anchors),
    redirects: Object.freeze(compressed),
  });
}

export function resolveCanonicalIdentifier(
  registryValue: unknown,
  requestValue: unknown,
): string {
  const registry = createIdentifierRedirectRegistry(registryValue);
  const request = exactDataRecord(
    requestValue,
    ["expectedKind", "expectedScope", "identifier"],
    "INVALID_IDENTIFIER",
  );
  const expectedKind = canonicalRedirectKind(
    request["expectedKind"],
    "INVALID_IDENTIFIER",
  );
  const expectedScope = canonicalScope(
    request["expectedScope"],
    "INVALID_IDENTIFIER",
  );
  const identifier = assertCanonicalIdentifier(
    request["identifier"],
    expectedKind,
  );
  const source = registry.anchors.find((anchor) => anchor.id === identifier);
  if (source === undefined) {
    return reject("IDENTIFIER_NOT_FOUND");
  }
  if (source.kind !== expectedKind) {
    return reject("REDIRECT_KIND_MISMATCH");
  }
  if (source.scopeKey !== expectedScope) {
    return reject("REDIRECT_SCOPE_MISMATCH");
  }

  const redirect = registry.redirects.find((row) => row.oldId === identifier);
  const canonicalId = redirect?.newId ?? identifier;
  const terminal = registry.anchors.find(
    (anchor) => anchor.id === canonicalId,
  );
  if (terminal === undefined) {
    return reject("REDIRECT_DANGLING_TARGET");
  }
  if (terminal.kind !== expectedKind) {
    return reject("REDIRECT_KIND_MISMATCH");
  }
  if (terminal.scopeKey !== expectedScope) {
    return reject("REDIRECT_SCOPE_MISMATCH");
  }
  return terminal.id;
}

interface IdentityRuleOccurrence {
  readonly occurrenceId: string;
  readonly currentCanonicalId: string;
  readonly kind: RedirectKind;
  readonly scopeKey: string;
  readonly nextIdentityKey: string;
}

export interface IdentityRuleMaintenanceCandidate {
  readonly currentCanonicalId: string;
  readonly kind: RedirectKind;
  readonly scopeKey: string;
  readonly retainedOccurrenceId: string;
  readonly splitOccurrenceIds: readonly string[];
}

export interface IdentityRuleDryRunResult {
  readonly status: "safe" | "blocked";
  readonly redirects: readonly IdentifierRedirectRow[];
  readonly maintenanceCandidates: readonly IdentityRuleMaintenanceCandidate[];
}

function ruleOccurrence(value: unknown): IdentityRuleOccurrence {
  const source = exactDataRecord(
    value,
    [
      "currentCanonicalId",
      "kind",
      "nextIdentityKey",
      "occurrenceId",
      "scopeKey",
    ],
    "INVALID_RULES_DRY_RUN_INPUT",
  );
  const kind = canonicalRedirectKind(
    source["kind"],
    "INVALID_RULES_DRY_RUN_INPUT",
  );
  const occurrenceId = source["occurrenceId"];
  const currentCanonicalId = source["currentCanonicalId"];
  const nextIdentityKey = source["nextIdentityKey"];
  if (
    !isCanonicalIdentifier(occurrenceId, kind) ||
    !isCanonicalIdentifier(currentCanonicalId, kind) ||
    typeof nextIdentityKey !== "string" ||
    nextIdentityKey.length === 0
  ) {
    return reject("INVALID_RULES_DRY_RUN_INPUT");
  }
  return Object.freeze({
    occurrenceId,
    currentCanonicalId,
    kind,
    scopeKey: canonicalScope(
      source["scopeKey"],
      "INVALID_RULES_DRY_RUN_INPUT",
    ),
    nextIdentityKey,
  });
}

function nextGroupKey(occurrence: IdentityRuleOccurrence): string {
  return JSON.stringify([
    occurrence.scopeKey,
    occurrence.kind,
    occurrence.nextIdentityKey,
  ]);
}

function earliestOccurrence(
  occurrences: readonly IdentityRuleOccurrence[],
): string {
  const first = occurrences[0] ?? reject("INVALID_RULES_DRY_RUN_INPUT");
  const ids = occurrences.map((occurrence) => occurrence.occurrenceId);
  ids.sort((left, right) =>
    compareOccurrenceIdentifiers(left, right, first.kind),
  );
  return ids[0] ?? reject("INVALID_RULES_DRY_RUN_INPUT");
}

export function dryRunIdentityRuleChange(
  value: unknown,
): IdentityRuleDryRunResult {
  const input = exactDataRecord(
    value,
    ["occurrences"],
    "INVALID_RULES_DRY_RUN_INPUT",
  );
  const occurrenceValues = plainDataArray(
    input["occurrences"],
    "INVALID_RULES_DRY_RUN_INPUT",
  );
  const occurrences = occurrenceValues.map((item) => ruleOccurrence(item));
  const occurrenceById = new Map<string, IdentityRuleOccurrence>();
  for (const occurrence of occurrences) {
    if (occurrenceById.has(occurrence.occurrenceId)) {
      return reject("INVALID_RULES_DRY_RUN_INPUT");
    }
    occurrenceById.set(occurrence.occurrenceId, occurrence);
  }

  const currentGroups = new Map<string, IdentityRuleOccurrence[]>();
  for (const occurrence of occurrences) {
    const group = currentGroups.get(occurrence.currentCanonicalId) ?? [];
    group.push(occurrence);
    currentGroups.set(occurrence.currentCanonicalId, group);
  }
  for (const [currentCanonicalId, group] of currentGroups) {
    const canonicalOccurrence = occurrenceById.get(currentCanonicalId);
    const first = group[0];
    if (
      canonicalOccurrence === undefined ||
      first === undefined ||
      canonicalOccurrence.currentCanonicalId !== currentCanonicalId ||
      group.some(
        (occurrence) =>
          occurrence.kind !== first.kind ||
          occurrence.scopeKey !== first.scopeKey,
      )
    ) {
      return reject("INVALID_RULES_DRY_RUN_INPUT");
    }
  }

  const maintenanceCandidates: IdentityRuleMaintenanceCandidate[] = [];
  for (const [currentCanonicalId, group] of currentGroups) {
    const nextGroups = new Map<string, IdentityRuleOccurrence[]>();
    for (const occurrence of group) {
      const key = nextGroupKey(occurrence);
      const nextGroup = nextGroups.get(key) ?? [];
      nextGroup.push(occurrence);
      nextGroups.set(key, nextGroup);
    }
    if (nextGroups.size <= 1) {
      continue;
    }
    const first = group[0] ?? reject("INVALID_RULES_DRY_RUN_INPUT");
    const representatives = [...nextGroups.values()].map((nextGroup) =>
      earliestOccurrence(nextGroup),
    );
    representatives.sort((left, right) =>
      compareOccurrenceIdentifiers(left, right, first.kind),
    );
    const retainedOccurrenceId =
      representatives[0] ?? reject("INVALID_RULES_DRY_RUN_INPUT");
    maintenanceCandidates.push(
      Object.freeze({
        currentCanonicalId,
        kind: first.kind,
        scopeKey: first.scopeKey,
        retainedOccurrenceId,
        splitOccurrenceIds: Object.freeze(representatives.slice(1)),
      }),
    );
  }
  maintenanceCandidates.sort((left, right) =>
    asciiCompare(left.currentCanonicalId, right.currentCanonicalId),
  );
  if (maintenanceCandidates.length > 0) {
    return Object.freeze({
      status: "blocked",
      redirects: Object.freeze([] as IdentifierRedirectRow[]),
      maintenanceCandidates: Object.freeze(maintenanceCandidates),
    });
  }

  const nextGroups = new Map<string, IdentityRuleOccurrence[]>();
  for (const occurrence of occurrences) {
    const key = nextGroupKey(occurrence);
    const group = nextGroups.get(key) ?? [];
    group.push(occurrence);
    nextGroups.set(key, group);
  }
  const redirects: IdentifierRedirectRow[] = [];
  for (const group of nextGroups.values()) {
    const first = group[0] ?? reject("INVALID_RULES_DRY_RUN_INPUT");
    const currentCanonicalIds = [
      ...new Set(group.map((occurrence) => occurrence.currentCanonicalId)),
    ];
    const selection = chooseCanonicalIdentifier({
      candidates: currentCanonicalIds,
      kind: first.kind,
      reason: "rule_change",
      keepId: null,
    });
    redirects.push(...selection.redirects);
  }
  redirects.sort((left, right) => asciiCompare(left.oldId, right.oldId));
  return Object.freeze({
    status: "safe",
    redirects: Object.freeze(redirects),
    maintenanceCandidates: Object.freeze(maintenanceCandidates),
  });
}
