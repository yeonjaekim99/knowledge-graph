import assert from "node:assert/strict";
import { test } from "node:test";

import {
  RecallRankingError,
  rankRecallClaims,
} from "../../../dist/application/recall-ranking.js";
import { RecallReadError } from "../../../dist/application/ports/recall-read-port.js";
import {
  RECALL_RANKING_SQL_SOURCE,
  SqliteConnectionError,
} from "../../../dist/adapters/sqlite/index.js";
import { runSqliteRecallSnapshot } from "../../../dist/adapters/sqlite/connection-factory.js";
import {
  RCL_006_NOW,
  RCL_006_OTHER_SCOPE,
  RCL_006_SCOPE,
  assertDeepFrozen,
  claimCommand,
  createRcl006Fixture,
  createRecallServiceAt,
  entityCommand,
  openObserver,
  permanentDump,
  reached,
  supportCommands,
} from "../../support/rcl-006-sqlite-fixture.mjs";

const RECENT_SECONDS = 2_592_000;

function rawRankingRow(overrides = {}) {
  return {
    recall_ranking_claim_id: "c1.0",
    recall_ranking_claim_scope_key: RCL_006_SCOPE,
    recall_ranking_claim_state: "active",
    recall_ranking_contested: 0,
    recall_ranking_depth: 0,
    recall_ranking_last_seen_at: RCL_006_NOW,
    recall_ranking_object_id: null,
    recall_ranking_object_merged_into: null,
    recall_ranking_object_name: null,
    recall_ranking_object_scope_key: null,
    recall_ranking_object_value: "safe-value",
    recall_ranking_origin_seq: 1,
    recall_ranking_recent: 1,
    recall_ranking_relation: "contains",
    recall_ranking_relation_label: null,
    recall_ranking_score: 7,
    recall_ranking_strongest_rank: 2,
    recall_ranking_subject_id: "e1.0",
    recall_ranking_subject_merged_into: null,
    recall_ranking_subject_name: "safe-subject",
    recall_ranking_subject_scope_key: RCL_006_SCOPE,
    recall_ranking_support_count: 1,
    recall_ranking_total_count: 1,
    ...overrides,
  };
}

async function withInjectedSnapshot(factory, snapshot, operation) {
  const reader = await factory.openReader();
  Object.defineProperty(reader, "withRecallSnapshot", {
    configurable: true,
    value: async (_scopeKey, _evaluationNow, callback) => callback(snapshot),
  });
  const injectedFactory = Object.freeze({
    async openReader() {
      return reader;
    },
  });
  return createRecallServiceAt(injectedFactory).withSnapshot(operation);
}

function injectedRawSnapshot(rawResult) {
  return Object.freeze({
    assertActive() {},
    async readRawRankingRows() {
      return rawResult;
    },
  });
}

async function selectInjectedRaw(factory, rawResult) {
  return withInjectedSnapshot(
    factory,
    injectedRawSnapshot(rawResult),
    (source) => source.selectRankedClaims([{ claimId: "c1.0", depth: 0 }], 2),
  );
}

async function rankInjectedRaw(factory, rawResult) {
  return withInjectedSnapshot(
    factory,
    injectedRawSnapshot(rawResult),
    (source) => rankRecallClaims(source, {
      limit: 1,
      reached: [reached("c1.0")],
    }),
  );
}

function smuggledReadError(marker) {
  const error = new RecallReadError("INVALID_RECALL_RANKING_STATE");
  error.name = `Smuggled${marker}`;
  error.message = marker;
  error.cause = { marker };
  error.secret = marker;
  return error;
}

function assertFreshReadStateError(error, injected, marker) {
  const expected = new RecallReadError("INVALID_RECALL_RANKING_STATE");
  assert.ok(error instanceof RecallReadError);
  assert.notStrictEqual(error, injected);
  assert.equal(error.code, expected.code);
  assert.equal(error.name, expected.name);
  assert.equal(error.message, expected.message);
  assert.deepEqual(Reflect.ownKeys(error).sort(), Reflect.ownKeys(expected).sort());
  assert.equal("cause" in error, false);
  assert.equal("secret" in error, false);
  assert.equal(JSON.stringify(error).includes(marker), false);
  return true;
}

