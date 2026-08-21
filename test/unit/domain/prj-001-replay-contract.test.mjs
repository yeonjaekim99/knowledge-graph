import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ProjectionReplayContractError,
  createProjectionReplayInput,
  runProjectionReplayReducer,
} from "../../../dist/domain/index.js";

const SCOPE = "u:replay-user/p:replay-project";

function event(seq, overrides = {}) {
  return {
    seq,
    eventId: `ev_${String(seq).padStart(26, "0")}`,
    scopeKey: SCOPE,
    kind: "statement",
    bodyJson: JSON.stringify({ raw_text: `event ${seq}`, parsed: [] }),
    actor: "unit-agent",
    branch: "prj-001",
    session: null,
    createdAt: 1_700_000_000 + seq,
    ...overrides,
  };
}

function emptyProjection() {
  return {
    statements: [],
    entities: [],
    surfaceForms: [],
    claims: [],
    claimSupport: [],
    idRedirects: [],
  };
}

function contractFailure(code) {
  return (error) => {
    assert.ok(error instanceof ProjectionReplayContractError);
    assert.equal(error.code, code);
    assert.equal("value" in error, false);
    return true;
  };
}

test("replay input is scope-bound, seq-sorted, recursively frozen, and clock-free", () => {
  const source = {
    scopeKey: SCOPE,
    rulesVersion: "projection-v1",
    events: [event(1), event(3)],
  };
  let received;

  const first = runProjectionReplayReducer(source, (input) => {
    received = input;
    assert.deepEqual(Object.keys(input), ["scopeKey", "rulesVersion", "events"]);
    assert.equal("clock" in input, false);
    assert.equal("rebuiltAt" in input, false);
    assert.equal(Object.isFrozen(input), true);
    assert.equal(Object.isFrozen(input.events), true);
    assert.equal(Object.isFrozen(input.events[0]), true);
    assert.throws(() => {
      input.events[0].seq = 99;
    }, TypeError);
    return emptyProjection();
  });
  const second = runProjectionReplayReducer(source, () => emptyProjection());

  assert.notEqual(received, source);
  assert.notEqual(received.events, source.events);
  assert.deepEqual(first, second);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.statements), true);
  assert.equal(source.events[0].seq, 1);
});

test("replay contract rejects unsorted, duplicate, and cross-scope journal input", () => {
  assert.throws(
    () =>
      createProjectionReplayInput({
        scopeKey: SCOPE,
        rulesVersion: "projection-v1",
        events: [event(2), event(1)],
      }),
    contractFailure("INVALID_EVENT_ORDER"),
  );
  assert.throws(
    () =>
      createProjectionReplayInput({
        scopeKey: SCOPE,
        rulesVersion: "projection-v1",
        events: [event(1), event(1)],
      }),
    contractFailure("INVALID_EVENT_ORDER"),
  );
  assert.throws(
    () =>
      createProjectionReplayInput({
        scopeKey: SCOPE,
        rulesVersion: "projection-v1",
        events: [event(1, { scopeKey: "u:other/p:project" })],
      }),
    contractFailure("SCOPE_MISMATCH"),
  );
  assert.throws(
    () =>
      createProjectionReplayInput({
        scopeKey: SCOPE,
        rulesVersion: " projection-v1 ",
        events: [],
      }),
    contractFailure("INVALID_RULES_VERSION"),
  );
});

test("reducer output cannot introduce another scope or a non-statement support target", () => {
  const input = {
    scopeKey: SCOPE,
    rulesVersion: "projection-v1",
    events: [event(1)],
  };

  assert.throws(
    () =>
      runProjectionReplayReducer(input, () => ({
        ...emptyProjection(),
        entities: [
          {
            id: "e1.0",
            scopeKey: "u:other/p:project",
            name: "other",
            normalName: "other",
            kind: null,
            mergedInto: null,
            originSeq: 1,
          },
        ],
      })),
    contractFailure("SCOPE_MISMATCH"),
  );

  assert.throws(
    () =>
      runProjectionReplayReducer(input, () => ({
        ...emptyProjection(),
        statements: [
          {
            eventId: event(1).eventId,
            scopeKey: SCOPE,
            state: "live",
            orderSeq: 1,
            createdAt: 1_700_000_001,
            provenance: "user_stated",
            expiresAt: null,
          },
        ],
        claimSupport: [
          {
            claimId: "c1.0",
            eventId: event(1).eventId,
            draftIndex: 0,
            live: 1,
            expiresAt: null,
          },
        ],
      })),
    contractFailure("INVALID_PROJECTION_SNAPSHOT"),
  );
});
