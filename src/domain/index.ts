export { reduceEvents } from "./reducer.js";
export type { PureReducer } from "./reducer.js";
export {
  ProjectionReplayContractError,
  createProjectionReplayInput,
  projectionSnapshotRowCount,
  runProjectionReplayReducer,
} from "./projection-replay.js";
export type {
  ClaimProjectionRow,
  ClaimSupportProjectionRow,
  EntityProjectionRow,
  IdRedirectProjectionRow,
  ProjectionJournalEventKind,
  ProjectionReplayContractErrorCode,
  ProjectionReplayInput,
  ProjectionReplayJournalEvent,
  ProjectionReplayReducer,
  ProjectionSnapshot,
  StatementProjectionRow,
  SurfaceFormProjectionRow,
} from "./projection-replay.js";
export {
  CANONICAL_RELATIONS,
  NORMALIZATION_VERSION,
  ProjectionRuleError,
  RELATION_REGISTRY,
  getRelationDefinition,
  normalizeLiteralIdentity,
  normalizeRelationLabel,
  normalizeV1,
} from "./projection-rules.js";
export {
  ProjectionIdentifierError,
  assertCanonicalIdentifier,
  chooseCanonicalIdentifier,
  compareOccurrenceIdentifiers,
  createIdentifierRedirectRegistry,
  dryRunIdentityRuleChange,
  enumerateOccurrenceCandidates,
  isCanonicalIdentifier,
  resolveCanonicalIdentifier,
} from "./projection-identifiers.js";
export type {
  CanonicalIdentifierSelection,
  IdentifierAnchor,
  IdentifierKind,
  IdentifierRedirectReason,
  IdentifierRedirectRegistry,
  IdentifierRedirectRow,
  IdentityRuleDryRunResult,
  IdentityRuleMaintenanceCandidate,
  OccurrenceCandidates,
  ProjectionIdentifierErrorCode,
  RedirectKind,
} from "./projection-identifiers.js";
export {
  ProjectionPreScanError,
  preScanProjectionEvents,
} from "./projection-event-pre-scan.js";
export type {
  EffectiveAliasEvent,
  EffectiveClaimRetractionEvent,
  EffectiveDecisionEvent,
  EffectiveEventRetractionEvent,
  EffectiveMergeEvent,
  EffectiveProjectionEvent,
  EffectiveStatementEvent,
  PreScannedStatement,
  ProjectionPreScanErrorCode,
  ProjectionPreScanResult,
  StatementCandidateRegistration,
} from "./projection-event-pre-scan.js";
export {
  EntityProjectionError,
  projectEntitySurfaceKinds,
  reduceEntitySurfaceKinds,
  resolveEntityReference,
  strongestSurfaceOrigin,
} from "./projection-entities.js";
export type {
  AmbiguousEntityCandidate,
  AmbiguousEntityReference,
  EntityKindMaintenanceCandidate,
  EntityOccurrenceProjection,
  EntityProjectionErrorCode,
  EntityReferenceResolution,
  EntitySurfaceKindProjection,
  MissingEntityReference,
  ResolvedEntityReference,
} from "./projection-entities.js";
export {
  ClaimProjectionError,
  projectClaimSupportState,
  reduceClaimSupportState,
} from "./projection-claims.js";
export type {
  ClaimOccurrenceProjection,
  ClaimProjectionErrorCode,
  ClaimSupportStateProjection,
  StructuralClaimSupportProjectionRow,
} from "./projection-claims.js";
export {
  ProjectionDecisionError,
  projectMergeAliasState,
  reduceMergeAliasState,
} from "./projection-decisions.js";
export type {
  MergeAliasStateProjection,
  ProjectionDecisionErrorCode,
} from "./projection-decisions.js";
export {
  DEFAULT_STATEMENT_TTL,
  ProjectionValidityError,
  STATEMENT_TTL_SECONDS,
  reduceClaimValidityState,
  resolveEffectiveStatementLifetime,
} from "./projection-validity.js";
export type {
  ClaimValidityProjection,
  ClaimValidityStructuralInput,
  DefaultStatementTtl,
  EffectiveStatementLifetime,
  ProjectionValidityErrorCode,
  StatementProvenance,
  StatementTtl,
  StatementTtlSeconds,
} from "./projection-validity.js";
export type {
  CanonicalRelation,
  CanonicalRelationDefinition,
  ProjectionRuleErrorCode,
  RelationCardinality,
} from "./projection-rules.js";
