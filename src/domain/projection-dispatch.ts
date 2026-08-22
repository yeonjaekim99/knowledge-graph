import {
  preScanProjectionEvents,
  type ProjectionPreScanResult,
} from "./projection-event-pre-scan.js";
import { reduceMergeAliasState } from "./projection-decisions.js";
import {
  runProjectionReplayReducer,
  type ProjectionReplayInput,
  type ProjectionReplayJournalEvent,
  type ProjectionSnapshot,
} from "./projection-replay.js";
import { reduceClaimValidityState } from "./projection-validity.js";

export type ProjectionDispatchMode = "incremental" | "replay";
export type ProjectionDispatchReason = "safe_suffix" | "historical_statement" | "event_retraction";

export interface ProjectionDispatchPlan {
  readonly mode: ProjectionDispatchMode;
  readonly reason: ProjectionDispatchReason;
}

export type ProjectionDispatchErrorCode =
  | "INVALID_DISPATCH_BATCH"
  | "INVALID_DISPATCH_EVENT";

const ERROR_MESSAGES: Readonly<Record<ProjectionDispatchErrorCode, string>> =
  Object.freeze({
    INVALID_DISPATCH_BATCH:
      "projection dispatch requires a non-empty ordered event suffix",
    INVALID_DISPATCH_EVENT:
      "projection dispatch requires a canonical stored event envelope",
  });

export class ProjectionDispatchError extends TypeError {
  public override readonly name: string = "ProjectionDispatchError";
  public readonly code: ProjectionDispatchErrorCode;

  public constructor(code: ProjectionDispatchErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.code = code;
  }
}

function reject(code: ProjectionDispatchErrorCode): never {
  throw new ProjectionDispatchError(code);
}

function dataRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return reject("INVALID_DISPATCH_EVENT");
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return reject("INVALID_DISPATCH_EVENT");
  }
  const result: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      return reject("INVALID_DISPATCH_EVENT");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !("value" in descriptor)
    ) {
      return reject("INVALID_DISPATCH_EVENT");
    }
    result[key] = descriptor.value;
  }
  return result;
}

function jsonBody(event: ProjectionReplayJournalEvent): Readonly<Record<string, unknown>> {
  if (typeof event.bodyJson !== "string") {
    return reject("INVALID_DISPATCH_EVENT");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(event.bodyJson) as unknown;
  } catch {
    return reject("INVALID_DISPATCH_EVENT");
  }
  return dataRecord(parsed);
}

function assembleProjectionSnapshot(input: ProjectionReplayInput): ProjectionSnapshot {
  const preScan: ProjectionPreScanResult = preScanProjectionEvents(input);
  const structural = reduceMergeAliasState(preScan);
  const validity = reduceClaimValidityState(preScan, structural);
  return Object.freeze({
    statements: validity.statements,
    entities: structural.entities,
    surfaceForms: structural.surfaceForms,
    claims: structural.claims,
    claimSupport: validity.claimSupport,
    idRedirects: structural.idRedirects,
  });
}

/** The single production composition of PRJ-004 through PRJ-008. */
export function projectProjectionSnapshot(value: unknown): ProjectionSnapshot {
  return runProjectionReplayReducer(value, assembleProjectionSnapshot);
}

export function planProjectionDispatch(value: unknown): ProjectionDispatchPlan {
  if (!Array.isArray(value) || value.length === 0) {
    return reject("INVALID_DISPATCH_BATCH");
  }
  let previousSeq = 0;
  for (const rawEvent of value) {
    const source = dataRecord(rawEvent);
    const seq = source["seq"];
    const kind = source["kind"];
    if (
      !Number.isSafeInteger(seq) ||
      Number(seq) <= previousSeq ||
      (kind !== "statement" &&
        kind !== "retraction" &&
        kind !== "merge" &&
        kind !== "alias")
    ) {
      return reject("INVALID_DISPATCH_EVENT");
    }
    previousSeq = Number(seq);
    const event = rawEvent as ProjectionReplayJournalEvent;
    const body = jsonBody(event);
    if (kind === "statement" && Object.hasOwn(body, "supersedes")) {
      return Object.freeze({ mode: "replay", reason: "historical_statement" });
    }
    if (kind === "retraction") {
      const target = body["target"];
      const targetRecord = dataRecord(target);
      if (Object.hasOwn(targetRecord, "event_id")) {
        return Object.freeze({ mode: "replay", reason: "event_retraction" });
      }
      if (!Object.hasOwn(targetRecord, "claim_id")) {
        return reject("INVALID_DISPATCH_EVENT");
      }
    }
  }
  return Object.freeze({ mode: "incremental", reason: "safe_suffix" });
}
