import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildTestEnvironment,
  discoverTestFiles,
  loadTestPlan,
} from "../../scripts/run-test-layers.mjs";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function readJson(relativePath) {
  return JSON.parse(readFileSync(resolve(PROJECT_ROOT, relativePath), "utf8"));
}

function expandTaskReferences(value) {
  const references = new Set(value.match(/\b[A-Z]{3}-\d{3}\b/g) ?? []);
  for (const match of value.matchAll(/\b([A-Z]{3})-(\d{3})~(\d{3})\b/g)) {
    const [, prefix, first, last] = match;
    for (let number = Number(first); number <= Number(last); number += 1) {
      references.add(`${prefix}-${String(number).padStart(3, "0")}`);
    }
  }
  return [...references].sort();
}

function traceabilityOwners() {
  const text = readFileSync(
    resolve(PROJECT_ROOT, "docs/roadmap/traceability.md"),
    "utf8",
  );
  const owners = new Map();
  for (const line of text.split("\n")) {
    if (!/^\| S\d{2} \|/.test(line)) {
      continue;
    }
    const cells = line
      .slice(1, -1)
      .split("|")
      .map((cell) => cell.trim());
    owners.set(
      cells[0],
      expandTaskReferences(`${cells[2]} ${cells[3]}`),
    );
  }
  return owners;
}

test("local test plan fixes layers, fast/performance suites, and process context", () => {
  const plan = loadTestPlan({ projectRoot: PROJECT_ROOT });

  assert.equal(plan.schema_version, 1);
  assert.equal(plan.default_suite, "fast");
  assert.deepEqual(
    plan.layers.map(({ id }) => id),
    [
      "foundation",
      "unit",
      "integration-sqlite",
      "integration-projection",
      "contract-mcp",
      "e2e-process",
      "performance",
    ],
  );
  assert.equal(
    plan.layers.find(({ id }) => id === "performance").suites.includes("fast"),
    false,
  );
  assert.deepEqual(plan.environment, {
    TZ: "UTC",
    LANG: "C",
    LC_ALL: "C",
    RECALL_TEST_LOCALE: "en-US",
    RECALL_TEST_NOW_SECONDS: "1700000000",
    RECALL_TEST_SEED: "recall-fnd-005-v1",
  });

  const environment = buildTestEnvironment(
    { PATH: "/fixture/bin", TZ: "Asia/Seoul", RECALL_TEST_SEED: "ambient" },
    plan.environment,
  );
  assert.equal(environment.PATH, "/fixture/bin");
  assert.equal(environment.TZ, "UTC");
  assert.equal(environment.RECALL_TEST_SEED, "recall-fnd-005-v1");
  assert.equal(Object.isFrozen(plan), true);
  assert.equal(Object.isFrozen(plan.layers), true);
});

test("the local runner starts every test file in the fixed process environment", () => {
  assert.equal(process.env.TZ, "UTC");
  assert.equal(process.env.LANG, "C");
  assert.equal(process.env.LC_ALL, "C");
  assert.equal(process.env.RECALL_TEST_LOCALE, "en-US");
  assert.equal(process.env.RECALL_TEST_NOW_SECONDS, "1700000000");
  assert.equal(process.env.RECALL_TEST_SEED, "recall-fnd-005-v1");
  assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, "UTC");
});

test("test discovery is sorted, rooted, and keeps performance out of fast", () => {
  const plan = loadTestPlan({ projectRoot: PROJECT_ROOT });
  const fast = discoverTestFiles({
    projectRoot: PROJECT_ROOT,
    plan,
    selector: "fast",
  });
  const performance = discoverTestFiles({
    projectRoot: PROJECT_ROOT,
    plan,
    selector: "performance",
  });

  assert.deepEqual(fast, [...fast].sort());
  assert.ok(fast.includes("test/foundation/test-plan.test.mjs"));
  assert.equal(fast.some((path) => path.startsWith("test/performance/")), false);
  assert.deepEqual(performance, []);
  assert.throws(
    () =>
      discoverTestFiles({
        projectRoot: PROJECT_ROOT,
        plan,
        selector: "unknown-layer",
      }),
    /unknown test suite or layer/,
  );
});

test("S01-S24 migration manifest is complete and matches source ADR/task ownership", () => {
  const manifest = readJson("test/manifests/adr-production-scenarios.json");
  const sourcePath = resolve(PROJECT_ROOT, manifest.source.path);
  const sourceBytes = readFileSync(sourcePath);
  const source = JSON.parse(sourceBytes.toString("utf8"));
  const sourceById = new Map(source.scenarios.map((scenario) => [scenario.id, scenario]));
  const owners = traceabilityOwners();
  const plan = loadTestPlan({ projectRoot: PROJECT_ROOT });
  const layerRoots = new Map(plan.layers.map((layer) => [layer.id, layer.root]));

  assert.equal(manifest.schema_version, 1);
  assert.deepEqual(manifest.canonical_projection, {
    format: "recall-projection-v1",
    include_tables: [
      "statements",
      "entities",
      "surface_forms",
      "claims",
      "claim_support",
      "id_redirects",
    ],
    exclude_tables: ["projection_meta", "schema_migrations", "journal_fts"],
  });
  assert.equal(
    createHash("sha256").update(sourceBytes).digest("hex"),
    manifest.source.sha256,
  );
  assert.deepEqual(
    manifest.scenarios.map(({ id }) => id),
    Array.from({ length: 24 }, (_, index) => `S${String(index + 1).padStart(2, "0")}`),
  );
  assert.equal(new Set(manifest.scenarios.map(({ target }) => target)).size, 24);

  for (const scenario of manifest.scenarios) {
    const sourceScenario = sourceById.get(scenario.id);
    assert.ok(sourceScenario, `${scenario.id} must exist in the source matrix`);
    assert.equal(scenario.source_test, sourceScenario.test);
    assert.deepEqual(scenario.adrs, sourceScenario.adrs);
    assert.deepEqual([...scenario.owner_tasks].sort(), owners.get(scenario.id));
    assert.equal(new Set(scenario.owner_tasks).size, scenario.owner_tasks.length);
    assert.ok(layerRoots.has(scenario.layer));
    assert.ok(scenario.target.startsWith(`${layerRoots.get(scenario.layer)}/`));
    assert.match(scenario.target, new RegExp(`/${scenario.id.toLowerCase()}-[^/]+\\.test\\.mjs$`));
    assert.ok(["planned", "implemented"].includes(scenario.status));
    assert.equal(
      existsSync(resolve(PROJECT_ROOT, scenario.target)),
      scenario.status === "implemented",
      `${scenario.id} status must track its target file`,
    );
  }

  assert.deepEqual([...sourceById.keys()], manifest.scenarios.map(({ id }) => id));
  assert.deepEqual([...owners.keys()], manifest.scenarios.map(({ id }) => id));
  assert.deepEqual(
    manifest.non_scenario_gates.map(({ id }) => id),
    ["MCP-CONTRACT", "PERFORMANCE"],
  );
  assert.equal(source.non_executable_assessment["ADR-016"].classification, "implementation decision");
  assert.equal(manifest.non_scenario_gates[0].layer, "contract-mcp");
});
