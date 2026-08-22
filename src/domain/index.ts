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
  RecallQuerySurfaceError,
  extractRecallQueryTerms,
  resolveRecallSurfaceSeeds,
} from "./recall-query-surface.js";
export {
  RecallGraphTraversalError,
  compareRecallTraversalClaims,
  truncateRecallSeedDisplay,
  validateRecallGraphTraversalInput,
  validateRecallTraversalNeighborhood,
} from "./recall-graph-traversal.js";
export type {
  RecallGraphSeed,
  RecallGraphTraversalErrorCode,
  RecallGraphTraversalInput,
  RecallGraphTraversalResult,
  RecallReachedClaim,
  RecallTraversalClaimReference,
  RecallTraversalEntity,
  RecallTraversalLink,
  RecallTraversalNeighborhood,
  RecallTraversalParent,
  ValidatedRecallGraphTraversalInput,
} from "./recall-graph-traversal.js";
export type {
  RecallQuerySurfaceErrorCode,
  RecallQuerySurfaceSelection,
  RecallQueryTerm,
  RecallSurfaceCandidateState,
  RecallSurfaceEntityState,
  RecallSurfaceSeed,
  RecallSurfaceSeedState,
} from "./recall-query-surface.js";
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
export {
  ProjectionDispatchError,
  planProjectionDispatch,
  projectProjectionSnapshot,
} from "./projection-dispatch.js";
export type {
  ProjectionDispatchErrorCode,
  ProjectionDispatchMode,
  ProjectionDispatchPlan,
  ProjectionDispatchReason,
} from "./projection-dispatch.js";
export {
  ProjectionIncrementalError,
  reduceIncrementalProjection,
} from "./projection-incremental.js";
export type { ProjectionIncrementalErrorCode } from "./projection-incremental.js";
export type {
  CanonicalRelation,
  CanonicalRelationDefinition,
  ProjectionRuleErrorCode,
  RelationCardinality,
} from "./projection-rules.js";
export {
  SECRET_DETECTOR_VERSION,
  SECRET_ENTROPY_ALLOWLIST_REGISTRY,
  SECRET_ENTROPY_POLICY,
  SECRET_SIGNATURE_REGISTRY,
  STORABLE_SECRET_FIELD_CONTEXTS,
  SecretDetectorError,
  createSecretDetector,
  detectSecretEntropy,
  detectSecretPatterns,
  detectSecrets,
} from "./secret-detector.js";
export type {
  EntropyAllowlistMode,
  SecretClass,
  SecretDetectionResult,
  SecretDetector,
  SecretDetectorDependencies,
  SecretDetectorErrorCode,
  SecretEntropyAllowlistDefinition,
  SecretEntropyPolicy,
  SecretFieldContext,
  SecretFinding,
  SecretSignatureDefinition,
} from "./secret-detector.js";
