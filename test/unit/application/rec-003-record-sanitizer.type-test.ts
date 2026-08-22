import type {
  ApprovedRecordDraft,
  RecordSecretDetection,
  RecordSecretSanitizationResult,
  RejectedRecordClaim,
} from "../../../src/index.js";
// @ts-expect-error sanitizer runtime remains behind the application boundary
import { sanitizeMemoryRecordSecrets as rootSanitizer } from "../../../src/index.js";
import {
  RecordSecretSanitizationError,
  sanitizeMemoryRecordSecrets,
} from "../../../src/application/index.js";

const detection: RecordSecretDetection = () => ({
  registryVersion: "secret-detector-v1",
  findings: [],
});
const result: RecordSecretSanitizationResult = sanitizeMemoryRecordSecrets(
  { raw_text: "safe", claims: [] },
  detection,
);
const approved: ApprovedRecordDraft | undefined = result.approvedDrafts[0];
const rejected: RejectedRecordClaim = {
  index: 0,
  status: "rejected",
  note: "remove the secret and retry",
};

if (approved !== undefined) {
  // @ts-expect-error accepted draft input indexes are immutable
  approved.inputIndex = 2;
}
// @ts-expect-error rejected sanitation results never expose a claim ID
rejected.claim_id = "c1.0";

void rootSanitizer;
void RecordSecretSanitizationError;
void result;
