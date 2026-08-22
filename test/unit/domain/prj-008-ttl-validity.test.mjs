import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ProjectionValidityError,
  preScanProjectionEvents,
  reduceClaimValidityState,
  reduceMergeAliasState,
  resolveEffectiveStatementLifetime,
} from "../../../dist/domain/index.js";

const SCOPE = "u:validity-user/p:recall";
const RULES_VERSION = "projection-v1";
const BASE_TIME = 1_700_000_000;

function eventId(seq) {
  return `ev_${String(seq).padStart(26, "0")}`;
}

function journalEvent(seq, kind, body, createdAt = BASE_TIME + seq) {
  return {
    seq,
    eventId: eventId(seq),
    scopeKey: SCOPE,
    kind,
    bodyJson: JSON.stringify(body),
    actor: "unit-agent",
    branch: "prj-008",
    session: null,
    createdAt,
  };
}

function statementEvent(seq, parsed, options = {}) {
  return journalEvent(
    seq,
    "statement",
    {
      raw_text: options.rawText ?? `statement ${seq}`,
      parsed,
      provenance: options.provenance ?? "user_stated",
      ttl: options.ttl ?? "permanent",
      ...(options.supersedes === undefined
        ? {}
        : { supersedes: options.supersedes }),
    },
    options.createdAt,
  );
}

function eventRetraction(seq, targetEventId) {
  return journalEvent(seq, "retraction", {
    target: { event_id: targetEventId, cascade: true },
  });
}

function entityDraft(subject, relation, object, options = {}) {
  return { subject, relation, object, ...options };
}

function replayInput(events) {
  return { scopeKey: SCOPE, rulesVersion: RULES_VERSION, events };
}

function validityProjection(input) {
  const preScan = preScanProjectionEvents(input);
  const structural = reduceMergeAliasState(preScan);
  return {
    preScan,
    structural,
    result: reduceClaimValidityState(preScan, structural),
  };
}

