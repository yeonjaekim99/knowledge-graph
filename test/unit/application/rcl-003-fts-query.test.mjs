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

test("user strings become at most ten deduplicated quoted phrase literals", () => {
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
    plan.terms.map(({ display, normalized, phraseLiteral }) => ({
      display,
      normalized,
      phraseLiteral,
    })),
    [
      {
        display: "alpha OR beta",
        normalized: "alphaorbeta",
        phraseLiteral: "\"alpha OR beta\"",
      },
      {
        display: "NEAR(foo)",
        normalized: "near(foo)",
        phraseLiteral: "\"NEAR(foo)\"",
      },
      {
        display: "a\"b",
        normalized: "a\"b",
        phraseLiteral: "\"a\"\"b\"",
      },
      {
        display: "제어문자검색",
        normalized: "제어문자검색",
        phraseLiteral: "\"제어문자검색\"",
      },
      {
        display: "인증서버",
        normalized: "인증서버",
        phraseLiteral: "\"인증서버\"",
      },
      {
        display: "😀😃😄",
        normalized: "😀😃😄",
        phraseLiteral: "\"😀😃😄\"",
      },
      {
        display: "ＦＯＯ",
        normalized: "foo",
        phraseLiteral: "\"ＦＯＯ\"",
      },
      {
        display: "literal*glob",
        normalized: "literal*glob",
        phraseLiteral: "\"literal*glob\"",
      },
      {
        display: "column:value",
        normalized: "column:value",
        phraseLiteral: "\"column:value\"",
      },
    ],
  );
  assert.equal(
    plan.matchExpression,
    plan.terms.map((term) => term.phraseLiteral).join(" OR "),
  );
  assert.equal(Object.isFrozen(plan), true);
  assert.equal(Object.isFrozen(plan.terms), true);
  assert.equal(Object.isFrozen(plan.terms[0]), true);
});

test("only normalized candidates with at least three Unicode code points reach trigram FTS", () => {
  const skipped = prepareRecallFtsQuery([
    "가",
    "ab",
    "Ａ_Ｂ",
    "\u0000- _\u001f",
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
});

test("the internal capability rejects malformed or over-cap candidate collections without echoing them", () => {
  const privateMarker = "do-not-echo-rcl-003";
  for (const value of [
    privateMarker,
    [privateMarker, 3],
    Array.from({ length: 11 }, (_, index) => `${privateMarker}-${index}`),
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
});
