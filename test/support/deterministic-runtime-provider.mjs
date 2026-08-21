import { createRuntimeProvider } from "../../dist/application/runtime-context.js";

const DEFAULT_EVENT_ID = `ev_${"0".repeat(26)}`;
const DEFAULT_APPROVAL_TOKEN = `ra_${"A".repeat(43)}`;

/**
 * Reusable deterministic fixture. It returns the exact RuntimeProvider produced
 * by the application factory; only its leaf dependencies differ from production.
 */
export function createDeterministicRuntimeProvider({
  nowMilliseconds = 0,
  eventIds = [DEFAULT_EVENT_ID],
  approvalTokens = [DEFAULT_APPROVAL_TOKEN],
  rulesVersion = "test-rules-v1",
  scope = {
    userId: "test-user",
    projectId: "test-project",
    scopeKey: "u:test-user/p:test-project",
  },
  metadata = { actor: null, branch: null, session: null },
} = {}) {
  const queuedEventIds = [...eventIds];
  const queuedApprovalTokens = [...approvalTokens];
  const fixedScope = Object.freeze({ ...scope });
  const fixedMetadata = Object.freeze({ ...metadata });

  return createRuntimeProvider({
    clock: {
      nowMilliseconds() {
        return nowMilliseconds;
      },
    },
    eventIds: {
      nextEventId() {
        const value = queuedEventIds.shift();
        if (value === undefined) {
          throw new Error("deterministic event ID queue exhausted");
        }
        return value;
      },
    },
    approvalTokens: {
      nextApprovalToken() {
        const value = queuedApprovalTokens.shift();
        if (value === undefined) {
          throw new Error("deterministic approval token queue exhausted");
        }
        return value;
      },
    },
    rules: {
      currentRulesVersion() {
        return rulesVersion;
      },
    },
    scope: {
      resolveScope() {
        return fixedScope;
      },
    },
    metadata: {
      async resolveMetadata() {
        return fixedMetadata;
      },
    },
  });
}
