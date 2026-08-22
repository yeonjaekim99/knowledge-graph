import assert from "node:assert/strict";
import { test } from "node:test";

import {
  RecallQuerySurfaceError,
  extractRecallQueryTerms,
  normalizeV1,
  resolveRecallSurfaceSeeds,
} from "../../../dist/domain/index.js";

const SCOPE = "u:alice/p:recall";
const OTHER_SCOPE = "u:bob/p:recall";

function querySurfaceFailure(code, forbiddenValue) {
  return (error) => {
    assert.ok(error instanceof RecallQuerySurfaceError);
    assert.equal(error.code, code);
    assert.equal("cause" in error, false);
    assert.equal("value" in error, false);
    if (forbiddenValue !== undefined) {
      assert.equal(error.message.includes(forbiddenValue), false);
      assert.equal(JSON.stringify(error).includes(forbiddenValue), false);
    }
    return true;
  };
}

function term(text, surfaceNorm = normalizeV1(text)) {
  return { text, surfaceNorm };
}

function entity(id, mergedInto = null, scopeKey = SCOPE) {
  return { id, scopeKey, mergedInto };
}

function candidate(termOrder, surfaceNorm, entityId, scopeKey = SCOPE) {
  return { termOrder, scopeKey, surfaceNorm, entityId };
}

function redirect(oldId, newId, reason = "merge", kind = "entity") {
  return { oldId, newId, kind, reason };
}

function surfaceState({
  terms,
  candidates,
  entities,
  idRedirects = [],
  scopeKey = SCOPE,
}) {
  return { scopeKey, terms, candidates, entities, idRedirects };
}

function assertDeepFrozen(value) {
  if (value === null || typeof value !== "object") {
    return;
  }
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) {
    assertDeepFrozen(child);
  }
}

test("explicit terms preserve display order, reuse normalize_v1, and filter only short candidates", () => {
  const result = extractRecallQueryTerms({
    query: "this query must not be derived",
    terms: [
      " Ａ-Ｂ ",
      "ab",
      "😀",
      "😀😀",
      "가",
      "가 나",
      "가-나",
      "１２",
      " -_ ",
      "Node.js",
    ],
  });

  assert.deepEqual(result, [
    { text: "Ａ-Ｂ", surfaceNorm: "ab" },
    { text: "ab", surfaceNorm: "ab" },
    { text: "😀😀", surfaceNorm: "😀😀" },
    { text: "가 나", surfaceNorm: "가나" },
    { text: "가-나", surfaceNorm: "가나" },
    { text: "１２", surfaceNorm: "12" },
    { text: "Node.js", surfaceNorm: "node.js" },
  ]);
  assert.equal(result.some((item) => item.text.includes("query")), false);
  assert.deepEqual(
    extractRecallQueryTerms({ query: "query is still ignored", terms: [] }),
    [],
  );
  assertDeepFrozen(result);
});

test("distinct explicit display terms survive a shared surface normalization", () => {
  const result = extractRecallQueryTerms({
    query: "ignored",
    terms: ["auth-server", "auth_server"],
  });

  assert.deepEqual(result, [
    { text: "auth-server", surfaceNorm: "authserver" },
    { text: "auth_server", surfaceNorm: "authserver" },
  ]);
  assertDeepFrozen(result);
});

test("query-derived terms sort by normalized Unicode code-point length then source order and stop at ten", () => {
  const query = "가나다,𐐀𐐁𐐂 aa bb cc dd ee ff gg hh ii jj x";
  const result = extractRecallQueryTerms({ query });

  assert.deepEqual(
    result.map(({ text }) => text),
    [query, "가나다", "𐐀𐐁𐐂", "aa", "bb", "cc", "dd", "ee", "ff", "gg"],
  );
  assert.equal(Array.from(result[1].surfaceNorm).length, 3);
  assert.equal(Array.from(result[2].surfaceNorm).length, 3);
  assert.equal(result[2].surfaceNorm.length, 6);
  assert.equal(result.length, 10);
  assert.deepEqual(
    extractRecallQueryTerms({ query: "ＡＢ" }),
    [{ text: "ＡＢ", surfaceNorm: "ab" }],
  );
  assert.deepEqual(
    extractRecallQueryTerms({ query: "a-b" }),
    [{ text: "a-b", surfaceNorm: "ab" }],
  );
});

