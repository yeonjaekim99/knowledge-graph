import assert from "node:assert/strict";
import { test } from "node:test";

import {
  RecordContractError,
  claimDraftSchemaDefinition,
  memoryRecordInputSchemaDefinition,
  recordResultSchemaDefinition,
  resolveAcceptedRecordClaimStatus,
} from "../../../dist/application/index.js";
import {
  JsonSchemaValidationError,
  claimDraftContract,
  createMcpJsonSchemaContract,
  memoryRecordInputContract,
  recordResultContract,
  validateRecordResultForInput,
} from "../../../dist/adapters/mcp/index.js";

const EVENT_ID = `ev_0${"A".repeat(25)}`;
const APPROVAL = `ra_${"A".repeat(43)}`;
const JSON_SCHEMA_OPTIONS = Object.freeze({ target: "draft-2020-12" });

function entityDraft(overrides = {}) {
  return {
    subject: "인증 시스템",
    subject_kind: "service",
    relation: "uses",
    relation_label: "uses database",
    object: "PostgreSQL",
    object_kind: "database",
    subject_aliases: ["로그인"],
    object_aliases: ["주 DB"],
    ...overrides,
  };
}

function literalDraft(overrides = {}) {
  return {
    subject: "테스트 명령",
    relation: "describes",
    object_value: "pnpm test",
    ...overrides,
  };
}

function recordInput(overrides = {}) {
  return {
    raw_text: "인증 시스템은 PostgreSQL을 사용한다.",
    claims: [entityDraft()],
    ...overrides,
  };
}

function freeFormInputCases(value) {
  const draftCases = [
    ["subject", entityDraft({ subject: value })],
    ["object", entityDraft({ object: value })],
    ["object_value", literalDraft({ object_value: value })],
    ["subject_kind", entityDraft({ subject_kind: value })],
    ["object_kind", entityDraft({ object_kind: value })],
    ["relation_label", entityDraft({ relation_label: value })],
    ["subject_aliases", entityDraft({ subject_aliases: [value] })],
    ["object_aliases", entityDraft({ object_aliases: [value] })],
  ];
  return [
    { name: "raw_text", draft: null, input: recordInput({ raw_text: value }) },
    ...draftCases.map(([name, draft]) => ({
      name,
      draft,
      input: recordInput({ claims: [draft] }),
    })),
  ];
}

function assertRedactedIssues(result, marker) {
  assert.ok(result.issues?.length > 0);
  assert.equal(JSON.stringify(result.issues).includes(marker), false);
}

function assertRedactedSchemaError(error, marker) {
  assert.ok(error instanceof JsonSchemaValidationError);
  assert.equal(error.code, "SCHEMA_VALIDATION_FAILED");
  assert.equal(error.boundary, "input");
  assert.ok(error.issueCount > 0);
  assert.equal("cause" in error, false);
  assert.equal(error.message.includes(marker), false);
  assert.equal(JSON.stringify(error).includes(marker), false);
  return true;
}

async function observeMalformedContractSurface({
  label,
  contract,
  value,
  marker,
  accepted,
}) {
  const standardResult = await contract.standardSchema["~standard"].validate(
    value,
  );
  if (standardResult.issues === undefined) {
    accepted.push(`${label}:standard`);
  } else {
    assertRedactedIssues(standardResult, marker);
  }
  try {
    await contract.validate(value, "input");
    accepted.push(`${label}:helper`);
  } catch (error) {
    assertRedactedSchemaError(error, marker);
  }
}

async function rejectsSchema(contract, value, boundary = "input") {
  await assert.rejects(contract.validate(value, boundary), (error) => {
    assert.ok(error instanceof JsonSchemaValidationError);
    assert.equal(error.code, "SCHEMA_VALIDATION_FAILED");
    assert.equal(error.boundary, boundary);
    assert.ok(error.issueCount > 0);
    return true;
  });
}

