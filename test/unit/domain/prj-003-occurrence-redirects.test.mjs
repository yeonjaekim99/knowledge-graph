import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ProjectionIdentifierError,
  assertCanonicalIdentifier,
  chooseCanonicalIdentifier,
  compareOccurrenceIdentifiers,
  createIdentifierRedirectRegistry,
  dryRunIdentityRuleChange,
  enumerateOccurrenceCandidates,
  isCanonicalIdentifier,
  resolveCanonicalIdentifier,
} from "../../../dist/domain/index.js";

const SCOPE_A = "u:alice/p:recall";
const SCOPE_B = "u:bob/p:recall";

function identifierFailure(code, forbiddenValue) {
  return (error) => {
    assert.ok(error instanceof ProjectionIdentifierError);
    assert.equal(error.code, code);
    assert.equal("value" in error, false);
    if (forbiddenValue !== undefined) {
      assert.equal(error.message.includes(forbiddenValue), false);
    }
    return true;
  };
}

function anchor(id, kind = "entity", scopeKey = SCOPE_A) {
  return { id, kind, scopeKey };
}

function redirect(oldId, newId, kind = "entity", reason = "deduplicated") {
  return { oldId, newId, kind, reason };
}

test("stored draft order allocates every subject and entity object occurrence", () => {
  const candidates = enumerateOccurrenceCandidates({
    seq: 9,
    parsed: [
      {
        subject: "인증 시스템",
        object: "PostgreSQL",
        subject_aliases: ["로그인"],
      },
      {
        subject: "인증 시스템",
        object_value: "pnpm test",
        object_aliases: ["소비하지 않음"],
      },
      { subject: "인증 시스템", object: "Redis" },
    ],
  });

  assert.deepEqual(candidates, [
    {
      draftIndex: 0,
      claimId: "c9.0",
      subjectId: "e9.0",
      objectId: "e9.1",
    },
    {
      draftIndex: 1,
      claimId: "c9.1",
      subjectId: "e9.2",
      objectId: null,
    },
    {
      draftIndex: 2,
      claimId: "c9.2",
      subjectId: "e9.3",
      objectId: "e9.4",
    },
  ]);
  assert.equal(Object.isFrozen(candidates), true);
  assert.equal(candidates.every(Object.isFrozen), true);
});

test("occurrence allocation rejects unsafe seq and malformed stored draft shape without evaluating getters", () => {
  assert.throws(
    () => enumerateOccurrenceCandidates({ seq: 0, parsed: [] }),
    identifierFailure("INVALID_OCCURRENCE_INPUT"),
  );
  assert.throws(
    () => enumerateOccurrenceCandidates({ seq: 1, parsed: {} }),
    identifierFailure("INVALID_OCCURRENCE_INPUT"),
  );
  assert.throws(
    () =>
      enumerateOccurrenceCandidates({
        seq: 1,
        parsed: [{ subject: "값", object: "개체", object_value: "리터럴" }],
      }),
    identifierFailure("INVALID_OCCURRENCE_INPUT"),
  );

  let getterEvaluated = false;
  const getterDraft = { object: "개체" };
  Object.defineProperty(getterDraft, "subject", {
    enumerable: true,
    get() {
      getterEvaluated = true;
      return "비밀 subject";
    },
  });
  assert.throws(
    () => enumerateOccurrenceCandidates({ seq: 1, parsed: [getterDraft] }),
    identifierFailure("INVALID_OCCURRENCE_INPUT", "비밀 subject"),
  );
  assert.equal(getterEvaluated, false);

  let slotGetterEvaluated = false;
  const getterParsed = [];
  Object.defineProperty(getterParsed, "0", {
    enumerable: true,
    get() {
      slotGetterEvaluated = true;
      return { subject: "비밀 draft", object: "개체" };
    },
  });
  assert.throws(
    () => enumerateOccurrenceCandidates({ seq: 1, parsed: getterParsed }),
    identifierFailure("INVALID_OCCURRENCE_INPUT", "비밀 draft"),
  );
  assert.equal(slotGetterEvaluated, false);
});

