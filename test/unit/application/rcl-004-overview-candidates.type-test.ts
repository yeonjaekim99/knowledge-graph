import type {
  RecallOverviewCandidateResult,
  RecallOverviewSeedCandidate,
  RecallRawCandidate,
  RecallSnapshotSource,
} from "../../../src/application/ports/recall-read-port.js";
import { selectRecallOverviewCandidates } from "../../../src/application/recall-overview.js";

declare const source: RecallSnapshotSource;

const result: Promise<RecallOverviewCandidateResult> =
  selectRecallOverviewCandidates(source, 10);
void result;

declare const seed: RecallOverviewSeedCandidate;
const depth: 0 = seed.depth;
const display: string = seed.display;
const order: number = seed.seedOrder;
void depth;
void display;
void order;

declare const raw: RecallRawCandidate;
const rawEvent: string = raw.eventId;
void rawEvent;

source.selectOverviewCandidates(50);

// @ts-expect-error overview receives the already-validated numeric result limit
source.selectOverviewCandidates({ limit: 10 });

// @ts-expect-error overview exposes typed candidates, never raw SQL
source.query("SELECT * FROM claims");

// @ts-expect-error RCL-004 does not add an entity Answer union member
const entityAnswer: { readonly kind: "entity" } = seed;
void entityAnswer;
