import assert from "node:assert/strict";
import { test } from "node:test";

import {
  EntityProjectionError,
  preScanProjectionEvents,
  projectEntitySurfaceKinds,
  reduceEntitySurfaceKinds,
  resolveEntityReference,
  strongestSurfaceOrigin,
} from "../../../dist/domain/index.js";

const SCOPE = "u:entity-user/p:recall";
const OTHER_SCOPE = "u:other-user/p:recall";
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

function journalEvent(seq, kind, body) {
  return {
    seq,
    eventId: eventId(seq),
    scopeKey: SCOPE,
    kind,
    bodyJson: JSON.stringify(body),
    actor: "unit-agent",
    branch: "prj-005",
    session: null,
    createdAt: BASE_TIME + seq,
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

function literalDraft(subject, objectValue, options = {}) {
  return {
    subject,
    relation: "describes",
    object_value: objectValue,
    ...options,
  };
}

function entityRow(id, name, normalName, overrides = {}) {
  return {
    id,
    scopeKey: SCOPE,
    name,
    normalName,
    kind: null,
    mergedInto: null,
    originSeq: Number(id.slice(1).split(".")[0]),
    ...overrides,
  };
}

function referenceState(overrides = {}) {
  return {
    scopeKey: SCOPE,
    name: "로그인",
    entityAnchors: [
      { id: "e1.0", kind: "entity", scopeKey: SCOPE },
      { id: "e2.0", kind: "entity", scopeKey: SCOPE },
      { id: "e3.0", kind: "entity", scopeKey: SCOPE },
    ],
    entities: [
      entityRow("e1.0", "인증 시스템", "인증시스템"),
      entityRow("e3.0", "결제 시스템", "결제시스템"),
    ],
    surfaceForms: [
      {
        scopeKey: SCOPE,
        surfaceNorm: "로그인",
        entityId: "e2.0",
        origin: "confirmed",
      },
    ],
    idRedirects: [
      {
        oldId: "e2.0",
        newId: "e1.0",
        kind: "entity",
        reason: "deduplicated",
      },
    ],
    ...overrides,
  };
}

function projectionFailure(code, forbiddenValue) {
  return (error) => {
    assert.ok(error instanceof EntityProjectionError);
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

test("projects occurrence-stable entities, directional surfaces, redirects, and kinds", () => {
  const input = replayInput([
    statementEvent(1, {
      parsed: [
        {
          subject: "  인증 시스템  ",
          subject_kind: " Service ",
          subject_aliases: ["로그인", " 로그인 "],
          relation: "uses",
          object: "서버 세션",
          object_kind: "INFRASTRUCTURE",
          object_aliases: ["session", "session"],
        },
        literalDraft("인증-시스템", "enabled", {
          subject_kind: "service",
        }),
      ],
    }),
  ]);

  const before = structuredClone(input);
  const result = projectEntitySurfaceKinds(input);

  assert.deepEqual(result.entityAnchors, [
    { id: "e1.0", kind: "entity", scopeKey: SCOPE },
    { id: "e1.1", kind: "entity", scopeKey: SCOPE },
    { id: "e1.2", kind: "entity", scopeKey: SCOPE },
  ]);
  assert.deepEqual(result.entities, [
    {
      id: "e1.0",
      scopeKey: SCOPE,
      name: "인증 시스템",
      normalName: "인증시스템",
      kind: "service",
      mergedInto: null,
      originSeq: 1,
    },
    {
      id: "e1.1",
      scopeKey: SCOPE,
      name: "서버 세션",
      normalName: "서버세션",
      kind: "infrastructure",
      mergedInto: null,
      originSeq: 1,
    },
  ]);
  assert.deepEqual(result.surfaceForms, [
    {
      scopeKey: SCOPE,
      surfaceNorm: "session",
      entityId: "e1.1",
      origin: "agent_supplied",
    },
    {
      scopeKey: SCOPE,
      surfaceNorm: "로그인",
      entityId: "e1.0",
      origin: "agent_supplied",
    },
    {
      scopeKey: SCOPE,
      surfaceNorm: "서버세션",
      entityId: "e1.1",
      origin: "name",
    },
    {
      scopeKey: SCOPE,
      surfaceNorm: "인증시스템",
      entityId: "e1.0",
      origin: "name",
    },
  ]);
  assert.deepEqual(result.idRedirects, [
    {
      oldId: "e1.2",
      newId: "e1.0",
      kind: "entity",
      reason: "deduplicated",
    },
  ]);
  assert.deepEqual(result.occurrences, [
    {
      eventId: eventId(1),
      draftIndex: 0,
      subjectId: "e1.0",
      objectId: "e1.1",
    },
    {
      eventId: eventId(1),
      draftIndex: 1,
      subjectId: "e1.0",
      objectId: null,
    },
  ]);
  assert.deepEqual(result.kindMaintenance, []);
  assert.deepEqual(input, before);
  assertDeepFrozen(result);
  assert.equal(JSON.stringify(projectEntitySurfaceKinds(input)), JSON.stringify(result));
  assert.deepEqual(reduceEntitySurfaceKinds(preScanProjectionEvents(input)), result);
});

test("claim retraction preserves statement entity, surface, and kind evidence", () => {
  const statement = statementEvent(1, {
    parsed: [
      literalDraft("인증 시스템", "enabled", {
        subject_kind: "service",
        subject_aliases: ["로그인"],
      }),
    ],
  });

  const live = projectEntitySurfaceKinds(replayInput([statement]));
  const claimRetracted = projectEntitySurfaceKinds(
    replayInput([statement, claimRetraction(2, "c1.0")]),
  );

  assert.deepEqual(claimRetracted, live);
});

test("statement retraction keeps occurrence anchors but removes structural evidence", () => {
  const statement = statementEvent(1, {
    parsed: [
      {
        subject: "인증 시스템",
        subject_kind: "service",
        subject_aliases: ["로그인"],
        relation: "uses",
        object: "서버 세션",
        object_kind: "infrastructure",
        object_aliases: ["session"],
      },
    ],
  });

  const result = projectEntitySurfaceKinds(
    replayInput([statement, statementRetraction(2, statement.eventId)]),
  );

  assert.deepEqual(result.entityAnchors.map(({ id }) => id), ["e1.0", "e1.1"]);
  assert.deepEqual(
    result.entities.map(({ id, kind }) => ({ id, kind })),
    [
      { id: "e1.0", kind: null },
      { id: "e1.1", kind: null },
    ],
  );
  assert.deepEqual(result.surfaceForms, []);
  assert.deepEqual(result.occurrences, [
    {
      eventId: eventId(1),
      draftIndex: 0,
      subjectId: "e1.0",
      objectId: "e1.1",
    },
  ]);
});

test("a later live occurrence reuses an inactive anchor without a new name origin", () => {
  const first = statementEvent(1, {
    parsed: [literalDraft("인증 시스템", "old", { subject_kind: "legacy" })],
  });
  const later = statementEvent(3, {
    parsed: [literalDraft("인증-시스템", "new", { subject_kind: "service" })],
  });

  const result = projectEntitySurfaceKinds(
    replayInput([first, statementRetraction(2, first.eventId), later]),
  );

  assert.equal(result.entities[0].id, "e1.0");
  assert.equal(result.entities[0].name, "인증 시스템");
  assert.equal(result.entities[0].kind, "service");
  assert.deepEqual(result.idRedirects, [
    {
      oldId: "e3.0",
      newId: "e1.0",
      kind: "entity",
      reason: "deduplicated",
    },
  ]);
  assert.deepEqual(result.surfaceForms, [
    {
      scopeKey: SCOPE,
      surfaceNorm: "인증시스템",
      entityId: "e1.0",
      origin: "agent_supplied",
    },
  ]);
});

test("reinterpret root order selects the earliest live kind and reports later mismatches", () => {
  const rawText = "인증 시스템 분류";
  const root = statementEvent(1, {
    rawText,
    parsed: [literalDraft("인증 시스템", "v1", { subject_kind: "legacy" })],
  });
  const later = statementEvent(2, {
    parsed: [literalDraft("인증 시스템", "v2", { subject_kind: "database" })],
  });
  const successor = statementEvent(3, {
    rawText,
    parsed: [literalDraft("인증 시스템", "v1", { subject_kind: " Service " })],
    supersedes: root.eventId,
  });

  const result = projectEntitySurfaceKinds(replayInput([root, later, successor]));

  assert.equal(result.entities[0].id, "e1.0");
  assert.equal(result.entities[0].kind, "service");
  assert.deepEqual(result.idRedirects, [
    {
      oldId: "e2.0",
      newId: "e1.0",
      kind: "entity",
      reason: "deduplicated",
    },
    {
      oldId: "e3.0",
      newId: "e1.0",
      kind: "entity",
      reason: "deduplicated",
    },
  ]);
  assert.deepEqual(result.kindMaintenance, [
    {
      entityId: "e1.0",
      existingKind: "service",
      observedKind: "database",
      eventId: eventId(2),
    },
  ]);
});

test("subject precedes object when one draft gives the same entity conflicting kinds", () => {
  const result = projectEntitySurfaceKinds(
    replayInput([
      statementEvent(1, {
        parsed: [
          {
            subject: "노드",
            subject_kind: "service",
            relation: "uses",
            object: "노드",
            object_kind: "database",
          },
        ],
      }),
    ]),
  );

  assert.equal(result.entities[0].kind, "service");
  assert.deepEqual(result.kindMaintenance, [
    {
      entityId: "e1.0",
      existingKind: "service",
      observedKind: "database",
      eventId: eventId(1),
    },
  ]);
});

test("surface origin strength never downgrades an existing contribution", () => {
  assert.equal(strongestSurfaceOrigin("agent_supplied", "name"), "name");
  assert.equal(strongestSurfaceOrigin("name", "agent_supplied"), "name");
  assert.equal(strongestSurfaceOrigin("name", "confirmed"), "confirmed");
  assert.equal(strongestSurfaceOrigin("confirmed", "agent_supplied"), "confirmed");
  assert.throws(
    () => strongestSurfaceOrigin("trusted", "name"),
    projectionFailure("INVALID_SURFACE_ORIGIN", "trusted"),
  );
});

test("reference resolution canonicalizes redirected surfaces and supports every origin", () => {
  for (const origin of ["name", "agent_supplied", "confirmed"]) {
    const state = referenceState({
      surfaceForms: [
        {
          scopeKey: SCOPE,
          surfaceNorm: "로그인",
          entityId: "e2.0",
          origin,
        },
      ],
    });
    assert.deepEqual(resolveEntityReference(state), {
      status: "resolved",
      normalName: "로그인",
      entityId: "e1.0",
    });
  }
});

test("exact active normal name is the sole deterministic tie-break among homonyms", () => {
  const surfaces = [
    {
      scopeKey: SCOPE,
      surfaceNorm: "로그인",
      entityId: "e2.0",
      origin: "confirmed",
    },
    {
      scopeKey: SCOPE,
      surfaceNorm: "로그인",
      entityId: "e3.0",
      origin: "agent_supplied",
    },
  ];
  const state = referenceState({
    entities: [
      entityRow("e1.0", "인증 시스템", "인증시스템"),
      entityRow("e3.0", "로그인", "로그인"),
    ],
    surfaceForms: surfaces,
  });

  const expected = {
    status: "resolved",
    normalName: "로그인",
    entityId: "e3.0",
  };
  assert.deepEqual(resolveEntityReference(state), expected);
  assert.deepEqual(
    resolveEntityReference({
      ...state,
      entityAnchors: [...state.entityAnchors].reverse(),
      entities: [...state.entities].reverse(),
      surfaceForms: [...state.surfaceForms].reverse(),
      idRedirects: [...state.idRedirects].reverse(),
    }),
    expected,
  );
});

test("ambiguous homonyms are stable for preflight and fail closed once stored", () => {
  const state = referenceState({
    surfaceForms: [
      {
        scopeKey: SCOPE,
        surfaceNorm: "로그인",
        entityId: "e2.0",
        origin: "confirmed",
      },
      {
        scopeKey: SCOPE,
        surfaceNorm: "로그인",
        entityId: "e3.0",
        origin: "agent_supplied",
      },
    ],
  });
  assert.deepEqual(resolveEntityReference(state), {
    status: "ambiguous",
    normalName: "로그인",
    candidates: [
      { entityId: "e1.0", name: "인증 시스템" },
      { entityId: "e3.0", name: "결제 시스템" },
    ],
  });

  const ambiguousInput = replayInput([
    statementEvent(1, {
      parsed: [literalDraft("Alpha", "one", { subject_aliases: ["shared"] })],
    }),
    statementEvent(2, {
      parsed: [literalDraft("Beta", "two", { subject_aliases: ["shared"] })],
    }),
    statementEvent(3, {
      parsed: [literalDraft("shared", "three")],
    }),
  ]);
  assert.throws(
    () => projectEntitySurfaceKinds(ambiguousInput),
    projectionFailure("AMBIGUOUS_ENTITY", "shared"),
  );
});

test("entity draft, kind, state shape, and redirect failures stay payload-redacted", () => {
  const secret = "should-not-appear";
  assert.throws(
    () =>
      projectEntitySurfaceKinds(
        replayInput([
          statementEvent(1, {
            parsed: [literalDraft(42, secret)],
          }),
        ]),
      ),
    projectionFailure("INVALID_ENTITY_DRAFT", secret),
  );
  assert.throws(
    () =>
      projectEntitySurfaceKinds(
        replayInput([
          statementEvent(1, {
            parsed: [literalDraft("entity", "value", { subject_kind: " " })],
          }),
        ]),
      ),
    projectionFailure("INVALID_ENTITY_KIND"),
  );
  const sixtyFourCodePoints = "A".repeat(64);
  assert.equal(
    projectEntitySurfaceKinds(
      replayInput([
        statementEvent(1, {
          parsed: [
            literalDraft("entity", "value", {
              subject_kind: sixtyFourCodePoints,
            }),
          ],
        }),
      ]),
    ).entities[0].kind,
    sixtyFourCodePoints.toLowerCase(),
  );
  assert.throws(
    () =>
      projectEntitySurfaceKinds(
        replayInput([
          statementEvent(1, {
            parsed: [
              literalDraft("entity", "value", {
                subject_kind: "A".repeat(65),
              }),
            ],
          }),
        ]),
      ),
    projectionFailure("INVALID_ENTITY_KIND"),
  );
  assert.throws(
    () =>
      resolveEntityReference({
        ...referenceState(),
        unexpected: secret,
      }),
    projectionFailure("INVALID_ENTITY_STATE", secret),
  );
  assert.throws(
    () =>
      resolveEntityReference(
        referenceState({
          entityAnchors: [
            { id: "e1.0", kind: "entity", scopeKey: SCOPE },
            { id: "e2.0", kind: "entity", scopeKey: OTHER_SCOPE },
            { id: "e3.0", kind: "entity", scopeKey: SCOPE },
          ],
        }),
      ),
    projectionFailure("INVALID_ENTITY_STATE", OTHER_SCOPE),
  );
});
