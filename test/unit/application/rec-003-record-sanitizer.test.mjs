import assert from "node:assert/strict";
import { test } from "node:test";

import {
  RecordSecretSanitizationError,
  sanitizeMemoryRecordSecrets,
} from "../../../dist/application/index.js";
import {
  SECRET_DETECTOR_VERSION,
} from "../../../dist/domain/index.js";

const SYNTHETIC_GITHUB_TOKEN = `ghp_${"SyntheticOnly1234567890".repeat(2)}`;
const SYNTHETIC_ENTROPY_TOKEN = "Aa0_Bb1-Cc2+Dd3/Ee4=";

function entityDraft(overrides = {}) {
  return {
    subject: "저장소",
    relation: "uses",
    object: "SQLite",
    ...overrides,
  };
}

function literalDraft(overrides = {}) {
  return {
    subject: "설정",
    relation: "describes",
    object_value: "enabled",
    ...overrides,
  };
}

function input(claims, overrides = {}) {
  return {
    raw_text: "안전한 원문",
    claims,
    ...overrides,
  };
}

function emptyDetection() {
  return {
    registryVersion: SECRET_DETECTOR_VERSION,
    findings: [],
  };
}

function syntheticFinding(value, secretClass = "github-token") {
  return {
    registryVersion: SECRET_DETECTOR_VERSION,
    findings: [
      {
        secretClass,
        startCodeUnit: 0,
        endCodeUnit: value.length,
      },
    ],
  };
}

function sanitizerFailure(code, forbiddenValue) {
  return (error) => {
    assert.ok(error instanceof RecordSecretSanitizationError);
    assert.equal(error.code, code);
    assert.equal("cause" in error, false);
    assert.equal("value" in error, false);
    assert.equal(error.message.includes(forbiddenValue), false);
    assert.equal(JSON.stringify(error).includes(forbiddenValue), false);
    return true;
  };
}

test("raw findings are masked by class without retaining either submitted secret", () => {
  const rawText = `before ${SYNTHETIC_GITHUB_TOKEN} middle ${SYNTHETIC_ENTROPY_TOKEN} after`;
  const result = sanitizeMemoryRecordSecrets(input([], { raw_text: rawText }));

  assert.equal(
    result.maskedRawText,
    "before [REDACTED:GITHUB-TOKEN] middle [REDACTED:HIGH-ENTROPY] after",
  );
  assert.equal(result.maskedRawText.includes(SYNTHETIC_GITHUB_TOKEN), false);
  assert.equal(result.maskedRawText.includes(SYNTHETIC_ENTROPY_TOKEN), false);
  assert.deepEqual(result.approvedDrafts, []);
  assert.deepEqual(result.rejectedClaims, []);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.approvedDrafts), true);
  assert.equal(Object.isFrozen(result.rejectedClaims), true);
});

test("one secret draft is rejected while safe drafts retain original input indexes", () => {
  const claims = [
    literalDraft({ object_value: SYNTHETIC_GITHUB_TOKEN }),
    entityDraft({ subject_aliases: ["DB"] }),
  ];
  const result = sanitizeMemoryRecordSecrets(
    input(claims, {
      raw_text: `토큰 ${SYNTHETIC_GITHUB_TOKEN}은 버리고 SQLite는 기억한다`,
    }),
  );

  assert.equal(result.approvedDrafts.length, 1);
  assert.equal(result.approvedDrafts[0].inputIndex, 1);
  assert.equal(result.approvedDrafts[0].draft.subject, "저장소");
  assert.equal(Object.isFrozen(result.approvedDrafts[0]), true);
  assert.equal(Object.isFrozen(result.approvedDrafts[0].draft), true);
  assert.equal(Object.isFrozen(result.approvedDrafts[0].draft.subject_aliases), true);

  assert.deepEqual(
    result.rejectedClaims.map(({ index, status }) => ({ index, status })),
    [{ index: 0, status: "rejected" }],
  );
  const note = result.rejectedClaims[0].note;
  assert.match(note, /claims\[0\]\.object_value/);
  assert.match(note, /github-token/);
  assert.match(note, /retry/i);
  assert.equal(note.includes(SYNTHETIC_GITHUB_TOKEN), false);
  assert.equal(result.maskedRawText.includes(SYNTHETIC_GITHUB_TOKEN), false);

  claims[1].subject = "변조됨";
  claims[1].subject_aliases[0] = "변조됨";
  assert.equal(result.approvedDrafts[0].draft.subject, "저장소");
  assert.deepEqual(result.approvedDrafts[0].draft.subject_aliases, ["DB"]);
});

