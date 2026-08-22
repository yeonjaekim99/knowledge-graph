import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ClaimProjectionError,
  preScanProjectionEvents,
  projectClaimSupportState,
  reduceClaimSupportState,
  reduceEntitySurfaceKinds,
} from "../../../dist/domain/index.js";

const SCOPE = "u:claim-user/p:recall";
const RULES_VERSION = "projection-v1";
const BASE_TIME = 1_700_000_000;

function eventId(seq) {
  return `ev_${String(seq).padStart(26, "0")}`;
}

function statementBody({
  rawText,
  parsed,
  provenance = "user_stated",
  ttl = "permanent",
  supersedes,
}) {
  return {
    raw_text: rawText,
    parsed,
    provenance,
    ttl,
    ...(supersedes === undefined ? {} : { supersedes }),
  };
}

function journalEvent(seq, kind, body, createdAt = BASE_TIME + seq) {
  return {
    seq,
    eventId: eventId(seq),
    scopeKey: SCOPE,
    kind,
    bodyJson: JSON.stringify(body),
    actor: "unit-agent",
    branch: "prj-006",
    session: null,
    createdAt,
  };
}

function statementEvent(seq, options) {
  return journalEvent(
    seq,
    "statement",
    statementBody({
      rawText: options.rawText ?? `statement ${seq}`,
      parsed: options.parsed,
      provenance: options.provenance,
      ttl: options.ttl,
      supersedes: options.supersedes,
    }),
    options.createdAt,
  );
}

function claimRetraction(seq, claimId) {
  return journalEvent(seq, "retraction", {
    target: { claim_id: claimId },
  });
}

function statementRetraction(seq, targetEventId) {
  return journalEvent(seq, "retraction", {
    target: { event_id: targetEventId, cascade: false },
  });
}

function replayInput(events) {
  return { scopeKey: SCOPE, rulesVersion: RULES_VERSION, events };
}

function entityDraft(subject, relation, object, options = {}) {
  return { subject, relation, object, ...options };
}

function literalDraft(subject, relation, objectValue, options = {}) {
  return { subject, relation, object_value: objectValue, ...options };
}

function claimFailure(code, forbiddenValue) {
  return (error) => {
    assert.ok(error instanceof ClaimProjectionError);
    assert.equal(error.code, code);
    assert.equal("value" in error, false);
    assert.equal("cause" in error, false);
    if (forbiddenValue !== undefined) {
      assert.equal(error.message.includes(forbiddenValue), false);
    }
    return true;
  };
}

function assertDeepFrozen(value) {
  if (value === null || typeof value !== "object") {
    return;
  }
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) {
    assertDeepFrozen(child);
  }
}

function statesByValue(result) {
  return Object.fromEntries(
    result.claims.map((claim) => [claim.objectValue, claim.state]),
  );
}

test("anchors every occurrence and reinforces one canonical claim", () => {
  const input = replayInput([
    statementEvent(1, {
      parsed: [entityDraft("인증 시스템", "uses", "PostgreSQL")],
    }),
    statementEvent(2, {
      parsed: [entityDraft("인증-시스템", "uses", "Postgre_SQL")],
    }),
  ]);
  const before = structuredClone(input);

  const result = projectClaimSupportState(input);

  assert.deepEqual(result.claimAnchors, [
    { id: "c1.0", kind: "claim", scopeKey: SCOPE },
    { id: "c2.0", kind: "claim", scopeKey: SCOPE },
  ]);
  assert.deepEqual(result.claims, [
    {
      id: "c1.0",
      scopeKey: SCOPE,
      subjectId: "e1.0",
      relation: "uses",
      objectId: "e1.1",
      objectValue: null,
      state: "active",
      originSeq: 1,
      firstSeenAt: BASE_TIME + 1,
      lastSeenAt: BASE_TIME + 2,
    },
  ]);
  assert.deepEqual(result.claimSupport, [
    { claimId: "c1.0", eventId: eventId(1), draftIndex: 0, live: 1 },
    { claimId: "c1.0", eventId: eventId(2), draftIndex: 0, live: 1 },
  ]);
  assert.deepEqual(result.idRedirects, [
    {
      oldId: "c2.0",
      newId: "c1.0",
      kind: "claim",
      reason: "deduplicated",
    },
  ]);
  assert.deepEqual(result.occurrences, [
    { eventId: eventId(1), draftIndex: 0, claimId: "c1.0" },
    { eventId: eventId(2), draftIndex: 0, claimId: "c1.0" },
  ]);
  assert.deepEqual(input, before);
  assertDeepFrozen(result);
  assert.equal(JSON.stringify(projectClaimSupportState(input)), JSON.stringify(result));

  const preScan = preScanProjectionEvents(input);
  assert.deepEqual(
    reduceClaimSupportState(preScan, reduceEntitySurfaceKinds(preScan)),
    result,
  );
});

