import type {
  ClaimDraft,
  MemoryRecordInput,
  RecordClaimResult,
  RecordResult,
} from "../../../src/index.js";
// @ts-expect-error accepted status calculation facts remain application-internal
import type { AcceptedRecordClaimStatusFacts } from "../../../src/index.js";

const entityDraft: ClaimDraft = {
  subject: "인증 시스템",
  subject_kind: "service",
  relation: "uses",
  object: "PostgreSQL",
  object_kind: "database",
  subject_aliases: ["로그인"],
  object_aliases: ["주 DB"],
};
const literalDraft: ClaimDraft = {
  subject: "테스트 명령",
  relation: "describes",
  object_value: "pnpm test",
};
const normalInput: MemoryRecordInput = {
  raw_text: "테스트 명령은 pnpm test다.",
  claims: [literalDraft],
};
const reinterpretInput: MemoryRecordInput = {
  raw_text: "인증 시스템은 PostgreSQL을 사용한다.",
  claims: [entityDraft],
  supersedes: `ev_0${"A".repeat(25)}`,
  reinterpret_approval: `ra_${"A".repeat(43)}`,
};
const created: RecordClaimResult = {
  index: 0,
  status: "created",
  claim_id: "c1.0",
};
const rejected: RecordClaimResult = {
  index: 1,
  status: "rejected",
  note: "use one canonical subject",
};
const result: RecordResult = {
  event_id: `ev_0${"A".repeat(25)}`,
  claims: [created, rejected],
};

void normalInput;
void reinterpretInput;
void result;

const inputWithTrustedScope: MemoryRecordInput = {
  raw_text: "forged scope",
  claims: [],
  // @ts-expect-error trusted scope is not a tool input
  scope_key: "u:alice/p:recall",
};

const invalidRelation: ClaimDraft = {
  subject: "A",
  // @ts-expect-error relation is the closed ADR-004 vocabulary
  relation: "configures",
  object: "B",
};

// @ts-expect-error accepted result branches require claim_id
const acceptedWithoutClaimId: RecordClaimResult = {
  index: 0,
  status: "created",
};

const rejectedWithClaimId: RecordClaimResult = {
  index: 0,
  status: "rejected",
  note: "retry",
  // @ts-expect-error rejected result branches never expose claim_id
  claim_id: "c1.0",
};

void inputWithTrustedScope;
void invalidRelation;
void acceptedWithoutClaimId;
void rejectedWithClaimId;
