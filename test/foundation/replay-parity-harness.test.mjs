import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CanonicalProjectionError,
  canonicalProjectionDump,
} from "../support/canonical-projection.mjs";
import { createDeterministicTestContext } from "../support/deterministic-test-context.mjs";
import {
  ReplayParityError,
  runReplayParity,
} from "../support/replay-parity-harness.mjs";

function counterProjection(total, rows = [{ id: "counter", total }]) {
  return {
    counters: {
      primaryKey: ["id"],
      rows,
    },
  };
}

function additiveRunners({ divergeAtPrefix } = {}) {
  return {
    createIncrementalRunner() {
      let total = 0;
      return {
        apply(event) {
          total += event.amount;
        },
        snapshot() {
          return counterProjection(total);
        },
      };
    },
    fullReplayRunner({ events }) {
      let total = events.reduce((sum, event) => sum + event.amount, 0);
      if (events.length === divergeAtPrefix) {
        total += 1;
      }
      return counterProjection(total);
    },
  };
}

test("canonical projection dump ignores object, table, and row input ordering", () => {
  const first = canonicalProjectionDump({
    claims: {
      primaryKey: ["id"],
      rows: [
        { id: "c2.0", value: "둘", active: true },
        { active: false, value: "하나", id: "c1.0" },
      ],
    },
    entities: {
      primaryKey: ["id"],
      rows: [{ name: "인증", id: "e1.0" }],
    },
  });
  const reordered = canonicalProjectionDump({
    entities: {
      rows: [{ id: "e1.0", name: "인증" }],
      primaryKey: ["id"],
    },
    claims: {
      rows: [
        { value: "하나", id: "c1.0", active: false },
        { value: "둘", active: true, id: "c2.0" },
      ],
      primaryKey: ["id"],
    },
  });

  assert.deepEqual(reordered, first);
  assert.equal(first.format, "recall-projection-v1");
  assert.equal(first.table_count, 2);
  assert.equal(first.row_count, 3);
  assert.equal(
    first.checksum,
    "af656e5669164e454219828130171863c6ed635dfe5241e84cc0aea313c01dc3",
  );
  assert.ok(first.canonical.includes("s6:인증"));
  assert.doesNotThrow(() => JSON.stringify(first));
  assert.equal(Object.isFrozen(first), true);
});

test("canonical projection rejects non-JSON state and ambiguous primary keys", () => {
  const cases = [
    {
      code: "NON_JSON_VALUE",
      value: { t: { primaryKey: ["id"], rows: [{ id: "1", value: undefined }] } },
    },
    {
      code: "NON_JSON_VALUE",
      value: { t: { primaryKey: ["id"], rows: [{ id: "1", value: 1n }] } },
    },
    {
      code: "NON_JSON_VALUE",
      value: { t: { primaryKey: ["id"], rows: [{ id: "1", value: Number.NaN }] } },
    },
    {
      code: "UNSAFE_NUMBER",
      value: {
        t: {
          primaryKey: ["id"],
          rows: [{ id: "1", value: Number.MAX_SAFE_INTEGER + 1 }],
        },
      },
    },
    {
      code: "NON_JSON_VALUE",
      value: { t: { primaryKey: ["id"], rows: [{ id: "1", value: new Date(0) }] } },
    },
    {
      code: "MISSING_PRIMARY_KEY",
      value: { t: { primaryKey: ["id"], rows: [{ value: "missing" }] } },
    },
    {
      code: "DUPLICATE_PRIMARY_KEY",
      value: { t: { primaryKey: ["id"], rows: [{ id: "1" }, { id: "1" }] } },
    },
  ];

  for (const fixture of cases) {
    assert.throws(
      () => canonicalProjectionDump(fixture.value),
      (error) =>
        error instanceof CanonicalProjectionError && error.code === fixture.code,
    );
  }

  const cyclic = { id: "1" };
  cyclic.self = cyclic;
  assert.throws(
    () => canonicalProjectionDump({ t: { primaryKey: ["id"], rows: [cyclic] } }),
    (error) => error instanceof CanonicalProjectionError && error.code === "NON_JSON_VALUE",
  );

  const sparse = [];
  sparse.length = 1;
  assert.throws(
    () => canonicalProjectionDump({ t: { primaryKey: ["id"], rows: [{ id: "1", sparse }] } }),
    (error) => error instanceof CanonicalProjectionError && error.code === "NON_JSON_VALUE",
  );

  const accessor = { id: "1" };
  Object.defineProperty(accessor, "value", {
    enumerable: true,
    get() {
      throw new Error("must not invoke accessors");
    },
  });
  assert.throws(
    () => canonicalProjectionDump({ t: { primaryKey: ["id"], rows: [accessor] } }),
    (error) => error instanceof CanonicalProjectionError && error.code === "NON_JSON_VALUE",
  );
});