test("query candidate ordering and cap precede surface normalization dedupe", () => {
  assert.deepEqual(extractRecallQueryTerms({ query: "ＡＢＣ ABC" }), [
    { text: "ＡＢＣ ABC", surfaceNorm: "abcabc" },
    { text: "ＡＢＣ", surfaceNorm: "abc" },
    { text: "ABC", surfaceNorm: "abc" },
  ]);

  const query = `${Array(10).fill("aaaa").join(" ")} zz`;
  const result = extractRecallQueryTerms({ query });
  assert.equal(result.length, 10);
  assert.equal(result[0].text, query);
  assert.deepEqual(
    result.slice(1).map(({ text }) => text),
    Array(9).fill("aaaa"),
  );
  assert.equal(result.some(({ text }) => text === "zz"), false);
});

test("invalid extractor input fails without retaining submitted query or term payload", () => {
  const secret = "secret-query-payload";
  assert.throws(
    () => extractRecallQueryTerms({ query: secret, terms: Array(11).fill("ok") }),
    querySurfaceFailure("INVALID_QUERY_TERM_INPUT", secret),
  );
  assert.throws(
    () => extractRecallQueryTerms({ query: secret, terms: [42] }),
    querySurfaceFailure("INVALID_QUERY_TERM_INPUT", secret),
  );
  assert.throws(
    () => extractRecallQueryTerms({ query: " ".repeat(8) }),
    querySurfaceFailure("INVALID_QUERY_TERM_INPUT"),
  );
  const malformed = `safe-${"\ud800"}-payload`;
  assert.throws(
    () => extractRecallQueryTerms({ query: malformed }),
    querySurfaceFailure("INVALID_QUERY_TERM_INPUT", malformed),
  );
  assert.throws(
    () => extractRecallQueryTerms({ query: "safe", terms: [malformed] }),
    querySurfaceFailure("INVALID_QUERY_TERM_INPUT", malformed),
  );
});

test("surface pair dedupe keeps the first distinct display term", () => {
  const terms = [term("auth-server"), term("auth_server")];
  const result = resolveRecallSurfaceSeeds(
    surfaceState({
      terms,
      candidates: [
        candidate(0, "authserver", "e1.0"),
        candidate(1, "authserver", "e1.0"),
      ],
      entities: [entity("e1.0")],
    }),
  );

  assert.deepEqual(result, {
    terms,
    seeds: [
      {
        entityId: "e1.0",
        matchedTerm: "auth-server",
        surfaceNorm: "authserver",
      },
    ],
    truncated: false,
  });
});

test("surface rows are canonicalized through merge and ID redirect chains before stable polysemy dedupe", () => {
  const terms = [term("로그인"), term("DB")];
  const result = resolveRecallSurfaceSeeds(
    surfaceState({
      terms,
      candidates: [
        candidate(1, "db", "e11.0"),
        candidate(0, "로그인", "e2.0"),
        candidate(0, "로그인", "e10.0"),
        candidate(1, "db", "e3.0"),
        candidate(0, "로그인", "e1.0"),
      ],
      entities: [
        entity("e1.0", "e2.0"),
        entity("e2.0", "e3.0"),
        entity("e3.0"),
        entity("e10.0"),
        entity("e11.0", "e10.0"),
      ],
      idRedirects: [
        redirect("e1.0", "e2.0"),
        redirect("e2.0", "e3.0"),
        redirect("e11.0", "e10.0", "rule_change"),
      ],
    }),
  );

  assert.deepEqual(result, {
    terms,
    seeds: [
      {
        entityId: "e10.0",
        matchedTerm: "로그인",
        surfaceNorm: "로그인",
      },
      {
        entityId: "e3.0",
        matchedTerm: "로그인",
        surfaceNorm: "로그인",
      },
    ],
    truncated: false,
  });
  assertDeepFrozen(result);
  assert.equal(
    JSON.stringify(resolveRecallSurfaceSeeds(surfaceState({
      terms,
      candidates: [
        candidate(1, "db", "e11.0"),
        candidate(0, "로그인", "e2.0"),
        candidate(0, "로그인", "e10.0"),
        candidate(1, "db", "e3.0"),
        candidate(0, "로그인", "e1.0"),
      ],
      entities: [
        entity("e1.0", "e2.0"),
        entity("e2.0", "e3.0"),
        entity("e3.0"),
        entity("e10.0"),
        entity("e11.0", "e10.0"),
      ],
      idRedirects: [
        redirect("e1.0", "e2.0"),
        redirect("e2.0", "e3.0"),
        redirect("e11.0", "e10.0", "rule_change"),
      ],
    }))),
    JSON.stringify(result),
  );
});

