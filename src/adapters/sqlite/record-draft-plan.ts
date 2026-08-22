import {
  finalizeRecordDraftPlan,
  recordDraftSurvivorIndexes,
} from "../../application/memory-record-draft-plan.js";
import type {
  FinalizedRecordDraftPlan,
  RecordDraftSurvivorPlan,
} from "../../application/memory-record-draft-plan.js";
import type { SqliteProjectionDispatchSession } from "./connection-factory.js";
import {
  WriteEntityResolutionError,
  finalizeSqliteWriteEntityDrafts,
} from "./write-entity-resolver.js";

interface SqliteRecordDraftFinalizationInput {
  readonly dispatchId: number;
  readonly plan: RecordDraftSurvivorPlan;
  readonly statementBodyJson: string;
}

function rejected(): Promise<never> {
  return Promise.reject(
    new WriteEntityResolutionError("INVALID_WRITE_ENTITY_RESOLUTION_INPUT"),
  );
}

function snapshotInput(value: unknown): SqliteRecordDraftFinalizationInput {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new WriteEntityResolutionError("INVALID_WRITE_ENTITY_RESOLUTION_INPUT");
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  const expectedKeys = ["dispatchId", "plan", "statementBodyJson"] as const;
  const expected = new Set<string>(expectedKeys);
  const keys = Reflect.ownKeys(value);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    keys.length !== expectedKeys.length ||
    keys.some(
      (key) => typeof key !== "string" || !expected.has(key),
    )
  ) {
    throw new WriteEntityResolutionError("INVALID_WRITE_ENTITY_RESOLUTION_INPUT");
  }
  const fields: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !("value" in descriptor)
    ) {
      throw new WriteEntityResolutionError(
        "INVALID_WRITE_ENTITY_RESOLUTION_INPUT",
      );
    }
    fields[key] = descriptor.value;
  }
  if (
    !Number.isSafeInteger(fields["dispatchId"]) ||
    Number(fields["dispatchId"]) <= 0 ||
    typeof fields["statementBodyJson"] !== "string" ||
    fields["statementBodyJson"].length === 0
  ) {
    throw new WriteEntityResolutionError("INVALID_WRITE_ENTITY_RESOLUTION_INPUT");
  }
  const plan = fields["plan"] as RecordDraftSurvivorPlan;
  recordDraftSurvivorIndexes(plan);
  return Object.freeze({
    dispatchId: Number(fields["dispatchId"]),
    plan,
    statementBodyJson: fields["statementBodyJson"],
  });
}

/**
 * Binds REC-005's survivor plan to REC-004's exact-body/global-seq finalizer.
 * It deliberately has neither append nor commit capability.
 */
export async function finalizeSqliteRecordDraftPlan(
  session: SqliteProjectionDispatchSession,
  value: unknown,
): Promise<FinalizedRecordDraftPlan> {
  let input: SqliteRecordDraftFinalizationInput;
  let survivorDraftIndexes: readonly number[];
  try {
    input = snapshotInput(value);
    survivorDraftIndexes = recordDraftSurvivorIndexes(input.plan);
  } catch {
    return rejected();
  }
  const finalized = await finalizeSqliteWriteEntityDrafts(session, {
    dispatchId: input.dispatchId,
    survivorDraftIndexes,
    statementBodyJson: input.statementBodyJson,
  });
  return finalizeRecordDraftPlan(input.plan, finalized);
}
