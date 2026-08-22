import {
  finalizeRecordDraftPlan,
  selectRecordDraftSurvivors,
} from "../../../src/application/index.js";
import type {
  FinalizedRecordDraftPlan,
  RecordDraftSurvivorPlan,
} from "../../../src/application/index.js";
// @ts-expect-error draft planning runtime remains behind the application boundary
import { selectRecordDraftSurvivors as rootDraftPlanner } from "../../../src/index.js";

const selected: RecordDraftSurvivorPlan = selectRecordDraftSurvivors({
  approvedDrafts: [],
  rejectedClaims: [],
  resolutions: [],
});
const finalized: FinalizedRecordDraftPlan = finalizeRecordDraftPlan(selected, {
  expectedJournalSeq: 1,
  drafts: [],
});

// @ts-expect-error survivor indexes are immutable
selected.survivorDraftIndexes.push(0);
// @ts-expect-error mappings expose candidate identity only, never a committed event
finalized.eventId;
// @ts-expect-error REC-006 owns final created/reinforced/superseded status
finalized.mappings[0]?.status;

void rootDraftPlanner;
void finalized;
