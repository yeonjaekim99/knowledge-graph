import type {
  RecallFtsCandidateResult,
  RecallSnapshotSource,
} from "../../../src/application/ports/recall-read-port.js";

declare const source: RecallSnapshotSource;

const result: Promise<RecallFtsCandidateResult> =
  source.searchFtsCandidates(["인증서버", "😀😃😄"]);
void result;

source.searchFtsCandidates(Object.freeze(["quoted \" phrase"]));

// @ts-expect-error candidates are text, never caller-supplied SQL/query objects
source.searchFtsCandidates([{ phraseLiteral: "*" }]);

// @ts-expect-error the snapshot source does not expose a raw SQL connection
source.query("SELECT * FROM journal_fts");