function validityFailure(code, forbiddenValue) {
  return (error) => {
    assert.ok(error instanceof ProjectionValidityError);
    assert.equal(error.code, code);
    assert.equal("value" in error, false);
    assert.equal("cause" in error, false);
    assert.equal(error.message.includes(forbiddenValue), false);
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

test("provenance defaults and explicit TTLs resolve from the effective created time", () => {
  assert.deepEqual(
    resolveEffectiveStatementLifetime({
      createdAt: BASE_TIME,
      provenance: "user_stated",
    }),
    { ttl: "permanent", expiresAt: null },
  );
  assert.deepEqual(
    resolveEffectiveStatementLifetime({
      createdAt: BASE_TIME,
      provenance: "observed",
    }),
    { ttl: "permanent", expiresAt: null },
  );
  assert.deepEqual(
    resolveEffectiveStatementLifetime({
      createdAt: BASE_TIME,
      provenance: "inferred",
    }),
    { ttl: "weeks", expiresAt: BASE_TIME + 2_592_000 },
  );
  assert.deepEqual(
    resolveEffectiveStatementLifetime({
      createdAt: BASE_TIME,
      provenance: "user_stated",
      ttl: "session",
    }),
    { ttl: "session", expiresAt: BASE_TIME + 43_200 },
  );
  assert.deepEqual(
    resolveEffectiveStatementLifetime({
      createdAt: BASE_TIME,
      provenance: "observed",
      ttl: "weeks",
    }),
    { ttl: "weeks", expiresAt: BASE_TIME + 2_592_000 },
  );
});

test("all statements and their supports share expiry, including raw-only and reinterpreted history", () => {
  const input = replayInput([
    statementEvent(1, [], {
      rawText: "배포 창구는 금요일 오후다",
      provenance: "inferred",
      ttl: "session",
      createdAt: BASE_TIME,
    }),
    statementEvent(
      2,
      [entityDraft("인증", "uses", "JWT", { relation_label: "예전 표현" })],
      { provenance: "observed", ttl: "permanent", createdAt: BASE_TIME + 20 },
    ),
    statementEvent(
      3,
      [entityDraft("인증", "uses", "세션", { relation_label: "원래 해석" })],
      {
        rawText: "인증은 세션을 쓴다",
        provenance: "inferred",
        ttl: "weeks",
        createdAt: BASE_TIME + 30,
      },
    ),
    statementEvent(
      4,
      [entityDraft("인증", "uses", "세션", { relation_label: "다시 해석" })],
      {
        rawText: "인증은 세션을 쓴다",
        provenance: "inferred",
        ttl: "weeks",
        supersedes: eventId(3),
        createdAt: BASE_TIME + 400,
      },
    ),
    statementEvent(
      5,
      [entityDraft("인증", "rejects", "JWT")],
      { provenance: "user_stated", ttl: "session", createdAt: BASE_TIME + 50 },
    ),
    eventRetraction(6, eventId(5)),
  ]);
  const before = structuredClone(input);
  const { preScan, structural, result } = validityProjection(input);

  assert.deepEqual(input, before);
  assert.equal(result.statements.length, 5);
  assert.deepEqual(result.statements[0], {
    eventId: eventId(1),
    scopeKey: SCOPE,
    state: "live",
    orderSeq: 1,
    createdAt: BASE_TIME,
    provenance: "inferred",
    expiresAt: BASE_TIME + 43_200,
  });
  assert.equal(
    result.claimSupport.some(({ eventId: supportEventId }) => supportEventId === eventId(1)),
    false,
  );

  const statementsById = new Map(
    result.statements.map((statement) => [statement.eventId, statement]),
  );
  for (const support of result.claimSupport) {
    assert.equal(
      support.expiresAt,
      statementsById.get(support.eventId)?.expiresAt,
      support.eventId,
    );
  }

  const root = statementsById.get(eventId(3));
  const successor = statementsById.get(eventId(4));
  assert.equal(root?.state, "superseded");
  assert.equal(successor?.state, "live");
  assert.equal(successor?.createdAt, BASE_TIME + 30);
  assert.equal(successor?.expiresAt, BASE_TIME + 30 + 2_592_000);
  assert.equal(statementsById.get(eventId(5))?.state, "retracted");

  assertDeepFrozen(result);
  assert.equal(
    JSON.stringify(reduceClaimValidityState(preScan, structural)),
    JSON.stringify(result),
  );
});

test("merge-deduplicated support keeps each effective statement lifetime", () => {
  const { result } = validityProjection(
    replayInput([
      statementEvent(
        1,
        [entityDraft("인증 서버", "uses", "PostgreSQL")],
        { provenance: "observed", ttl: "permanent", createdAt: BASE_TIME },
      ),
      statementEvent(
        2,
        [entityDraft("auth-service", "uses", "PostgreSQL")],
        { provenance: "inferred", ttl: "session", createdAt: BASE_TIME + 10 },
      ),
      journalEvent(3, "merge", { keep: "e1.0", absorb: "e2.0" }),
    ]),
  );

  assert.deepEqual(
    result.claimSupport.map(({ claimId, eventId: supportEventId, expiresAt }) => ({
      claimId,
      eventId: supportEventId,
      expiresAt,
    })),
    [
      { claimId: "c1.0", eventId: eventId(1), expiresAt: null },
      {
        claimId: "c1.0",
        eventId: eventId(2),
        expiresAt: BASE_TIME + 10 + 43_200,
      },
    ],
  );
});

test("invalid lifetime and structural seams fail closed without echoing submitted data", () => {
  const secret = "submitted-secret-scope";
  assert.throws(
    () =>
      resolveEffectiveStatementLifetime({
        createdAt: Number.MAX_SAFE_INTEGER,
        provenance: "inferred",
        ttl: "weeks",
        secret,
      }),
    validityFailure("INVALID_TTL_INPUT", secret),
  );
  assert.throws(
    () =>
      resolveEffectiveStatementLifetime({
        createdAt: Number.MAX_SAFE_INTEGER,
        provenance: "inferred",
        ttl: "weeks",
      }),
    validityFailure("TTL_EXPIRY_OUT_OF_RANGE", secret),
  );

  const input = replayInput([
    statementEvent(1, [entityDraft("인증", "uses", "JWT")]),
  ]);
  const preScan = preScanProjectionEvents(input);
  const structural = reduceMergeAliasState(preScan);
  assert.throws(
    () =>
      reduceClaimValidityState(preScan, {
        ...structural,
        scopeKey: `u:${secret}/p:recall`,
      }),
    validityFailure("INVALID_VALIDITY_STATE", secret),
  );
  assert.throws(
    () =>
      reduceClaimValidityState(preScan, {
        ...structural,
        claimSupport: [
          {
            ...structural.claimSupport[0],
            eventId: secret,
          },
        ],
      }),
    validityFailure("INVALID_VALIDITY_STATE", secret),
  );
});
