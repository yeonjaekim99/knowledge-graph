import assert from "node:assert/strict";
import { test } from "node:test";

import {
  JsonSchemaValidationError,
  createMcpJsonSchemaContract,
  memoryRecallInputContract,
  recallResultContract,
  validateMemoryRecallInput,
  validateRecallResult,
} from "../../../dist/adapters/mcp/index.js";
import {
  memoryRecallInputDefinition,
  recallResultDefinition,
} from "../../../dist/application/index.js";

const OPTIONS = Object.freeze({ target: "draft-2020-12" });
const EVENT_ID = `ev_${"0".repeat(26)}`;

function schemaError(boundary) {
  return (error) => {
    assert.ok(error instanceof JsonSchemaValidationError);
    assert.equal(error.code, "SCHEMA_VALIDATION_FAILED");
    assert.equal(error.boundary, boundary);
    assert.ok(error.issueCount > 0);
    assert.equal("cause" in error, false);
    return true;
  };
}

test("search and overview use one frozen discriminated input schema with normative defaults", async () => {
  assert.strictEqual(
    memoryRecallInputContract.definition,
    memoryRecallInputDefinition,
  );
  assert.strictEqual(
    memoryRecallInputContract.standardSchema["~standard"].jsonSchema.input(
      OPTIONS,
    ),
    memoryRecallInputDefinition.schema,
  );
  assert.equal(Object.isFrozen(memoryRecallInputDefinition.schema), true);

  const standardSearch = await memoryRecallInputContract.standardSchema[
    "~standard"
  ].validate({ query: "  padded search  " });
  assert.equal(standardSearch.issues, undefined);
  assert.deepEqual(standardSearch.value, {
    mode: "search",
    query: "padded search",
    depth: 2,
    limit: 10,
    detail: "brief",
  });

  const standardOverview = await memoryRecallInputContract.standardSchema[
    "~standard"
  ].validate({ mode: "overview" });
  assert.equal(standardOverview.issues, undefined);
  assert.deepEqual(standardOverview.value, {
    mode: "overview",
    limit: 10,
    detail: "brief",
  });
  assert.equal("depth" in standardOverview.value, false);

  assert.deepEqual(await validateMemoryRecallInput({ query: "인증" }), {
    mode: "search",
    query: "인증",
    depth: 2,
    limit: 10,
    detail: "brief",
  });
  assert.deepEqual(
    await validateMemoryRecallInput({
      mode: "search",
      query: "로그인 정책",
      terms: ["로그인", "정책"],
      depth: 3,
      limit: 50,
      detail: "full",
    }),
    {
      mode: "search",
      query: "로그인 정책",
      terms: ["로그인", "정책"],
      depth: 3,
      limit: 50,
      detail: "full",
    },
  );
  assert.deepEqual(await validateMemoryRecallInput({ mode: "overview" }), {
    mode: "overview",
    limit: 10,
    detail: "brief",
  });
});

test("input validation rejects missing query, mode leaks, closed fields, and Unicode bounds", async () => {
  const invalidInputs = [
    {},
    { mode: "search" },
    { mode: "search", query: "   " },
    { mode: "overview", query: "must fail" },
    { mode: "overview", depth: 1 },
    { mode: "overview", terms: ["must fail"] },
    { mode: "search", query: "ok", depth: 0 },
    { mode: "search", query: "ok", depth: 4 },
    { mode: "search", query: "ok", limit: 0 },
    { mode: "search", query: "ok", limit: 51 },
    { mode: "search", query: "ok", limit: 1.5 },
    { mode: "search", query: "ok", terms: Array(11).fill("term") },
    { mode: "search", query: "ok", terms: [""] },
    { mode: "search", query: "ok", terms: ["x".repeat(257)] },
    { mode: "search", query: `safe-${"\ud800"}-payload` },
    { mode: "search", query: "ok", terms: [`safe-${"\udfff"}-payload`] },
    { mode: "search", query: "ok", scope_key: "u:attacker/p:other" },
    { mode: "search", query: "ok", actor: "attacker" },
    { mode: "search", query: "😀".repeat(4_097) },
  ];

  for (const input of invalidInputs) {
    await assert.rejects(validateMemoryRecallInput(input), schemaError("input"));
  }

  const paddedUnicodeQuery = `  ${"😀".repeat(4_096)}  `;
  const unicodeBoundary = await validateMemoryRecallInput({
    query: paddedUnicodeQuery,
    terms: ["😀".repeat(256)],
  });
  assert.equal(Array.from(unicodeBoundary.query).length, 4_096);
  assert.equal(Array.from(unicodeBoundary.terms[0]).length, 256);

  const sdkValidation = await memoryRecallInputContract.standardSchema[
    "~standard"
  ].validate({ query: paddedUnicodeQuery });
  assert.equal(sdkValidation.issues, undefined);
  assert.equal(Array.from(sdkValidation.value.query).length, 4_096);

  const advertisedContract = createMcpJsonSchemaContract(
    memoryRecallInputDefinition,
  );
  const advertisedValidation = await advertisedContract.standardSchema[
    "~standard"
  ].validate({ query: paddedUnicodeQuery });
  assert.equal(advertisedValidation.issues, undefined);
  assert.equal(advertisedValidation.value.query, paddedUnicodeQuery);
  const advertisedTooLong = await advertisedContract.standardSchema[
    "~standard"
  ].validate({ query: ` ${"😀".repeat(4_097)} ` });
  assert.ok(advertisedTooLong.issues?.length > 0);
  for (const malformed of [
    { query: `safe-${"\ud800"}-payload` },
    { query: "ok", terms: [`safe-${"\udfff"}-payload`] },
  ]) {
    const malformedResult = await advertisedContract.standardSchema[
      "~standard"
    ].validate(malformed);
    assert.ok(malformedResult.issues?.length > 0);
  }

  const advertisedQuerySchema =
    memoryRecallInputDefinition.schema.oneOf[0].properties.query;
  assert.equal(advertisedQuerySchema.maxLength, undefined);
  assert.equal(
    advertisedQuerySchema["x-recall-trimmedCodePointMinLength"],
    1,
  );
  assert.equal(
    advertisedQuerySchema["x-recall-trimmedCodePointMaxLength"],
    4_096,
  );
});