test("parity harness compares empty and every incremental journal prefix", async () => {
  const events = Object.freeze([
    Object.freeze({ amount: 2 }),
    Object.freeze({ amount: 3 }),
    Object.freeze({ amount: -1 }),
  ]);
  const context = createDeterministicTestContext({ seed: "parity-seed" });
  const result = await runReplayParity({
    scenarioId: "S02",
    events,
    context,
    ...additiveRunners(),
  });

  assert.deepEqual(result.prefixes.map(({ prefix_length }) => prefix_length), [0, 1, 2, 3]);
  assert.equal(result.prefixes.every(({ matches }) => matches), true);
  assert.equal(result.final_checksum, result.prefixes.at(-1).incremental_checksum);
  assert.deepEqual(events, [{ amount: 2 }, { amount: 3 }, { amount: -1 }]);
  assert.equal(Object.isFrozen(result), true);
});

test("parity mismatch is fail-fast, reproducible, JSON-safe, and payload-redacted", async () => {
  const secret = "TOP_SECRET_EVENT_PAYLOAD";
  let disposed = 0;
  const runners = additiveRunners({ divergeAtPrefix: 2 });
  const createIncrementalRunner = (...args) => {
    const runner = runners.createIncrementalRunner(...args);
    return {
      ...runner,
      dispose() {
        disposed += 1;
      },
    };
  };

  await assert.rejects(
    runReplayParity({
      scenarioId: "S23",
      events: [{ amount: 1, raw_text: secret }, { amount: 2 }],
      context: createDeterministicTestContext({
        seed: "failure-seed",
        nowSeconds: 99,
      }),
      createIncrementalRunner,
      fullReplayRunner: runners.fullReplayRunner,
    }),
    (error) => {
      assert.ok(error instanceof ReplayParityError);
      assert.equal(error.code, "REPLAY_PARITY_MISMATCH");
      assert.equal(error.scenarioId, "S23");
      assert.equal(error.prefixLength, 2);
      assert.deepEqual(error.reproduction, {
        scenario_id: "S23",
        seed: "failure-seed",
        prefix_length: 2,
        now_seconds: 99,
        timezone: "UTC",
        locale: "en-US",
      });
      assert.doesNotMatch(error.message, new RegExp(secret));
      assert.doesNotMatch(JSON.stringify(error), new RegExp(secret));
      assert.match(error.incrementalChecksum, /^[0-9a-f]{64}$/);
      assert.match(error.fullReplayChecksum, /^[0-9a-f]{64}$/);
      return true;
    },
  );
  assert.equal(disposed, 1);
});

test("parity harness freezes cloned events before either runner receives them", async () => {
  await assert.rejects(
    runReplayParity({
      scenarioId: "S03",
      events: [{ amount: 1 }],
      context: createDeterministicTestContext(),
      createIncrementalRunner() {
        return {
          apply(event) {
            event.amount = 99;
          },
          snapshot() {
            return counterProjection(0);
          },
        };
      },
      fullReplayRunner() {
        return counterProjection(0);
      },
    }),
    TypeError,
  );
});
