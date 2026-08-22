import assert from "node:assert/strict";
import { test } from "node:test";

import {
  planProjectionDispatch,
  projectProjectionSnapshot,
  reduceIncrementalProjection,
} from "../../../dist/domain/index.js";

const SCOPE = "u:projection-user/p:prj-009";

function eventId(suffix) {
  return `ev_${"0".repeat(25)}${suffix}`;
}

function statement(seq, suffix, { supersedes } = {}) {
  const body = {
    raw_text: `statement ${seq}`,
    parsed: [
      {
        subject: "Auth Server",
        relation: "uses",
        object: "Session Store",
      },
    ],
    provenance: "user_stated",
    ttl: "permanent",
  };
  if (supersedes !== undefined) {
    body.supersedes = supersedes;
  }
  return Object.freeze({
    seq,
    eventId: eventId(suffix),
    scopeKey: SCOPE,
    kind: "statement",
    bodyJson: JSON.stringify(body),
    actor: "test-agent",
    branch: "prj-009",
    session: null,
    createdAt: 1_700_000_000 + seq,
  });
}

function customStatement(seq, suffix, rawText, parsed) {
  return Object.freeze({
    seq,
    eventId: eventId(suffix),
    scopeKey: SCOPE,
    kind: "statement",
    bodyJson: JSON.stringify({
      raw_text: rawText,
      parsed,
      provenance: "user_stated",
      ttl: "permanent",
    }),
    actor: "test-agent",
    branch: "prj-009",
    session: null,
    createdAt: 1_700_000_000 + seq,
  });
}

function decision(seq, suffix, kind, body) {
  return Object.freeze({
    seq,
    eventId: eventId(suffix),
    scopeKey: SCOPE,
    kind,
    bodyJson: JSON.stringify(body),
    actor: "test-agent",
    branch: "prj-009",
    session: null,
    createdAt: 1_700_000_000 + seq,
  });
}

function emptySnapshot() {
  return Object.freeze({
    statements: Object.freeze([]),
    entities: Object.freeze([]),
    surfaceForms: Object.freeze([]),
    claims: Object.freeze([]),
    claimSupport: Object.freeze([]),
    idRedirects: Object.freeze([]),
  });
}

test("the production reducer assembles one canonical projection snapshot", () => {
  const input = {
    scopeKey: SCOPE,
    rulesVersion: "rules-v1",
    events: [statement(1, "1")],
  };

  const snapshot = projectProjectionSnapshot(input);

  assert.equal(snapshot.statements.length, 1);
  assert.equal(snapshot.entities.length, 2);
  assert.equal(snapshot.claims.length, 1);
  assert.equal(snapshot.claimSupport.length, 1);
  assert.equal(snapshot.claimSupport[0].expiresAt, null);
  assert.equal(Object.isFrozen(snapshot), true);
});

test("dispatch planning separates safe suffix events from historical rewrites", () => {
  const root = statement(1, "1");
  assert.deepEqual(planProjectionDispatch([root]), {
    mode: "incremental",
    reason: "safe_suffix",
  });
  assert.deepEqual(
    planProjectionDispatch([
      statement(2, "2", { supersedes: root.eventId }),
    ]),
    { mode: "replay", reason: "historical_statement" },
  );
});

test("every safe incremental prefix is byte-equivalent to the full production reducer", () => {
  const events = [
    customStatement(1, "1", "auth uses db", [
      {
        subject: "Auth Server",
        subject_kind: "service",
        relation: "uses",
        object: "Database",
        subject_aliases: ["Auth"],
      },
    ]),
    customStatement(2, "2", "auth api mode one", [
      {
        subject: "Auth API",
        subject_kind: "api",
        relation: "describes",
        object_value: "mode-one",
      },
    ]),
    decision(3, "3", "alias", {
      surface: "login",
      entity_id: "e1.0",
    }),
    customStatement(4, "4", "login uses cache", [
      {
        subject: "login",
        relation: "uses",
        object: "Cache",
      },
    ]),
    decision(5, "5", "merge", { keep: "e2.0", absorb: "e1.0" }),
    decision(6, "6", "retraction", {
      target: { claim_id: "c1.0" },
      note: "obsolete dependency",
    }),
  ];

  let incremental = emptySnapshot();
  for (let index = 0; index < events.length; index += 1) {
    const history = events.slice(0, index + 1);
    incremental = reduceIncrementalProjection({
      scopeKey: SCOPE,
      rulesVersion: "rules-v1",
      current: incremental,
      events: [events[index]],
      history,
    });
    const replayed = projectProjectionSnapshot({
      scopeKey: SCOPE,
      rulesVersion: "rules-v1",
      events: history,
    });
    assert.deepEqual(incremental, replayed, `prefix ${index + 1}`);
    assert.equal(Object.isFrozen(incremental), true);
  }

  const canonical = incremental.entities.find((row) => row.id === "e2.0");
  assert.equal(canonical.kind, "service", "earliest kind survives explicit keep");
  assert.equal(
    incremental.claims.find((row) => row.id === "c1.0").state,
    "retracted",
  );
});

test("historical events cannot enter the incremental reducer", () => {
  const root = statement(1, "1");
  const successor = statement(2, "2", { supersedes: root.eventId });
  const secret = "SHOULD_NOT_APPEAR";
  assert.throws(
    () =>
      reduceIncrementalProjection({
        scopeKey: SCOPE,
        rulesVersion: "rules-v1",
        current: emptySnapshot(),
        events: [{ ...successor, bodyJson: successor.bodyJson + secret }],
        history: [root, successor],
      }),
    (error) => {
      assert.equal(error.code, "INVALID_INCREMENTAL_INPUT");
      assert.doesNotMatch(JSON.stringify(error), new RegExp(secret));
      return true;
    },
  );
});
