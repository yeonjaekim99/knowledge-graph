import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ProjectionPreScanError,
  ProjectionReplayContractError,
  preScanProjectionEvents,
} from "../../../dist/domain/index.js";

const SCOPE = "u:pre-scan-user/p:recall";
const RULES_VERSION = "projection-v1";
const BASE_TIME = 1_700_000_000;

function eventId(seq) {
  return `ev_${String(seq).padStart(26, "0")}`;
}

function draft(subject, object, relation = "uses") {
  return { subject, relation, object };
}

function literalDraft(subject, objectValue, relation = "describes") {
  return { subject, relation, object_value: objectValue };
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

function journalEvent(seq, kind, body, overrides = {}) {
  return {
    seq,
    eventId: eventId(seq),
    scopeKey: SCOPE,
    kind,
    bodyJson: JSON.stringify(body),
    actor: "unit-agent",
    branch: "prj-004",
    session: null,
    createdAt: BASE_TIME + seq,
    ...overrides,
  };
}

function statementEvent(seq, options = {}) {
  return journalEvent(
    seq,
    "statement",
    statementBody({
      rawText: options.rawText ?? `statement ${seq}`,
      parsed: options.parsed ?? [],
      provenance: options.provenance,
      ttl: options.ttl,
      supersedes: options.supersedes,
    }),
    options.eventOverrides,
  );
}

function claimRetraction(seq, claimId) {
  return journalEvent(seq, "retraction", {
    target: { claim_id: claimId },
  });
}

function eventRetraction(seq, targetEventId, cascade) {
  return journalEvent(seq, "retraction", {
    target: { event_id: targetEventId, cascade },
  });
}

function input(events) {
  return { scopeKey: SCOPE, rulesVersion: RULES_VERSION, events };
}

function preScanFailure(code, forbiddenValue) {
  return (error) => {
    assert.ok(error instanceof ProjectionPreScanError);
    assert.equal(error.code, code);
    assert.equal("value" in error, false);
    assert.equal("cause" in error, false);
    if (forbiddenValue !== undefined) {
      assert.equal(error.message.includes(forbiddenValue), false);
    }
    return true;
  };
}

function stateById(result) {
  return Object.fromEntries(
    result.statements.map((statement) => [statement.eventId, statement.state]),
  );
}

test("pre-scan returns an immutable ordered semantic stream and every statement candidate anchor", () => {
  const source = input([
    statementEvent(1, {
      parsed: [literalDraft("테스트 명령", "pnpm test")],
    }),
    journalEvent(2, "merge", { keep: "e1.0", absorb: "e1.1" }),
    journalEvent(3, "alias", { surface: "테스트", entity_id: "e1.0" }),
    claimRetraction(4, "c1.0"),
  ]);
  const before = structuredClone(source);

  const result = preScanProjectionEvents(source);

  assert.deepEqual(
    result.events.map(({ kind, eventId: id, orderSeq, actualSeq }) => ({
      kind,
      eventId: id,
      orderSeq,
      actualSeq,
    })),
    [
      { kind: "statement", eventId: eventId(1), orderSeq: 1, actualSeq: 1 },
      { kind: "merge", eventId: eventId(2), orderSeq: 2, actualSeq: 2 },
      { kind: "alias", eventId: eventId(3), orderSeq: 3, actualSeq: 3 },
      { kind: "retraction", eventId: eventId(4), orderSeq: 4, actualSeq: 4 },
    ],
  );
  assert.deepEqual(result.statementCandidates, [
    {
      eventId: eventId(1),
      actualSeq: 1,
      candidates: [
        {
          draftIndex: 0,
          claimId: "c1.0",
          subjectId: "e1.0",
          objectId: null,
        },
      ],
    },
  ]);
  assert.deepEqual(result.events[3].target, {
    kind: "claim",
    claimId: "c1.0",
  });
  assert.deepEqual(source, before);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.statements), true);
  assert.equal(Object.isFrozen(result.statementCandidates), true);
  assert.equal(Object.isFrozen(result.statementCandidates[0].candidates), true);
  assert.equal(Object.isFrozen(result.events), true);
  assert.equal(Object.isFrozen(result.events[0].parsed), true);
  assert.equal(Object.isFrozen(result.events[3].target), true);
});

