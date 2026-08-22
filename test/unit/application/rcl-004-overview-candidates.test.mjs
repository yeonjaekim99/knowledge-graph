import assert from "node:assert/strict";
import { test } from "node:test";

import {
  RECALL_OVERVIEW_NOTE_TEXT,
  selectRecallOverviewCandidates,
} from "../../../dist/application/recall-overview.js";
import { RecallReadError } from "../../../dist/application/ports/recall-read-port.js";

function readError(code) {
  return (error) => {
    assert.ok(error instanceof RecallReadError);
    assert.equal(error.code, code);
    assert.equal("cause" in error, false);
    return true;
  };
}

function payloadError(kind, code, marker) {
  const error =
    kind === "typed" ? new RecallReadError(code) : new Error(marker);
  error.name = marker;
  error.message = marker;
  error.cause = { marker };
  error.secret = marker;
  return error;
}

function freshReadError(injected, code, marker) {
  return (error) => {
    const expected = new RecallReadError(code);
    assert.ok(error instanceof RecallReadError);
    assert.notStrictEqual(error, injected);
    assert.equal(error.code, expected.code);
    assert.equal(error.name, expected.name);
    assert.equal(error.message, expected.message);
    assert.deepEqual(Reflect.ownKeys(error).sort(), Reflect.ownKeys(expected).sort());
    assert.equal("cause" in error, false);
    assert.equal(JSON.stringify(error).includes(marker), false);
    return true;
  };
}

test("overview delegates one validated result limit through the typed snapshot capability", async () => {
  const expected = Object.freeze({
    seeds: Object.freeze([]),
    rawCandidates: Object.freeze([]),
    truncation: Object.freeze({ reasons: Object.freeze([]) }),
    notes: Object.freeze([]),
  });
  const calls = [];
  const source = Object.freeze({
    async selectOverviewCandidates(limit) {
      calls.push(limit);
      return expected;
    },
  });

  for (const limit of [1, 10, 50]) {
    const result = await selectRecallOverviewCandidates(source, limit);
    assert.strictEqual(result, expected);
  }
  assert.deepEqual(calls, [1, 10, 50]);
  assert.match(RECALL_OVERVIEW_NOTE_TEXT.overview_seed_limit, /seed/u);
  assert.match(RECALL_OVERVIEW_NOTE_TEXT.overview_raw_limit, /raw/u);
});

test("overview rejects malformed internal limits before touching the source and never echoes values", async () => {
  let calls = 0;
  const source = Object.freeze({
    async selectOverviewCandidates() {
      calls += 1;
      throw new Error("must not run");
    },
  });

  for (const value of [0, 51, 1.5, Number.NaN, "10", null, undefined]) {
    await assert.rejects(
      selectRecallOverviewCandidates(source, value),
      readError("INVALID_RECALL_OVERVIEW_REQUEST"),
    );
  }
  assert.equal(calls, 0);
});

test("overview request validation replaces accessor and Proxy failures with a fresh fixed error", async () => {
  const marker = "do-not-echo-rcl-004-request";
  const injected = new RecallReadError("INVALID_RECALL_OVERVIEW_REQUEST");
  injected.name = marker;
  injected.message = marker;
  injected.cause = { marker };
  const source = new Proxy(
    {},
    {
      getOwnPropertyDescriptor() {
        throw injected;
      },
      get() {
        throw injected;
      },
    },
  );

  await assert.rejects(
    selectRecallOverviewCandidates(source, 10),
    (error) => {
      const expected = new RecallReadError("INVALID_RECALL_OVERVIEW_REQUEST");
      assert.ok(error instanceof RecallReadError);
      assert.notStrictEqual(error, injected);
      assert.equal(error.code, expected.code);
      assert.equal(error.name, expected.name);
      assert.equal(error.message, expected.message);
      assert.deepEqual(Reflect.ownKeys(error).sort(), Reflect.ownKeys(expected).sort());
      assert.equal(JSON.stringify(error).includes(marker), false);
      return true;
    },
  );
});

test("overview capability sync throws, rejections, and hostile thenables become fresh fixed errors", async () => {
  for (const mode of ["sync", "reject", "then-getter"]) {
    for (const kind of ["typed", "ordinary"]) {
      const marker = `do-not-echo-rcl-004-application-${mode}-${kind}`;
      const injected = payloadError(
        kind,
        "INVALID_RECALL_OVERVIEW_REQUEST",
        marker,
      );
      const source = Object.freeze({
        selectOverviewCandidates() {
          if (mode === "sync") {
            throw injected;
          }
          if (mode === "reject") {
            return Promise.reject(injected);
          }
          return Object.create(null, {
            then: {
              enumerable: true,
              get() {
                throw injected;
              },
            },
          });
        },
      });

      await assert.rejects(
        selectRecallOverviewCandidates(source, 10),
        freshReadError(
          injected,
          "INVALID_RECALL_OVERVIEW_REQUEST",
          marker,
        ),
      );
    }
  }
});
