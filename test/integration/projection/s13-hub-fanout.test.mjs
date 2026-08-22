import assert from "node:assert/strict";
import { test } from "node:test";

import { traverseRecallGraph } from "../../../dist/application/recall-graph-traversal.js";
import {
  RCL_005_NOW,
  claimCommands,
  createRcl005Fixture,
  createRecallService,
  entityCommand,
} from "../../support/rcl-005-sqlite-fixture.mjs";

test("S13 link and incident fanout use numeric claim suffix order, keep thirty, and expose both cuts", async (t) => {
  const { factory } = await createRcl005Fixture(t);
  const claimIds = Array.from({ length: 31 }, (_, parsedIndex) => `c2.${parsedIndex}`);
  await factory.enqueueWriteTransaction([
    entityCommand("e1.0", "허브"),
    ...claimIds.map((_, index) => entityCommand(`e${index + 2}.0`, `노드 ${index}`)),
    ...claimIds.flatMap((claimId, index) =>
      claimCommands({
        claimId,
        subjectId: "e1.0",
        objectId: `e${index + 2}.0`,
        relation: "relates_to",
        createdAt: RCL_005_NOW - 10,
        originSeq: 2,
      })),
  ]);

  const result = await createRecallService(factory).withSnapshot((source) =>
    traverseRecallGraph(source, {
      entry: "surface",
      depth: 1,
      seeds: [{ entityId: "e1.0", display: "허브" }],
    }));

  assert.deepEqual(
    result.reached.map(({ claimId }) => claimId),
    claimIds.slice(0, 30),
  );
  assert.equal(result.parents.length, 31);
  assert.equal(result.parents.some(({ entityId }) => entityId === "e32.0"), false);
  assert.deepEqual(result.truncation, { links: true, incidents: true });
  assert.equal("answers" in result, false);
  assert.equal("score" in result, false);
  assert.equal("moreAvailable" in result, false);
});
