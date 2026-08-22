import assert from "node:assert/strict";
import { test } from "node:test";

import {
  RecordDraftPlanningError,
  finalizeRecordDraftPlan,
  selectRecordDraftSurvivors,
} from "../../../dist/application/index.js";

const DUPLICATE_NOTE =
  "duplicate draft folded into the first stored draft";
const SUBJECT_AMBIGUITY_NOTE =
  "subject matches multiple entities; retry with an exact canonical name or confirm an alias or merge";
const OBJECT_AMBIGUITY_NOTE =
  "object matches multiple entities; retry with an exact canonical name or confirm an alias or merge";
const SECRET_NOTE =
  "Secret detected at claims[0].object_value (class=github-token); remove the secret and retry.";

function literalDraft(overrides = {}) {
  return {
    subject: "테스트 명령",
    relation: "describes",
    object_value: "pnpm test",
    ...overrides,
  };
}

function entityDraft(overrides = {}) {
  return {
    subject: "인증 시스템",
    relation: "uses",
    object: "PostgreSQL",
    ...overrides,
  };
}

function approved(inputIndex, draft) {
  return { inputIndex, draft };
}

function resolved(draftIndex, subjectId, objectId = null) {
  return {
    draftIndex,
    status: "resolved",
    subjectId,
    objectId,
  };
}

function ambiguous(draftIndex, field = "subject") {
  return {
    draftIndex,
    status: "rejected",
    reason: "ambiguous_entity",
    field,
    candidates: [
      { entityId: "e1.0", name: "Alpha" },
      { entityId: "e2.0", name: "Beta" },
    ],
    note:
      field === "subject" ? SUBJECT_AMBIGUITY_NOTE : OBJECT_AMBIGUITY_NOTE,
  };
}

function rejected(index = 0, note = SECRET_NOTE) {
  return { index, status: "rejected", note };
}

function selection(value) {
  return selectRecordDraftSurvivors({
    approvedDrafts: value.approvedDrafts,
    rejectedClaims: value.rejectedClaims ?? [],
    resolutions: value.resolutions,
  });
}

function planningFailure(code, forbidden = "synthetic-payload") {
  return (error) => {
    assert.ok(error instanceof RecordDraftPlanningError);
    assert.equal(error.code, code);
    assert.equal("cause" in error, false);
    assert.equal("input" in error, false);
    assert.equal("payload" in error, false);
    assert.equal(error.message.includes(forbidden), false);
    assert.equal(JSON.stringify(error).includes(forbidden), false);
    return true;
  };
}

test("preserves approved input order and folds canonical entity identities once", () => {
  const first = entityDraft({
    subject: "인증 시스템",
    object: "PostgreSQL",
    relation_label: "사용",
  });
  const duplicate = entityDraft({
    subject: "login",
    object: "주 DB",
    relation_label: "depends on",
    subject_kind: "service",
  });
  const other = literalDraft();

  const plan = selection({
    approvedDrafts: [approved(1, first), approved(2, duplicate), approved(4, other)],
    rejectedClaims: [rejected(0), rejected(3, "Secret detected at claims[3].subject (class=high-entropy); remove the secret and retry.")],
    resolutions: [
      resolved(1, "e1.0", "e1.1"),
      resolved(2, "e1.0", "e1.1"),
      resolved(4, "e1.2"),
    ],
  });

  assert.deepEqual(plan.survivorDraftIndexes, [1, 4]);
  assert.deepEqual(
    plan.storedDrafts.map(({ inputIndex, storedIndex, draft }) => ({
      inputIndex,
      storedIndex,
      draft,
    })),
    [
      { inputIndex: 1, storedIndex: 0, draft: first },
      { inputIndex: 4, storedIndex: 1, draft: other },
    ],
  );
  assert.deepEqual(plan.outcomes, [
    { index: 0, status: "rejected", note: SECRET_NOTE },
    { index: 1, status: "accepted", storedIndex: 0 },
    {
      index: 2,
      status: "reinforced",
      storedIndex: 0,
      duplicateOfIndex: 1,
      note: DUPLICATE_NOTE,
    },
    {
      index: 3,
      status: "rejected",
      note: "Secret detected at claims[3].subject (class=high-entropy); remove the secret and retry.",
    },
    { index: 4, status: "accepted", storedIndex: 1 },
  ]);
  assert.equal(Object.isFrozen(plan), true);
  assert.equal(Object.isFrozen(plan.storedDrafts[0].draft), true);
  assert.equal(Object.isFrozen(plan.outcomes), true);
});

