import type {
  RecallFtsCandidateResult,
  RecallFtsRawCandidate,
  RecallRawCandidate,
  RecallSnapshotSource,
} from "../../../src/application/ports/recall-read-port.js";
import { searchRecallFtsFallback } from "../../../src/application/recall-fts-query.js";
import type { RecallQuerySurfaceSelection } from "../../../src/domain/recall-query-surface.js";

declare const source: RecallSnapshotSource;

const result: Promise<RecallFtsCandidateResult> =
  source.searchFtsCandidates(["인증서버", "😀😃😄"]);
void result;

declare const ftsRaw: RecallFtsRawCandidate;
const overviewReusableRaw: RecallRawCandidate = ftsRaw;
void overviewReusableRaw;

source.searchFtsCandidates(Object.freeze(["quoted \" phrase"]));

declare const selection: RecallQuerySurfaceSelection;
const fallback: Promise<RecallFtsCandidateResult> = searchRecallFtsFallback(
  source,
  selection,
);
void fallback;

// @ts-expect-error candidates are text, never caller-supplied SQL/query objects
source.searchFtsCandidates([{ phraseLiteral: "*" }]);

// @ts-expect-error the snapshot source does not expose a raw SQL connection
source.query("SELECT * FROM journal_fts");
