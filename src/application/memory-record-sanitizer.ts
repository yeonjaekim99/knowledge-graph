import {
  SECRET_DETECTOR_VERSION,
  SECRET_SIGNATURE_REGISTRY,
  detectSecrets,
} from "../domain/index.js";
import type {
  SecretClass,
  SecretDetectionResult,
  SecretFieldContext,
  SecretFinding,
} from "../domain/index.js";
import type {
  ClaimDraft,
  MemoryRecordInput,
} from "./memory-record-contract.js";

export type RecordSecretDetection = (
  value: string,
  context: SecretFieldContext,
) => SecretDetectionResult;

export interface ApprovedRecordDraft {
  readonly inputIndex: number;
  readonly draft: ClaimDraft;
}

export interface RejectedRecordClaim {
  readonly index: number;
  readonly status: "rejected";
  readonly note: string;
}

export interface RecordSecretSanitizationResult {
  readonly maskedRawText: string;
  readonly approvedDrafts: readonly ApprovedRecordDraft[];
  readonly rejectedClaims: readonly RejectedRecordClaim[];
}

export type RecordSecretSanitizationErrorCode =
  | "DETECTOR_FAILED"
  | "REINTERPRET_DRAFT_REJECTED";

const ERROR_MESSAGES: Readonly<
  Record<RecordSecretSanitizationErrorCode, string>
> = Object.freeze({
  DETECTOR_FAILED:
    "record secret detection could not establish a safe result",
  REINTERPRET_DRAFT_REJECTED:
    "reinterpretation requires every submitted draft to pass secret detection",
});

export class RecordSecretSanitizationError extends Error {
  public override readonly name: string = "RecordSecretSanitizationError";
  public readonly code: RecordSecretSanitizationErrorCode;
  public readonly rejections: readonly RejectedRecordClaim[];

  public constructor(
    code: RecordSecretSanitizationErrorCode,
    rejections: readonly RejectedRecordClaim[] = [],
  ) {
    super(ERROR_MESSAGES[code]);
    this.code = code;
    this.rejections = freezeRejections(rejections);
  }
}

interface CheckedDetection {
  readonly findings: readonly SecretFinding[];
  readonly positionsAreSafe: boolean;
}

interface DraftField {
  readonly path: string;
  readonly value: string;
  readonly context: SecretFieldContext;
}

interface DraftSecretIssue {
  readonly path: string;
  readonly secretClass: SecretClass | "secret";
}

const SECRET_CLASS_SET: ReadonlySet<string> = new Set([
  ...SECRET_SIGNATURE_REGISTRY.map(({ secretClass }) => secretClass),
  "high-entropy",
]);
const MAX_DETECTOR_FINDINGS = 32_768;

function exactOwnKeys(value: object, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === expected.length &&
    expected.every((key) => keys.includes(key))
  );
}

function ownEnumerableDataValue(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (
    descriptor === undefined ||
    descriptor.enumerable !== true ||
    !("value" in descriptor)
  ) {
    throw new RecordSecretSanitizationError("DETECTOR_FAILED");
  }
  return descriptor.value;
}

function snapshotFindingCandidates(
  findings: unknown[],
): readonly unknown[] {
  const lengthDescriptor = Object.getOwnPropertyDescriptor(findings, "length");
  if (
    lengthDescriptor === undefined ||
    !("value" in lengthDescriptor) ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0 ||
    lengthDescriptor.value > MAX_DETECTOR_FINDINGS
  ) {
    throw new RecordSecretSanitizationError("DETECTOR_FAILED");
  }
  const length = lengthDescriptor.value as number;
  const keys = Reflect.ownKeys(findings);
  const keySet: ReadonlySet<PropertyKey> = new Set(keys);
  if (keys.length !== length + 1 || !keySet.has("length")) {
    throw new RecordSecretSanitizationError("DETECTOR_FAILED");
  }
  const candidates: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const key = String(index);
    if (!keySet.has(key)) {
      throw new RecordSecretSanitizationError("DETECTOR_FAILED");
    }
    candidates.push(ownEnumerableDataValue(findings, key));
  }
  return candidates;
}

function isCodePointBoundary(value: string, offset: number): boolean {
  if (offset <= 0 || offset >= value.length) {
    return true;
  }
  const previous = value.charCodeAt(offset - 1);
  const current = value.charCodeAt(offset);
  return !(
    previous >= 0xd800 &&
    previous <= 0xdbff &&
    current >= 0xdc00 &&
    current <= 0xdfff
  );
}

