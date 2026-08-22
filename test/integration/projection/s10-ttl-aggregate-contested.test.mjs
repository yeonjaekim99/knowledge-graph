import assert from "node:assert/strict";
import { test } from "node:test";

import { rankRecallClaims } from "../../../dist/application/recall-ranking.js";
import { RECALL_RANKING_SQL_SOURCE } from "../../../dist/adapters/sqlite/index.js";
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
