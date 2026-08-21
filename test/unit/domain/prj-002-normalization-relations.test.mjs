import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CANONICAL_RELATIONS,
  NORMALIZATION_VERSION,
  ProjectionRuleError,
  RELATION_REGISTRY,
  getRelationDefinition,
  normalizeLiteralIdentity,
  normalizeRelationLabel,
  normalizeV1,
} from "../../../dist/domain/index.js";

function ruleFailure(code, forbiddenValue) {
  return (error) => {
    assert.ok(error instanceof ProjectionRuleError);
    assert.equal(error.code, code);
    assert.equal("value" in error, false);
    if (forbiddenValue !== undefined) {
      assert.equal(error.message.includes(forbiddenValue), false);
    }
    return true;
  };
}

test("normalize_v1 fixes trim, NFKC, lowercase, and separator removal order", () => {
  assert.equal(NORMALIZATION_VERSION, "v1");
  assert.equal(normalizeV1(" 인증_서버-API "), "인증서버api");
  assert.equal(normalizeV1("ＰｏｓｔｇｒｅＳＱＬ"), "postgresql");
  assert.equal(normalizeV1("\tＡ\u00a0-\u2003_B\n"), "ab");
  assert.equal(normalizeV1("ᴬ"), "a");
});

test("normalize_v1 is locale-independent and does not remove Korean particles or identity punctuation", () => {
  assert.equal(normalizeV1("I"), "i");
  assert.equal("I".toLocaleLowerCase("tr"), "ı");
  assert.equal(normalizeV1("서버가"), "서버가");
  assert.equal(normalizeV1("서버를"), "서버를");
  assert.notEqual(normalizeV1("서버가"), normalizeV1("서버를"));
  assert.equal(normalizeV1("Node.js/24"), "node.js/24");
  assert.notEqual(normalizeV1("인증서버"), normalizeV1("auth-server"));
});

test("normalize_v1 rejects non-text and empty normalized values without echoing input", () => {
  assert.throws(
    () => normalizeV1(null),
    ruleFailure("INVALID_NORMALIZATION_INPUT"),
  );
  assert.throws(
    () => normalizeV1(" \t-__\u2003 "),
    ruleFailure("EMPTY_NORMALIZED_VALUE", "-__"),
  );
});

test("literal identity applies trim plus NFKC while preserving case, internal whitespace, and punctuation", () => {
  assert.equal(
    normalizeLiteralIdentity("  Ｎｏｄｅ  ２４!  "),
    "Node  24!",
  );
  assert.equal(normalizeLiteralIdentity("  A\t  B?  "), "A\t  B?");
  assert.notEqual(
    normalizeLiteralIdentity("PostgreSQL"),
    normalizeLiteralIdentity("postgresql"),
  );
  assert.throws(
    () => normalizeLiteralIdentity(undefined),
    ruleFailure("INVALID_LITERAL_INPUT"),
  );
  assert.throws(
    () => normalizeLiteralIdentity(" \u2003 "),
    ruleFailure("EMPTY_LITERAL_VALUE"),
  );
});

test("the immutable relation registry fixes all five meanings, cardinalities, and default predicates", () => {
  assert.deepEqual(CANONICAL_RELATIONS, [
    "uses",
    "rejects",
    "contains",
    "describes",
    "relates_to",
  ]);
  assert.equal(Object.isFrozen(CANONICAL_RELATIONS), true);
  assert.equal(Object.isFrozen(RELATION_REGISTRY), true);

  const expected = {
    uses: ["의존, 사용, 요구", "multiple", "사용"],
    rejects: ["배제, 거부, 탈락한 선택지", "multiple", "거부"],
    contains: ["포함, 위치, 소속", "multiple", "포함"],
    describes: ["속성 슬롯의 값 또는 상태", "single", "="],
    relates_to: ["다른 네 관계로 안전하게 분류할 수 없는 연결", "multiple", "관련"],
  };
  for (const relation of CANONICAL_RELATIONS) {
    const definition = getRelationDefinition(relation);
    assert.equal(definition, RELATION_REGISTRY[relation]);
    assert.equal(Object.isFrozen(definition), true);
    assert.deepEqual(
      [definition.meaning, definition.cardinality, definition.defaultPredicate],
      expected[relation],
    );
  }
  assert.throws(
    () => getRelationDefinition("configures"),
    ruleFailure("INVALID_RELATION", "configures"),
  );
});

test("relation labels are trimmed, code-point bounded, and required for relates_to", () => {
  assert.equal(normalizeRelationLabel("uses", undefined), null);
  assert.equal(
    normalizeRelationLabel("uses", "  세션을 쓴다  "),
    "세션을 쓴다",
  );
  assert.equal(
    normalizeRelationLabel("relates_to", "\u2003연결됨\u2003"),
    "연결됨",
  );
  assert.equal(
    normalizeRelationLabel("relates_to", "😀".repeat(256)),
    "😀".repeat(256),
  );
  assert.throws(
    () => normalizeRelationLabel("relates_to", undefined),
    ruleFailure("RELATION_LABEL_REQUIRED"),
  );
  assert.throws(
    () => normalizeRelationLabel("relates_to", " \u2003 "),
    ruleFailure("RELATION_LABEL_REQUIRED"),
  );
  assert.throws(
    () => normalizeRelationLabel("uses", "   "),
    ruleFailure("INVALID_RELATION_LABEL"),
  );
  assert.throws(
    () => normalizeRelationLabel("uses", null),
    ruleFailure("INVALID_RELATION_LABEL"),
  );
  assert.throws(
    () => normalizeRelationLabel("relates_to", "😀".repeat(257)),
    ruleFailure("INVALID_RELATION_LABEL"),
  );
});