test("reinterpret leaf keeps actual-seq IDs while inheriting root order and effective metadata", () => {
  const rawText = "인증은 JWT를 사용한다";
  const root = statementEvent(1, {
    rawText,
    parsed: [draft("인증", "JWT")],
    provenance: "inferred",
    ttl: "weeks",
  });
  const successor = statementEvent(3, {
    rawText,
    parsed: [
      {
        ...draft("인증", "JWT"),
        relation_label: "사용한다고 추론",
      },
    ],
    provenance: "inferred",
    ttl: "weeks",
    supersedes: root.eventId,
  });

  const result = preScanProjectionEvents(
    input([root, claimRetraction(2, "c1.0"), successor]),
  );

  assert.deepEqual(stateById(result), {
    [root.eventId]: "superseded",
    [successor.eventId]: "live",
  });
  assert.deepEqual(result.statements[1], {
    eventId: successor.eventId,
    actualSeq: 3,
    rootEventId: root.eventId,
    supersedes: root.eventId,
    state: "live",
    orderSeq: 1,
    recordedAt: BASE_TIME + 3,
    createdAt: BASE_TIME + 1,
    provenance: "inferred",
    ttl: "weeks",
  });
  assert.deepEqual(
    result.events.map((event) => [event.kind, event.orderSeq, event.actualSeq]),
    [
      ["statement", 1, 3],
      ["retraction", 2, 2],
    ],
  );
  assert.equal(result.events[0].candidates[0].claimId, "c3.0");
  assert.equal(result.events[0].candidates[0].subjectId, "e3.0");
  assert.equal(result.statementCandidates[0].candidates[0].claimId, "c1.0");
  assert.equal(result.statementCandidates[1].candidates[0].claimId, "c3.0");
});

test("backdated reinterpret is ordered before a later independent statement", () => {
  const root = statementEvent(1, {
    rawText: "런타임은 Node 20이다",
    parsed: [literalDraft("런타임 버전", "Node 20")],
  });
  const later = statementEvent(2, {
    rawText: "런타임은 Node 22이다",
    parsed: [literalDraft("런타임 버전", "Node 22")],
  });
  const successor = statementEvent(3, {
    rawText: "런타임은 Node 20이다",
    parsed: [literalDraft("런타임 버전", "Node 20 LTS")],
    supersedes: root.eventId,
  });

  const result = preScanProjectionEvents(input([root, later, successor]));

  assert.deepEqual(
    result.events.map((event) => [event.eventId, event.orderSeq, event.actualSeq]),
    [
      [successor.eventId, 1, 3],
      [later.eventId, 2, 2],
    ],
  );
  assert.equal(result.events[0].parsed[0].object_value, "Node 20 LTS");
  assert.equal(result.events[1].parsed[0].object_value, "Node 22");
});

test("cascade false restores the predecessor while later cascade true retracts the whole chain", () => {
  const root = statementEvent(1, { rawText: "원문" });
  const successor = statementEvent(2, {
    rawText: "원문",
    supersedes: root.eventId,
  });
  const undo = eventRetraction(3, successor.eventId, false);

  const restored = preScanProjectionEvents(input([root, successor, undo]));
  assert.deepEqual(stateById(restored), {
    [root.eventId]: "live",
    [successor.eventId]: "retracted",
  });
  assert.deepEqual(
    restored.events.filter((event) => event.kind === "statement").map((event) => event.eventId),
    [root.eventId],
  );
  assert.deepEqual(restored.events[1].target, {
    kind: "event",
    eventId: successor.eventId,
    cascade: false,
    affectedEventIds: [successor.eventId],
  });

  const deleted = preScanProjectionEvents(
    input([
      root,
      successor,
      undo,
      eventRetraction(4, successor.eventId, true),
    ]),
  );
  assert.deepEqual(stateById(deleted), {
    [root.eventId]: "retracted",
    [successor.eventId]: "retracted",
  });
  assert.deepEqual(
    deleted.events.filter((event) => event.kind === "statement"),
    [],
  );
  assert.deepEqual(deleted.events.at(-1).target.affectedEventIds, [
    root.eventId,
    successor.eventId,
  ]);
});

test("cascade false rejects an intermediate cut that would create two live leaves", () => {
  const root = statementEvent(1, { rawText: "같은 원문" });
  const middle = statementEvent(2, {
    rawText: "같은 원문",
    supersedes: root.eventId,
  });
  const leaf = statementEvent(3, {
    rawText: "같은 원문",
    supersedes: middle.eventId,
  });

  assert.throws(
    () =>
      preScanProjectionEvents(
        input([root, middle, leaf, eventRetraction(4, middle.eventId, false)]),
      ),
    preScanFailure("MULTIPLE_LIVE_LEAVES"),
  );
});

