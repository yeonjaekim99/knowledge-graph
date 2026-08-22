import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ProjectionDecisionError,
  preScanProjectionEvents,
  projectMergeAliasState,
  reduceClaimSupportState,
  reduceEntitySurfaceKinds,
  reduceMergeAliasState,
} from "../../../dist/domain/index.js";

const SCOPE = "u:decision-user/p:recall";
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
    branch: "prj-007",
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

function mergeEvent(seq, keep, absorb, extra = {}) {
  return journalEvent(seq, "merge", { keep, absorb, ...extra });
}

function aliasEvent(seq, surface, entityId, extra = {}) {
  return journalEvent(seq, "alias", {
    surface,
    entity_id: entityId,
    ...extra,
  });
}

function claimRetraction(seq, claimId) {
  return journalEvent(seq, "retraction", {
    target: { claim_id: claimId },
  });
}

function eventRetraction(seq, targetEventId) {
  return journalEvent(seq, "retraction", {
    target: { event_id: targetEventId },
  });
}

function replayInput(events) {
  return { scopeKey: SCOPE, rulesVersion: RULES_VERSION, events };
}

function entityDraft(subject, relation, object, options = {}) {
  return { subject, relation, object, ...options };
}

function literalDraft(subject, objectValue, options = {}) {
  return {
    subject,
    relation: "describes",
    object_value: objectValue,
    ...options,
  };
}

function activeClaims(result) {
  return result.claims.filter(({ state }) => state === "active");
}

function redirect(result, oldId) {
  return result.idRedirects.find((row) => row.oldId === oldId);
}

function surface(result, surfaceNorm, entityId) {
  return result.surfaceForms.find(
    (row) => row.surfaceNorm === surfaceNorm && row.entityId === entityId,
  );
}

function entity(result, id) {
  return result.entities.find((row) => row.id === id);
}

