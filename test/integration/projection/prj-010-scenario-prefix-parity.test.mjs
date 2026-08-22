import assert from "node:assert/strict";
import { test } from "node:test";

import { createDeterministicTestContext } from "../../support/deterministic-test-context.mjs";
import { createProjectionScenarioCatalog } from "../../support/prj-010-projection-scenarios.mjs";
import { runProductionScenarioParity } from "../../support/prj-010-sqlite-parity.mjs";

test("S01-S24 journal-reducible histories match full replay at every production prefix", async (t) => {
  const scenarios = createProjectionScenarioCatalog();
  const context = createDeterministicTestContext({
    seed: "recall-prj-010-s01-s24-v1",
  });
  let operationPrefixes = 0;

  for (const scenario of scenarios) {
    await t.test(`${scenario.id} ${scenario.projectionBoundary}`, async () => {
      const parity = await runProductionScenarioParity(scenario, context);
      assert.equal(parity.scenario_id, scenario.id);
      assert.equal(parity.prefixes.length, scenario.operations.length + 1);
      assert.equal(parity.prefixes.every(({ matches }) => matches), true);
      operationPrefixes += scenario.operations.length;
    });
  }

  assert.equal(scenarios.length, 24);
  assert.ok(operationPrefixes >= 90, "the catalog must exercise at least 90 operation prefixes");
});