function assertEveryDeclaredObjectIsClosed(value, path = "#") {
  if (Array.isArray(value)) {
    value.forEach((child, index) =>
      assertEveryDeclaredObjectIsClosed(child, `${path}/${index}`),
    );
    return;
  }
  if (value === null || typeof value !== "object") {
    return;
  }
  if (
    value.type === "object" ||
    (Array.isArray(value.type) && value.type.includes("object"))
  ) {
    assert.equal(
      value.additionalProperties,
      false,
      `${path} must be a closed object schema`,
    );
  }
  for (const [key, child] of Object.entries(value)) {
    assertEveryDeclaredObjectIsClosed(child, `${path}/${key}`);
  }
}

function collectDeclaredPropertyNames(value, names = new Set()) {
  if (Array.isArray(value)) {
    for (const child of value) {
      collectDeclaredPropertyNames(child, names);
    }
    return names;
  }
  if (value === null || typeof value !== "object") {
    return names;
  }
  if (value.properties !== null && typeof value.properties === "object") {
    for (const name of Object.keys(value.properties)) {
      names.add(name);
    }
  }
  for (const child of Object.values(value)) {
    collectDeclaredPropertyNames(child, names);
  }
  return names;
}

test("record definitions are frozen Draft 2020-12 sources and every object is closed", () => {
  for (const [definition, contract] of [
    [claimDraftSchemaDefinition, claimDraftContract],
    [memoryRecordInputSchemaDefinition, memoryRecordInputContract],
    [recordResultSchemaDefinition, recordResultContract],
  ]) {
    assert.equal(
      definition.schema.$schema,
      "https://json-schema.org/draft/2020-12/schema",
    );
    assert.equal(Object.isFrozen(definition), true);
    assert.equal(Object.isFrozen(definition.schema), true);
    assertEveryDeclaredObjectIsClosed(definition.schema);
    assert.strictEqual(contract.definition, definition);
    assert.strictEqual(
      contract.standardSchema["~standard"].jsonSchema.input(
        JSON_SCHEMA_OPTIONS,
      ),
      definition.schema,
    );
  }

  const inputPropertyNames = collectDeclaredPropertyNames(
    memoryRecordInputSchemaDefinition.schema,
  );
  for (const trustedField of [
    "scope_key",
    "actor",
    "branch",
    "session",
    "created_at",
  ]) {
    assert.equal(inputPropertyNames.has(trustedField), false);
  }
});

test("record input preserves raw strings and accepts every Unicode code-point boundary", async () => {
  const emoji = "😀";
  const input = {
    raw_text: `  ${emoji.repeat(32_768)}  `,
    claims: [
      entityDraft({
        subject: ` ${emoji.repeat(1_024)} `,
        subject_kind: ` ${emoji.repeat(64)} `,
        relation_label: ` ${emoji.repeat(256)} `,
        object: ` ${emoji.repeat(1_024)} `,
        object_kind: ` ${emoji.repeat(64)} `,
        subject_aliases: Array.from(
          { length: 20 },
          (_, index) => ` ${emoji.repeat(255)}${index % 10} `,
        ),
        object_aliases: [],
      }),
      literalDraft({ object_value: ` ${emoji.repeat(1_024)} ` }),
    ],
    provenance: "observed",
    ttl: "weeks",
  };

  assert.deepEqual(await memoryRecordInputContract.validate(input, "input"), input);
  assert.deepEqual(
    await claimDraftContract.validate(input.claims[0], "input"),
    input.claims[0],
  );

  const oneHundredClaims = recordInput({
    claims: Array.from({ length: 100 }, (_, index) =>
      literalDraft({ subject: `slot ${index}` }),
    ),
  });
  assert.equal(
    (await memoryRecordInputContract.validate(oneHundredClaims, "input"))
      .claims.length,
    100,
  );
  assert.deepEqual(
    await memoryRecordInputContract.validate(
      { raw_text: "원문만 기록", claims: [] },
      "input",
    ),
    { raw_text: "원문만 기록", claims: [] },
  );
});