function checkDetectionResult(
  value: string,
  result: unknown,
): CheckedDetection {
  if (
    result === null ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    !exactOwnKeys(result, ["registryVersion", "findings"])
  ) {
    throw new RecordSecretSanitizationError("DETECTOR_FAILED");
  }
  const registryVersion = ownEnumerableDataValue(result, "registryVersion");
  const findingsValue = ownEnumerableDataValue(result, "findings");
  if (
    registryVersion !== SECRET_DETECTOR_VERSION ||
    !Array.isArray(findingsValue)
  ) {
    throw new RecordSecretSanitizationError("DETECTOR_FAILED");
  }

  const findings: SecretFinding[] = [];
  let positionsAreSafe = true;
  let previousEnd = 0;
  for (const candidate of snapshotFindingCandidates(findingsValue)) {
    if (
      candidate === null ||
      typeof candidate !== "object" ||
      Array.isArray(candidate) ||
      !exactOwnKeys(candidate, [
        "secretClass",
        "startCodeUnit",
        "endCodeUnit",
      ])
    ) {
      throw new RecordSecretSanitizationError("DETECTOR_FAILED");
    }
    const secretClass = ownEnumerableDataValue(candidate, "secretClass");
    const startValue = ownEnumerableDataValue(candidate, "startCodeUnit");
    const endValue = ownEnumerableDataValue(candidate, "endCodeUnit");
    if (
      typeof secretClass !== "string" ||
      !SECRET_CLASS_SET.has(secretClass) ||
      typeof startValue !== "number" ||
      typeof endValue !== "number"
    ) {
      throw new RecordSecretSanitizationError("DETECTOR_FAILED");
    }
    const startCodeUnit = startValue;
    const endCodeUnit = endValue;
    const positionIsSafe =
      Number.isSafeInteger(startCodeUnit) &&
      Number.isSafeInteger(endCodeUnit) &&
      startCodeUnit >= 0 &&
      endCodeUnit > startCodeUnit &&
      endCodeUnit <= value.length &&
      startCodeUnit >= previousEnd &&
      isCodePointBoundary(value, startCodeUnit) &&
      isCodePointBoundary(value, endCodeUnit);
    positionsAreSafe &&= positionIsSafe;
    if (positionIsSafe) {
      previousEnd = endCodeUnit;
    }
    findings.push({
      secretClass: secretClass as SecretClass,
      startCodeUnit,
      endCodeUnit,
    });
  }
  return {
    findings,
    positionsAreSafe,
  };
}

function runDetector(
  detect: RecordSecretDetection,
  value: string,
  context: SecretFieldContext,
): CheckedDetection {
  try {
    return checkDetectionResult(value, detect(value, context));
  } catch {
    throw new RecordSecretSanitizationError("DETECTOR_FAILED");
  }
}

function maskRawText(
  rawText: string,
  detection: CheckedDetection,
): string {
  if (!detection.positionsAreSafe) {
    return "[REDACTED:SECRET]";
  }
  let masked = rawText;
  for (let index = detection.findings.length - 1; index >= 0; index -= 1) {
    const finding = detection.findings[index];
    if (finding === undefined) {
      throw new RecordSecretSanitizationError("DETECTOR_FAILED");
    }
    const replacement = `[REDACTED:${finding.secretClass.toUpperCase()}]`;
    masked =
      masked.slice(0, finding.startCodeUnit) +
      replacement +
      masked.slice(finding.endCodeUnit);
  }
  return masked;
}

function draftFields(draft: ClaimDraft, index: number): readonly DraftField[] {
  const prefix = `claims[${index}]`;
  const fields: DraftField[] = [
    {
      path: `${prefix}.subject`,
      value: draft.subject,
      context: "claim.subject",
    },
  ];
  if (draft.subject_kind !== undefined) {
    fields.push({
      path: `${prefix}.subject_kind`,
      value: draft.subject_kind,
      context: "claim.subject_kind",
    });
  }
  if ("object" in draft) {
    fields.push({
      path: `${prefix}.object`,
      value: draft.object,
      context: "claim.object",
    });
    if (draft.object_kind !== undefined) {
      fields.push({
        path: `${prefix}.object_kind`,
        value: draft.object_kind,
        context: "claim.object_kind",
      });
    }
  } else {
    fields.push({
      path: `${prefix}.object_value`,
      value: draft.object_value,
      context: "claim.object_value",
    });
  }
  if (draft.relation_label !== undefined) {
    fields.push({
      path: `${prefix}.relation_label`,
      value: draft.relation_label,
      context: "claim.relation_label",
    });
  }
  for (const [aliasIndex, alias] of (draft.subject_aliases ?? []).entries()) {
    fields.push({
      path: `${prefix}.subject_aliases[${aliasIndex}]`,
      value: alias,
      context: "claim.subject_alias",
    });
  }
  if ("object" in draft) {
    for (const [aliasIndex, alias] of (draft.object_aliases ?? []).entries()) {
      fields.push({
        path: `${prefix}.object_aliases[${aliasIndex}]`,
        value: alias,
        context: "claim.object_alias",
      });
    }
  }
  return fields;
}

