import assert from "node:assert/strict";
import { test } from "node:test";

import { canonicalProjectionDump } from "../../support/canonical-projection.mjs";
import { createDeterministicTestContext } from "../../support/deterministic-test-context.mjs";
import {
  BASE_TIME,
  PRIMARY_SCOPE,
  SECONDARY_SCOPE,
  aliasIntent,
  claimRetractionIntent,
  createAdversarialOperations,
  entityDraft,
  eventId,
  eventRetractionIntent,
  literalDraft,
  mergeIntent,
  operation,
  statementIntent,
} from "../../support/prj-010-projection-scenarios.mjs";
import {
  executeProductionOperations,
  runProductionScenarioParity,
} from "../../support/prj-010-sqlite-parity.mjs";

function statement(rawText, parsed, options = {}) {
  return statementIntent({ rawText, parsed, ...options });
}

function one(event, options = {}) {
  return operation([event], options);
}

function checksum(tables) {
  return canonicalProjectionDump(tables).checksum;
}

function shiftedTimes(tables, delta) {
  const copy = structuredClone(tables);
  for (const row of copy.statements.rows) {
    row.created_at -= delta;
    if (row.expires_at !== null) {
      row.expires_at -= delta;
    }
  }
  for (const row of copy.claims.rows) {
    row.first_seen_at -= delta;
    row.last_seen_at -= delta;
  }
  for (const row of copy.claim_support.rows) {
    if (row.expires_at !== null) {
      row.expires_at -= delta;
    }
  }
  return copy;
}

function semanticProjection(tables, scopeKey) {
  const entities = new Map(
    tables.entities.rows
      .filter((row) => row.scope_key === scopeKey)
      .map((row) => [row.id, row]),
  );
  const statements = new Map(
    tables.statements.rows
      .filter((row) => row.scope_key === scopeKey)
      .map((row) => [row.event_id, row]),
  );
  const supportByClaim = new Map();
  for (const row of tables.claim_support.rows) {
    const statementRow = statements.get(row.event_id);
    if (statementRow === undefined) {
      continue;
    }
    const values = supportByClaim.get(row.claim_id) ?? [];
    values.push({
      live: row.live,
      expires_at: row.expires_at,
      statement_state: statementRow.state,
      provenance: statementRow.provenance,
    });
    supportByClaim.set(row.claim_id, values);
  }

  const claims = tables.claims.rows
    .filter((row) => row.scope_key === scopeKey)
    .map((row) => ({
      subject: entities.get(row.subject_id)?.normal_name,
      relation: row.relation,
      object:
        row.object_id === null
          ? { value: row.object_value }
          : { entity: entities.get(row.object_id)?.normal_name },
      state: row.state,
      support: (supportByClaim.get(row.id) ?? []).sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right), "en-US"),
      ),
    }))
    .sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right), "en-US"),
    );

  const surfaces = tables.surface_forms.rows
    .filter((row) => row.scope_key === scopeKey)
    .map((row) => ({
      surface: row.surface_norm,
      entity: entities.get(row.entity_id)?.normal_name,
      origin: row.origin,
    }))
    .sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right), "en-US"),
    );

  return { claims, surfaces };
}

test("eight deterministic adversarial traces preserve all 288 operation prefixes", async () => {
  const context = createDeterministicTestContext({
    seed: "recall-prj-010-s23-v1",
  });
  const seeds = Array.from({ length: 8 }, (_, index) => index + 1);
  const results = await Promise.all(
    seeds.map(async (seed) => {
      const scenario = {
        id: `S23-${String(seed).padStart(2, "0")}`,
        operations: createAdversarialOperations(seed),
      };
      const result = await runProductionScenarioParity(scenario, context);
      assert.equal(result.prefixes.length, 37);
      assert.equal(result.prefixes.every(({ matches }) => matches), true);
      return scenario.operations.length;
    }),
  );
  assert.equal(results.reduce((sum, count) => sum + count, 0), 288);
});