test("the canonical seed stream reads one extra unique entity and returns only the first fifty", () => {
  const ids = Array.from({ length: 51 }, (_, index) => `e${index + 1}.0`);
  const sorted = ids.toSorted();
  const result = resolveRecallSurfaceSeeds(
    surfaceState({
      terms: [term("공통")],
      candidates: ids
        .toReversed()
        .map((entityId) => candidate(0, "공통", entityId)),
      entities: ids.map((id) => entity(id)),
    }),
  );

  assert.equal(result.truncated, true);
  assert.deepEqual(result.seeds.map(({ entityId }) => entityId), sorted.slice(0, 50));
  assert.equal(result.seeds.length, 50);
});

test("redirect cycle, excessive depth, kind/scope corruption, and merge disagreement fail closed", () => {
  const secret = "secret-surface-cycle";
  const secretTerm = term(secret);
  const cycle = surfaceState({
    terms: [secretTerm],
    candidates: [candidate(0, secretTerm.surfaceNorm, "e1.0")],
    entities: [entity("e1.0", "e2.0"), entity("e2.0", "e1.0")],
    idRedirects: [redirect("e1.0", "e2.0"), redirect("e2.0", "e1.0")],
  });
  assert.throws(
    () => resolveRecallSurfaceSeeds(cycle),
    querySurfaceFailure("INVALID_SURFACE_SEED_STATE", secret),
  );

  assert.throws(
    () =>
      resolveRecallSurfaceSeeds(
        surfaceState({
          terms: [secretTerm],
          candidates: [candidate(0, secretTerm.surfaceNorm, "e1.0")],
          entities: [entity("e1.0", "e2.0"), entity("e2.0"), entity("e3.0")],
          idRedirects: [redirect("e1.0", "e3.0")],
        }),
      ),
    querySurfaceFailure("INVALID_SURFACE_SEED_STATE", secret),
  );

  assert.throws(
    () =>
      resolveRecallSurfaceSeeds(
        surfaceState({
          terms: [secretTerm],
          candidates: [candidate(0, secretTerm.surfaceNorm, "e1.0")],
          entities: [entity("e1.0", "e2.0"), entity("e2.0", null, OTHER_SCOPE)],
          idRedirects: [redirect("e1.0", "e2.0")],
        }),
      ),
    querySurfaceFailure("INVALID_SURFACE_SEED_STATE", secret),
  );

  assert.throws(
    () =>
      resolveRecallSurfaceSeeds(
        surfaceState({
          terms: [secretTerm],
          candidates: [candidate(0, secretTerm.surfaceNorm, "e1.0")],
          entities: [entity("e1.0")],
          idRedirects: [redirect("e1.0", "c2.0", "deduplicated", "claim")],
        }),
      ),
    querySurfaceFailure("INVALID_SURFACE_SEED_STATE", secret),
  );

  const deepEntities = Array.from({ length: 34 }, (_, index) =>
    entity(
      `e${index + 1}.0`,
      index === 33 ? null : `e${index + 2}.0`,
    ));
  const deepRedirects = Array.from({ length: 33 }, (_, index) =>
    redirect(`e${index + 1}.0`, `e${index + 2}.0`));
  assert.throws(
    () =>
      resolveRecallSurfaceSeeds(
        surfaceState({
          terms: [secretTerm],
          candidates: [candidate(0, secretTerm.surfaceNorm, "e1.0")],
          entities: deepEntities,
          idRedirects: deepRedirects,
        }),
      ),
    querySurfaceFailure("INVALID_SURFACE_SEED_STATE", secret),
  );
});