test("uses canonical resolved IDs rather than display text or aliases for entity identity", () => {
  const sameTextDifferentEntities = selection({
    approvedDrafts: [approved(0, entityDraft()), approved(1, entityDraft())],
    resolutions: [
      resolved(0, "e1.0", "e1.1"),
      resolved(1, "e2.0", "e2.1"),
    ],
  });
  assert.deepEqual(sameTextDifferentEntities.survivorDraftIndexes, [0, 1]);

  const differentTextSameEntities = selection({
    approvedDrafts: [
      approved(0, entityDraft()),
      approved(
        1,
        entityDraft({
          subject: "login",
          object: "주 DB",
          subject_aliases: ["인증"],
          object_aliases: ["database"],
        }),
      ),
    ],
    resolutions: [
      resolved(0, "e1.0", "e1.1"),
      resolved(1, "e1.0", "e1.1"),
    ],
  });
  assert.deepEqual(differentTextSameEntities.survivorDraftIndexes, [0]);
  assert.equal(differentTextSameEntities.outcomes[1].status, "reinforced");
});

test("uses normative literal identity while relation, case, inner spacing and punctuation stay meaningful", () => {
  const plan = selection({
    approvedDrafts: [
      approved(0, literalDraft({ object_value: "  ｐｎｐｍ test  " })),
      approved(1, literalDraft({ object_value: "pnpm test" })),
      approved(2, literalDraft({ object_value: "PNPM test" })),
      approved(3, literalDraft({ object_value: "pnpm  test" })),
      approved(4, literalDraft({ object_value: "pnpm test!" })),
      approved(5, literalDraft({ relation: "relates_to", relation_label: "command" })),
    ],
    resolutions: Array.from({ length: 6 }, (_, index) =>
      resolved(index, "e1.0"),
    ),
  });

  assert.deepEqual(plan.survivorDraftIndexes, [0, 2, 3, 4, 5]);
  assert.equal(plan.outcomes[1].status, "reinforced");
  assert.equal(plan.outcomes[1].storedIndex, 0);
});

test("turns an entity ambiguity into only that draft's rejection", () => {
  const plan = selection({
    approvedDrafts: [approved(0, entityDraft()), approved(1, literalDraft())],
    resolutions: [ambiguous(0, "object"), resolved(1, "e3.0")],
  });

  assert.deepEqual(plan.survivorDraftIndexes, [1]);
  assert.deepEqual(plan.outcomes, [
    { index: 0, status: "rejected", note: OBJECT_AMBIGUITY_NOTE },
    { index: 1, status: "accepted", storedIndex: 0 },
  ]);
});