function cloneDraft(draft: ClaimDraft): ClaimDraft {
  const common = {
    subject: draft.subject,
    relation: draft.relation,
    ...(draft.subject_kind === undefined
      ? {}
      : { subject_kind: draft.subject_kind }),
    ...(draft.relation_label === undefined
      ? {}
      : { relation_label: draft.relation_label }),
    ...(draft.subject_aliases === undefined
      ? {}
      : { subject_aliases: Object.freeze([...draft.subject_aliases]) }),
  };
  const cloned =
    "object" in draft
      ? {
          ...common,
          object: draft.object,
          ...(draft.object_kind === undefined
            ? {}
            : { object_kind: draft.object_kind }),
          ...(draft.object_aliases === undefined
            ? {}
            : { object_aliases: Object.freeze([...draft.object_aliases]) }),
        }
      : {
          ...common,
          object_value: draft.object_value,
        };
  return Object.freeze(cloned) as ClaimDraft;
}

function rejectionNote(issue: DraftSecretIssue): string {
  return `Secret detected at ${issue.path} (class=${issue.secretClass}); remove the secret and retry.`;
}

function freezeRejections(
  rejections: readonly RejectedRecordClaim[],
): readonly RejectedRecordClaim[] {
  return Object.freeze(
    rejections.map((rejection) =>
      Object.freeze({
        index: rejection.index,
        status: "rejected" as const,
        note: rejection.note,
      }),
    ),
  );
}

function detectDraftIssue(
  draft: ClaimDraft,
  index: number,
  detect: RecordSecretDetection,
): DraftSecretIssue | undefined {
  let firstIssue: DraftSecretIssue | undefined;
  for (const field of draftFields(draft, index)) {
    const detection = runDetector(detect, field.value, field.context);
    if (firstIssue !== undefined || detection.findings.length === 0) {
      continue;
    }
    firstIssue = {
      path: field.path,
      secretClass: detection.positionsAreSafe
        ? (detection.findings[0]?.secretClass ?? "secret")
        : "secret",
    };
  }
  return firstIssue;
}

export function sanitizeMemoryRecordSecrets(
  input: MemoryRecordInput,
  detect: RecordSecretDetection = detectSecrets,
): RecordSecretSanitizationResult {
  const rawText = input.raw_text;
  const reinterpretation = "supersedes" in input;
  const submittedDrafts: readonly ClaimDraft[] = Object.freeze(
    input.claims.map((draft) => cloneDraft(draft)),
  );
  const rawDetection = runDetector(detect, rawText, "raw_text");
  const maskedRawText = maskRawText(rawText, rawDetection);
  const approvedDrafts: ApprovedRecordDraft[] = [];
  const rejectedClaims: RejectedRecordClaim[] = [];

  for (const [inputIndex, draft] of submittedDrafts.entries()) {
    const issue = detectDraftIssue(draft, inputIndex, detect);
    if (issue === undefined) {
      approvedDrafts.push(
        Object.freeze({
          inputIndex,
          draft,
        }),
      );
      continue;
    }
    rejectedClaims.push(
      Object.freeze({
        index: inputIndex,
        status: "rejected",
        note: rejectionNote(issue),
      }),
    );
  }

  const frozenRejections = freezeRejections(rejectedClaims);
  if (reinterpretation && frozenRejections.length > 0) {
    throw new RecordSecretSanitizationError(
      "REINTERPRET_DRAFT_REJECTED",
      frozenRejections,
    );
  }
  return Object.freeze({
    maskedRawText,
    approvedDrafts: Object.freeze(approvedDrafts),
    rejectedClaims: frozenRejections,
  });
}
