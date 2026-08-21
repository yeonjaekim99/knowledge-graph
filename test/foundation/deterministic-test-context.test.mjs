import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createDeterministicTestContext,
  createDeterministicTestContextFromEnvironment,
} from "../support/deterministic-test-context.mjs";

test("deterministic context freezes seed, clock, timezone, locale, and reproduction data", () => {
  const context = createDeterministicTestContext({
    seed: "fixture-seed",
    nowSeconds: 1_700_000_123,
    timezone: "UTC",
    locale: "en-US",
  });

  assert.equal(context.seed, "fixture-seed");
  assert.equal(context.clock.nowSeconds(), 1_700_000_123);
  assert.equal(context.clock.nowSeconds(7), 1_700_000_130);
  assert.equal(context.clock.nowMilliseconds(7), 1_700_000_130_000);
  assert.equal(context.timezone, "UTC");
  assert.equal(context.locale, "en-US");
  assert.deepEqual(context.reproduction({ scenarioId: "S23", prefixLength: 17 }), {
    scenario_id: "S23",
    seed: "fixture-seed",
    prefix_length: 17,
    now_seconds: 1_700_000_123,
    timezone: "UTC",
    locale: "en-US",
  });
  assert.equal(Object.isFrozen(context), true);
  assert.equal(Object.isFrozen(context.clock), true);
});

test("deterministic entropy is stable by seed and label without shared mutable order", () => {
  const first = createDeterministicTestContext({ seed: "seed-a" });
  const second = createDeterministicTestContext({ seed: "seed-a" });
  const different = createDeterministicTestContext({ seed: "seed-b" });

  assert.deepEqual(first.entropy.bytes("event-1", 64), second.entropy.bytes("event-1", 64));
  assert.notDeepEqual(first.entropy.bytes("event-1", 32), first.entropy.bytes("event-2", 32));
  assert.notDeepEqual(first.entropy.bytes("event-1", 32), different.entropy.bytes("event-1", 32));
  assert.equal(first.entropy.hex("event-1", 4).length, 8);
  assert.deepEqual(first.entropy.bytes("empty", 0), new Uint8Array());
});

test("environment adapter requires every fixed deterministic input", () => {
  const context = createDeterministicTestContextFromEnvironment({
    RECALL_TEST_SEED: "environment-seed",
    RECALL_TEST_NOW_SECONDS: "42",
    TZ: "UTC",
    RECALL_TEST_LOCALE: "ko-KR",
  });

  assert.equal(context.seed, "environment-seed");
  assert.equal(context.clock.nowSeconds(), 42);
  assert.equal(context.locale, "ko-KR");

  assert.throws(
    () => createDeterministicTestContextFromEnvironment({ TZ: "UTC" }),
    /missing deterministic test environment/,
  );
});

test("invalid deterministic inputs fail before a test runner can use them", () => {
  for (const options of [
    { seed: "" },
    { seed: "x".repeat(129) },
    { nowSeconds: -1 },
    { nowSeconds: 1.5 },
    { timezone: "Asia/Seoul" },
    { locale: "not_a_locale" },
  ]) {
    assert.throws(() => createDeterministicTestContext(options));
  }

  const context = createDeterministicTestContext();
  assert.throws(() => context.clock.nowSeconds(-1), /offset/);
  assert.throws(() => context.entropy.bytes("", 1), /label/);
  assert.throws(() => context.entropy.bytes("ok", 4_097), /length/);
  assert.throws(
    () => context.reproduction({ scenarioId: "bad id", prefixLength: 0 }),
    /scenarioId/,
  );
});