test("normal recording permits all drafts to be rejected and preserves masked raw text", () => {
  const result = sanitizeMemoryRecordSecrets(
    input(
      [
        literalDraft({ object_value: SYNTHETIC_GITHUB_TOKEN }),
        entityDraft({ object: SYNTHETIC_GITHUB_TOKEN }),
      ],
      { raw_text: `비밀 ${SYNTHETIC_GITHUB_TOKEN}` },
    ),
  );

  assert.deepEqual(result.approvedDrafts, []);
  assert.deepEqual(
    result.rejectedClaims.map(({ index }) => index),
    [0, 1],
  );
  assert.equal(result.maskedRawText, "비밀 [REDACTED:GITHUB-TOKEN]");
});

test("every stored ClaimDraft string category rejects only its owning draft", () => {
  const secret = "password=synthetic-only-value";
  const cases = [
    [entityDraft({ subject: secret }), "claims[0].subject"],
    [entityDraft({ subject_kind: secret }), "claims[0].subject_kind"],
    [entityDraft({ object: secret }), "claims[0].object"],
    [entityDraft({ object_kind: secret }), "claims[0].object_kind"],
    [literalDraft({ object_value: secret }), "claims[0].object_value"],
    [entityDraft({ relation_label: secret }), "claims[0].relation_label"],
    [
      entityDraft({ subject_aliases: ["safe", secret] }),
      "claims[0].subject_aliases[1]",
    ],
    [entityDraft({ object_aliases: [secret] }), "claims[0].object_aliases[0]"],
  ];

  for (const [draft, expectedPath] of cases) {
    const result = sanitizeMemoryRecordSecrets(input([draft]));
    assert.deepEqual(result.approvedDrafts, [], expectedPath);
    assert.equal(result.rejectedClaims.length, 1, expectedPath);
    assert.equal(result.rejectedClaims[0].note.includes(expectedPath), true);
    assert.equal(result.rejectedClaims[0].note.includes(secret), false);
  }
});

test("raw then draft fields use the exact trusted detector contexts and ADR order", () => {
  const calls = [];
  const detect = (value, context) => {
    calls.push([value, context]);
    return emptyDetection();
  };
  const draft = entityDraft({
    subject_kind: "component",
    object_kind: "database",
    relation_label: "사용",
    subject_aliases: ["repo", "저장소 별칭"],
    object_aliases: ["DB"],
  });

  const result = sanitizeMemoryRecordSecrets(input([draft]), detect);
  assert.equal(result.approvedDrafts.length, 1);
  assert.deepEqual(
    calls.map(([, context]) => context),
    [
      "raw_text",
      "claim.subject",
      "claim.subject_kind",
      "claim.object",
      "claim.object_kind",
      "claim.relation_label",
      "claim.subject_alias",
      "claim.subject_alias",
      "claim.object_alias",
    ],
  );
});

