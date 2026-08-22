import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SECRET_DETECTOR_VERSION,
  SECRET_ENTROPY_ALLOWLIST_REGISTRY,
  SECRET_ENTROPY_POLICY,
  SECRET_SIGNATURE_REGISTRY,
  STORABLE_SECRET_FIELD_CONTEXTS,
  SecretDetectorError,
  createSecretDetector,
  detectSecretEntropy,
  detectSecretPatterns,
  detectSecrets,
} from "../../../dist/domain/index.js";

const SYNTHETIC_GITHUB_TOKEN = `ghp_${"SyntheticOnly1234567890".repeat(2)}`;
const SYNTHETIC_RANDOM_TOKEN = "Aa0_Bb1-Cc2+Dd3/Ee4=";
const BALANCED_HEX = "0123456789abcdef".repeat(4);

function detectorFailure(code, forbiddenValue) {
  return (error) => {
    assert.ok(error instanceof SecretDetectorError);
    assert.equal(error.code, code);
    assert.equal("value" in error, false);
    assert.equal("cause" in error, false);
    assert.equal("finding" in error, false);
    if (forbiddenValue !== undefined) {
      assert.equal(error.message.includes(forbiddenValue), false);
      assert.equal(JSON.stringify(error).includes(forbiddenValue), false);
    }
    return true;
  };
}

function onlyFinding(result, expectedClass) {
  assert.equal(result.registryVersion, SECRET_DETECTOR_VERSION);
  assert.equal(result.findings.length, 1);
  const finding = result.findings[0];
  assert.equal(finding.secretClass, expectedClass);
  assert.deepEqual(Object.keys(finding).sort(), [
    "endCodeUnit",
    "secretClass",
    "startCodeUnit",
  ]);
  return finding;
}

test("the v1 pattern, entropy, and contextual allowlist registries are reviewable and immutable", () => {
  assert.equal(SECRET_DETECTOR_VERSION, "secret-detector-v1");
  assert.equal(Object.isFrozen(SECRET_SIGNATURE_REGISTRY), true);
  assert.equal(Object.isFrozen(SECRET_ENTROPY_POLICY), true);
  assert.equal(Object.isFrozen(SECRET_ENTROPY_ALLOWLIST_REGISTRY), true);
  assert.equal(SECRET_ENTROPY_POLICY.minimumCodePoints, 20);
  assert.equal(SECRET_ENTROPY_POLICY.minimumBitsPerCodePoint, 4);
  assert.equal(SECRET_ENTROPY_POLICY.minimumCharacterClasses, 2);

  const signatureIds = new Set(
    SECRET_SIGNATURE_REGISTRY.map((definition) => definition.id),
  );
  for (const id of [
    "aws-access-key",
    "aws-secret-access-key",
    "github-legacy-token",
    "github-fine-grained-token",
    "gitlab-token",
    "google-api-key",
    "slack-token",
    "stripe-secret-key",
    "jwt",
    "pem-private-key",
    "credential-url",
    "secret-assignment",
  ]) {
    assert.equal(signatureIds.has(id), true, id);
  }
  for (const definition of SECRET_SIGNATURE_REGISTRY) {
    assert.equal(Object.isFrozen(definition), true);
    assert.equal(definition.patternSource.includes("\\b"), false, definition.id);
  }

  const allowlistIds = new Set(
    SECRET_ENTROPY_ALLOWLIST_REGISTRY.map((definition) => definition.id),
  );
  for (const id of [
    "typed-uuid",
    "typed-event-ulid",
    "adjacent-commit-sha",
    "adjacent-checksum-hash",
    "typed-build-identifier",
    "trusted-local-git-object",
  ]) {
    assert.equal(allowlistIds.has(id), true, id);
  }
  for (const definition of SECRET_ENTROPY_ALLOWLIST_REGISTRY) {
    assert.equal(Object.isFrozen(definition), true);
    assert.equal(Object.isFrozen(definition.contexts), true);
  }
});

