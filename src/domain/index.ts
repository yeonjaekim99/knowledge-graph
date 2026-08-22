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
  EffectiveClaimRetractionEvent,
  EffectiveDecisionEvent,
  EffectiveEventRetractionEvent,
  EffectiveProjectionEvent,
  EffectiveStatementEvent,
  PreScannedStatement,
  ProjectionPreScanErrorCode,
  ProjectionPreScanResult,
  StatementCandidateRegistration,
} from "./projection-event-pre-scan.js";
export type {
  CanonicalRelation,
  CanonicalRelationDefinition,
  ProjectionRuleErrorCode,
  RelationCardinality,
} from "./projection-rules.js";