test("RecallResult schema accepts strict claim/raw answers without assembling semantics", async () => {
  assert.strictEqual(recallResultContract.definition, recallResultDefinition);
  assert.strictEqual(
    recallResultContract.standardSchema["~standard"].jsonSchema.output(OPTIONS),
    recallResultDefinition.schema,
  );

  const result = {
    answers: [
      {
        kind: "claim",
        claim_id: "c1.0",
        text: "인증 사용 JWT",
        path: "인증 → 게이트웨이 → 정책 → 서버 → JWT",
        hops: 4,
        contested: false,
        support: {
          count: 2,
          strongest: "user_stated",
          last_seen: "2026-08-22T12:34:56Z",
        },
        detail: {
          statements: [
            {
              event_id: EVENT_ID,
              raw_text: "인증은 JWT를 사용한다",
              provenance: "user_stated",
              created_at: "2026-08-22T12:34:56Z",
              recorded_at: "2026-08-22T12:35:00Z",
              actor: "contract-test",
              branch: "rcl-001",
            },
          ],
          more_available: false,
        },
      },
      {
        kind: "raw",
        event_id: EVENT_ID,
        text: "아직 구조화되지 않은 메모",
        created_at: "2026-08-22T12:34:56Z",
        recorded_at: "2026-08-22T12:34:56Z",
        provenance: "observed",
      },
    ],
    entry: "fts",
    more_available: true,
    note: "detail payload truncated",
  };

  assert.deepEqual(await validateRecallResult(result), result);
  assert.deepEqual(
    await validateRecallResult({
      answers: [],
      entry: "none",
      more_available: false,
    }),
    { answers: [], entry: "none", more_available: false },
  );
});

test("RecallResult rejects malformed IDs/times/support, wrong answer branches, and secret-bearing extras", async () => {
  const baseClaim = {
    kind: "claim",
    claim_id: "c1.0",
    text: "인증 사용 JWT",
    path: "인증 → JWT",
    hops: 1,
    contested: false,
    support: {
      count: 1,
      strongest: "observed",
      last_seen: "2026-08-22T12:34:56Z",
    },
  };
  const invalidResults = [
    { answers: [], entry: "none", more_available: false, scope_key: "secret" },
    { answers: [baseClaim], entry: "surface", more_available: "false" },
    {
      answers: [{ ...baseClaim, claim_id: "c0.0" }],
      entry: "surface",
      more_available: false,
    },
    {
      answers: [
        { ...baseClaim, support: { ...baseClaim.support, count: 0 } },
      ],
      entry: "surface",
      more_available: false,
    },
    {
      answers: [{ ...baseClaim, hops: 5 }],
      entry: "surface",
      more_available: false,
    },
    {
      answers: [
        {
          ...baseClaim,
          support: {
            ...baseClaim.support,
            last_seen: "2026-08-22T12:34:56.000Z",
          },
        },
      ],
      entry: "surface",
      more_available: false,
    },
    {
      answers: [
        {
          ...baseClaim,
          support: {
            ...baseClaim.support,
            last_seen: "2026-02-31T12:34:56Z",
          },
        },
      ],
      entry: "surface",
      more_available: false,
    },
    {
      answers: [
        {
          kind: "raw",
          event_id: EVENT_ID,
          text: "raw",
          created_at: "2026-08-22T12:34:56Z",
          recorded_at: "2026-08-22T12:34:56Z",
          provenance: "inferred",
          detail: { statements: [], more_available: false },
        },
      ],
      entry: "fts",
      more_available: false,
    },
    {
      answers: [
        {
          ...baseClaim,
          detail: {
            statements: Array.from({ length: 101 }, () => ({
              event_id: EVENT_ID,
              raw_text: "payload",
              provenance: "inferred",
              created_at: "2026-08-22T12:34:56Z",
              recorded_at: "2026-08-22T12:34:56Z",
            })),
            more_available: true,
          },
        },
      ],
      entry: "surface",
      more_available: true,
    },
  ];

  for (const result of invalidResults) {
    await assert.rejects(validateRecallResult(result), schemaError("output"));
  }

  const submittedSecret = "sk-live-RCL001-must-not-echo";
  await assert.rejects(
    validateRecallResult({
      answers: [],
      entry: "none",
      more_available: false,
      leaked: submittedSecret,
    }),
    (error) => {
      assert.ok(schemaError("output")(error));
      assert.doesNotMatch(error.message, new RegExp(submittedSecret, "u"));
      assert.equal(JSON.stringify(error).includes(submittedSecret), false);
      return true;
    },
  );
});