test("correct batch decomposition keeps the exact journal and projection", async () => {
  const root = one(
    statement("runtime v1", [literalDraft("Runtime", "describes", "v1")]),
    { at: BASE_TIME },
  );
  const retraction = claimRetractionIntent("c1.0");
  const replacement = statement("runtime v2", [
    literalDraft("Runtime", "describes", "v2"),
  ]);
  const compound = [
    root,
    operation([retraction, replacement], {
      at: BASE_TIME + 60,
      label: "compound-correct",
    }),
  ];
  const primitives = [
    root,
    one(retraction, { at: BASE_TIME + 60, label: "primitive-retraction" }),
    one(replacement, { at: BASE_TIME + 60, label: "primitive-replacement" }),
  ];

  const [batched, split] = await Promise.all([
    executeProductionOperations(compound, "CORRECT-COMPOUND"),
    executeProductionOperations(primitives, "CORRECT-PRIMITIVES"),
  ]);
  assert.deepEqual(batched.journal, split.journal);
  assert.equal(checksum(batched.tables), checksum(split.tables));
});

test("scope interleaving preserves each scope's semantic projection", async () => {
  const emit = (scope, label, localIndex) => {
    const parsed =
      localIndex === 0
        ? [entityDraft(`${label} Service`, "uses", `${label} DB`)]
        : [literalDraft(`${label} Command`, "describes", `${label}-v${localIndex}`)];
    return one(statement(`${label} local ${localIndex}`, parsed, {
      provenance: "observed",
    }), {
      scope,
      at: BASE_TIME + localIndex * 60,
    });
  };
  const primary = Array.from({ length: 3 }, (_, index) =>
    emit(PRIMARY_SCOPE, "A", index),
  );
  const secondary = Array.from({ length: 3 }, (_, index) =>
    emit(SECONDARY_SCOPE, "B", index),
  );
  const sequential = [...primary, ...secondary];
  const interleaved = primary.flatMap((entry, index) => [entry, secondary[index]]);

  const [left, right] = await Promise.all([
    executeProductionOperations(sequential, "SCOPE-SEQUENTIAL"),
    executeProductionOperations(interleaved, "SCOPE-INTERLEAVED"),
  ]);
  assert.deepEqual(
    semanticProjection(left.tables, PRIMARY_SCOPE.scopeKey),
    semanticProjection(right.tables, PRIMARY_SCOPE.scopeKey),
  );
  assert.deepEqual(
    semanticProjection(left.tables, SECONDARY_SCOPE.scopeKey),
    semanticProjection(right.tables, SECONDARY_SCOPE.scopeKey),
  );
});

test("time shift changes only structural timestamps and expiry by the same delta", async () => {
  const delta = 9_000_000;
  const early = [
    one(statement("temporary feature", [
      entityDraft("Temporary Feature", "uses", "Scratch Store"),
    ], { ttl: "session" }), { at: BASE_TIME }),
  ];
  const shifted = [
    one(statement("temporary feature", [
      entityDraft("Temporary Feature", "uses", "Scratch Store"),
    ], { ttl: "session" }), { at: BASE_TIME + delta }),
  ];
  const [left, right] = await Promise.all([
    executeProductionOperations(early, "TTL-EARLY"),
    executeProductionOperations(shifted, "TTL-SHIFTED"),
  ]);
  assert.equal(checksum(left.tables), checksum(shiftedTimes(right.tables, delta)));
});

test("merge and alias event retractions restore the exact baseline projection", async () => {
  const baseline = [
    one(statement("서비스 A uses db", [
      entityDraft("서비스 A", "uses", "Database"),
    ]), { at: BASE_TIME }),
    one(statement("service-a uses queue", [
      entityDraft("service-a", "uses", "Queue"),
    ]), { at: BASE_TIME + 60 }),
  ];
  const undo = [
    ...baseline,
    one(mergeIntent("e1.0", "e2.0"), { at: BASE_TIME + 120 }),
    one(eventRetractionIntent(eventId(3)), { at: BASE_TIME + 180 }),
    one(aliasIntent("로그인", "e1.0"), { at: BASE_TIME + 240 }),
    one(eventRetractionIntent(eventId(5)), { at: BASE_TIME + 300 }),
  ];
  const [before, after] = await Promise.all([
    executeProductionOperations(baseline, "UNDO-BASELINE"),
    executeProductionOperations(undo, "UNDO-DECISIONS"),
  ]);
  assert.equal(checksum(before.tables), checksum(after.tables));
});