function smuggledConnectionError(marker) {
  const error = new SqliteConnectionError("SQLITE_QUERY_FAILED");
  error.name = `Smuggled${marker}`;
  error.message = marker;
  error.cause = { marker };
  error.secret = marker;
  return error;
}

function assertFreshConnectionError(error, injected, marker) {
  const expected = new SqliteConnectionError("SQLITE_QUERY_FAILED");
  assert.ok(error instanceof SqliteConnectionError);
  assert.notStrictEqual(error, injected);
  assert.equal(error.code, expected.code);
  assert.equal(error.name, expected.name);
  assert.equal(error.message, expected.message);
  assert.equal(error.retryable, expected.retryable);
  assert.deepEqual(Reflect.ownKeys(error).sort(), Reflect.ownKeys(expected).sort());
  assert.equal("cause" in error, false);
  assert.equal("secret" in error, false);
  assert.equal(JSON.stringify(error).includes(marker), false);
  return true;
}

async function expectFactoryCandidateRejection(factory, candidates, injected, marker) {
  const reader = await factory.openReader();
  try {
    await assert.rejects(
      runSqliteRecallSnapshot(
        reader,
        RCL_006_SCOPE,
        RCL_006_NOW,
        (snapshot) => snapshot.readRawRankingRows(candidates, 2),
      ),
      (error) => assertFreshConnectionError(error, injected, marker),
    );
  } finally {
    await reader.close();
  }
}