test("explicit synthetic provider, JWT, private-key, URL, and assignment shapes retain their class", () => {
  const fixtures = [
    [`AKIA${"A1".repeat(8)}`, "aws-access-key"],
    [`aws_secret_access_key=${"Ab0/".repeat(10)}`, "aws-secret-access-key"],
    [SYNTHETIC_GITHUB_TOKEN, "github-token"],
    [`github_pat_${"Synthetic_0123456789".repeat(2)}`, "github-token"],
    [`glpat-${"Synthetic_0123456789".repeat(2)}`, "gitlab-token"],
    [`AIza${"A".repeat(35)}`, "google-api-key"],
    [`xoxb-${"1".repeat(12)}-${"A".repeat(24)}`, "slack-token"],
    [`xapp-${"1-A".repeat(12)}`, "slack-token"],
    [`sk_test_${"A1".repeat(12)}`, "stripe-secret-key"],
    ["eyJAAAAAA.BBBBBBBB.CCCCCCCC", "jwt"],
    ["eyJAAAAAA.BBBBBBBB.", "jwt"],
    ["-----BEGIN PRIVATE KEY-----", "private-key"],
    ["-----BEGIN ENCRYPTED PRIVATE KEY-----", "private-key"],
    ["postgresql://fixture-user:synthetic-password@localhost/recall", "credential-url"],
    ["redis://:synthetic-only-value@localhost", "credential-url"],
    ["postgresql://:synthetic-only-value@localhost/recall", "credential-url"],
    ["password=synthetic-only-value", "secret-assignment"],
    ["pwd=x", "secret-assignment"],
  ];

  for (const [value, secretClass] of fixtures) {
    const finding = onlyFinding(detectSecretPatterns(value), secretClass);
    assert.deepEqual(
      [finding.startCodeUnit, finding.endCodeUnit],
      [0, value.length],
      secretClass,
    );
  }
});

test("generic secret assignments include quoted JSON and object keys", () => {
  for (const [input, expectedClass, expectedValue] of [
    ['{"password":"synthetic-only-value"}', "secret-assignment", "synthetic-only-value"],
    ["{'secret': 'synthetic-only-value'}", "secret-assignment", "synthetic-only-value"],
    ['{"api_key":"synthetic-only-value"}', "secret-assignment", "synthetic-only-value"],
    ["DB_PASSWORD=synthetic-only-value", "secret-assignment", "synthetic-only-value"],
    ["CLIENT_SECRET=synthetic-only-value", "secret-assignment", "synthetic-only-value"],
    ["JWT_SECRET: synthetic-only-value", "secret-assignment", "synthetic-only-value"],
    ['SESSION_SECRET="synthetic-only-value"', "secret-assignment", "synthetic-only-value"],
    ['{"client_secret":"synthetic-only-value"}', "secret-assignment", "synthetic-only-value"],
    [
      '{"password":"synthetic\\\"only\\\"value"}',
      "secret-assignment",
      'synthetic\\\"only\\\"value',
    ],
    ["dbPassword=synthetic-only-value", "secret-assignment", "synthetic-only-value"],
    ["OPENAI_API_KEY=synthetic-only-value", "secret-assignment", "synthetic-only-value"],
    ["SECRET_KEY=synthetic-only-value", "secret-assignment", "synthetic-only-value"],
    ["API_SECRET_KEY=synthetic-only-value", "secret-assignment", "synthetic-only-value"],
    ["JWT_SECRET_KEY=synthetic-only-value", "secret-assignment", "synthetic-only-value"],
    ['{"secret_key":"synthetic-only-value"}', "secret-assignment", "synthetic-only-value"],
    ["MY_AWS_SECRET_ACCESS_KEY=synthetic-only-value", "secret-assignment", "synthetic-only-value"],
    [
      `{"aws_secret_access_key":"${"A".repeat(40)}"}`,
      "aws-secret-access-key",
      "A".repeat(40),
    ],
  ]) {
    const finding = onlyFinding(
      detectSecretPatterns(input),
      expectedClass,
    );
    assert.equal(
      input.slice(finding.startCodeUnit, finding.endCodeUnit).includes(
        expectedValue,
      ),
      true,
      input,
    );
  }
});

test("PEM findings cover complete and truncated credential bodies", () => {
  for (const pem of [
    [
      "-----BEGIN PRIVATE KEY-----",
      "AAAAAAAAAAAAAAAA",
      "AAAAAAAAAAAAAAAA",
      "-----END PRIVATE KEY-----",
    ].join("\n"),
    [
      "-----BEGIN PRIVATE KEY-----",
      "BBBBBBBBBBBBBBBB",
      "BBBBBBBBBBBBBBBB",
    ].join("\n"),
  ]) {
    const finding = onlyFinding(detectSecretPatterns(pem), "private-key");
    assert.deepEqual(
      [finding.startCodeUnit, finding.endCodeUnit],
      [0, pem.length],
    );
  }
});

