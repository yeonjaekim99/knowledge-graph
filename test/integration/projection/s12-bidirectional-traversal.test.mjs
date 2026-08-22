import assert from "node:assert/strict";
import { test } from "node:test";

import { RecallReadError } from "../../../dist/application/ports/recall-read-port.js";
import { traverseRecallGraph } from "../../../dist/application/recall-graph-traversal.js";
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
      "readTraversalNeighborhood",
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
      assert.ok(error instanceof RecallReadError);
      assert.equal(error.code, "INVALID_RECALL_TRAVERSAL_STATE");
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