test("unsafe detector positions redact all raw text and reject semantic draft fields", () => {
  const unsafeFinding = {
    registryVersion: SECRET_DETECTOR_VERSION,
    findings: [
      {
        secretClass: "github-token",
        startCodeUnit: -1,
        endCodeUnit: 2,
      },
    ],
  };
  const rawFallback = sanitizeMemoryRecordSecrets(
    input([entityDraft()]),
    (_value, context) =>
      context === "raw_text" ? unsafeFinding : emptyDetection(),
  );
  assert.equal(rawFallback.maskedRawText, "[REDACTED:SECRET]");
  assert.equal(rawFallback.approvedDrafts.length, 1);

  const rejectedDraft = sanitizeMemoryRecordSecrets(
    input([entityDraft()]),
    (_value, context) =>
      context === "claim.subject" ? unsafeFinding : emptyDetection(),
  );
  assert.deepEqual(rejectedDraft.approvedDrafts, []);
  assert.match(rejectedDraft.rejectedClaims[0].note, /class=secret/);
});

test("detector exceptions and malformed results fail closed without payload echo", () => {
  const submitted = `do-not-echo-${SYNTHETIC_GITHUB_TOKEN}`;
  assert.throws(
    () =>
      sanitizeMemoryRecordSecrets(
        input([], { raw_text: submitted }),
        () => {
          throw new Error(submitted);
        },
      ),
    sanitizerFailure("DETECTOR_FAILED", submitted),
  );
  assert.throws(
    () => sanitizeMemoryRecordSecrets(input([], { raw_text: submitted }), () => ({})),
    sanitizerFailure("DETECTOR_FAILED", submitted),
  );
});

test("reinterpretation rejects the whole successor when any draft contains a secret", () => {
  const reinterpretInput = input(
    [entityDraft(), literalDraft({ object_value: SYNTHETIC_GITHUB_TOKEN })],
    {
      raw_text: `재해석 ${SYNTHETIC_GITHUB_TOKEN}`,
      supersedes: `ev_${"0".repeat(26)}`,
      reinterpret_approval: `ra_${"A".repeat(43)}`,
    },
  );

  assert.throws(
    () => sanitizeMemoryRecordSecrets(reinterpretInput),
    (error) => {
      assert.ok(error instanceof RecordSecretSanitizationError);
      assert.equal(error.code, "REINTERPRET_DRAFT_REJECTED");
      assert.equal(error.rejections.length, 1);
      assert.equal(error.rejections[0].index, 1);
      assert.match(error.rejections[0].note, /retry/i);
      assert.equal(JSON.stringify(error).includes(SYNTHETIC_GITHUB_TOKEN), false);
      return true;
    },
  );
});

test("raw-only reinterpretation remains valid and masks its source independently", () => {
  const result = sanitizeMemoryRecordSecrets(
    input([], {
      raw_text: `재해석 ${SYNTHETIC_GITHUB_TOKEN}`,
      supersedes: `ev_${"0".repeat(26)}`,
      reinterpret_approval: `ra_${"A".repeat(43)}`,
    }),
  );
  assert.equal(result.maskedRawText, "재해석 [REDACTED:GITHUB-TOKEN]");
  assert.deepEqual(result.approvedDrafts, []);
  assert.deepEqual(result.rejectedClaims, []);
});

test("approved literal drafts are immutable clones with deterministic input order", () => {
  const claims = [literalDraft(), entityDraft(), literalDraft({ subject: "두 번째 값" })];
  const result = sanitizeMemoryRecordSecrets(input(claims));

  assert.deepEqual(
    result.approvedDrafts.map(({ inputIndex }) => inputIndex),
    [0, 1, 2],
  );
  assert.notEqual(result.approvedDrafts[0].draft, claims[0]);
  for (const approved of result.approvedDrafts) {
    assert.equal(Object.isFrozen(approved), true);
    assert.equal(Object.isFrozen(approved.draft), true);
  }
});

test("UTF-16 findings preserve adjacent astral text while masking exact slices", () => {
  const rawText = `🙂${SYNTHETIC_GITHUB_TOKEN}끝`;
  const result = sanitizeMemoryRecordSecrets(
    input([], { raw_text: rawText }),
    () => ({
      registryVersion: SECRET_DETECTOR_VERSION,
      findings: [
        {
          secretClass: "github-token",
          startCodeUnit: 2,
          endCodeUnit: 2 + SYNTHETIC_GITHUB_TOKEN.length,
        },
      ],
    }),
  );

  assert.equal(result.maskedRawText, "🙂[REDACTED:GITHUB-TOKEN]끝");
});

