import assert from "node:assert/strict";
import { test } from "node:test";

import { RecallReadError } from "../../../dist/application/ports/recall-read-port.js";
import {
  RecallGraphTraversalError,
  traverseRecallGraph,
} from "../../../dist/application/recall-graph-traversal.js";
import { RECALL_TRAVERSAL_SQL_SOURCE } from "../../../dist/adapters/sqlite/index.js";
import {
  RCL_005_NOW,
  RCL_005_OTHER_SCOPE,
  RCL_005_SCOPE,
  assertDeepFrozen,
  claimCommands,
  createRcl005Fixture,
  createRecallService,
  entityCommand,
  openObserver,
  permanentDump,
} from "../../support/rcl-005-sqlite-fixture.mjs";

function smuggledReadError(code, marker) {
  const error = new RecallReadError(code);
  error.name = `Smuggled${marker}`;
  error.message = `smuggled-message-${marker}`;
  error.cause = { token: marker };
  error.prefix = marker;
  error.suffix = marker;
  error.secret = marker;
  return error;
}

function assertFreshTraversalStateError(error, injected, marker) {
  const expected = new RecallGraphTraversalError("INVALID_TRAVERSAL_STATE");
  assert.ok(error instanceof RecallGraphTraversalError);
  assert.notStrictEqual(error, injected);
  assert.equal(error.code, "INVALID_TRAVERSAL_STATE");
  assert.equal(error.name, expected.name);
  assert.equal(error.message, expected.message);
  assert.deepEqual(Reflect.ownKeys(error).sort(), Reflect.ownKeys(expected).sort());
  assert.equal("cause" in error, false);
  assert.equal("prefix" in error, false);
  assert.equal("suffix" in error, false);
  assert.equal("secret" in error, false);
  assert.doesNotMatch(error.message, new RegExp(marker, "u"));
  assert.equal(JSON.stringify(error), JSON.stringify(expected));
  return true;
}

function validTraversalEntityRow() {
  return {
    recall_traversal_entity_id: "e1.0",
    recall_traversal_entity_merged_into: null,
    recall_traversal_entity_name: "safe",
    recall_traversal_entity_scope_key: RCL_005_SCOPE,
  };
}

async function traverseInjectedState(factory, rawState) {
  const reader = await factory.openReader();
  Object.defineProperty(reader, "withRecallSnapshot", {
    configurable: true,
    value: async (_scopeKey, _evaluationNow, operation) =>
      operation(
        Object.freeze({
          assertActive() {},
          async listRawAggregateRows() {
            return Object.freeze([]);
          },
          async readRawTraversalState() {
            return rawState;
          },
        }),
      ),
  });
  const injectedFactory = Object.freeze({
    async openReader() {
      return reader;
    },
  });
  return createRecallService(injectedFactory).withSnapshot((source) =>
    traverseRecallGraph(source, {
      entry: "surface",
      depth: 1,
      seeds: [{ entityId: "e1.0", display: "safe" }],
    }));
}

