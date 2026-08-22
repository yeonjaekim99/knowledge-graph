import assert from "node:assert/strict";
import { test } from "node:test";

import { RecallReadError } from "../../../dist/application/ports/recall-read-port.js";
import { RecallSnapshotService } from "../../../dist/application/recall-snapshot-service.js";

const VALID_SNAPSHOT = Object.freeze({
  recordedAt: 1_700_100_000,
  evaluationNow: 1_700_100_000,
  rulesVersion: "test-rules-v1",
  scope: Object.freeze({
    userId: "alice",
    projectId: "recall",
    scopeKey: "u:alice/p:recall",
  }),
  metadata: Object.freeze({ actor: null, branch: null, session: null }),
});

function readError(code) {
  return (error) => {
    assert.ok(error instanceof RecallReadError);
    assert.equal(error.code, code);
    assert.equal("cause" in error, false);
    return true;
  };
}

test("the service captures trusted scope and UTC epoch now once and exposes only typed snapshot reads", async () => {
  let captures = 0;
  let contexts = 0;
  const aggregate = Object.freeze({
    claimId: "c1.0",
    supportCount: 1,
    strongestRank: 2,
    lastSeenAt: 1_700_000_000,
    relationLabel: null,
    effectiveExpiresAt: null,
  });
  const runtime = {
    async capture() {
      captures += 1;
      return VALID_SNAPSHOT;
    },
    nextEventId() {
      throw new Error("recall must not allocate event IDs");
    },
    nextApprovalToken() {
      throw new Error("recall must not allocate approval tokens");
    },
  };
  const port = {
    async withSnapshot(context, operation) {
      contexts += 1;
      assert.deepEqual(context, {
        scopeKey: "u:alice/p:recall",
        evaluationNow: 1_700_100_000,
      });
      assert.equal(Object.isFrozen(context), true);
      const source = Object.freeze({
        listValidClaimAggregates: async () => Object.freeze([aggregate]),
        resolveSurfaceSeeds: async (terms) =>
          Object.freeze({ terms, seeds: Object.freeze([]), truncated: false }),
        searchFtsCandidates: async () => {
          throw new Error("unused FTS read");
        },
        readTraversalNeighborhood: async () => {
          throw new Error("unused traversal read");
        },
      });
      assert.deepEqual(Object.keys(source), [
        "listValidClaimAggregates",
        "resolveSurfaceSeeds",
        "searchFtsCandidates",
        "readTraversalNeighborhood",
      ]);
      return operation(source);
    },
  };

  const service = new RecallSnapshotService(runtime, port);
  const rows = await service.withSnapshot((source) =>
    source.listValidClaimAggregates(),
  );

  assert.equal(captures, 1);
  assert.equal(contexts, 1);
  assert.deepEqual(rows, [aggregate]);
});

test("invalid or attacker-shaped runtime context fails closed before opening a read", async () => {
  const invalidSnapshots = [
    {
      ...VALID_SNAPSHOT,
      scope: {
        ...VALID_SNAPSHOT.scope,
        scopeKey: "u:alice/p:recall' OR 1=1 --",
      },
    },
    { ...VALID_SNAPSHOT, evaluationNow: -1 },
    { ...VALID_SNAPSHOT, evaluationNow: 1.5 },
    { ...VALID_SNAPSHOT, evaluationNow: Number.MAX_SAFE_INTEGER + 1 },
  ];

  for (const snapshot of invalidSnapshots) {
    let opened = false;
    const service = new RecallSnapshotService(
      {
        async capture() {
          return snapshot;
        },
        nextEventId() {
          throw new Error("unused");
        },
        nextApprovalToken() {
          throw new Error("unused");
        },
      },
      {
        async withSnapshot() {
          opened = true;
          throw new Error("must not open");
        },
      },
    );

    await assert.rejects(
      service.withSnapshot(async () => null),
      readError("INVALID_RECALL_CONTEXT"),
    );
    assert.equal(opened, false);
  }
});