test("claim identity distinguishes entity objects, literal objects, case, and internal whitespace", () => {
  const result = projectClaimSupportState(
    replayInput([
      statementEvent(1, {
        parsed: [
          entityDraft("슬롯", "uses", "Target"),
          literalDraft("슬롯", "uses", "Target"),
          literalDraft("슬롯", "uses", "target"),
          literalDraft("슬롯", "uses", "two  spaces"),
          literalDraft("슬롯", "uses", "two spaces"),
        ],
      }),
    ]),
  );

  assert.equal(result.claims.length, 5);
  assert.equal(result.claims.every(({ state }) => state === "active"), true);
  assert.deepEqual(
    result.claims.map(({ objectId, objectValue }) => ({ objectId, objectValue })),
    [
      { objectId: "e1.1", objectValue: null },
      { objectId: null, objectValue: "Target" },
      { objectId: null, objectValue: "target" },
      { objectId: null, objectValue: "two  spaces" },
      { objectId: null, objectValue: "two spaces" },
    ],
  );
});

test("describes supersedes before activation and reuses a prior claim in A to B to A", () => {
  const result = projectClaimSupportState(
    replayInput([
      statementEvent(1, {
        parsed: [literalDraft("테스트 명령", "describes", "pnpm test")],
      }),
      statementEvent(2, {
        parsed: [literalDraft("테스트 명령", "describes", "pnpm test:unit")],
      }),
      statementEvent(3, {
        parsed: [literalDraft("테스트-명령", "describes", " pnpm test ")],
      }),
    ]),
  );

  assert.deepEqual(statesByValue(result), {
    "pnpm test": "active",
    "pnpm test:unit": "superseded",
  });
  assert.deepEqual(result.idRedirects, [
    {
      oldId: "c3.0",
      newId: "c1.0",
      kind: "claim",
      reason: "deduplicated",
    },
  ]);
  assert.deepEqual(
    result.claimSupport.filter(({ claimId }) => claimId === "c1.0"),
    [
      { claimId: "c1.0", eventId: eventId(1), draftIndex: 0, live: 1 },
      { claimId: "c1.0", eventId: eventId(3), draftIndex: 0, live: 1 },
    ],
  );
  assert.equal(
    result.claims.filter(
      ({ relation, state }) => relation === "describes" && state === "active",
    ).length,
    1,
  );
});

test("draft index orders two describes values inside one statement", () => {
  const result = projectClaimSupportState(
    replayInput([
      statementEvent(1, {
        parsed: [
          literalDraft("테스트 명령", "describes", "pnpm test"),
          literalDraft("테스트 명령", "describes", "pnpm test:unit"),
        ],
      }),
    ]),
  );

  assert.deepEqual(statesByValue(result), {
    "pnpm test": "superseded",
    "pnpm test:unit": "active",
  });
  assert.deepEqual(result.claimSupport.map(({ live }) => live), [1, 1]);
});

test("claim and event retractions preserve different describes histories", () => {
  const first = statementEvent(1, {
    parsed: [literalDraft("테스트 명령", "describes", "pnpm test")],
  });
  const second = statementEvent(2, {
    parsed: [literalDraft("테스트 명령", "describes", "pnpm test:unit")],
  });

  const claimRetracted = projectClaimSupportState(
    replayInput([first, second, claimRetraction(3, "c2.0")]),
  );
  assert.deepEqual(statesByValue(claimRetracted), {
    "pnpm test": "superseded",
    "pnpm test:unit": "retracted",
  });
  assert.equal(
    claimRetracted.claimSupport.find(({ eventId: id }) => id === second.eventId).live,
    0,
  );

  const eventRetracted = projectClaimSupportState(
    replayInput([first, second, statementRetraction(3, second.eventId)]),
  );
  assert.deepEqual(statesByValue(eventRetracted), {
    "pnpm test": "active",
    "pnpm test:unit": "retracted",
  });
  assert.equal(
    eventRetracted.claimSupport.find(({ eventId: id }) => id === second.eventId).live,
    0,
  );
});