test("event retractions exclude merge and alias decisions before reduction", () => {
  const merge = journalEvent(1, "merge", { keep: "e1.0", absorb: "e1.1" });
  const alias = journalEvent(2, "alias", {
    surface: "인증",
    entity_id: "e1.0",
  });
  const result = preScanProjectionEvents(
    input([
      merge,
      alias,
      journalEvent(3, "retraction", {
        target: { event_id: merge.eventId },
      }),
      journalEvent(4, "retraction", {
        target: { event_id: alias.eventId },
      }),
    ]),
  );

  assert.deepEqual(
    result.events.map((event) => event.kind),
    ["retraction", "retraction"],
  );
  assert.deepEqual(result.events[0].target.affectedEventIds, [merge.eventId]);
  assert.deepEqual(result.events[1].target.affectedEventIds, [alias.eventId]);
});

test("event retractions reject missing, future, retraction, and invalid cascade targets", () => {
  const targetRetraction = eventRetraction(2, eventId(1), false);
  const fixtures = [
    [
      input([
        journalEvent(1, "retraction", {
          target: { event_id: eventId(99), cascade: true },
        }),
      ]),
      "EVENT_TARGET_NOT_FOUND",
    ],
    [
      input([
        journalEvent(1, "retraction", {
          target: { event_id: eventId(2) },
        }),
        journalEvent(2, "alias", { surface: "x", entity_id: "e1.0" }),
      ]),
      "EVENT_TARGET_NOT_PAST",
    ],
    [
      input([
        statementEvent(1),
        targetRetraction,
        journalEvent(3, "retraction", {
          target: { event_id: targetRetraction.eventId },
        }),
      ]),
      "EVENT_TARGET_KIND_MISMATCH",
    ],
    [
      input([
        statementEvent(1),
        journalEvent(2, "retraction", {
          target: { event_id: eventId(1) },
        }),
      ]),
      "INVALID_EVENT_BODY",
    ],
    [
      input([
        journalEvent(1, "merge", { keep: "e1.0", absorb: "e1.1" }),
        journalEvent(2, "retraction", {
          target: { event_id: eventId(1), cascade: false },
        }),
      ]),
      "INVALID_EVENT_BODY",
    ],
  ];

  for (const [source, code] of fixtures) {
    assert.throws(() => preScanProjectionEvents(source), preScanFailure(code));
  }
});

test("supersedes graph rejects missing, future, non-statement, retracted, and branching targets", () => {
  const root = statementEvent(1, { rawText: "같은 원문" });
  const child = statementEvent(2, {
    rawText: "같은 원문",
    supersedes: root.eventId,
  });
  const fixtures = [
    [
      input([
        statementEvent(1, {
          supersedes: eventId(99),
        }),
      ]),
      "SUPERSEDES_TARGET_NOT_FOUND",
    ],
    [
      input([
        statementEvent(1, {
          rawText: "forward",
          supersedes: eventId(2),
        }),
        statementEvent(2, { rawText: "forward" }),
      ]),
      "SUPERSEDES_TARGET_NOT_PAST",
    ],
    [
      input([
        journalEvent(1, "alias", { surface: "x", entity_id: "e1.0" }),
        statementEvent(2, { supersedes: eventId(1) }),
      ]),
      "SUPERSEDES_TARGET_KIND_MISMATCH",
    ],
    [
      input([
        root,
        eventRetraction(2, root.eventId, false),
        statementEvent(3, {
          rawText: "같은 원문",
          supersedes: root.eventId,
        }),
      ]),
      "SUPERSEDES_TARGET_NOT_LIVE",
    ],
    [
      input([
        root,
        child,
        statementEvent(3, {
          rawText: "같은 원문",
          supersedes: root.eventId,
        }),
      ]),
      "MULTIPLE_LIVE_LEAVES",
    ],
  ];

  for (const [source, code] of fixtures) {
    assert.throws(() => preScanProjectionEvents(source), preScanFailure(code));
  }
});

test("scope-bound replay input rejects a cross-scope supersedes source before pre-scan", () => {
  const root = statementEvent(1, { rawText: "scope-bound" });
  const successor = statementEvent(2, {
    rawText: "scope-bound",
    supersedes: root.eventId,
    eventOverrides: { scopeKey: "u:another-user/p:recall" },
  });

  assert.throws(
    () => preScanProjectionEvents(input([root, successor])),
    (error) => {
      assert.ok(error instanceof ProjectionReplayContractError);
      assert.equal(error.code, "SCOPE_MISMATCH");
      assert.equal(error.message.includes("another-user"), false);
      return true;
    },
  );
});