test("canonical event/entity/claim IDs are exact and occurrence ordering is numeric", () => {
  assert.equal(isCanonicalIdentifier("c1.0", "unsupported-kind"), false);
  assert.equal(
    assertCanonicalIdentifier(
      "ev_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      "event",
    ),
    "ev_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  );
  assert.equal(assertCanonicalIdentifier("e9.10", "entity"), "e9.10");
  assert.equal(assertCanonicalIdentifier("c10.2", "claim"), "c10.2");
  assert.equal(
    compareOccurrenceIdentifiers("e9.10", "e10.2", "entity"),
    -1,
  );
  assert.equal(
    compareOccurrenceIdentifiers("c10.2", "c10.10", "claim"),
    -1,
  );

  for (const [value, kind] of [
    ["ev_81ARZ3NDEKTSV4RRFFQ69G5FAV", "event"],
    ["ev_01arz3ndektsv4rrffq69g5fav", "event"],
    ["e0.0", "entity"],
    ["e01.0", "entity"],
    ["e1.0 ", "entity"],
    ["c1.-1", "claim"],
    ["c1.0", "entity"],
  ]) {
    assert.throws(
      () => assertCanonicalIdentifier(value, kind),
      identifierFailure("INVALID_IDENTIFIER", value),
    );
  }
});

test("canonical selection uses numeric occurrence order except for explicit merge keep", () => {
  assert.deepEqual(
    chooseCanonicalIdentifier({
      candidates: ["e10.2", "e9.10", "e10.11"],
      kind: "entity",
      reason: "deduplicated",
      keepId: null,
    }),
    {
      canonicalId: "e9.10",
      redirects: [
        redirect("e10.2", "e9.10"),
        redirect("e10.11", "e9.10"),
      ],
    },
  );
  assert.deepEqual(
    chooseCanonicalIdentifier({
      candidates: ["c12.10", "c12.2"],
      kind: "claim",
      reason: "rule_change",
      keepId: null,
    }),
    {
      canonicalId: "c12.2",
      redirects: [
        redirect("c12.10", "c12.2", "claim", "rule_change"),
      ],
    },
  );
  assert.deepEqual(
    chooseCanonicalIdentifier({
      candidates: ["e1.0", "e9.0"],
      kind: "entity",
      reason: "merge",
      keepId: "e9.0",
    }),
    {
      canonicalId: "e9.0",
      redirects: [redirect("e1.0", "e9.0", "entity", "merge")],
    },
  );
  assert.throws(
    () =>
      chooseCanonicalIdentifier({
        candidates: ["e1.0", "e2.0"],
        kind: "entity",
        reason: "merge",
        keepId: null,
      }),
    identifierFailure("INVALID_CANONICAL_SELECTION"),
  );
});

test("redirect registry compresses every chain to one canonical target and resolves scope-bound IDs", () => {
  const registry = createIdentifierRedirectRegistry({
    anchors: [anchor("e3.0"), anchor("e1.0"), anchor("e2.0")],
    redirects: [
      redirect("e1.0", "e2.0"),
      redirect("e2.0", "e3.0", "entity", "merge"),
    ],
  });

  assert.deepEqual(registry.redirects, [
    redirect("e1.0", "e3.0"),
    redirect("e2.0", "e3.0", "entity", "merge"),
  ]);
  assert.equal(
    resolveCanonicalIdentifier(registry, {
      identifier: "e1.0",
      expectedKind: "entity",
      expectedScope: SCOPE_A,
    }),
    "e3.0",
  );
  assert.equal(
    resolveCanonicalIdentifier(registry, {
      identifier: "e3.0",
      expectedKind: "entity",
      expectedScope: SCOPE_A,
    }),
    "e3.0",
  );
  assert.equal(Object.isFrozen(registry), true);
  assert.equal(Object.isFrozen(registry.anchors), true);
  assert.equal(registry.anchors.every(Object.isFrozen), true);
  assert.equal(Object.isFrozen(registry.redirects), true);
  assert.equal(registry.redirects.every(Object.isFrozen), true);

  const claimRegistry = createIdentifierRedirectRegistry({
    anchors: [anchor("c9.10", "claim"), anchor("c10.2", "claim")],
    redirects: [
      redirect("c10.2", "c9.10", "claim", "rule_change"),
    ],
  });
  assert.equal(
    resolveCanonicalIdentifier(claimRegistry, {
      identifier: "c10.2",
      expectedKind: "claim",
      expectedScope: SCOPE_A,
    }),
    "c9.10",
  );
});

test("redirect registry rejects self, dangling, duplicate, cycle, kind, and scope corruption safely", () => {
  const failures = [
    [
      {
        anchors: [anchor("e1.0")],
        redirects: [redirect("e1.0", "e1.0")],
      },
      "REDIRECT_SELF_REFERENCE",
    ],
    [
      {
        anchors: [anchor("e1.0")],
        redirects: [redirect("e1.0", "e2.0")],
      },
      "REDIRECT_DANGLING_TARGET",
    ],
    [
      {
        anchors: [anchor("e1.0"), anchor("e2.0"), anchor("e3.0")],
        redirects: [
          redirect("e1.0", "e2.0"),
          redirect("e1.0", "e3.0"),
        ],
      },
      "INVALID_REDIRECT_REGISTRY",
    ],
    [
      {
        anchors: [anchor("e1.0"), anchor("e2.0")],
        redirects: [
          redirect("e1.0", "e2.0"),
          redirect("e2.0", "e1.0"),
        ],
      },
      "REDIRECT_CYCLE",
    ],
    [
      {
        anchors: [anchor("e1.0"), anchor("c2.0", "claim")],
        redirects: [redirect("e1.0", "c2.0")],
      },
      "REDIRECT_KIND_MISMATCH",
    ],
    [
      {
        anchors: [anchor("e1.0"), anchor("e2.0", "entity", SCOPE_B)],
        redirects: [redirect("e1.0", "e2.0")],
      },
      "REDIRECT_SCOPE_MISMATCH",
    ],
  ];

  for (const [value, code] of failures) {
    assert.throws(
      () => createIdentifierRedirectRegistry(value),
      identifierFailure(code),
    );
  }

  const registry = createIdentifierRedirectRegistry({
    anchors: [anchor("e1.0")],
    redirects: [],
  });
  assert.throws(
    () =>
      resolveCanonicalIdentifier(registry, {
        identifier: "e0.비밀",
        expectedKind: "entity",
        expectedScope: SCOPE_A,
      }),
    identifierFailure("INVALID_IDENTIFIER", "비밀"),
  );
  assert.throws(
    () =>
      resolveCanonicalIdentifier(registry, {
        identifier: "e1.0",
        expectedKind: "entity",
        expectedScope: SCOPE_B,
      }),
    identifierFailure("REDIRECT_SCOPE_MISMATCH"),
  );
});

test("redirect depth allows 32 hops and rejects the 33rd", () => {
  function chain(hops) {
    return {
      anchors: Array.from({ length: hops + 1 }, (_, index) =>
        anchor(`e${index + 1}.0`),
      ),
      redirects: Array.from({ length: hops }, (_, index) =>
        redirect(`e${index + 1}.0`, `e${index + 2}.0`),
      ),
    };
  }

  const registry = createIdentifierRedirectRegistry(chain(32));
  assert.equal(
    resolveCanonicalIdentifier(registry, {
      identifier: "e1.0",
      expectedKind: "entity",
      expectedScope: SCOPE_A,
    }),
    "e33.0",
  );
  assert.throws(
    () => createIdentifierRedirectRegistry(chain(33)),
    identifierFailure("REDIRECT_TOO_DEEP"),
  );
});

test("rules dry-run plans deterministic many-to-one redirects without mutation", () => {
  const input = {
    occurrences: [
      {
        occurrenceId: "e10.2",
        currentCanonicalId: "e10.2",
        kind: "entity",
        scopeKey: SCOPE_A,
        nextIdentityKey: "shared-normal",
      },
      {
        occurrenceId: "e9.10",
        currentCanonicalId: "e9.10",
        kind: "entity",
        scopeKey: SCOPE_A,
        nextIdentityKey: "shared-normal",
      },
    ],
  };
  const before = structuredClone(input);
  const result = dryRunIdentityRuleChange(input);
  const reversed = dryRunIdentityRuleChange({
    occurrences: input.occurrences.slice().reverse(),
  });

  assert.deepEqual(result, {
    status: "safe",
    redirects: [redirect("e10.2", "e9.10", "entity", "rule_change")],
    maintenanceCandidates: [],
  });
  assert.deepEqual(reversed, result);
  assert.deepEqual(input, before);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.redirects), true);
});