test("S10 ranking shares fixed aggregate label fallback and entity/literal contested identity without writes", async (t) => {
  const { databasePath, factory } = await createRcl006Fixture(t);
  await factory.enqueueWriteTransaction([
    entityCommand("e1.0", "인증"),
    entityCommand("e2.0", "JWT"),
    entityCommand("e3.0", "테스트 명령"),
    entityCommand("e90.0", "다른 scope 인증", RCL_006_OTHER_SCOPE),
    claimCommand({ claimId: "c1.0", subjectId: "e1.0", relation: "uses", objectId: "e2.0" }),
    claimCommand({ claimId: "c3.0", subjectId: "e1.0", relation: "rejects", objectId: "e2.0" }),
    claimCommand({ claimId: "c4.0", subjectId: "e3.0", relation: "describes", objectValue: "pnpm  test" }),
    claimCommand({ claimId: "c5.0", subjectId: "e1.0", relation: "uses", objectValue: "jwt-mode" }),
    claimCommand({ claimId: "c6.0", subjectId: "e1.0", relation: "rejects", objectValue: "jwt-mode" }),
    claimCommand({ claimId: "c7.0", subjectId: "e1.0", relation: "rejects", objectValue: "cookie-mode" }),
    claimCommand({ claimId: "c90.0", subjectId: "e90.0", relation: "rejects", objectValue: "jwt-mode", scopeKey: RCL_006_OTHER_SCOPE }),
    ...supportCommands({ sequence: 1, claimId: "c1.0", relationLabel: "예전에 사용", provenance: "observed", createdAt: RCL_006_NOW - 1_000 }),
    ...supportCommands({ sequence: 2, claimId: "c1.0", relationLabel: "최근 채택", provenance: "user_stated", createdAt: RCL_006_NOW - 60, expiresAt: RCL_006_NOW }),
    ...supportCommands({ sequence: 3, claimId: "c3.0", provenance: "user_stated", createdAt: RCL_006_NOW - 60, expiresAt: RCL_006_NOW }),
    ...supportCommands({ sequence: 4, claimId: "c4.0", provenance: "user_stated", createdAt: RCL_006_NOW - 50 }),
    ...supportCommands({ sequence: 5, claimId: "c5.0", provenance: "observed", createdAt: RCL_006_NOW - 40 }),
    ...supportCommands({ sequence: 6, claimId: "c6.0", provenance: "observed", createdAt: RCL_006_NOW - 30 }),
    ...supportCommands({ sequence: 7, claimId: "c7.0", provenance: "observed", createdAt: RCL_006_NOW - 20 }),
    ...supportCommands({ sequence: 8, claimId: "c1.0", relationLabel: "철회된 최신 표현", provenance: "user_stated", createdAt: RCL_006_NOW - 5, live: 0, statementState: "retracted" }),
    ...supportCommands({ sequence: 90, claimId: "c90.0", provenance: "user_stated", createdAt: RCL_006_NOW - 10, scopeKey: RCL_006_OTHER_SCOPE }),
  ]);

  assert.equal(Object.isFrozen(RECALL_RANKING_SQL_SOURCE), true);
  assert.match(RECALL_RANKING_SQL_SOURCE.selectRankedClaims, /temp\.recall_claim_agg/u);
  assert.match(RECALL_RANKING_SQL_SOURCE.selectRankedClaims, /:reached_json/u);
  assert.match(RECALL_RANKING_SQL_SOURCE.selectRankedClaims, /:scope_key/u);
  assert.match(RECALL_RANKING_SQL_SOURCE.selectRankedClaims, /:now/u);
  assert.match(RECALL_RANKING_SQL_SOURCE.selectRankedClaims, /BETWEEN \(:now - 2592000\) AND :now/u);
  assert.match(RECALL_RANKING_SQL_SOURCE.selectRankedClaims, /object_id IS/u);
  assert.match(RECALL_RANKING_SQL_SOURCE.selectRankedClaims, /object_value IS/u);
  assert.doesNotMatch(RECALL_RANKING_SQL_SOURCE.selectRankedClaims, /\b(?:INSERT|UPDATE|DELETE)\b/iu);

  const observer = openObserver(databasePath);
  t.after(() => observer.close());
  const beforeDump = permanentDump(observer);
  const beforeVersion = observer.pragma("data_version", { simple: true });
  const commonReached = ["c1.0", "c3.0", "c4.0", "c5.0", "c6.0", "c7.0"].map((id) => reached(id));
  const before = await createRecallServiceAt(factory, RCL_006_NOW - 1).withSnapshot((source) =>
    rankRecallClaims(source, { limit: 10, reached: commonReached }));
  const beforeById = new Map(before.map((candidate) => [candidate.claimId, candidate]));
  assert.equal(beforeById.get("c1.0").text, "인증 최근 채택 JWT");
  assert.equal(beforeById.get("c1.0").supportCount, 2);
  assert.equal(beforeById.get("c1.0").strongestRank, 3);
  assert.equal(beforeById.get("c1.0").contested, true);
  assert.equal(beforeById.get("c5.0").contested, true);
  assert.equal(beforeById.get("c6.0").contested, true);
  assert.equal(beforeById.get("c7.0").contested, false);
  assert.equal(beforeById.get("c4.0").text, "테스트 명령 = pnpm  test");

  const after = await createRecallServiceAt(factory, RCL_006_NOW).withSnapshot((source) =>
    rankRecallClaims(source, {
      limit: 10,
      reached: commonReached.filter(({ claimId }) => claimId !== "c3.0"),
    }));
  const afterById = new Map(after.map((candidate) => [candidate.claimId, candidate]));
  assert.equal(afterById.get("c1.0").text, "인증 예전에 사용 JWT");
  assert.equal(afterById.get("c1.0").supportCount, 1);
  assert.equal(afterById.get("c1.0").strongestRank, 2);
  assert.equal(afterById.get("c1.0").contested, false);
  assert.equal(afterById.has("c3.0"), false);
  assertDeepFrozen(assert, before);
  assertDeepFrozen(assert, after);
  assert.equal(permanentDump(observer), beforeDump);
  assert.equal(observer.pragma("data_version", { simple: true }), beforeVersion);
});

