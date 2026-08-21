export const capabilityInputSchema = /** @type {const} @satisfies {import("json-schema-to-ts").JSONSchema} */ ({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "urn:recall:fnd-004:capability-input",
  oneOf: [
    {
      type: "object",
      properties: {
        kind: { const: "entity" },
        subject: { type: "string", minLength: 1, maxLength: 64 },
        object: { type: "string", minLength: 1, maxLength: 64 },
        aliases: {
          type: "array",
          items: { type: "string", minLength: 1, maxLength: 64 },
          minItems: 1,
          maxItems: 4,
          uniqueItems: true,
        },
      },
      required: ["kind", "subject", "object"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        kind: { const: "literal" },
        subject: { type: "string", minLength: 1, maxLength: 64 },
        object_value: { type: "string", minLength: 1, maxLength: 256 },
      },
      required: ["kind", "subject", "object_value"],
      additionalProperties: false,
    },
  ],
});

export const capabilityOutputSchema = /** @type {const} @satisfies {import("json-schema-to-ts").JSONSchema} */ ({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "urn:recall:fnd-004:capability-output",
  type: "object",
  properties: {
    event_id: { type: "string", minLength: 29, maxLength: 29 },
    results: {
      type: "array",
      minItems: 0,
      maxItems: 3,
      items: {
        oneOf: [
          {
            type: "object",
            properties: {
              index: { type: "integer", minimum: 0, maximum: 2 },
              status: { const: "created" },
              claim_id: { type: "string", minLength: 4, maxLength: 64 },
            },
            required: ["index", "status", "claim_id"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              index: { type: "integer", minimum: 0, maximum: 2 },
              status: { const: "rejected" },
              note: { type: "string", minLength: 1, maxLength: 256 },
            },
            required: ["index", "status", "note"],
            additionalProperties: false,
          },
        ],
      },
    },
  },
  required: ["event_id", "results"],
  additionalProperties: false,
});
