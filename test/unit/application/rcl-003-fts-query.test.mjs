import assert from "node:assert/strict";
import { test } from "node:test";

import {
  RECALL_FTS_NOTE_TEXT,
  prepareRecallFtsQuery,
} from "../../../dist/application/recall-fts-query.js";
import { RecallReadError } from "../../../dist/application/ports/recall-read-port.js";

function readError(code) {
  return (error) => {
    assert.ok(error instanceof RecallReadError);
    assert.equal(error.code, code);
    assert.equal("cause" in error, false);
    return true;
  };
}

test("user strings become at most ten ordered quoted phrase literals", () => {
  const plan = prepareRecallFtsQuery([
    "  alpha OR beta  ",
    "NEAR(foo)",
    "a\"b",
    "제어\u0000문자\u001f검색",
    "인증서버",
    "😀😃😄",
    "ＦＯＯ",
    "foo",
    "literal*glob",
    "column:value",
  ]);

  assert.equal(plan.kind, "query");
  assert.deepEqual(
    plan.terms.map(({ display, phraseLiteral }) => ({
      display,
      phraseLiteral,
    })),
    [
      {
        display: "alpha OR beta",
        phraseLiteral: "\"alpha OR beta\"",
      },
      {
        display: "NEAR(foo)",
        phraseLiteral: "\"NEAR(foo)\"",
      },
      {
        display: "a\"b",
        phraseLiteral: "\"a\"\"b\"",
      },
      {
        display: "제어문자검색",
        phraseLiteral: "\"제어문자검색\"",
      },
      {
        display: "인증서버",
        phraseLiteral: "\"인증서버\"",
      },
      {
        display: "😀😃😄",
        phraseLiteral: "\"😀😃😄\"",
      },
      {
        display: "ＦＯＯ",
        phraseLiteral: "\"ＦＯＯ\"",
      },
      {
        display: "foo",
        phraseLiteral: "\"foo\"",
      },
      {
        display: "literal*glob",
        phraseLiteral: "\"literal*glob\"",
      },
      {
        display: "column:value",
        phraseLiteral: "\"column:value\"",
      },
    ],
  );
  assert.equal("normalized" in plan.terms[0], false);
  assert.equal(
    plan.matchExpression,
    plan.terms.map((term) => term.phraseLiteral).join(" OR "),
  );
  assert.equal(Object.isFrozen(plan), true);
  assert.equal(Object.isFrozen(plan.terms), true);
  assert.equal(Object.isFrozen(plan.terms[0]), true);

  const ten = prepareRecallFtsQuery(
    Array.from({ length: 10 }, (_, index) => `term-${index}-검색`),
  );
  assert.equal(ten.kind, "query");
  assert.equal(ten.terms.length, 10);
  assert.equal(ten.matchExpression.split(" OR ").length, 10);

  const fullQuery = prepareRecallFtsQuery(["😀".repeat(4_096)]);
  assert.equal(fullQuery.kind, "query");
  assert.equal(Array.from(fullQuery.terms[0].display).length, 4_096);
});

test("only sanitized bound phrases with at least three Unicode code points reach trigram FTS", () => {
  const skipped = prepareRecallFtsQuery([
    "가",
    "ab",
    "㍿",
    "\u0000-_\u001f",
  ]);

  assert.deepEqual(skipped, {
    kind: "skip",
    terms: [],
    matchExpression: null,
    notes: [
      {
        code: "fts_terms_too_short",
        text: RECALL_FTS_NOTE_TEXT.fts_terms_too_short,
      },
    ],
  });
  assert.match(skipped.notes[0].text, /세 글자/u);
  assert.match(skipped.notes[0].text, /terms/u);

  const emoji = prepareRecallFtsQuery(["😀😃", "😀😃😄"]);
  assert.equal(emoji.kind, "query");
  assert.deepEqual(emoji.terms.map((term) => term.display), ["😀😃😄"]);

  const compatibilityBoundaries = prepareRecallFtsQuery(["a\u0301b", "㍿"]);
  assert.equal(compatibilityBoundaries.kind, "query");
  assert.deepEqual(
    compatibilityBoundaries.terms.map((term) => term.display),
    ["a\u0301b"],
  );
});

test("the internal capability rejects malformed or over-cap candidate collections without echoing them", () => {
  const privateMarker = "do-not-echo-rcl-003";
  const sparse = new Array(1);
  let accessorRead = false;
  const accessor = [];
  Object.defineProperty(accessor, "0", {
    enumerable: true,
    get() {
      accessorRead = true;
      return privateMarker;
    },
  });
  accessor.length = 1;
  for (const value of [
    privateMarker,
    [privateMarker, 3],
    sparse,
    accessor,
    Array.from({ length: 11 }, (_, index) => `${privateMarker}-${index}`),
    [`${privateMarker}${"x".repeat(4_097)}`],
  ]) {
    assert.throws(
      () => prepareRecallFtsQuery(value),
      (error) => {
        assert.ok(readError("INVALID_RECALL_FTS_REQUEST")(error));
        assert.doesNotMatch(error.message, new RegExp(privateMarker, "u"));
        assert.equal(JSON.stringify(error).includes(privateMarker), false);
        return true;
      },
    );
  }
  assert.equal(accessorRead, false);

  const trapMarker = "do-not-echo-rcl-003-proxy-trap";
  const trappedArray = new Proxy([], {
    get(target, property, receiver) {
      if (property === "length") {
        throw new Error(trapMarker);
      }
      return Reflect.get(target, property, receiver);
    },
    getOwnPropertyDescriptor() {
      throw new Error(trapMarker);
    },
  });
  assert.throws(
    () => prepareRecallFtsQuery(trappedArray),
    (error) => {
      assert.ok(readError("INVALID_RECALL_FTS_REQUEST")(error));
      assert.doesNotMatch(error.message, new RegExp(trapMarker, "u"));
      assert.equal(JSON.stringify(error).includes(trapMarker), false);
      return true;
    },
  );
});