test("ASCII lookarounds classify provider tokens next to Korean particles and punctuation", () => {
  const koreanPrefix = "토큰😀";
  const koreanInput = `${koreanPrefix}${SYNTHETIC_GITHUB_TOKEN}은 폐기한다`;
  const koreanFinding = onlyFinding(
    detectSecretPatterns(koreanInput),
    "github-token",
  );
  assert.equal(koreanFinding.startCodeUnit, koreanPrefix.length);
  assert.equal(
    koreanFinding.endCodeUnit,
    koreanPrefix.length + SYNTHETIC_GITHUB_TOKEN.length,
  );
  assert.equal(Array.from(koreanPrefix).length, koreanPrefix.length - 1);

  const punctuationInput = `(${SYNTHETIC_GITHUB_TOKEN}),`;
  const punctuationFinding = onlyFinding(
    detectSecretPatterns(punctuationInput),
    "github-token",
  );
  assert.deepEqual(
    [punctuationFinding.startCodeUnit, punctuationFinding.endCodeUnit],
    [1, 1 + SYNTHETIC_GITHUB_TOKEN.length],
  );

  assert.equal(
    detectSecretPatterns(`x${SYNTHETIC_GITHUB_TOKEN}y`).findings.length,
    0,
  );
});

test("entropy uses Unicode code points and fixes length, entropy, and character-class boundaries", () => {
  const exactTwenty = SYNTHETIC_RANDOM_TOKEN;
  const nineteen = exactTwenty.slice(0, -1);
  const exactFourBits = "Aa0_Bb1-Cc2+Dd3/".repeat(2);
  const belowFourBits = `${"A".repeat(19)}0`;
  const oneClass = "ABCDEFGHIJKLMNOPQRST";
  assert.equal(Array.from(exactTwenty).length, 20);
  assert.equal(Array.from(nineteen).length, 19);

  onlyFinding(detectSecretEntropy(exactTwenty, "raw_text"), "high-entropy");
  onlyFinding(detectSecretEntropy(exactFourBits, "raw_text"), "high-entropy");
  assert.equal(detectSecretEntropy(nineteen, "raw_text").findings.length, 0);
  assert.equal(
    detectSecretEntropy(belowFourBits, "raw_text").findings.length,
    0,
  );
  assert.equal(detectSecretEntropy(oneClass, "raw_text").findings.length, 0);

  const surrogateToken = `😀${"Aa0_Bb1-Cc2+Dd3/Ee4"}`;
  assert.equal(Array.from(surrogateToken).length, 20);
  const surrogateFinding = onlyFinding(
    detectSecretEntropy(surrogateToken, "raw_text"),
    "high-entropy",
  );
  assert.equal(surrogateFinding.endCodeUnit, surrogateToken.length);
  assert.equal(surrogateToken.length, 21);
});

test("entropy candidates retain internal punctuation without joining prose across spaces", () => {
  const punctuationVariants = [
    "Aa0_Bb1-Cc:2+Dd3/Ee4=",
    "Aa0_Bb1-Cc,2+Dd3/Ee4=",
    "Aa0_Bb1-Cc;2+Dd3/Ee4=",
    "Aa0_Bb1-Cc(2)+Dd3/Ee4=",
    "Aa0_Bb1-Cc[2]+Dd3/Ee4=",
    "Aa0_Bb1-Cc{2}+Dd3/Ee4=",
    "Aa0_Bb1-Cc<2>+Dd3/Ee4=",
  ];

  for (const token of punctuationVariants) {
    assert.equal(Array.from(token).length >= 20, true, token);
    const input = `discard (${token}), now`;
    const finding = onlyFinding(
      detectSecretEntropy(input, "raw_text"),
      "high-entropy",
    );
    assert.deepEqual(
      [finding.startCodeUnit, finding.endCodeUnit],
      ["discard (".length, "discard (".length + token.length],
      token,
    );
  }

  assert.equal(
    detectSecretEntropy(
      "This ordinary sentence, with punctuation; remains separate prose.",
      "raw_text",
    ).findings.length,
    0,
  );
});