test("S12 TEMP traversal moves both directions, collects literals, excludes scope and expiry, and never writes", async (t) => {
  const { databasePath, factory } = await createRcl005Fixture(t);
  await factory.enqueueWriteTransaction([
    entityCommand("e1.0", "리포"),
    entityCommand("e2.0", "인증 시스템"),
    entityCommand("e3.0", "서버 세션"),
    entityCommand("e4.0", "만료 노드"),
    entityCommand("e90.0", "다른 범위", RCL_005_OTHER_SCOPE),
    ...claimCommands({
      claimId: "c1.0",
      subjectId: "e1.0",
      objectId: "e2.0",
      relation: "contains",
      createdAt: RCL_005_NOW - 30,
    }),
    ...claimCommands({
      claimId: "c2.0",
      subjectId: "e2.0",
      objectId: "e3.0",
      relation: "uses",
      provenance: "user_stated",
      createdAt: RCL_005_NOW - 20,
    }),
    ...claimCommands({
      claimId: "c3.0",
      subjectId: "e2.0",
      objectValue: "pnpm test:auth",
      provenance: "user_stated",
      createdAt: RCL_005_NOW - 10,
    }),
    ...claimCommands({
      claimId: "c4.0",
      subjectId: "e3.0",
      objectId: "e4.0",
      createdAt: RCL_005_NOW - 100,
      expiresAt: RCL_005_NOW,
    }),
    ...claimCommands({
      claimId: "c90.0",
      scopeKey: RCL_005_OTHER_SCOPE,
      subjectId: "e90.0",
      objectValue: "other-scope-only",
      createdAt: RCL_005_NOW - 5,
    }),
  ]);

  assert.equal(Object.isFrozen(RECALL_TRAVERSAL_SQL_SOURCE), true);
  assert.match(RECALL_TRAVERSAL_SQL_SOURCE.createTempLinks, /temp\.recall_claim_agg/u);
  assert.match(RECALL_TRAVERSAL_SQL_SOURCE.createTempIncident, /temp\.recall_claim_agg/u);
  assert.match(RECALL_TRAVERSAL_SQL_SOURCE.selectLinks, /LIMIT 31/u);
  assert.match(RECALL_TRAVERSAL_SQL_SOURCE.selectIncidents, /LIMIT 31/u);

  const observer = openObserver(databasePath);
  t.after(() => observer.close());
  const beforeDump = permanentDump(observer);
  const beforeVersion = observer.pragma("data_version", { simple: true });
  let staleSource;
  const result = await createRecallService(factory).withSnapshot(async (source) => {
    staleSource = source;
    assert.deepEqual(Object.keys(source), [
      "listValidClaimAggregates",
      "resolveSurfaceSeeds",
      "searchFtsCandidates",
      "selectOverviewCandidates",
      "readTraversalNeighborhood",
      "selectRankedClaims",
    ]);
    const first = await traverseRecallGraph(source, {
      entry: "surface",
      depth: 2,
      seeds: [{ entityId: "e3.0", display: "세션 저장소" }],
    });
    const second = await traverseRecallGraph(source, {
      entry: "surface",
      depth: 2,
      seeds: [{ entityId: "e3.0", display: "세션 저장소" }],
    });
    assert.equal(JSON.stringify(second), JSON.stringify(first));
    return first;
  });

  const byClaim = new Map(result.reached.map((item) => [item.claimId, item]));
  assert.equal(byClaim.get("c2.0").path, "세션 저장소 → 서버 세션 → 인증 시스템");
  assert.equal(byClaim.get("c2.0").hops, 1);
  assert.equal(byClaim.get("c1.0").path, "세션 저장소 → 서버 세션 → 인증 시스템 → 리포");
  assert.equal(byClaim.get("c1.0").hops, 2);
  assert.equal(byClaim.get("c3.0").path, "세션 저장소 → 서버 세션 → 인증 시스템");
  assert.equal(byClaim.get("c3.0").hops, 1);
  assert.equal(byClaim.has("c4.0"), false);
  assert.equal(byClaim.has("c90.0"), false);
  assert.deepEqual(result.truncation, { links: false, incidents: false });
  assertDeepFrozen(assert, result);
  assert.equal(permanentDump(observer), beforeDump);
  assert.equal(observer.pragma("data_version", { simple: true }), beforeVersion);

  await assert.rejects(
    staleSource.readTraversalNeighborhood("e3.0"),
    (error) => {
      assert.equal(error.code, "RECALL_SNAPSHOT_FAILED");
      assert.equal("cause" in error, false);
      return true;
    },
  );
});

test("S12 traversal remains on one WAL snapshot and observes a concurrent commit only on the next call", async (t) => {
  const { factory } = await createRcl005Fixture(t);
  await factory.enqueueWriteTransaction([
    entityCommand("e1.0", "A"),
    entityCommand("e2.0", "B"),
    ...claimCommands({ claimId: "c1.0", subjectId: "e1.0", objectId: "e2.0" }),
  ]);
  const service = createRecallService(factory);
  const observations = await service.withSnapshot(async (source) => {
    const before = await traverseRecallGraph(source, {
      entry: "surface",
      depth: 2,
      seeds: [{ entityId: "e1.0", display: "A" }],
    });
    await factory.enqueueWriteTransaction([
      entityCommand("e3.0", "C"),
      ...claimCommands({ claimId: "c2.0", subjectId: "e2.0", objectId: "e3.0" }),
    ]);
    const after = await traverseRecallGraph(source, {
      entry: "surface",
      depth: 2,
      seeds: [{ entityId: "e1.0", display: "A" }],
    });
    return { before, after };
  });
  assert.equal(JSON.stringify(observations.after), JSON.stringify(observations.before));
  const next = await service.withSnapshot((source) =>
    traverseRecallGraph(source, {
      entry: "surface",
      depth: 2,
      seeds: [{ entityId: "e1.0", display: "A" }],
    }));
  assert.equal(next.reached.some(({ claimId }) => claimId === "c2.0"), true);
});