test("every free-form record input keeps valid astral pairs across advertised, Standard Schema, and helper paths", async () => {
  const value = "valid-astral-😀-pair";
  assert.equal(value.isWellFormed(), true);
  const advertisedClaimDraftContract = createMcpJsonSchemaContract(
    claimDraftSchemaDefinition,
  );
  const advertisedMemoryRecordContract = createMcpJsonSchemaContract(
    memoryRecordInputSchemaDefinition,
  );

  for (const { name, draft, input } of freeFormInputCases(value)) {
    const advertisedInput = await advertisedMemoryRecordContract.standardSchema[
      "~standard"
    ].validate(input);
    assert.equal(advertisedInput.issues, undefined, `${name}:advertised`);
    const standardInput = await memoryRecordInputContract.standardSchema[
      "~standard"
    ].validate(input);
    assert.equal(standardInput.issues, undefined, `${name}:standard`);
    assert.deepEqual(await memoryRecordInputContract.validate(input, "input"), input);

    if (draft !== null) {
      const advertisedDraft = await advertisedClaimDraftContract.standardSchema[
        "~standard"
      ].validate(draft);
      assert.equal(advertisedDraft.issues, undefined, `${name}:draft-advertised`);
      const standardDraft = await claimDraftContract.standardSchema[
        "~standard"
      ].validate(draft);
      assert.equal(standardDraft.issues, undefined, `${name}:draft-standard`);
      assert.deepEqual(await claimDraftContract.validate(draft, "input"), draft);
    }
  }
});

test("every free-form record input rejects ill-formed UTF-16 across advertised, Standard Schema, and helper paths", async () => {
  const malformedShapes = [
    ["lone-high", "\ud800"],
    ["lone-low", "\udfff"],
    ["high-high", "\ud800\ud800"],
    ["low-high", "\udfff\ud800"],
  ];
  const advertisedClaimDraftContract = createMcpJsonSchemaContract(
    claimDraftSchemaDefinition,
  );
  const advertisedMemoryRecordContract = createMcpJsonSchemaContract(
    memoryRecordInputSchemaDefinition,
  );
  const accepted = [];

  for (const [shape, malformed] of malformedShapes) {
    const marker = `scalar-probe-${shape}`;
    const value = `${marker}-${malformed}-payload`;
    assert.equal(value.isWellFormed(), false);
    for (const { name, draft, input } of freeFormInputCases(value)) {
      const advertisedInput =
        await advertisedMemoryRecordContract.standardSchema["~standard"].validate(
          input,
        );
      if (advertisedInput.issues === undefined) {
        accepted.push(`${shape}:${name}:record-advertised`);
      } else {
        assertRedactedIssues(advertisedInput, marker);
      }
      await observeMalformedContractSurface({
        label: `${shape}:${name}:record`,
        contract: memoryRecordInputContract,
        value: input,
        marker,
        accepted,
      });

      if (draft !== null) {
        const advertisedDraft =
          await advertisedClaimDraftContract.standardSchema["~standard"].validate(
            draft,
          );
        if (advertisedDraft.issues === undefined) {
          accepted.push(`${shape}:${name}:draft-advertised`);
        } else {
          assertRedactedIssues(advertisedDraft, marker);
        }
        await observeMalformedContractSurface({
          label: `${shape}:${name}:draft`,
          contract: claimDraftContract,
          value: draft,
          marker,
          accepted,
        });
      }
    }
  }

  assert.equal(
    accepted.length,
    0,
    `ill-formed values were accepted by ${accepted.length} contract paths: ${accepted
      .slice(0, 12)
      .join(", ")}`,
  );
});

