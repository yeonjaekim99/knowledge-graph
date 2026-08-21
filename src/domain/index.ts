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
export type {
  CanonicalRelation,
  CanonicalRelationDefinition,
  ProjectionRuleErrorCode,
  RelationCardinality,
} from "./projection-rules.js";