test("SQL computes every score term and applies the complete deterministic tie-break", async (t) => {
  const { factory } = await createRcl006Fixture(t);
  const commands = [entityCommand("e1.0", "랭킹 기준")];
  let sequence = 100;
  const add = ({
    claimId,
    provenance = "observed",
    count = 1,
    createdAt = RCL_006_NOW - RECENT_SECONDS - 10,
    relation = "contains",
    objectValue = claimId,
  }) => {
    commands.push(claimCommand({ claimId, subjectId: "e1.0", relation, objectValue }));
    for (let index = 0; index < count; index += 1) {
      commands.push(...supportCommands({
        sequence,
        claimId,
        provenance,
        createdAt: createdAt - index,
      }));
      sequence += 1;
    }
  };

  add({ claimId: "c10.0", provenance: "inferred" });
  add({ claimId: "c11.0", count: 3, relation: "uses", objectValue: "depth-pair" });
  add({ claimId: "c91.0", relation: "rejects", objectValue: "depth-pair" });
  add({ claimId: "c12.0", provenance: "user_stated" });
  add({ claimId: "c13.0", count: 3 });
  add({ claimId: "c14.0", count: 4 });
  add({ claimId: "c15.0", count: 2, createdAt: RCL_006_NOW - 10 });
  add({ claimId: "c16.0", createdAt: RCL_006_NOW - 1 });
  add({ claimId: "c17.0", createdAt: RCL_006_NOW - 2 });
  add({ claimId: "c18.0" });
  add({ claimId: "c19.0" });
  add({ claimId: "c20.2" });
  add({ claimId: "c20.10" });
  add({ claimId: "c21.0", count: 5 });
  add({ claimId: "c22.0", count: 4 });
  add({ claimId: "c23.0", createdAt: RCL_006_NOW - RECENT_SECONDS });
  add({ claimId: "c24.0", createdAt: RCL_006_NOW - RECENT_SECONDS - 1 });
  await factory.enqueueWriteTransaction(commands);

  const depths = new Map([["c11.0", 1]]);
  const requested = [
    "c24.0", "c20.10", "c17.0", "c10.0", "c21.0", "c13.0", "c18.0", "c15.0",
    "c23.0", "c12.0", "c20.2", "c19.0", "c14.0", "c11.0", "c16.0", "c22.0",
  ].map((id) => reached(id, depths.get(id) ?? 0));
  const ranked = await createRecallServiceAt(factory).withSnapshot((source) =>
    rankRecallClaims(source, { limit: 50, reached: requested }));
  const byId = new Map(ranked.map((candidate, index) => [candidate.claimId, { ...candidate, index }]));

  assert.equal(byId.get("c10.0").score, 2);
  assert.equal(byId.get("c11.0").score, 2);
  assert.equal(byId.get("c12.0").score, 7);
  assert.equal(byId.get("c14.0").score, 8);
  assert.equal(byId.get("c15.0").score, 8);
  assert.equal(byId.get("c21.0").score, 8);
  assert.equal(byId.get("c22.0").score, 8);
  assert.equal(byId.get("c23.0").score, 7);
  assert.equal(byId.get("c24.0").score, 5);
  assert.ok(byId.get("c10.0").index < byId.get("c11.0").index, "depth ASC");
  assert.ok(byId.get("c12.0").index < byId.get("c13.0").index, "strongest DESC");
  assert.ok(byId.get("c14.0").index < byId.get("c15.0").index, "support count DESC");
  assert.ok(byId.get("c16.0").index < byId.get("c17.0").index, "last seen DESC");
  assert.ok(byId.get("c18.0").index < byId.get("c19.0").index, "origin seq ASC");
  assert.ok(byId.get("c20.2").index < byId.get("c20.10").index, "numeric suffix ASC");
  assert.ok(byId.get("c21.0").index < byId.get("c22.0").index, "support score caps at four before tie-break");
  assert.equal(ranked.some((candidate) => "answers" in candidate), false);
  assert.equal(ranked.some((candidate) => "moreAvailable" in candidate), false);
});

test("ranking remains on one fixed WAL snapshot and limit+1 returns only the sentinel candidate", async (t) => {
  const { factory } = await createRcl006Fixture(t);
  await factory.enqueueWriteTransaction([
    entityCommand("e1.0", "A"),
    claimCommand({ claimId: "c1.0", subjectId: "e1.0", objectValue: "one" }),
    claimCommand({ claimId: "c2.0", subjectId: "e1.0", objectValue: "two" }),
    claimCommand({ claimId: "c3.0", subjectId: "e1.0", objectValue: "three" }),
    ...supportCommands({ sequence: 201, claimId: "c1.0", createdAt: RCL_006_NOW - 30 }),
    ...supportCommands({ sequence: 202, claimId: "c2.0", createdAt: RCL_006_NOW - 20 }),
    ...supportCommands({ sequence: 203, claimId: "c3.0", createdAt: RCL_006_NOW - 10 }),
  ]);
  const service = createRecallServiceAt(factory);
  const allReached = [reached("c1.0"), reached("c2.0"), reached("c3.0")];
  const observations = await service.withSnapshot(async (source) => {
    const before = await rankRecallClaims(source, { limit: 1, reached: allReached });
    await factory.enqueueWriteTransaction([
      ...supportCommands({
        sequence: 204,
        claimId: "c1.0",
        relationLabel: "new snapshot label",
        provenance: "user_stated",
        createdAt: RCL_006_NOW,
      }),
    ]);
    const after = await rankRecallClaims(source, { limit: 1, reached: allReached });
    return { before, after };
  });
  assert.equal(observations.before.length, 2);
  assert.equal(JSON.stringify(observations.after), JSON.stringify(observations.before));
  const next = await service.withSnapshot((source) =>
    rankRecallClaims(source, { limit: 1, reached: allReached }));
  assert.equal(next.length, 2);
  assert.equal(next[0].claimId, "c1.0");
  assert.equal(next[0].text, "A new snapshot label one");
});