test("rules dry-run blocks one-to-many splits and emits ID-only maintenance candidates", () => {
  const occurrences = [
    {
      occurrenceId: "e4.0",
      currentCanonicalId: "e4.0",
      kind: "entity",
      scopeKey: SCOPE_A,
      nextIdentityKey: "auth-service",
    },
    {
      occurrenceId: "e5.0",
      currentCanonicalId: "e4.0",
      kind: "entity",
      scopeKey: SCOPE_A,
      nextIdentityKey: "billing-service",
    },
    {
      occurrenceId: "e6.0",
      currentCanonicalId: "e4.0",
      kind: "entity",
      scopeKey: SCOPE_A,
      nextIdentityKey: "billing-service",
    },
  ];
  const result = dryRunIdentityRuleChange({ occurrences });
  const reversed = dryRunIdentityRuleChange({
    occurrences: occurrences.slice().reverse(),
  });

  assert.deepEqual(result, {
    status: "blocked",
    redirects: [],
    maintenanceCandidates: [
      {
        currentCanonicalId: "e4.0",
        kind: "entity",
        scopeKey: SCOPE_A,
        retainedOccurrenceId: "e4.0",
        splitOccurrenceIds: ["e5.0"],
      },
    ],
  });
  assert.deepEqual(reversed, result);
  assert.equal(JSON.stringify(result).includes("auth-service"), false);
  assert.equal(JSON.stringify(result).includes("billing-service"), false);

  assert.throws(
    () =>
      dryRunIdentityRuleChange({
        occurrences: [
          {
            ...occurrences[0],
            currentCanonicalId: "e99.0",
          },
        ],
      }),
    identifierFailure("INVALID_RULES_DRY_RUN_INPUT"),
  );
});