test("edge punctuation cannot shrink a qualifying secret below the entropy boundary", () => {
  for (const token of [
    ":Aa0_Bb1-Cc2+Dd3/Ee;",
    "(Aa0_Bb1-Cc2+Dd3/Ee)",
  ]) {
    assert.equal(Array.from(token).length, 20, token);
    const finding = onlyFinding(
      detectSecretEntropy(token, "raw_text"),
      "high-entropy",
    );
    assert.deepEqual(
      [finding.startCodeUnit, finding.endCodeUnit],
      [0, token.length],
      token,
    );
  }
});

test("entropy allowlists are shape- and context-bound while explicit patterns always win", () => {
  onlyFinding(detectSecretEntropy(BALANCED_HEX, "raw_text"), "high-entropy");
  assert.equal(
    detectSecretEntropy(`commit ${BALANCED_HEX}`, "raw_text").findings.length,
    0,
  );
  assert.equal(
    detectSecretEntropy(`sha: ${BALANCED_HEX}`, "raw_text").findings.length,
    0,
  );
  assert.equal(
    detectSecretEntropy(`sha=${BALANCED_HEX}`, "raw_text").findings.length,
    0,
  );
  assert.equal(
    detectSecretEntropy(`checksum: ${BALANCED_HEX}`, "raw_text").findings
      .length,
    0,
  );
  assert.equal(
    detectSecretEntropy(`build id: ${BALANCED_HEX}`, "raw_text").findings
      .length,
    0,
  );
  assert.equal(
    detectSecretEntropy(`build-id=${BALANCED_HEX}`, "raw_text").findings
      .length,
    0,
  );
  for (const wrapped of [
    `commit (${BALANCED_HEX})`,
    `commit [${BALANCED_HEX}]`,
    `sha: \`${BALANCED_HEX}\``,
    `checksum <${BALANCED_HEX}>`,
    `commit .${BALANCED_HEX}.`,
  ]) {
    assert.equal(
      detectSecretEntropy(wrapped, "raw_text").findings.length,
      0,
      wrapped,
    );
  }
  for (const attackerControlledMarker of [
    `commit${BALANCED_HEX}`,
    `hash${BALANCED_HEX}`,
    `sha256${BALANCED_HEX}`,
    `buildid${BALANCED_HEX}`,
    `uncommit ${BALANCED_HEX}`,
    `secretcommit ${BALANCED_HEX}`,
    `notsha: ${BALANCED_HEX}`,
    `mychecksum=${BALANCED_HEX}`,
    `rehash ${BALANCED_HEX}`,
    `rebuild-id=${BALANCED_HEX}`,
    `비밀commit ${BALANCED_HEX}`,
    `écommit ${BALANCED_HEX}`,
    `秘密sha: ${BALANCED_HEX}`,
  ]) {
    onlyFinding(
      detectSecretEntropy(attackerControlledMarker, "raw_text"),
      "high-entropy",
    );
  }

  for (const context of [
    "reference.commit_sha",
    "reference.hash",
    "reference.checksum",
    "trusted.local_git_object",
  ]) {
    assert.equal(detectSecretEntropy(BALANCED_HEX, context).findings.length, 0);
  }
  const arbitrarySymbolicHexBranch = BALANCED_HEX;
  onlyFinding(
    detectSecretEntropy(arbitrarySymbolicHexBranch, "metadata.branch"),
    "high-entropy",
  );
  for (const [context, attackerControlledMetadata] of [
    ["metadata.branch", `commit.${BALANCED_HEX}`],
    ["metadata.branch", `hash=${BALANCED_HEX}`],
    ["metadata.actor", `sha:${BALANCED_HEX}`],
  ]) {
    onlyFinding(
      detectSecretEntropy(attackerControlledMetadata, context),
      "high-entropy",
    );
  }

  const uuid = "01234567-89ab-4cde-8f01-23456789abcd";
  onlyFinding(detectSecretEntropy(uuid, "raw_text"), "high-entropy");
  assert.equal(
    detectSecretEntropy(uuid, "target.entity_id").findings.length,
    0,
  );
  assert.equal(
    detectSecretEntropy(`(${uuid}),`, "target.entity_id").findings.length,
    0,
  );

  const eventId = "ev_01ARZ3NDEKTSV4RRFFQ69G5FAV";
  onlyFinding(detectSecretEntropy(eventId, "raw_text"), "high-entropy");
  assert.equal(
    detectSecretEntropy(eventId, "target.event_id").findings.length,
    0,
  );

  const buildId = "bld_01ARZ3NDEKTSV4RRFFQ69G5FAV";
  onlyFinding(detectSecretEntropy(buildId, "raw_text"), "high-entropy");
  assert.equal(
    detectSecretEntropy(buildId, "reference.build_id").findings.length,
    0,
  );

  const explicitInAllowlistedContext = onlyFinding(
    detectSecrets(SYNTHETIC_GITHUB_TOKEN, "reference.build_id"),
    "github-token",
  );
  assert.equal(explicitInAllowlistedContext.startCodeUnit, 0);
});