test("trimmed Unicode bounds and alias/claim caps are whole-request contract errors", async () => {
  const emoji = "😀";
  const invalidInputs = [
    recordInput({ raw_text: ` ${emoji.repeat(32_769)} ` }),
    recordInput({ claims: [entityDraft({ subject: ` ${emoji.repeat(1_025)} ` })] }),
    recordInput({ claims: [entityDraft({ object: ` ${emoji.repeat(1_025)} ` })] }),
    recordInput({ claims: [literalDraft({ object_value: ` ${emoji.repeat(1_025)} ` })] }),
    recordInput({ claims: [entityDraft({ relation_label: ` ${emoji.repeat(257)} ` })] }),
    recordInput({
      claims: [entityDraft({ subject_aliases: [` ${emoji.repeat(257)} `] })],
    }),
    recordInput({ claims: [entityDraft({ subject_kind: ` ${emoji.repeat(65)} ` })] }),
    recordInput({ claims: [entityDraft({ object_kind: ` ${emoji.repeat(65)} ` })] }),
    recordInput({
      claims: [
        entityDraft({
          subject_aliases: Array.from({ length: 21 }, (_, index) => `s${index}`),
        }),
      ],
    }),
    recordInput({
      claims: [
        entityDraft({
          object_aliases: Array.from({ length: 21 }, (_, index) => `o${index}`),
        }),
      ],
    }),
    recordInput({
      claims: Array.from({ length: 101 }, (_, index) =>
        literalDraft({ subject: `slot ${index}` }),
      ),
    }),
    recordInput({ provenance: "hearsay" }),
    recordInput({ ttl: "forever" }),
  ];

  for (const input of invalidInputs) {
    await rejectsSchema(memoryRecordInputContract, input);
  }
});

test("whitespace-only stored strings are structural errors without echoing values", async () => {
  const invalidInputs = [
    recordInput({ raw_text: " \t\n " }),
    recordInput({ raw_text: "\uFEFF" }),
    recordInput({ claims: [entityDraft({ subject: "　 " })] }),
    recordInput({ claims: [entityDraft({ object: " \n " })] }),
    recordInput({ claims: [literalDraft({ object_value: "\t" })] }),
    recordInput({ claims: [entityDraft({ relation_label: "  " })] }),
    recordInput({ claims: [entityDraft({ subject_kind: "  " })] }),
    recordInput({ claims: [entityDraft({ object_kind: "  " })] }),
    recordInput({ claims: [entityDraft({ subject_aliases: ["  "] })] }),
    recordInput({ claims: [entityDraft({ object_aliases: ["\n"] })] }),
  ];

  for (const input of invalidInputs) {
    const standardResult = await memoryRecordInputContract.standardSchema[
      "~standard"
    ].validate(input);
    assert.ok(standardResult.issues?.length > 0);
    await assert.rejects(
      memoryRecordInputContract.validate(input, "input"),
      (error) => {
        assert.ok(error instanceof JsonSchemaValidationError);
        assert.deepEqual(Object.keys(error).sort(), [
          "boundary",
          "code",
          "issueCount",
          "name",
        ]);
        assert.doesNotMatch(JSON.stringify(error), /인증 시스템|PostgreSQL/);
        return true;
      },
    );
  }
});

test("ClaimDraft enforces XOR, object-only fields, relation vocabulary, and relates_to label", async () => {
  const invalidDrafts = [
    { subject: "A", relation: "uses", object: "B", object_value: "literal" },
    { subject: "A", relation: "uses" },
    { subject: "A", relation: "uses", object_value: "B", object_kind: "service" },
    { subject: "A", relation: "uses", object_value: "B", object_aliases: ["bee"] },
    { subject: "A", relation: "relates_to", object: "B" },
    { subject: "A", relation: "relates_to", relation_label: " ", object: "B" },
    { subject: "A", relation: "configures", object: "B" },
    { subject: "A", relation: "uses", object: "B", extra: true },
  ];

  for (const draft of invalidDrafts) {
    await rejectsSchema(claimDraftContract, draft);
    await rejectsSchema(memoryRecordInputContract, recordInput({ claims: [draft] }));
  }

  for (const draft of [
    entityDraft({ relation: "relates_to", relation_label: "configured beside" }),
    literalDraft({ relation: "relates_to", relation_label: "configured as" }),
  ]) {
    assert.deepEqual(await claimDraftContract.validate(draft, "input"), draft);
  }
});

