import type {
  EventId,
  JournalMetadata,
  ReinterpretApprovalToken,
  RuntimeProvider,
  RuntimeProviderDependencies,
  RuntimeScope,
  RuntimeSnapshot,
} from "./ports/runtime-provider.js";

const EVENT_ID_PATTERN = /^ev_[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const APPROVAL_TOKEN_PATTERN = /^ra_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const SCOPE_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const SESSION_KEY_PATTERN = /^hmac-sha256:[0-9a-f]{64}$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;

export type RuntimeBoundaryErrorCode =
  | "invalid_clock"
  | "invalid_event_id"
  | "invalid_approval_token"
  | "invalid_rules_version"
  | "invalid_scope"
  | "invalid_metadata";

export class RuntimeBoundaryError extends Error {
  public override readonly name: string = "RuntimeBoundaryError";
  public readonly code: RuntimeBoundaryErrorCode;

  public constructor(code: RuntimeBoundaryErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

function assertClock(milliseconds: number): void {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw new RuntimeBoundaryError(
      "invalid_clock",
      "runtime clock must return a non-negative safe integer in milliseconds",
    );
  }
}

function assertRulesVersion(value: string): void {
  if (
    value.length === 0 ||
    value.length > 128 ||
    value.trim() !== value ||
    CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    throw new RuntimeBoundaryError(
      "invalid_rules_version",
      "rules version must be a trimmed, non-empty value of at most 128 characters",
    );
  }
}

function assertScope(scope: RuntimeScope): void {
  if (
    !SCOPE_ID_PATTERN.test(scope.userId) ||
    !SCOPE_ID_PATTERN.test(scope.projectId) ||
    scope.scopeKey !== `u:${scope.userId}/p:${scope.projectId}`
  ) {
    throw new RuntimeBoundaryError(
      "invalid_scope",
      "runtime scope must contain validated user/project IDs and their exact scope key",
    );
  }
}

function assertNullableMetadataText(
  name: "actor" | "branch",
  value: string | null,
): void {
  if (value === null) {
    return;
  }
  if (
    value.length === 0 ||
    CONTROL_CHARACTER_PATTERN.test(value) ||
    (name === "actor" && Array.from(value).length > 128)
  ) {
    throw new RuntimeBoundaryError(
      "invalid_metadata",
      `${name} metadata does not satisfy the normalized runtime contract`,
    );
  }
}

function assertMetadata(metadata: JournalMetadata): void {
  assertNullableMetadataText("actor", metadata.actor);
  assertNullableMetadataText("branch", metadata.branch);
  if (
    metadata.session !== null &&
    !SESSION_KEY_PATTERN.test(metadata.session)
  ) {
    throw new RuntimeBoundaryError(
      "invalid_metadata",
      "session metadata must be a lowercase HMAC-SHA-256 correlation key",
    );
  }
}

function freezeSnapshot(
  seconds: number,
  rulesVersion: string,
  scope: RuntimeScope,
  metadata: JournalMetadata,
): RuntimeSnapshot {
  return Object.freeze({
    recordedAt: seconds,
    evaluationNow: seconds,
    rulesVersion,
    scope: Object.freeze({ ...scope }),
    metadata: Object.freeze({ ...metadata }),
  });
}

async function captureSnapshot(
  dependencies: RuntimeProviderDependencies,
): Promise<RuntimeSnapshot> {
  const milliseconds = dependencies.clock.nowMilliseconds();
  assertClock(milliseconds);

  const rulesVersion = dependencies.rules.currentRulesVersion();
  const scope = dependencies.scope.resolveScope();
  assertRulesVersion(rulesVersion);
  assertScope(scope);

  const metadata = await dependencies.metadata.resolveMetadata();
  assertMetadata(metadata);

  return freezeSnapshot(
    Math.floor(milliseconds / 1_000),
    rulesVersion,
    scope,
    metadata,
  );
}

function checkedEventId(value: EventId): EventId {
  if (!EVENT_ID_PATTERN.test(value)) {
    throw new RuntimeBoundaryError(
      "invalid_event_id",
      "event ID provider returned a non-canonical ev_ ULID",
    );
  }
  return value;
}

function checkedApprovalToken(
  value: ReinterpretApprovalToken,
): ReinterpretApprovalToken {
  if (!APPROVAL_TOKEN_PATTERN.test(value)) {
    throw new RuntimeBoundaryError(
      "invalid_approval_token",
      "approval token provider returned a non-canonical 256-bit token",
    );
  }
  return value;
}

export function createRuntimeProvider(
  dependencies: RuntimeProviderDependencies,
): RuntimeProvider {
  let snapshot: Promise<RuntimeSnapshot> | undefined;

  return Object.freeze({
    capture(): Promise<RuntimeSnapshot> {
      snapshot ??= captureSnapshot(dependencies);
      return snapshot;
    },
    nextEventId(): EventId {
      return checkedEventId(dependencies.eventIds.nextEventId());
    },
    nextApprovalToken(): ReinterpretApprovalToken {
      return checkedApprovalToken(
        dependencies.approvalTokens.nextApprovalToken(),
      );
    },
  });
}