test("finalizes compact stored, claim and entity occurrence mappings without a commit result", () => {
  const selected = selection({
    approvedDrafts: [
      approved(1, entityDraft()),
      approved(2, entityDraft({ subject: "login", object: "주 DB" })),
      approved(3, literalDraft({ subject: "runner" })),
    ],
    rejectedClaims: [rejected(0)],
    resolutions: [
      resolved(1, "e1.0", "e1.1"),
      resolved(2, "e1.0", "e1.1"),
      resolved(3, "e9.0"),
    ],
  });

  const plan = finalizeRecordDraftPlan(selected, {
    expectedJournalSeq: 9,
    drafts: [
      resolved(1, "e1.0", "e1.1"),
      resolved(3, "e9.2"),
    ],
  });

  assert.deepEqual(plan.mappings, [
    {
      inputIndex: 1,
      storedIndex: 0,
      claimCandidateId: "c9.0",
      subjectOccurrence: {
        position: 0,
        candidateId: "e9.0",
        canonicalId: "e1.0",
      },
      objectOccurrence: {
        position: 1,
        candidateId: "e9.1",
        canonicalId: "e1.1",
      },
    },
    {
      inputIndex: 3,
      storedIndex: 1,
      claimCandidateId: "c9.1",
      subjectOccurrence: {
        position: 2,
        candidateId: "e9.2",
        canonicalId: "e9.2",
      },
      objectOccurrence: null,
    },
  ]);
  assert.deepEqual(plan.outcomes, [
    { index: 0, status: "rejected", note: SECRET_NOTE },
    {
      index: 1,
      status: "accepted",
      storedIndex: 0,
      claimCandidateId: "c9.0",
    },
    {
      index: 2,
      status: "reinforced",
      storedIndex: 0,
      duplicateOfIndex: 1,
      claimCandidateId: "c9.0",
      note: DUPLICATE_NOTE,
    },
    {
      index: 3,
      status: "accepted",
      storedIndex: 1,
      claimCandidateId: "c9.1",
    },
  ]);
  assert.equal("eventId" in plan, false);
  assert.equal("committed" in plan, false);
  assert.equal("status" in plan.mappings[0], false);
  assert.equal(Object.isFrozen(plan.mappings[0].subjectOccurrence), true);
});

test("empty and all-rejected requests consume no stored or occurrence positions", () => {
  const empty = selection({ approvedDrafts: [], resolutions: [] });
  assert.deepEqual(empty.storedDrafts, []);
  assert.deepEqual(empty.survivorDraftIndexes, []);
  assert.deepEqual(empty.outcomes, []);

  const allRejected = selection({
    approvedDrafts: [],
    rejectedClaims: [rejected(0)],
    resolutions: [],
  });
  const finalized = finalizeRecordDraftPlan(allRejected, {
    expectedJournalSeq: 12,
    drafts: [],
  });
  assert.deepEqual(finalized.mappings, []);
  assert.deepEqual(finalized.outcomes, [rejected(0)]);
});

test("rejects broken coverage, resolution parity and semantic draft shape", () => {
  const validApproved = [approved(0, entityDraft())];
  const cases = [
    {
      approvedDrafts: [approved(1, entityDraft())],
      rejectedClaims: [],
      resolutions: [resolved(1, "e1.0", "e1.1")],
    },
    {
      approvedDrafts: validApproved,
      rejectedClaims: [rejected(0)],
      resolutions: [resolved(0, "e1.0", "e1.1")],
    },
    {
      approvedDrafts: validApproved,
      resolutions: [],
    },
    {
      approvedDrafts: validApproved,
      resolutions: [resolved(1, "e1.0", "e1.1")],
    },
    {
      approvedDrafts: [approved(0, literalDraft())],
      resolutions: [resolved(0, "e1.0", "e1.1")],
    },
    {
      approvedDrafts: [approved(0, { ...entityDraft(), relation: "configures" })],
      resolutions: [resolved(0, "e1.0", "e1.1")],
    },
    {
      approvedDrafts: [approved(0, { ...entityDraft(), extra: true })],
      resolutions: [resolved(0, "e1.0", "e1.1")],
    },
  ];

  for (const value of cases) {
    assert.throws(
      () => selection(value),
      planningFailure("INVALID_RECORD_DRAFT_PLAN_INPUT"),
    );
  }
});