test("adapter rejects ranking request accessors without evaluation or payload retention", async (t) => {
  const { factory } = await createRcl006Fixture(t);
  await factory.enqueueWriteTransaction([
    entityCommand("e1.0", "safe"),
    claimCommand({ claimId: "c1.0", subjectId: "e1.0", objectValue: "safe" }),
    ...supportCommands({ sequence: 301, claimId: "c1.0" }),
  ]);
  const marker = "adapter-ranking-request-secret";
  const injected = new RecallReadError("INVALID_RECALL_RANKING_STATE");
  injected.message = marker;
  injected.cause = { marker };
  let accessorCalled = false;
  const candidates = [{ claimId: "c1.0", depth: 0 }];
  Object.defineProperty(candidates, "0", {
    configurable: true,
    enumerable: true,
    get() {
      accessorCalled = true;
      throw injected;
    },
  });
  await createRecallServiceAt(factory).withSnapshot(async (source) => {
    await assert.rejects(
      source.selectRankedClaims(candidates, 2),
      (error) => {
        const expected = new RecallReadError("INVALID_RECALL_RANKING_REQUEST");
        assert.ok(error instanceof RecallReadError);
        assert.notStrictEqual(error, injected);
        assert.equal(error.code, expected.code);
        assert.equal(error.name, expected.name);
        assert.equal(error.message, expected.message);
        assert.equal("cause" in error, false);
        assert.equal(JSON.stringify(error).includes(marker), false);
        return true;
      },
    );
  });
  assert.equal(accessorCalled, false);
});

test("adapter rejects a non-canonical literal returned by SQLite", async (t) => {
  const { factory } = await createRcl006Fixture(t);
  await assert.rejects(
    selectInjectedRaw(factory, {
      rows: [rawRankingRow({ recall_ranking_object_value: "ｐｎｐｍ　ｔｅｓｔ" })],
    }),
    (error) => {
      const expected = new RecallReadError("INVALID_RECALL_RANKING_STATE");
      assert.ok(error instanceof RecallReadError);
      assert.equal(error.code, expected.code);
      assert.equal(error.name, expected.name);
      assert.equal(error.message, expected.message);
      assert.equal("cause" in error, false);
      assert.equal(JSON.stringify(error).includes("ｐｎｐｍ"), false);
      return true;
    },
  );
});

test("adapter rejects contested state for relations outside uses and rejects", async (t) => {
  const { factory } = await createRcl006Fixture(t);
  await assert.rejects(
    selectInjectedRaw(factory, {
      rows: [rawRankingRow({
        recall_ranking_contested: 1,
        recall_ranking_score: 4,
      })],
    }),
    (error) => {
      const expected = new RecallReadError("INVALID_RECALL_RANKING_STATE");
      assert.ok(error instanceof RecallReadError);
      assert.equal(error.code, expected.code);
      assert.equal(error.name, expected.name);
      assert.equal(error.message, expected.message);
      assert.equal("cause" in error, false);
      return true;
    },
  );
});

test("adapter redacts a typed snapshot assertActive failure", async (t) => {
  const { factory } = await createRcl006Fixture(t);
  const marker = "ranking-assert-active-secret";
  const injected = smuggledReadError(marker);
  await assert.rejects(
    withInjectedSnapshot(
      factory,
      Object.freeze({
        assertActive() {
          throw injected;
        },
      }),
      (source) => source.selectRankedClaims(
        [{ claimId: "c1.0", depth: 0 }],
        2,
      ),
    ),
    (error) => assertFreshReadStateError(error, injected, marker),
  );
});

