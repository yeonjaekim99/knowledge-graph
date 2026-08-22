import {
  formatRecallClaimBrief,
  rankRecallClaims,
} from "../../../src/application/recall-ranking.js";
import type { RecallValidClaimSource } from "../../../src/application/ports/recall-read-port.js";
import type { RecallRankedClaimCandidate } from "../../../src/domain/recall-ranking.js";

declare const source: RecallValidClaimSource;

const ranked: Promise<readonly RecallRankedClaimCandidate[]> = rankRecallClaims(
  source,
  {
    limit: 10,
    reached: [
      {
        claimId: "c1.0",
        depth: 0,
        seedOrder: 0,
        anchorId: "e1.0",
        path: "인증 → JWT",
        hops: 1,
      },
    ],
  },
);

const brief: string = formatRecallClaimBrief({
  subjectName: "테스트 명령",
  relation: "describes",
  relationLabel: null,
  objectName: null,
  objectValue: "pnpm test",
});

void ranked;
void brief;
void source.selectRankedClaims([{ claimId: "c1.0", depth: 0 }], 11);

// @ts-expect-error ranking requires the public limit used for the limit+1 probe
void rankRecallClaims(source, { reached: [] });

// @ts-expect-error only RCL-005 reached claims, not raw claim IDs, enter ranking
void rankRecallClaims(source, { limit: 10, reached: ["c1.0"] });

// @ts-expect-error brief formatting requires exactly one canonical object display
void formatRecallClaimBrief({
  subjectName: "A",
  relation: "uses",
  relationLabel: null,
  objectName: "B",
});