function decisionFailure(code, forbiddenValue) {
  return (error) => {
    assert.ok(error instanceof ProjectionDecisionError);
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

test("without decisions the combined reducer preserves PRJ-005 and PRJ-006 output", () => {
  const input = replayInput([
    statementEvent(1, [
      entityDraft("인증 시스템", "uses", "PostgreSQL", {
        subject_aliases: ["로그인"],
        subject_kind: "service",
      }),
    ]),
    statementEvent(2, [
      entityDraft("인증-시스템", "uses", "Postgre_SQL"),
    ]),
  ]);
  const before = structuredClone(input);
  const preScan = preScanProjectionEvents(input);
  const entityState = reduceEntitySurfaceKinds(preScan);
  const claimState = reduceClaimSupportState(preScan, entityState);

  const result = projectMergeAliasState(input);

  assert.deepEqual(result.entityAnchors, entityState.entityAnchors);
  assert.deepEqual(result.entities, entityState.entities);
  assert.deepEqual(result.surfaceForms, entityState.surfaceForms);
  assert.deepEqual(result.entityOccurrences, entityState.occurrences);
  assert.deepEqual(result.kindMaintenance, entityState.kindMaintenance);
  assert.deepEqual(result.claimAnchors, claimState.claimAnchors);
  assert.deepEqual(result.claims, claimState.claims);
  assert.deepEqual(result.claimSupport, claimState.claimSupport);
  assert.deepEqual(result.claimOccurrences, claimState.occurrences);
  assert.deepEqual(
    result.idRedirects.filter(({ kind }) => kind === "entity"),
    entityState.idRedirects,
  );
  assert.deepEqual(
    result.idRedirects.filter(({ kind }) => kind === "claim"),
    claimState.idRedirects,
  );
  assert.deepEqual(input, before);
  assertDeepFrozen(result);
  assert.equal(JSON.stringify(projectMergeAliasState(input)), JSON.stringify(result));
  assert.deepEqual(reduceMergeAliasState(preScan), result);
});

test("the combined reducer closes the alias-derived PRJ-005 and PRJ-006 seam", () => {
  const result = projectMergeAliasState(
    replayInput([
      statementEvent(1, [
        entityDraft("인증 시스템", "uses", "세션", {
          subject_aliases: ["로그인"],
        }),
      ]),
      statementEvent(2, [entityDraft("로그인", "uses", "MFA")]),
    ]),
  );

  assert.equal(result.claims.find(({ id }) => id === "c2.0")?.subjectId, "e1.0");
  assert.equal(redirect(result, "e2.0")?.newId, "e1.0");
  assert.equal(surface(result, "로그인", "e1.0")?.origin, "agent_supplied");
});

test("merge rewrites surfaces and claims while retaining all statement support", () => {
  const result = projectMergeAliasState(
    replayInput([
      statementEvent(1, [
        entityDraft("인증서버", "uses", "PostgreSQL", {
          subject_aliases: ["로그인"],
        }),
      ]),
      statementEvent(2, [entityDraft("auth-service", "uses", "PostgreSQL")]),
      mergeEvent(3, "e1.0", "e2.0"),
    ]),
  );

  assert.deepEqual(
    activeClaims(result).map(({ id }) => id),
    ["c1.0"],
  );
  assert.equal(result.claims.find(({ id }) => id === "c2.0")?.state, "superseded");
  assert.deepEqual(
    result.claimSupport.map(({ claimId, eventId: supportEventId, live }) => ({
      claimId,
      eventId: supportEventId,
      live,
    })),
    [
      { claimId: "c1.0", eventId: eventId(1), live: 1 },
      { claimId: "c1.0", eventId: eventId(2), live: 1 },
    ],
  );
  assert.deepEqual(redirect(result, "e2.0"), {
    oldId: "e2.0",
    newId: "e1.0",
    kind: "entity",
    reason: "merge",
  });
  assert.deepEqual(redirect(result, "c2.0"), {
    oldId: "c2.0",
    newId: "c1.0",
    kind: "claim",
    reason: "merge",
  });
  assert.equal(entity(result, "e2.0")?.mergedInto, "e1.0");
  assert.equal(surface(result, "authservice", "e1.0")?.origin, "name");
  assert.equal(surface(result, "로그인", "e1.0")?.origin, "agent_supplied");
});

test("retracting a merge is byte-equivalent to replaying without the decision", () => {
  const first = statementEvent(1, [entityDraft("A", "uses", "DB")]);
  const second = statementEvent(2, [entityDraft("B", "uses", "DB")]);
  const later = statementEvent(4, [entityDraft("B", "uses", "Cache")]);
  const baseline = projectMergeAliasState(replayInput([first, second, later]));
  const undone = projectMergeAliasState(
    replayInput([
      first,
      second,
      mergeEvent(3, "e1.0", "e2.0"),
      later,
      eventRetraction(5, eventId(3)),
    ]),
  );

  assert.equal(JSON.stringify(undone), JSON.stringify(baseline));
  assert.equal(activeClaims(undone).length, 3);
  assert.equal(undone.claims.find(({ id }) => id === "c4.0")?.subjectId, "e2.0");
});

test("alias confirmation upgrades origin and event retraction restores the remaining contribution", () => {
  const statement = statementEvent(1, [
    entityDraft("인증 시스템", "uses", "세션", {
      subject_aliases: ["로그인"],
    }),
  ]);
  const confirmed = projectMergeAliasState(
    replayInput([statement, aliasEvent(2, "로그인", "e1.0")]),
  );
  const restored = projectMergeAliasState(
    replayInput([
      statement,
      aliasEvent(2, "로그인", "e1.0"),
      eventRetraction(3, eventId(2)),
    ]),
  );
  const baseline = projectMergeAliasState(replayInput([statement]));

  assert.equal(surface(confirmed, "로그인", "e1.0")?.origin, "confirmed");
  assert.equal(surface(restored, "로그인", "e1.0")?.origin, "agent_supplied");
  assert.equal(JSON.stringify(restored), JSON.stringify(baseline));
});

test("retracting an alias also removes its effect on later statement resolution", () => {
  const first = statementEvent(1, [entityDraft("인증 시스템", "uses", "세션")]);
  const later = statementEvent(3, [entityDraft("로그인", "uses", "MFA")]);
  const baseline = projectMergeAliasState(replayInput([first, later]));
  const undone = projectMergeAliasState(
    replayInput([
      first,
      aliasEvent(2, "로그인", "e1.0"),
      later,
      eventRetraction(4, eventId(2)),
    ]),
  );

  assert.equal(JSON.stringify(undone), JSON.stringify(baseline));
  assert.equal(undone.claims.find(({ id }) => id === "c3.0")?.subjectId, "e3.0");
  assert.equal(surface(undone, "로그인", "e1.0"), undefined);
  assert.equal(surface(undone, "로그인", "e3.0")?.origin, "name");
});

test("a confirmed alias resolves a later statement occurrence to the same entity", () => {
  const result = projectMergeAliasState(
    replayInput([
      statementEvent(1, [entityDraft("인증 시스템", "uses", "세션")]),
      aliasEvent(2, "로그인", "e1.0"),
      statementEvent(3, [entityDraft("로그인", "uses", "MFA")]),
    ]),
  );

  assert.equal(result.claims.find(({ id }) => id === "c3.0")?.subjectId, "e1.0");
  assert.deepEqual(redirect(result, "e3.0"), {
    oldId: "e3.0",
    newId: "e1.0",
    kind: "entity",
    reason: "deduplicated",
  });
  assert.equal(surface(result, "로그인", "e1.0")?.origin, "confirmed");
});

test("merge chooses the latest structural describes activation and undo separates both slots", () => {
  const first = statementEvent(1, [literalDraft("A 런타임", "Node 20")]);
  const second = statementEvent(2, [literalDraft("B 런타임", "Node 22")]);
  const merged = projectMergeAliasState(
    replayInput([first, second, mergeEvent(3, "e1.0", "e2.0")]),
  );
  const undone = projectMergeAliasState(
    replayInput([
      first,
      second,
      mergeEvent(3, "e1.0", "e2.0"),
      eventRetraction(4, eventId(3)),
    ]),
  );

  assert.deepEqual(
    activeClaims(merged).map(({ objectValue }) => objectValue),
    ["Node 22"],
  );
  assert.deepEqual(
    activeClaims(undone).map(({ objectValue }) => objectValue).sort(),
    ["Node 20", "Node 22"],
  );
});

test("a backdated reinterpret cannot become the latest describes value through merge", () => {
  const root = statementEvent(1, [literalDraft("A 런타임", "Node 18")], {
    rawText: "A 런타임을 해석한다",
  });
  const result = projectMergeAliasState(
    replayInput([
      root,
      statementEvent(2, [literalDraft("B 런타임", "Node 22")]),
      mergeEvent(3, "e1.0", "e2.0"),
      statementEvent(4, [literalDraft("A 런타임", "Node 20")], {
        rawText: "A 런타임을 해석한다",
        supersedes: eventId(1),
      }),
    ]),
  );

  assert.deepEqual(
    activeClaims(result).map(({ objectValue }) => objectValue),
    ["Node 22"],
  );
  assert.equal(result.claims.find(({ id }) => id === "c4.0")?.state, "superseded");
});

test("a pre-merge claim retraction does not prematurely supersede the other describes slot", () => {
  const result = projectMergeAliasState(
    replayInput([
      statementEvent(1, [literalDraft("A 런타임", "Node 20")]),
      statementEvent(2, [literalDraft("B 런타임", "Node 22")]),
      claimRetraction(3, "c2.0"),
      mergeEvent(4, "e1.0", "e2.0"),
    ]),
  );

  assert.deepEqual(
    activeClaims(result).map(({ objectValue }) => objectValue),
    ["Node 20"],
  );
  assert.equal(result.claims.find(({ id }) => id === "c2.0")?.state, "retracted");
});

test("a retracted duplicate activation cannot win a later describes merge", () => {
  const result = projectMergeAliasState(
    replayInput([
      statementEvent(1, [literalDraft("B 런타임", "Node 20")]),
      statementEvent(2, [literalDraft("C 런타임", "Node 22")]),
      statementEvent(3, [literalDraft("A 런타임", "Node 20")]),
      claimRetraction(4, "c3.0"),
      mergeEvent(5, "e3.0", "e1.0"),
      mergeEvent(6, "e3.0", "e2.0"),
    ]),
  );

  assert.deepEqual(
    activeClaims(result).map(({ objectValue }) => objectValue),
    ["Node 22"],
  );
  assert.equal(result.claims.find(({ id }) => id === "c1.0")?.state, "superseded");
  assert.equal(result.claims.find(({ id }) => id === "c3.0")?.state, "superseded");
});

test("support collision keeps the smallest draft index and any remaining live contribution", () => {
  const result = projectMergeAliasState(
    replayInput([
      statementEvent(1, [
        entityDraft("A", "uses", "DB"),
        entityDraft("B", "uses", "DB"),
      ]),
      claimRetraction(2, "c1.0"),
      mergeEvent(3, "e1.0", "e1.2"),
    ]),
  );

  assert.deepEqual(result.claimSupport, [
    { claimId: "c1.0", eventId: eventId(1), draftIndex: 0, live: 1 },
  ]);
  assert.deepEqual(redirect(result, "c1.1"), {
    oldId: "c1.1",
    newId: "c1.0",
    kind: "claim",
    reason: "merge",
  });
  assert.equal(result.claims.find(({ id }) => id === "c1.0")?.state, "active");
});

test("claim survivor uses numeric occurrence order independently of explicit entity keep", () => {
  const result = projectMergeAliasState(
    replayInput([
      statementEvent(2, [entityDraft("early", "uses", "DB")]),
      statementEvent(10, [entityDraft("late", "uses", "DB")]),
      mergeEvent(11, "e10.0", "e2.0"),
    ]),
  );

  assert.equal(activeClaims(result)[0]?.id, "c2.0");
  assert.equal(activeClaims(result)[0]?.subjectId, "e10.0");
  assert.equal(redirect(result, "e2.0")?.newId, "e10.0");
  assert.deepEqual(redirect(result, "c10.0"), {
    oldId: "c10.0",
    newId: "c2.0",
    kind: "claim",
    reason: "merge",
  });
});

test("merging entity objects rewrites and reinforces the same claim identity", () => {
  const result = projectMergeAliasState(
    replayInput([
      statementEvent(1, [entityDraft("서비스", "uses", "DB-A")]),
      statementEvent(2, [entityDraft("서비스", "uses", "DB-B")]),
      mergeEvent(3, "e1.1", "e2.1"),
    ]),
  );

  assert.equal(activeClaims(result).length, 1);
  assert.equal(activeClaims(result)[0]?.objectId, "e1.1");
  assert.deepEqual(
    result.claimSupport.map(({ claimId, live }) => ({ claimId, live })),
    [
      { claimId: "c1.0", live: 1 },
      { claimId: "c1.0", live: 1 },
    ],
  );
});

test("merge chains compress redirects and a reverse edge is rejected as a cycle", () => {
  const prefix = [
    statementEvent(1, [literalDraft("A", "one")]),
    statementEvent(2, [literalDraft("B", "two")]),
    statementEvent(3, [literalDraft("C", "three")]),
    mergeEvent(4, "e2.0", "e1.0"),
    mergeEvent(5, "e3.0", "e2.0"),
  ];
  const result = projectMergeAliasState(replayInput(prefix));

  assert.equal(redirect(result, "e1.0")?.newId, "e3.0");
  assert.equal(redirect(result, "e2.0")?.newId, "e3.0");
  assert.equal(entity(result, "e1.0")?.mergedInto, "e3.0");
  assert.equal(entity(result, "e2.0")?.mergedInto, "e3.0");
  assert.throws(
    () =>
      projectMergeAliasState(
        replayInput([...prefix, mergeEvent(6, "e1.0", "e3.0")]),
      ),
    decisionFailure("MERGE_CYCLE"),
  );
});

test("repeating an existing merge direction is a deterministic no-op", () => {
  const first = statementEvent(1, [literalDraft("A", "one")]);
  const second = statementEvent(2, [literalDraft("B", "two")]);
  const once = projectMergeAliasState(
    replayInput([first, second, mergeEvent(3, "e2.0", "e1.0")]),
  );
  const repeated = projectMergeAliasState(
    replayInput([
      first,
      second,
      mergeEvent(3, "e2.0", "e1.0"),
      mergeEvent(4, "e2.0", "e1.0"),
    ]),
  );

  assert.equal(JSON.stringify(repeated), JSON.stringify(once));
});

test("merge preserves strongest surface origin and earliest kind contribution", () => {
  const result = projectMergeAliasState(
    replayInput([
      statementEvent(1, [
        literalDraft("흡수 대상", "old", {
          subject_aliases: ["공통"],
          subject_kind: "service",
        }),
      ]),
      statementEvent(2, [
        literalDraft("유지 대상", "new", {
          subject_aliases: ["공통"],
          subject_kind: "component",
        }),
      ]),
      aliasEvent(3, "공통", "e1.0"),
      mergeEvent(4, "e2.0", "e1.0"),
    ]),
  );

  assert.equal(surface(result, "공통", "e2.0")?.origin, "confirmed");
  assert.equal(entity(result, "e2.0")?.kind, "service");
  assert.equal(entity(result, "e1.0")?.kind, null);
  assert.deepEqual(result.kindMaintenance, [
    {
      entityId: "e2.0",
      existingKind: "service",
      observedKind: "component",
      eventId: eventId(2),
    },
  ]);
});

test("two confirmed homonyms make a later stored statement fail closed", () => {
  assert.throws(
    () =>
      projectMergeAliasState(
        replayInput([
          statementEvent(1, [literalDraft("A", "one")]),
          statementEvent(2, [literalDraft("B", "two")]),
          aliasEvent(3, "공통", "e1.0"),
          aliasEvent(4, "공통", "e2.0"),
          statementEvent(5, [entityDraft("공통", "uses", "DB")]),
        ]),
      ),
    decisionFailure("AMBIGUOUS_ENTITY"),
  );
});

test("malformed, missing, and future decision targets fail with payload-redacted errors", () => {
  const statement = statementEvent(1, [literalDraft("A", "one")]);
  assert.throws(
    () =>
      projectMergeAliasState(
        replayInput([statement, mergeEvent(2, "e1.0", "e1.9")]),
      ),
    decisionFailure("MERGE_TARGET_NOT_FOUND", "e1.9"),
  );
  assert.throws(
    () =>
      projectMergeAliasState(
        replayInput([
          statement,
          aliasEvent(2, "미래", "e3.0"),
          statementEvent(3, [literalDraft("B", "two")]),
        ]),
      ),
    decisionFailure("DECISION_TARGET_NOT_PAST", "e3.0"),
  );
  assert.throws(
    () =>
      projectMergeAliasState(
        replayInput([statement, mergeEvent(2, "e1.0", "e1.0", { extra: true })]),
      ),
    decisionFailure("INVALID_DECISION_BODY", "extra"),
  );
  assert.throws(
    () =>
      projectMergeAliasState(
        replayInput([statement, aliasEvent(2, "   ", "e1.0")]),
      ),
    decisionFailure("INVALID_DECISION_BODY"),
  );
});