test("normal and reinterpret branches require the exact canonical pair", async () => {
  const reinterpret = recordInput({
    supersedes: EVENT_ID,
    reinterpret_approval: APPROVAL,
  });
  assert.deepEqual(
    await memoryRecordInputContract.validate(reinterpret, "input"),
    reinterpret,
  );

  for (const input of [
    recordInput({ supersedes: EVENT_ID }),
    recordInput({ reinterpret_approval: APPROVAL }),
    recordInput({ supersedes: `ev_8${"A".repeat(25)}`, reinterpret_approval: APPROVAL }),
    recordInput({ supersedes: `ev_0${"a".repeat(25)}`, reinterpret_approval: APPROVAL }),
    recordInput({ supersedes: EVENT_ID, reinterpret_approval: `ra_${"A".repeat(42)}` }),
    recordInput({ supersedes: EVENT_ID, reinterpret_approval: `${APPROVAL}=` }),
  ]) {
    await rejectsSchema(memoryRecordInputContract, input);
  }
});

test("trusted scope and journal metadata can never enter record input", async () => {
  for (const [field, value] of [
    ["scope_key", "u:alice/p:recall"],
    ["actor", "client"],
    ["branch", "main"],
    ["session", "session-1"],
    ["created_at", "2026-08-22T00:00:00Z"],
    ["event_id", EVENT_ID],
  ]) {
    await rejectsSchema(memoryRecordInputContract, {
      ...recordInput(),
      [field]: value,
    });
  }
});

test("RecordResult requires claim IDs for accepted statuses and actionable rejected notes", async () => {
  const emoji = "😀";
  const output = {
    event_id: EVENT_ID,
    claims: [
      { index: 0, status: "created", claim_id: "c1.0" },
      {
        index: 1,
        status: "rejected",
        note: ` ${emoji.repeat(2_048)} `,
      },
      {
        index: 2,
        status: "reinforced",
        claim_id: "c1.1",
        note: "merged with input index 0",
      },
      { index: 3, status: "superseded_previous", claim_id: "c1.2" },
    ],
  };
  assert.deepEqual(await recordResultContract.validate(output, "output"), output);
  const oneHundredResults = {
    event_id: EVENT_ID,
    claims: Array.from({ length: 100 }, (_, index) => ({
      index,
      status: "created",
      claim_id: `c1.${index}`,
    })),
  };
  assert.equal(
    (await recordResultContract.validate(oneHundredResults, "output")).claims
      .length,
    100,
  );

  const invalidOutputs = [
    { event_id: EVENT_ID, claims: [{ index: 0, status: "created" }] },
    {
      event_id: EVENT_ID,
      claims: [{ index: 0, status: "rejected", claim_id: "c1.0", note: "retry" }],
    },
    { event_id: EVENT_ID, claims: [{ index: 0, status: "rejected" }] },
    { event_id: EVENT_ID, claims: [{ index: 0, status: "rejected", note: " " }] },
    {
      event_id: EVENT_ID,
      claims: [{ index: 0, status: "created", claim_id: "C1.0" }],
    },
    {
      event_id: EVENT_ID,
      claims: [{ index: -1, status: "created", claim_id: "c1.0" }],
    },
    {
      event_id: EVENT_ID,
      claims: [{ index: 100, status: "created", claim_id: "c1.0" }],
    },
    {
      event_id: EVENT_ID,
      claims: [{ index: 0, status: "stored", claim_id: "c1.0" }],
    },
    {
      event_id: EVENT_ID,
      claims: [{ index: 0, status: "created", claim_id: "c1.0", scope_key: "forged" }],
    },
    { event_id: `ev_8${"A".repeat(25)}`, claims: [] },
    {
      event_id: EVENT_ID,
      claims: [
        {
          index: 0,
          status: "rejected",
          note: ` ${emoji.repeat(2_049)} `,
        },
      ],
    },
    {
      event_id: EVENT_ID,
      claims: Array.from({ length: 101 }, () => ({
        index: 0,
        status: "created",
        claim_id: "c1.0",
      })),
    },
  ];
  for (const outputValue of invalidOutputs) {
    await rejectsSchema(recordResultContract, outputValue, "output");
  }
});