test("S12 cross-scope entity corruption fails closed, redacts payload, and cleans the snapshot", async (t) => {
  const { databasePath, factory } = await createRcl005Fixture(t);
  const secret = "secret-cross-scope-entity";
  await factory.enqueueWriteTransaction([
    entityCommand("e1.0", "safe"),
    entityCommand("e2.0", secret, RCL_005_OTHER_SCOPE),
    entityCommand("e3.0", "clean"),
    ...claimCommands({ claimId: "c1.0", subjectId: "e1.0", objectId: "e2.0" }),
  ]);
  const observer = openObserver(databasePath);
  t.after(() => observer.close());
  const beforeDump = permanentDump(observer);
  const beforeVersion = observer.pragma("data_version", { simple: true });
  const service = createRecallService(factory);

  await assert.rejects(
    service.withSnapshot((source) =>
      traverseRecallGraph(source, {
        entry: "surface",
        depth: 1,
        seeds: [{ entityId: "e1.0", display: "safe" }],
      })),
    (error) => {
      assert.ok(error instanceof RecallGraphTraversalError);
      assert.equal(error.code, "INVALID_TRAVERSAL_STATE");
      assert.equal(error.message.includes(secret), false);
      assert.equal(JSON.stringify(error).includes(secret), false);
      assert.equal("cause" in error, false);
      return true;
    },
  );

  const clean = await service.withSnapshot((source) =>
    traverseRecallGraph(source, {
      entry: "surface",
      depth: 1,
      seeds: [{ entityId: "e3.0", display: "clean" }],
    }));
  assert.deepEqual(clean.reached, []);
  assert.equal(permanentDump(observer), beforeDump);
  assert.equal(observer.pragma("data_version", { simple: true }), beforeVersion);
  assert.equal("insert" in RECALL_TRAVERSAL_SQL_SOURCE, false);
});

test("S12 traversal adapter snapshots raw envelope, row, array, and accessors into fresh errors", async (t) => {
  const { factory } = await createRcl005Fixture(t);
  let accessorRead = false;

  for (const boundary of ["envelope", "row", "array", "accessor"]) {
    const marker = `do-not-smuggle-rcl-005-adapter-${boundary}`;
    const injected = smuggledReadError(
      "INVALID_RECALL_TRAVERSAL_STATE",
      marker,
    );
    let rawState;
    if (boundary === "envelope") {
      rawState = new Proxy(
        {
          entityRow: validTraversalEntityRow(),
          linkRows: [],
          incidentRows: [],
        },
        {
          getPrototypeOf() {
            throw injected;
          },
        },
      );
    } else if (boundary === "row") {
      rawState = {
        entityRow: new Proxy(validTraversalEntityRow(), {
          ownKeys() {
            throw injected;
          },
        }),
        linkRows: [],
        incidentRows: [],
      };
    } else if (boundary === "array") {
      rawState = {
        entityRow: validTraversalEntityRow(),
        linkRows: new Proxy([], {
          getOwnPropertyDescriptor() {
            throw injected;
          },
        }),
        incidentRows: [],
      };
    } else {
      const entityRow = validTraversalEntityRow();
      Object.defineProperty(entityRow, "recall_traversal_entity_name", {
        enumerable: true,
        get() {
          accessorRead = true;
          throw injected;
        },
      });
      rawState = { entityRow, linkRows: [], incidentRows: [] };
    }

    await assert.rejects(
      traverseInjectedState(factory, rawState),
      (error) =>
        assertFreshTraversalStateError(
          error,
          injected,
          marker,
        ),
      boundary,
    );
  }
  assert.equal(accessorRead, false);
});
