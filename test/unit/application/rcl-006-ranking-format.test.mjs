import assert from "node:assert/strict";
import { test } from "node:test";

import {
  RecallRankingError,
  formatRecallClaimBrief,
  rankRecallClaims,
} from "../../../dist/application/recall-ranking.js";

const reached = Object.freeze({
  claimId: "c1.0",
  depth: 0,
  seedOrder: 0,
  anchorId: "e1.0",
  path: "테스트 명령",
  hops: 0,
});

function rankedState(overrides = {}) {
  return Object.freeze({
    claimId: "c1.0",
    depth: 0,
    score: 9,
    subjectId: "e1.0",
    subjectName: "테스트 명령",
    relation: "describes",
    objectId: null,
    objectName: null,
    objectValue: "pnpm test",
    supportCount: 1,
    strongestRank: 3,
    lastSeenAt: 1_700_200_000,
    relationLabel: null,
    contested: false,
    recent: true,
    originSeq: 1,
    totalCount: 1,
    ...overrides,
  });
}

function smuggledRankingError(marker) {
  const error = new RecallRankingError("INVALID_RANKING_STATE");
  error.name = `Smuggled${marker}`;
  error.message = `smuggled-message-${marker}`;
  error.cause = { token: marker };
  error.secret = marker;
  return error;
}

function assertFreshRankingStateError(error, injected, marker) {
  const expected = new RecallRankingError("INVALID_RANKING_STATE");
  assert.ok(error instanceof RecallRankingError);
  assert.notStrictEqual(error, injected);
  assert.equal(error.code, "INVALID_RANKING_STATE");
  assert.equal(error.name, expected.name);
  assert.equal(error.message, expected.message);
  assert.deepEqual(Reflect.ownKeys(error).sort(), Reflect.ownKeys(expected).sort());
  assert.equal("cause" in error, false);
  assert.equal("secret" in error, false);
  assert.doesNotMatch(error.message, new RegExp(marker, "u"));
  assert.equal(JSON.stringify(error), JSON.stringify(expected));
  return true;
}

test("brief formatter uses the aggregate label or every ADR-004 default without particle correction", () => {
  const defaults = new Map([
    ["uses", "사용"],
    ["rejects", "거부"],
    ["contains", "포함"],
    ["describes", "="],
    ["relates_to", "관련"],
  ]);
  for (const [relation, predicate] of defaults) {
    assert.equal(
      formatRecallClaimBrief({
        subjectName: "인증",
        relation,
        relationLabel: null,
        objectName: "JWT",
        objectValue: null,
      }),
      `인증 ${predicate} JWT`,
    );
  }
  assert.equal(
    formatRecallClaimBrief({
      subjectName: "인증",
      relation: "uses",
      relationLabel: "을 실제로 사용한다",
      objectName: "JWT",
      objectValue: null,
    }),
    "인증 을 실제로 사용한다 JWT",
  );
  assert.equal(
    formatRecallClaimBrief({
      subjectName: "테스트 명령",
      relation: "describes",
      relationLabel: null,
      objectName: null,
      objectValue: "pnpm  test -- --runInBand",
    }),
    "테스트 명령 = pnpm  test -- --runInBand",
  );
});

test("ranking requests only claim/depth with a limit+1 probe and preserves traversal display fields", async () => {
  const calls = [];
  const source = Object.freeze({
    async selectRankedClaims(candidates, probeLimit) {
      calls.push({ candidates, probeLimit });
      return Object.freeze([rankedState()]);
    },
  });
  const result = await rankRecallClaims(source, {
    limit: 1,
    reached: [reached],
  });
  assert.deepEqual(calls, [
    {
      candidates: [{ claimId: "c1.0", depth: 0 }],
      probeLimit: 2,
    },
  ]);
  assert.deepEqual(result, [
    {
      claimId: "c1.0",
      score: 9,
      depth: 0,
      seedOrder: 0,
      anchorId: "e1.0",
      text: "테스트 명령 = pnpm test",
      path: "테스트 명령",
      hops: 0,
      contested: false,
      supportCount: 1,
      strongestRank: 3,
      lastSeenAt: 1_700_200_000,
    },
  ]);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result[0]), true);
});

