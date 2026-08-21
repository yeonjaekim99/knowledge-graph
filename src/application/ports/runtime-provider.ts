export type UnixEpochSeconds = number;
export type ScopeKey = `u:${string}/p:${string}`;
export type EventId = `ev_${string}`;
export type ReinterpretApprovalToken = `ra_${string}`;
export type SessionCorrelationKey = `hmac-sha256:${string}`;

export interface RuntimeScope {
  readonly userId: string;
  readonly projectId: string;
  readonly scopeKey: ScopeKey;
}

export interface JournalMetadata {
  readonly actor: string | null;
  readonly branch: string | null;
  readonly session: SessionCorrelationKey | null;
}

export interface RuntimeSnapshot {
  /** UTC Unix epoch seconds captured once at the request boundary. */
  readonly recordedAt: UnixEpochSeconds;
  /** The same fixed instant used by every recall query in this request. */
  readonly evaluationNow: UnixEpochSeconds;
  readonly rulesVersion: string;
  readonly scope: RuntimeScope;
  readonly metadata: JournalMetadata;
}

export interface RuntimeClock {
  nowMilliseconds(): number;
}

export interface RandomBytesProvider {
  randomBytes(length: number): Uint8Array;
}

export interface EventIdProvider {
  nextEventId(): EventId;
}

export interface ApprovalTokenProvider {
  nextApprovalToken(): ReinterpretApprovalToken;
}

export interface RulesVersionProvider {
  currentRulesVersion(): string;
}

/** Request-scoped: trusted user and fixed project are already bound. */
export interface ScopeProvider {
  resolveScope(): RuntimeScope;
}

/** Request-scoped: trusted client/session inputs and project directory are already bound. */
export interface MetadataProvider {
  resolveMetadata(): Promise<JournalMetadata>;
}

export interface BranchProvider {
  currentBranch(): Promise<string | null>;
}

export interface RuntimeProviderDependencies {
  readonly clock: RuntimeClock;
  readonly eventIds: EventIdProvider;
  readonly approvalTokens: ApprovalTokenProvider;
  readonly rules: RulesVersionProvider;
  readonly scope: ScopeProvider;
  readonly metadata: MetadataProvider;
}

/**
 * Application services see only this request-scoped contract. There is no tool
 * payload parameter from which scope or audit metadata can be supplied.
 */
export interface RuntimeProvider {
  capture(): Promise<RuntimeSnapshot>;
  nextEventId(): EventId;
  nextApprovalToken(): ReinterpretApprovalToken;
}