test("claim retraction only cuts the targeted claim in a multi-claim statement", () => {
  const result = projectClaimSupportState(
    replayInput([
      statementEvent(1, {
        parsed: [
          entityDraft("인증 시스템", "uses", "서버 세션"),
          entityDraft("인증 시스템", "rejects", "JWT"),
        ],
      }),
      claimRetraction(2, "c1.0"),
    ]),
  );

  assert.deepEqual(
    result.claims.map(({ id, state }) => ({ id, state })),
    [
      { id: "c1.0", state: "retracted" },
      { id: "c1.1", state: "active" },
    ],
  );
  assert.deepEqual(result.claimSupport.map(({ live }) => live), [0, 1]);
});

test("a prior claim retraction cuts a backdated reinterpret support but a later ordinary statement reactivates", () => {
  const rawText = "인증은 JWT를 사용한다";
  const root = statementEvent(1, {
    rawText,
    provenance: "inferred",
    ttl: "weeks",
    parsed: [entityDraft("인증", "uses", "JWT")],
  });
  const retraction = claimRetraction(2, "c1.0");
  const successor = statementEvent(3, {
    rawText,
    provenance: "inferred",
    ttl: "weeks",
    supersedes: root.eventId,
    parsed: [
      entityDraft("인증", "uses", "JWT", {
        relation_label: "사용한다고 추론",
      }),
    ],
  });

  const backdated = projectClaimSupportState(
    replayInput([root, retraction, successor]),
  );
  assert.equal(backdated.claims[0].state, "retracted");
  assert.deepEqual(backdated.claimSupport.map(({ live }) => live), [0, 0]);

  const reactivated = projectClaimSupportState(
    replayInput([
      root,
      retraction,
      successor,
      statementEvent(4, {
        parsed: [entityDraft("인증", "uses", "JWT")],
      }),
    ]),
  );
  assert.equal(reactivated.claims[0].id, "c1.0");
  assert.equal(reactivated.claims[0].state, "active");
  assert.equal(reactivated.claims[0].firstSeenAt, BASE_TIME + 4);
  assert.equal(reactivated.claims[0].lastSeenAt, BASE_TIME + 4);
  assert.deepEqual(reactivated.claimSupport.map(({ live }) => live), [0, 0, 1]);
});

test("first and last seen use effective statement time rather than reinterpret append time", () => {
  const rawText = "인증은 JWT를 사용한다";
  const root = statementEvent(1, {
    rawText,
    parsed: [entityDraft("인증", "uses", "JWT")],
  });
  const later = statementEvent(2, {
    parsed: [entityDraft("인증", "uses", "JWT")],
  });
  const successor = statementEvent(3, {
    rawText,
    supersedes: root.eventId,
    parsed: [entityDraft("인증", "uses", "JWT")],
    createdAt: BASE_TIME + 300,
  });

  const result = projectClaimSupportState(replayInput([root, later, successor]));

  assert.equal(result.claims[0].firstSeenAt, BASE_TIME + 1);
  assert.equal(result.claims[0].lastSeenAt, BASE_TIME + 2);
  assert.deepEqual(result.claimSupport.map(({ live }) => live), [0, 1, 1]);
});

test("backdated reinterpret cannot override a later describes decision and event undo preserves it", () => {
  const rawText = "런타임은 Node 20이다";
  const root = statementEvent(1, {
    rawText,
    parsed: [literalDraft("런타임 버전", "describes", "Node 20")],
  });
  const later = statementEvent(2, {
    parsed: [literalDraft("런타임 버전", "describes", "Node 22")],
  });
  const successor = statementEvent(3, {
    rawText,
    supersedes: root.eventId,
    parsed: [literalDraft("런타임 버전", "describes", "Node 20 LTS")],
  });

  const reinterpreted = projectClaimSupportState(
    replayInput([root, later, successor]),
  );
  assert.deepEqual(statesByValue(reinterpreted), {
    "Node 20": "retracted",
    "Node 22": "active",
    "Node 20 LTS": "superseded",
  });

  const undone = projectClaimSupportState(
    replayInput([
      root,
      later,
      successor,
      statementRetraction(4, successor.eventId),
    ]),
  );
  assert.deepEqual(statesByValue(undone), {
    "Node 20": "superseded",
    "Node 22": "active",
    "Node 20 LTS": "retracted",
  });
});