test("ranking rejects malformed input and inconsistent source score with fixed payload-free errors", async () => {
  await assert.rejects(
    rankRecallClaims({ selectRankedClaims() {} }, {
      limit: 0,
      reached: [],
    }),
    (error) => {
      assert.ok(error instanceof RecallRankingError);
      assert.equal(error.code, "INVALID_RANKING_INPUT");
      assert.equal("cause" in error, false);
      return true;
    },
  );
  await assert.rejects(
    rankRecallClaims(
      {
        async selectRankedClaims() {
          return [rankedState({ score: 10 })];
        },
      },
      { limit: 1, reached: [reached] },
    ),
    (error) => {
      assert.ok(error instanceof RecallRankingError);
      assert.equal(error.code, "INVALID_RANKING_STATE");
      assert.equal("cause" in error, false);
      return true;
    },
  );
});

test("ranking source lookup, invocation, Promise rejection, and hostile thenable settlement use fresh errors", async () => {
  const cases = [
    (injected) => Object.defineProperty({}, "selectRankedClaims", {
      get() {
        throw injected;
      },
    }),
    (injected) => new Proxy({}, {
      get() {
        throw injected;
      },
    }),
    (injected) => ({
      selectRankedClaims() {
        throw injected;
      },
    }),
    (injected) => ({
      selectRankedClaims() {
        return Promise.reject(injected);
      },
    }),
    (injected) => ({
      selectRankedClaims() {
        return {
          then(_resolve, reject) {
            reject(injected);
          },
        };
      },
    }),
  ];
  for (const [index, createSource] of cases.entries()) {
    const marker = `ranking-boundary-${index}`;
    const injected = smuggledRankingError(marker);
    await assert.rejects(
      rankRecallClaims(createSource(injected), {
        limit: 1,
        reached: [reached],
      }),
      (error) => assertFreshRankingStateError(error, injected, marker),
    );
  }
});

test("ranking snapshots output arrays without invoking accessors or accepting extra array state", async () => {
  const marker = "ranking-array-accessor-secret";
  const injected = smuggledRankingError(marker);
  let accessorCalled = false;
  const accessorRows = [rankedState()];
  Object.defineProperty(accessorRows, "0", {
    configurable: true,
    enumerable: true,
    get() {
      accessorCalled = true;
      throw injected;
    },
  });
  await assert.rejects(
    rankRecallClaims(
      { selectRankedClaims: () => accessorRows },
      { limit: 1, reached: [reached] },
    ),
    (error) => assertFreshRankingStateError(error, injected, marker),
  );
  assert.equal(accessorCalled, false);

  const extraRows = [rankedState()];
  extraRows.secret = "array-smuggled-payload";
  await assert.rejects(
    rankRecallClaims(
      { selectRankedClaims: () => extraRows },
      { limit: 1, reached: [reached] },
    ),
    (error) => {
      assert.ok(error instanceof RecallRankingError);
      assert.equal(error.code, "INVALID_RANKING_STATE");
      assert.equal(JSON.stringify(error).includes(extraRows.secret), false);
      return true;
    },
  );
});

test("brief and ranking input descriptor snapshots reject accessors without evaluating them", async () => {
  let briefAccessorCalled = false;
  const brief = {
    subjectName: "A",
    relation: "uses",
    relationLabel: null,
    objectName: "B",
    objectValue: null,
  };
  Object.defineProperty(brief, "subjectName", {
    enumerable: true,
    get() {
      briefAccessorCalled = true;
      return "secret-subject";
    },
  });
  assert.throws(
    () => formatRecallClaimBrief(brief),
    (error) => error instanceof RecallRankingError && error.code === "INVALID_RANKING_STATE",
  );
  assert.equal(briefAccessorCalled, false);

  let inputAccessorCalled = false;
  const hostileReached = { ...reached };
  Object.defineProperty(hostileReached, "path", {
    enumerable: true,
    get() {
      inputAccessorCalled = true;
      return "secret-path";
    },
  });
  await assert.rejects(
    rankRecallClaims(
      { selectRankedClaims() {} },
      { limit: 1, reached: [hostileReached] },
    ),
    (error) => error instanceof RecallRankingError && error.code === "INVALID_RANKING_INPUT",
  );
  assert.equal(inputAccessorCalled, false);
});