test("schema failures are distinct from a typed semantic rejected result", async () => {
  const input = recordInput({ claims: [entityDraft()] });
  await rejectsSchema(
    memoryRecordInputContract,
    recordInput({ claims: [{ subject: "A", relation: "uses" }] }),
  );

  const semanticResult = {
    event_id: EVENT_ID,
    claims: [
      {
        index: 0,
        status: "rejected",
        note: "subject is ambiguous; use its exact canonical name",
      },
    ],
  };
  assert.deepEqual(
    await validateRecordResultForInput(input, semanticResult),
    semanticResult,
  );
});

test("RecordResult has exactly one unique result for every original input index", async () => {
  const emptyInput = recordInput({ claims: [] });
  const emptyResult = { event_id: EVENT_ID, claims: [] };
  assert.deepEqual(
    await validateRecordResultForInput(emptyInput, emptyResult),
    emptyResult,
  );

  const input = recordInput({
    claims: [entityDraft(), literalDraft(), entityDraft({ subject: "캐시" })],
  });
  const completeOutOfOrder = {
    event_id: EVENT_ID,
    claims: [
      { index: 2, status: "created", claim_id: "c1.2" },
      { index: 0, status: "created", claim_id: "c1.0" },
      { index: 1, status: "reinforced", claim_id: "c1.1" },
    ],
  };
  assert.deepEqual(
    await validateRecordResultForInput(input, completeOutOfOrder),
    completeOutOfOrder,
  );

  for (const invalid of [
    {
      event_id: EVENT_ID,
      claims: [
        { index: 0, status: "created", claim_id: "c1.0" },
        { index: 0, status: "reinforced", claim_id: "c1.0" },
        { index: 2, status: "created", claim_id: "c1.2" },
      ],
    },
    {
      event_id: EVENT_ID,
      claims: [
        { index: 0, status: "created", claim_id: "c1.0" },
        { index: 1, status: "created", claim_id: "c1.1" },
      ],
    },
    {
      event_id: EVENT_ID,
      claims: [
        { index: 0, status: "created", claim_id: "c1.0" },
        { index: 1, status: "created", claim_id: "c1.1" },
        { index: 3, status: "created", claim_id: "c1.3" },
      ],
    },
  ]) {
    await assert.rejects(validateRecordResultForInput(input, invalid), (error) => {
      assert.ok(error instanceof RecordContractError);
      assert.equal(error.code, "RESULT_INDEX_COVERAGE_MISMATCH");
      assert.doesNotMatch(JSON.stringify(error), /인증 시스템|PostgreSQL/);
      return true;
    });
  }
});

test("accepted status precedence is superseded_previous, then created, then reinforced", () => {
  assert.equal(
    resolveAcceptedRecordClaimStatus({
      supersededPrevious: true,
      identityCreated: true,
    }),
    "superseded_previous",
  );
  assert.equal(
    resolveAcceptedRecordClaimStatus({
      supersededPrevious: false,
      identityCreated: true,
    }),
    "created",
  );
  assert.equal(
    resolveAcceptedRecordClaimStatus({
      supersededPrevious: false,
      identityCreated: false,
    }),
    "reinforced",
  );
  for (const invalid of [null, {}, { supersededPrevious: true }]) {
    assert.throws(
      () => resolveAcceptedRecordClaimStatus(invalid),
      (error) =>
        error instanceof RecordContractError &&
        error.code === "INVALID_ACCEPTED_STATUS_FACTS",
    );
  }
});