test("overlapping, out-of-order, and split-surrogate positions are unsafe", () => {
  const cases = [
    [
      "abcdef",
      [
        { secretClass: "github-token", startCodeUnit: 1, endCodeUnit: 4 },
        { secretClass: "jwt", startCodeUnit: 3, endCodeUnit: 5 },
      ],
    ],
    [
      "abcdef",
      [
        { secretClass: "github-token", startCodeUnit: 3, endCodeUnit: 5 },
        { secretClass: "jwt", startCodeUnit: 0, endCodeUnit: 2 },
      ],
    ],
    [
      "🙂secret",
      [{ secretClass: "github-token", startCodeUnit: 1, endCodeUnit: 3 }],
    ],
  ];

  for (const [rawText, findings] of cases) {
    const result = sanitizeMemoryRecordSecrets(
      input([], { raw_text: rawText }),
      () => ({ registryVersion: SECRET_DETECTOR_VERSION, findings }),
    );
    assert.equal(result.maskedRawText, "[REDACTED:SECRET]");
  }
});

test("a detector failure in a later field cannot hide behind an earlier draft hit", () => {
  const submitted = `unsafe-${SYNTHETIC_GITHUB_TOKEN}`;
  const calls = [];
  const detect = (value, context) => {
    calls.push(context);
    if (context === "claim.subject") {
      return syntheticFinding(value);
    }
    if (context === "claim.object") {
      throw new Error(`${submitted} SELECT * FROM secrets /tmp/recall.db`);
    }
    return emptyDetection();
  };

  assert.throws(
    () => sanitizeMemoryRecordSecrets(input([entityDraft()]), detect),
    sanitizerFailure("DETECTOR_FAILED", submitted),
  );
  assert.deepEqual(calls, ["raw_text", "claim.subject", "claim.object"]);
});

test("unknown classes and payload-bearing detector results fail closed", () => {
  const submitted = `unknown-${SYNTHETIC_GITHUB_TOKEN}`;
  for (const result of [
    {
      registryVersion: SECRET_DETECTOR_VERSION,
      findings: [
        { secretClass: "unknown", startCodeUnit: 0, endCodeUnit: 1 },
      ],
    },
    {
      registryVersion: SECRET_DETECTOR_VERSION,
      findings: [],
      matchedText: submitted,
    },
  ]) {
    assert.throws(
      () =>
        sanitizeMemoryRecordSecrets(
          input([], { raw_text: submitted }),
          () => result,
        ),
      sanitizerFailure("DETECTOR_FAILED", submitted),
    );
  }
});

test("sanitation snapshots caller-owned raw and drafts before detector execution", () => {
  const recordInput = input([
    entityDraft({ subject_aliases: ["repo"], object_aliases: ["DB"] }),
  ]);
  const detect = () => {
    recordInput.raw_text = SYNTHETIC_GITHUB_TOKEN;
    recordInput.claims[0].subject = SYNTHETIC_GITHUB_TOKEN;
    recordInput.claims[0].subject_aliases[0] = SYNTHETIC_GITHUB_TOKEN;
    recordInput.claims[0].object_aliases[0] = SYNTHETIC_GITHUB_TOKEN;
    return emptyDetection();
  };

  const result = sanitizeMemoryRecordSecrets(recordInput, detect);
  assert.equal(result.maskedRawText, "안전한 원문");
  assert.equal(result.approvedDrafts[0].draft.subject, "저장소");
  assert.deepEqual(result.approvedDrafts[0].draft.subject_aliases, ["repo"]);
  assert.deepEqual(result.approvedDrafts[0].draft.object_aliases, ["DB"]);
});
