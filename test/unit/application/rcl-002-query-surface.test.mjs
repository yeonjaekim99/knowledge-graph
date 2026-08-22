import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveRecallQuerySurface } from "../../../dist/application/recall-query-surface.js";
import { RecallSnapshotService } from "../../../dist/application/recall-snapshot-service.js";

const SNAPSHOT = Object.freeze({
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

test("query surface policy runs inside the RCL-001 snapshot and exposes only the narrow typed read capability", async () => {
  let captures = 0;
  let reads = 0;
  const observedTerms = [];
  const service = new RecallSnapshotService(
    {
      async capture() {
        captures += 1;
        return SNAPSHOT;
      },
      nextEventId() {
        throw new Error("recall must not allocate event IDs");
      },
      nextApprovalToken() {
        throw new Error("recall must not allocate approval tokens");
      },
    },
    {
      async withSnapshot(context, operation) {
        assert.deepEqual(context, {
          scopeKey: "u:alice/p:recall",
          evaluationNow: 1_700_100_000,
        });
        const source = Object.freeze({
          listValidClaimAggregates: async () => Object.freeze([]),
          async resolveSurfaceSeeds(terms) {
            reads += 1;
            observedTerms.push(terms);
            return Object.freeze({
              terms,
              seeds: Object.freeze([
                Object.freeze({
                  entityId: "e1.0",
                  matchedTerm: terms[0].text,
                  surfaceNorm: terms[0].surfaceNorm,
                }),
              ]),
              truncated: false,
            });
          },
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
        assert.equal("query" in source, false);
        assert.equal("sql" in source, false);
        assert.equal("connection" in source, false);
        return operation(source);
      },
    },
  );

  const result = await service.withSnapshot((source) =>
    resolveRecallQuerySurface(source, {
      query: "query fallback must be ignored",
      terms: [" 로-그_인 ", "로그인"],
    }),
  );

  assert.equal(captures, 1);
  assert.equal(reads, 1);
  assert.deepEqual(observedTerms, [
    [
      { text: "로-그_인", surfaceNorm: "로그인" },
      { text: "로그인", surfaceNorm: "로그인" },
    ],
  ]);
  assert.deepEqual(result, {
    terms: [
      { text: "로-그_인", surfaceNorm: "로그인" },
      { text: "로그인", surfaceNorm: "로그인" },
    ],
    seeds: [
      {
        entityId: "e1.0",
        matchedTerm: "로-그_인",
        surfaceNorm: "로그인",
      },
    ],
    truncated: false,
  });
});
