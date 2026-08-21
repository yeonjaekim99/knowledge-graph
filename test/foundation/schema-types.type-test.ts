import type { InferJsonSchema } from "../../src/schema/index.js";
import {
  capabilityInputSchema,
  capabilityOutputSchema,
} from "../support/schema-capability-fixture.mjs";

type CapabilityInput = InferJsonSchema<typeof capabilityInputSchema>;
type CapabilityOutput = InferJsonSchema<typeof capabilityOutputSchema>;

const entityInput: CapabilityInput = {
  kind: "entity",
  subject: "인증 시스템",
  object: "서버 세션",
  aliases: ["로그인"],
};
const literalInput: CapabilityInput = {
  kind: "literal",
  subject: "테스트 명령",
  object_value: "pnpm test",
};
const structuredOutput: CapabilityOutput = {
  event_id: "ev_00000000000000000000000000",
  results: [
    { index: 0, status: "created", claim_id: "c1.0" },
    { index: 1, status: "rejected", note: "retry safely" },
  ],
};

void entityInput;
void literalInput;
void structuredOutput;

const wrongEntityBranch: CapabilityInput = {
  kind: "entity",
  subject: "인증 시스템",
  // @ts-expect-error the discriminant fixes the entity branch
  object_value: "서버 세션",
};

const outputWithUnknownField: CapabilityOutput = {
  event_id: "ev_00000000000000000000000000",
  results: [],
  // @ts-expect-error closed result branches do not expose arbitrary fields
  scope_key: "u:alice/p:recall",
};

void wrongEntityBranch;
void outputWithUnknownField;