test("rejects forged sanitizer and ambiguity notes instead of forwarding payload", () => {
  assert.throws(
    () =>
      selection({
        approvedDrafts: [],
        rejectedClaims: [rejected(0, "token=synthetic-payload")],
        resolutions: [],
      }),
    planningFailure("INVALID_RECORD_DRAFT_PLAN_INPUT"),
  );
  assert.throws(
    () =>
      selection({
        approvedDrafts: [approved(0, entityDraft())],
        resolutions: [
          { ...ambiguous(0), note: "path=/private synthetic-payload" },
        ],
      }),
    planningFailure("INVALID_RECORD_DRAFT_PLAN_INPUT"),
  );
});

test("rejects malformed finalization before producing candidate IDs", () => {
  const selected = selection({
    approvedDrafts: [approved(0, entityDraft()), approved(1, literalDraft())],
    resolutions: [resolved(0, "e1.0", "e1.1"), resolved(1, "e1.2")],
  });
  const cases = [
    { expectedJournalSeq: 0, drafts: [resolved(0, "e1.0", "e1.1"), resolved(1, "e1.2")] },
    { expectedJournalSeq: 2, drafts: [resolved(0, "e1.0", "e1.1")] },
    { expectedJournalSeq: 2, drafts: [resolved(1, "e1.2"), resolved(0, "e1.0", "e1.1")] },
    { expectedJournalSeq: 2, drafts: [resolved(0, "e1.0"), resolved(1, "e1.2")] },
    { expectedJournalSeq: 2, drafts: [resolved(0, "e1.0", "e1.1"), resolved(1, "bad-id")] },
  ];
  for (const value of cases) {
    assert.throws(
      () => finalizeRecordDraftPlan(selected, value),
      planningFailure("INVALID_RECORD_DRAFT_FINALIZATION"),
    );
  }
});

test("contains Proxy, accessor and payload-bearing failures at both boundaries", () => {
  const poison = new Error("synthetic-payload");
  Object.defineProperties(poison, {
    cause: { enumerable: true, value: { token: "synthetic-payload" } },
    payload: { enumerable: true, value: "synthetic-payload" },
  });
  const badInputs = [
    new Proxy({}, { ownKeys() { throw poison; } }),
    Object.defineProperty({}, "approvedDrafts", {
      enumerable: true,
      get() { throw poison; },
    }),
    {
      approvedDrafts: new Proxy([], { getOwnPropertyDescriptor() { throw poison; } }),
      rejectedClaims: [],
      resolutions: [],
    },
  ];
  for (const value of badInputs) {
    assert.throws(
      () => selectRecordDraftSurvivors(value),
      planningFailure("INVALID_RECORD_DRAFT_PLAN_INPUT"),
    );
  }

  const selected = selection({ approvedDrafts: [], resolutions: [] });
  const finalization = new Proxy({}, { ownKeys() { throw poison; } });
  assert.throws(
    () => finalizeRecordDraftPlan(selected, finalization),
    planningFailure("INVALID_RECORD_DRAFT_FINALIZATION"),
  );
});

test("snapshots caller-owned drafts and results without retaining later mutation", () => {
  const draft = entityDraft({ subject_aliases: ["로그인"] });
  const resolution = resolved(0, "e1.0", "e1.1");
  const plan = selection({
    approvedDrafts: [approved(0, draft)],
    resolutions: [resolution],
  });

  draft.subject = "변조됨";
  draft.subject_aliases[0] = "변조됨";
  resolution.subjectId = "e99.0";
  assert.equal(plan.storedDrafts[0].draft.subject, "인증 시스템");
  assert.deepEqual(plan.storedDrafts[0].draft.subject_aliases, ["로그인"]);

  const finalizedInput = {
    expectedJournalSeq: 2,
    drafts: [resolved(0, "e1.0", "e1.1")],
  };
  const final = finalizeRecordDraftPlan(plan, finalizedInput);
  finalizedInput.drafts[0].subjectId = "e99.0";
  assert.equal(final.mappings[0].subjectOccurrence.canonicalId, "e1.0");
});