test("supersedes cycle and content or effective metadata drift fail closed", () => {
  const cycleFirst = statementEvent(1, {
    rawText: "cycle",
    supersedes: eventId(2),
  });
  const cycleSecond = statementEvent(2, {
    rawText: "cycle",
    supersedes: cycleFirst.eventId,
  });
  assert.throws(
    () => preScanProjectionEvents(input([cycleFirst, cycleSecond])),
    preScanFailure("SUPERSEDES_CYCLE"),
  );

  const root = statementEvent(1, {
    rawText: "마스킹된 원문",
    provenance: "observed",
    ttl: "weeks",
  });
  for (const successor of [
    statementEvent(2, {
      rawText: "다른 원문",
      provenance: "observed",
      ttl: "weeks",
      supersedes: root.eventId,
    }),
    statementEvent(2, {
      rawText: "마스킹된 원문",
      provenance: "user_stated",
      ttl: "weeks",
      supersedes: root.eventId,
    }),
    statementEvent(2, {
      rawText: "마스킹된 원문",
      provenance: "observed",
      ttl: "session",
      supersedes: root.eventId,
    }),
  ]) {
    assert.throws(
      () => preScanProjectionEvents(input([root, successor])),
      preScanFailure("SUPERSEDES_CONTENT_MISMATCH", "다른 원문"),
    );
  }
});

test("deep supersedes cycles fail with a safe typed error instead of exhausting the call stack", () => {
  const depth = 12_000;
  const events = [];
  for (let seq = 1; seq <= depth; seq += 1) {
    events.push(
      statementEvent(seq, {
        rawText: "deep cycle",
        supersedes: seq === 1 ? eventId(depth) : eventId(seq - 1),
      }),
    );
  }

  assert.throws(
    () => preScanProjectionEvents(input(events)),
    preScanFailure("SUPERSEDES_CYCLE"),
  );
});

test("deep cascade expansion is iterative and deterministically covers the whole chain", () => {
  const depth = 12_000;
  const events = [statementEvent(1, { rawText: "deep chain" })];
  for (let seq = 2; seq <= depth; seq += 1) {
    events.push(
      statementEvent(seq, {
        rawText: "deep chain",
        supersedes: eventId(seq - 1),
      }),
    );
  }
  events.push(eventRetraction(depth + 1, eventId(depth), true));

  const result = preScanProjectionEvents(input(events));

  assert.equal(result.events.at(-1).target.affectedEventIds.length, depth);
  assert.equal(result.events.at(-1).target.affectedEventIds[0], eventId(1));
  assert.equal(result.events.at(-1).target.affectedEventIds.at(-1), eventId(depth));
  assert.equal(result.statements.every(({ state }) => state === "retracted"), true);
});

test("malformed event bodies and candidate drafts are rejected without payload echo", () => {
  const secret = "submitted-secret-value";
  const invalidBodies = [
    journalEvent(1, "statement", {
      raw_text: secret,
      parsed: [],
      ttl: "permanent",
    }),
    journalEvent(1, "statement", {
      raw_text: secret,
      parsed: [
        {
          subject: "x",
          relation: "uses",
          object: "y",
          object_value: "z",
        },
      ],
      provenance: "user_stated",
      ttl: "permanent",
    }),
    journalEvent(1, "retraction", {
      target: { claim_id: "c0.invalid" },
    }),
  ];

  for (const invalid of invalidBodies) {
    assert.throws(
      () => preScanProjectionEvents(input([invalid])),
      preScanFailure("INVALID_EVENT_BODY", secret),
    );
  }
});

test("the same journal produces byte-equivalent pre-scan output without ambient time", () => {
  const root = statementEvent(1, {
    rawText: "결정적 원문",
    parsed: [draft("프로젝트", "SQLite")],
    provenance: "observed",
  });
  const successor = statementEvent(3, {
    rawText: "결정적 원문",
    parsed: [draft("프로젝트", "SQLite")],
    provenance: "observed",
    supersedes: root.eventId,
  });
  const source = input([root, claimRetraction(2, "c1.0"), successor]);

  const first = preScanProjectionEvents(source);
  const second = preScanProjectionEvents(structuredClone(source));

  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.deepEqual(Object.keys(first), [
    "scopeKey",
    "rulesVersion",
    "statements",
    "statementCandidates",
    "events",
  ]);
  assert.equal("now" in first, false);
  assert.equal("clock" in first, false);
});