test("numeric occurrence order selects c2 before c10 and a redirected target retracts the survivor", () => {
  const result = projectClaimSupportState(
    replayInput([
      statementEvent(2, {
        parsed: [entityDraft("인증", "uses", "JWT")],
      }),
      statementEvent(10, {
        parsed: [entityDraft("인증", "uses", "JWT")],
      }),
      claimRetraction(11, "c10.0"),
    ]),
  );

  assert.equal(result.claims[0].id, "c2.0");
  assert.equal(result.claims[0].state, "retracted");
  assert.deepEqual(result.claimSupport.map(({ live }) => live), [0, 0]);
  assert.deepEqual(result.idRedirects, [
    {
      oldId: "c10.0",
      newId: "c2.0",
      kind: "claim",
      reason: "deduplicated",
    },
  ]);
});

test("TTL changes do not mutate structural claim or support state", () => {
  const draft = literalDraft("작업 상태", "describes", "진행 중");
  const permanent = projectClaimSupportState(
    replayInput([statementEvent(1, { parsed: [draft], ttl: "permanent" })]),
  );
  const session = projectClaimSupportState(
    replayInput([statementEvent(1, { parsed: [draft], ttl: "session" })]),
  );

  assert.deepEqual(session, permanent);
});

test("a raw-only statement creates no claim or support rows", () => {
  const result = projectClaimSupportState(
    replayInput([statementEvent(1, { parsed: [] })]),
  );

  assert.deepEqual(result.claimAnchors, []);
  assert.deepEqual(result.claims, []);
  assert.deepEqual(result.claimSupport, []);
  assert.deepEqual(result.idRedirects, []);
  assert.deepEqual(result.occurrences, []);
  assertDeepFrozen(result);
});

test("multiple relations coexist without implicit conflict resolution", () => {
  const result = projectClaimSupportState(
    replayInput([
      statementEvent(1, {
        parsed: [
          entityDraft("인증", "uses", "JWT"),
          entityDraft("인증", "uses", "서버 세션"),
          entityDraft("인증", "rejects", "JWT"),
          entityDraft("리포", "contains", "인증"),
          entityDraft("인증", "relates_to", "로그인", {
            relation_label: "연결됨",
          }),
        ],
      }),
    ]),
  );

  assert.equal(result.claims.length, 5);
  assert.equal(result.claims.every(({ state }) => state === "active"), true);
  assert.deepEqual(
    result.claims.map(({ relation }) => relation),
    ["uses", "uses", "rejects", "contains", "relates_to"],
  );
});

test("duplicate canonical identity inside one stored statement fails closed", () => {
  const secret = "duplicate-secret-payload";
  assert.throws(
    () =>
      projectClaimSupportState(
        replayInput([
          statementEvent(1, {
            rawText: secret,
            parsed: [
              entityDraft("인증 시스템", "uses", "PostgreSQL"),
              entityDraft("인증-시스템", "uses", "Postgre_SQL"),
            ],
          }),
        ]),
      ),
    claimFailure("DUPLICATE_STATEMENT_CLAIM", secret),
  );
});

test("invalid drafts, retraction targets, and entity seams use payload-redacted typed errors", () => {
  const secret = "configures-secret";
  assert.throws(
    () =>
      projectClaimSupportState(
        replayInput([
          statementEvent(1, {
            parsed: [entityDraft("인증", secret, "DB")],
          }),
        ]),
      ),
    claimFailure("INVALID_CLAIM_DRAFT", secret),
  );
  assert.throws(
    () =>
      projectClaimSupportState(
        replayInput([
          statementEvent(1, {
            parsed: [entityDraft("인증", "relates_to", "로그인")],
          }),
        ]),
      ),
    claimFailure("INVALID_CLAIM_DRAFT"),
  );
  assert.throws(
    () =>
      projectClaimSupportState(
        replayInput([
          statementEvent(1, {
            parsed: [literalDraft("슬롯", "describes", "A")],
          }),
          claimRetraction(2, "c1.9"),
        ]),
      ),
    claimFailure("CLAIM_RETRACTION_TARGET_NOT_FOUND", "c1.9"),
  );
  assert.throws(
    () =>
      projectClaimSupportState(
        replayInput([
          claimRetraction(1, "c2.0"),
          statementEvent(2, {
            parsed: [literalDraft("슬롯", "describes", "A")],
          }),
        ]),
      ),
    claimFailure("CLAIM_RETRACTION_TARGET_NOT_PAST", "c2.0"),
  );

  const input = replayInput([
    statementEvent(1, {
      parsed: [literalDraft("슬롯", "describes", "A")],
    }),
  ]);
  const preScan = preScanProjectionEvents(input);
  const entities = reduceEntitySurfaceKinds(preScan);
  assert.throws(
    () =>
      reduceClaimSupportState(preScan, {
        ...entities,
        occurrences: [],
      }),
    claimFailure("INVALID_CLAIM_STATE"),
  );
});