test("one detector surface covers every string category REC-002 owns", () => {
  assert.deepEqual(STORABLE_SECRET_FIELD_CONTEXTS, [
    "raw_text",
    "claim.subject",
    "claim.subject_kind",
    "claim.object",
    "claim.object_kind",
    "claim.object_value",
    "claim.relation_label",
    "claim.subject_alias",
    "claim.object_alias",
    "revise.note",
    "revise.alias_surface",
    "metadata.actor",
    "metadata.branch",
  ]);
  assert.equal(Object.isFrozen(STORABLE_SECRET_FIELD_CONTEXTS), true);

  for (const context of STORABLE_SECRET_FIELD_CONTEXTS) {
    onlyFinding(detectSecrets(SYNTHETIC_GITHUB_TOKEN, context), "github-token");
  }
});

test("combined results are deterministic, deeply frozen, non-overlapping, and payload-free", () => {
  const value = `😀 ${SYNTHETIC_GITHUB_TOKEN} ${SYNTHETIC_RANDOM_TOKEN}`;
  const first = detectSecrets(value, "raw_text");
  const second = detectSecrets(value, "raw_text");
  assert.deepEqual(first, second);
  assert.notEqual(first, second);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.findings), true);
  assert.equal(first.findings.every((finding) => Object.isFrozen(finding)), true);
  assert.deepEqual(
    first.findings.map((finding) => finding.secretClass),
    ["github-token", "high-entropy"],
  );
  assert.equal(first.findings[0].endCodeUnit <= first.findings[1].startCodeUnit, true);

  const serialized = JSON.stringify(first);
  assert.equal(serialized.includes(SYNTHETIC_GITHUB_TOKEN), false);
  assert.equal(serialized.includes(SYNTHETIC_GITHUB_TOKEN.slice(0, 12)), false);
  assert.equal(serialized.includes(SYNTHETIC_RANDOM_TOKEN), false);
  assert.deepEqual(Object.keys(first).sort(), ["findings", "registryVersion"]);
});

test("a provider signature keeps its class while an overlapping assignment widens the unsafe range", () => {
  const value = `password=${SYNTHETIC_GITHUB_TOKEN}`;
  const finding = onlyFinding(detectSecrets(value, "raw_text"), "github-token");
  assert.deepEqual(
    [finding.startCodeUnit, finding.endCodeUnit],
    [0, value.length],
  );

  const entropyOverlap = `${SYNTHETIC_GITHUB_TOKEN}.${SYNTHETIC_RANDOM_TOKEN}`;
  const widened = onlyFinding(
    detectSecrets(entropyOverlap, "raw_text"),
    "github-token",
  );
  assert.deepEqual(
    [widened.startCodeUnit, widened.endCodeUnit],
    [0, entropyOverlap.length],
  );
});

test("invalid boundaries and internal detector failures are typed, fail closed, and redacted", () => {
  assert.throws(
    () => detectSecrets(null, "raw_text"),
    detectorFailure("INVALID_INPUT"),
  );
  assert.throws(
    () => detectSecrets(SYNTHETIC_GITHUB_TOKEN, "unknown.field"),
    detectorFailure("INVALID_CONTEXT", SYNTHETIC_GITHUB_TOKEN),
  );
  assert.throws(
    () => createSecretDetector({ calculateEntropy: "not-a-function" }),
    detectorFailure("INVALID_CONFIGURATION"),
  );

  const throwingDetector = createSecretDetector({
    calculateEntropy() {
      throw new Error(`must not escape: ${SYNTHETIC_RANDOM_TOKEN}`);
    },
  });
  assert.throws(
    () => throwingDetector.detect(SYNTHETIC_RANDOM_TOKEN, "raw_text"),
    detectorFailure("DETECTION_FAILED", SYNTHETIC_RANDOM_TOKEN),
  );
});