test("connection factory snapshots ranking candidate arrays without invoking accessors", async (t) => {
  const { factory } = await createRcl006Fixture(t);
  const marker = "ranking-factory-array-secret";
  const injected = smuggledConnectionError(marker);
  let accessorCalled = false;
  const candidates = [{ claimId: "c1.0", depth: 0 }];
  Object.defineProperty(candidates, "0", {
    configurable: true,
    enumerable: true,
    get() {
      accessorCalled = true;
      throw injected;
    },
  });
  await expectFactoryCandidateRejection(factory, candidates, injected, marker);
  assert.equal(accessorCalled, false);
});

test("connection factory snapshots ranking candidate rows without invoking accessors", async (t) => {
  const { factory } = await createRcl006Fixture(t);
  const marker = "ranking-factory-row-secret";
  const injected = smuggledConnectionError(marker);
  let accessorCalled = false;
  const candidate = { claimId: "c1.0", depth: 0 };
  Object.defineProperty(candidate, "claimId", {
    configurable: true,
    enumerable: true,
    get() {
      accessorCalled = true;
      throw injected;
    },
  });
  await expectFactoryCandidateRejection(factory, [candidate], injected, marker);
  assert.equal(accessorCalled, false);
});

test("connection factory converts hostile ranking candidate Proxy traps to fresh errors", async (t) => {
  const { factory } = await createRcl006Fixture(t);
  const marker = "ranking-factory-proxy-secret";
  const injected = smuggledConnectionError(marker);
  const candidates = new Proxy(
    [{ claimId: "c1.0", depth: 0 }],
    {
      get(target, key, receiver) {
        if (key === Symbol.iterator) {
          throw injected;
        }
        return Reflect.get(target, key, receiver);
      },
      ownKeys() {
        throw injected;
      },
    },
  );
  await expectFactoryCandidateRejection(factory, candidates, injected, marker);
});

test("raw ranking envelopes, arrays, rows, corrupt scope/time, and typed rejection fail closed without payloads", async (t) => {
  const { factory } = await createRcl006Fixture(t);
  const marker = "raw-ranking-secret";
  const cases = [];

  let envelopeAccessorCalled = false;
  const accessorEnvelope = {};
  Object.defineProperty(accessorEnvelope, "rows", {
    enumerable: true,
    get() {
      envelopeAccessorCalled = true;
      return [rawRankingRow()];
    },
  });
  cases.push(accessorEnvelope);

  let arrayAccessorCalled = false;
  const accessorArray = [rawRankingRow()];
  Object.defineProperty(accessorArray, "0", {
    configurable: true,
    enumerable: true,
    get() {
      arrayAccessorCalled = true;
      return rawRankingRow({ recall_ranking_subject_name: marker });
    },
  });
  cases.push({ rows: accessorArray });

  let rowAccessorCalled = false;
  const accessorRow = rawRankingRow();
  Object.defineProperty(accessorRow, "recall_ranking_subject_name", {
    enumerable: true,
    get() {
      rowAccessorCalled = true;
      return marker;
    },
  });
  cases.push({ rows: [accessorRow] });
  cases.push({ rows: [rawRankingRow({ recall_ranking_subject_scope_key: RCL_006_OTHER_SCOPE })] });
  cases.push({ rows: [rawRankingRow({ recall_ranking_last_seen_at: RCL_006_NOW + 1 })] });
  cases.push({ rows: [rawRankingRow({ recall_ranking_score: 999, secret: marker })] });

  const injected = new RecallReadError("INVALID_RECALL_RANKING_STATE");
  injected.name = `Smuggled${marker}`;
  injected.message = marker;
  injected.cause = { marker };
  cases.push({
    then(_resolve, reject) {
      reject(injected);
    },
  });

  for (const rawResult of cases) {
    await assert.rejects(
      rankInjectedRaw(factory, rawResult),
      (error) => {
        const expected = new RecallRankingError("INVALID_RANKING_STATE");
        assert.ok(error instanceof RecallRankingError);
        assert.notStrictEqual(error, injected);
        assert.equal(error.code, expected.code);
        assert.equal(error.name, expected.name);
        assert.equal(error.message, expected.message);
        assert.equal("cause" in error, false);
        assert.equal(JSON.stringify(error).includes(marker), false);
        return true;
      },
    );
  }
  assert.equal(envelopeAccessorCalled, false);
  assert.equal(arrayAccessorCalled, false);
  assert.equal(rowAccessorCalled, false);
});
