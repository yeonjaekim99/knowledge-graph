import assert from "node:assert/strict";
import { test } from "node:test";

import {
  JsonSchemaValidationError,
  createMcpJsonSchemaContract,
} from "../../dist/adapters/mcp/index.js";
import {
  JSON_SCHEMA_DIALECT_2020_12,
  JsonSchemaDefinitionError,
  defineJsonSchema,
  serializeJsonSchema,
} from "../../dist/schema/index.js";
import {
  capabilityInputSchema,
  capabilityOutputSchema,
} from "../support/schema-capability-fixture.mjs";

const JSON_SCHEMA_OPTIONS = Object.freeze({ target: "draft-2020-12" });

function reverseObjectKeys(value) {
  if (Array.isArray(value)) {
    return value.map((item) => reverseObjectKeys(item));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, child]) => [key, reverseObjectKeys(child)]),
    );
  }
  return value;
}

function definitionError(code, path) {
  return (error) => {
    assert.ok(error instanceof JsonSchemaDefinitionError);
    assert.equal(error.code, code);
    assert.equal(error.schemaPath, path);
    return true;
  };
}

test("JSON Schema is the frozen normative source with deterministic serialization", () => {
  const definition = defineJsonSchema(capabilityInputSchema);
  const reordered = defineJsonSchema(reverseObjectKeys(capabilityInputSchema));

  assert.equal(
    definition.schema.$schema,
    JSON_SCHEMA_DIALECT_2020_12,
  );
  assert.equal(serializeJsonSchema(definition), definition.canonical);
  assert.equal(definition.canonical, reordered.canonical);
  assert.equal(Object.isFrozen(definition), true);
  assert.equal(Object.isFrozen(definition.schema), true);
  assert.equal(Object.isFrozen(definition.schema.oneOf), true);
  assert.equal(Object.isFrozen(definition.schema.oneOf[0].properties), true);
  assert.throws(() => {
    definition.schema.oneOf[0].properties.subject.maxLength = 65;
  }, TypeError);
});

test("schema policy rejects unsupported dialects and every declared open object", () => {
  assert.throws(
    () => defineJsonSchema({ type: "string" }),
    definitionError("UNSUPPORTED_DIALECT", "#/$schema"),
  );
  assert.throws(
    () => defineJsonSchema(true),
    definitionError("INVALID_SCHEMA_KEYWORD", "#"),
  );
  assert.throws(
    () =>
      defineJsonSchema({
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        properties: {},
        additionalProperties: false,
      }),
    definitionError("UNSUPPORTED_DIALECT", "#/$schema"),
  );
  assert.throws(
    () =>
      defineJsonSchema({
        $schema: JSON_SCHEMA_DIALECT_2020_12,
        type: "object",
        properties: {},
      }),
    definitionError("OPEN_OBJECT_SCHEMA", "#"),
  );
  assert.throws(
    () =>
      defineJsonSchema({
        $schema: JSON_SCHEMA_DIALECT_2020_12,
        type: "object",
        properties: {
          nested: { type: "object", properties: {} },
        },
        additionalProperties: false,
      }),
    definitionError("OPEN_OBJECT_SCHEMA", "#/properties/nested"),
  );
});

test("schema policy rejects malformed oneOf, invalid bounds, and non-JSON values", () => {
  assert.throws(
    () =>
      defineJsonSchema({
        $schema: JSON_SCHEMA_DIALECT_2020_12,
        oneOf: [{ type: "string" }],
      }),
    definitionError("INVALID_SCHEMA_KEYWORD", "#/oneOf"),
  );
  assert.throws(
    () =>
      defineJsonSchema({
        $schema: JSON_SCHEMA_DIALECT_2020_12,
        type: "string",
        minLength: 2,
        maxLength: 1,
      }),
    definitionError("INVALID_SCHEMA_KEYWORD", "#"),
  );
  assert.throws(
    () =>
      defineJsonSchema({
        $schema: JSON_SCHEMA_DIALECT_2020_12,
        type: "string",
        default: undefined,
      }),
    definitionError("NON_JSON_VALUE", "#/default"),
  );

  const cyclic = { $schema: JSON_SCHEMA_DIALECT_2020_12 };
  cyclic.not = cyclic;
  assert.throws(
    () => defineJsonSchema(cyclic),
    definitionError("NON_JSON_VALUE", "#/not"),
  );
});

test("one Standard Schema object advertises and validates the same input source", async () => {
  const definition = defineJsonSchema(capabilityInputSchema);
  const contract = createMcpJsonSchemaContract(definition);
  const advertisedInput = contract.standardSchema[
    "~standard"
  ].jsonSchema.input(JSON_SCHEMA_OPTIONS);
  const advertisedOutput = contract.standardSchema[
    "~standard"
  ].jsonSchema.output(JSON_SCHEMA_OPTIONS);

  assert.strictEqual(advertisedInput, definition.schema);
  assert.strictEqual(advertisedOutput, definition.schema);
  assert.equal(Object.isFrozen(contract), true);
  assert.deepEqual(
    await contract.validate(
      {
        kind: "entity",
        subject: "인증 시스템",
        object: "서버 세션",
        aliases: ["로그인", "인증"],
      },
      "input",
    ),
    {
      kind: "entity",
      subject: "인증 시스템",
      object: "서버 세션",
      aliases: ["로그인", "인증"],
    },
  );
  assert.deepEqual(
    await contract.validate(
      {
        kind: "literal",
        subject: "테스트 명령",
        object_value: "pnpm test",
      },
      "input",
    ),
    {
      kind: "literal",
      subject: "테스트 명령",
      object_value: "pnpm test",
    },
  );
});

test("runtime input validation enforces closed branches, XOR, and min/max", async () => {
  const contract = createMcpJsonSchemaContract(
    defineJsonSchema(capabilityInputSchema),
  );
  const invalidInputs = [
    {
      kind: "entity",
      subject: "인증 시스템",
      object: "서버 세션",
      scope_key: "u:alice/p:recall",
    },
    {
      kind: "entity",
      subject: "인증 시스템",
      object: "서버 세션",
      object_value: "both branches must fail",
    },
    { kind: "entity", subject: "인증 시스템" },
    { kind: "literal", subject: "", object_value: "pnpm test" },
    {
      kind: "entity",
      subject: "인증 시스템",
      object: "x".repeat(65),
    },
    {
      kind: "entity",
      subject: "인증 시스템",
      object: "서버 세션",
      aliases: [],
    },
    {
      kind: "entity",
      subject: "인증 시스템",
      object: "서버 세션",
      aliases: ["a", "b", "c", "d", "e"],
    },
    {
      kind: "entity",
      subject: "인증 시스템",
      object: "서버 세션",
      aliases: ["로그인", "로그인"],
    },
  ];

  for (const input of invalidInputs) {
    await assert.rejects(
      contract.validate(input, "input"),
      (error) =>
        error instanceof JsonSchemaValidationError &&
        error.code === "SCHEMA_VALIDATION_FAILED" &&
        error.boundary === "input" &&
        error.issueCount > 0,
    );
  }
});

test("the normative output schema validates structured results from the same source", async () => {
  const definition = defineJsonSchema(capabilityOutputSchema);
  const contract = createMcpJsonSchemaContract(definition);
  const structuredResult = {
    event_id: "ev_00000000000000000000000000",
    results: [
      { index: 0, status: "created", claim_id: "c1.0" },
      { index: 1, status: "rejected", note: "retry safely" },
    ],
  };

  assert.strictEqual(
    contract.standardSchema["~standard"].jsonSchema.output(
      JSON_SCHEMA_OPTIONS,
    ),
    definition.schema,
  );
  assert.deepEqual(
    await contract.validate(structuredResult, "output"),
    structuredResult,
  );

  for (const output of [
    { ...structuredResult, scope_key: "u:alice/p:recall" },
    { event_id: "too-short", results: [] },
    {
      event_id: "ev_00000000000000000000000000",
      results: [{ index: -1, status: "created", claim_id: "c1.0" }],
    },
    {
      event_id: "ev_00000000000000000000000000",
      results: [{ index: 3, status: "created", claim_id: "c1.0" }],
    },
    {
      event_id: "ev_00000000000000000000000000",
      results: [
        { index: 0, status: "created", claim_id: "c1.0" },
        { index: 1, status: "created", claim_id: "c1.1" },
        { index: 2, status: "created", claim_id: "c1.2" },
        { index: 3, status: "created", claim_id: "c1.3" },
      ],
    },
    {
      event_id: "ev_00000000000000000000000000",
      results: [{ index: 0, status: "created", note: "wrong branch" }],
    },
  ]) {
    await assert.rejects(
      contract.validate(output, "output"),
      (error) =>
        error instanceof JsonSchemaValidationError &&
        error.boundary === "output",
    );
  }
});

test("validation failures expose no submitted value or SDK issue payload", async () => {
  const contract = createMcpJsonSchemaContract(
    defineJsonSchema(capabilityInputSchema),
  );
  const secret = "TOP_SECRET_DO_NOT_ECHO";

  await assert.rejects(
    contract.validate(
      {
        kind: "entity",
        subject: "인증 시스템",
        object: "서버 세션",
        object_value: secret,
      },
      "input",
    ),
    (error) => {
      assert.ok(error instanceof JsonSchemaValidationError);
      assert.doesNotMatch(error.message, new RegExp(secret));
      assert.doesNotMatch(JSON.stringify(error), new RegExp(secret));
      assert.deepEqual(Object.keys(error).sort(), [
        "boundary",
        "code",
        "issueCount",
        "name",
      ]);
      assert.equal("input" in error, false);
      assert.equal("issues" in error, false);
      return true;
    },
  );
});
