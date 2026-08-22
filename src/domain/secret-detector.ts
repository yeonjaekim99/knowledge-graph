export const SECRET_DETECTOR_VERSION = "secret-detector-v1" as const;

export type SecretClass =
  | "aws-access-key"
  | "aws-secret-access-key"
  | "github-token"
  | "gitlab-token"
  | "google-api-key"
  | "slack-token"
  | "stripe-secret-key"
  | "jwt"
  | "private-key"
  | "credential-url"
  | "secret-assignment"
  | "high-entropy";

export type SecretFieldContext =
  | "raw_text"
  | "claim.subject"
  | "claim.subject_kind"
  | "claim.object"
  | "claim.object_kind"
  | "claim.object_value"
  | "claim.relation_label"
  | "claim.subject_alias"
  | "claim.object_alias"
  | "revise.note"
  | "revise.alias_surface"
  | "metadata.actor"
  | "metadata.branch"
  | "target.event_id"
  | "target.entity_id"
  | "target.claim_id"
  | "reference.commit_sha"
  | "reference.hash"
  | "reference.checksum"
  | "reference.build_id"
  | "trusted.local_git_object";

const STORABLE_SECRET_FIELD_CONTEXT_VALUES: readonly SecretFieldContext[] = [
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
];

export const STORABLE_SECRET_FIELD_CONTEXTS: readonly SecretFieldContext[] =
  Object.freeze(STORABLE_SECRET_FIELD_CONTEXT_VALUES.slice());

const SECRET_FIELD_CONTEXT_VALUES: readonly SecretFieldContext[] = [
  ...STORABLE_SECRET_FIELD_CONTEXT_VALUES,
  "target.event_id",
  "target.entity_id",
  "target.claim_id",
  "reference.commit_sha",
  "reference.hash",
  "reference.checksum",
  "reference.build_id",
  "trusted.local_git_object",
];
const SECRET_FIELD_CONTEXT_SET: ReadonlySet<string> = new Set(
  SECRET_FIELD_CONTEXT_VALUES,
);

type SecretPatternFlags = "u" | "iu";

export interface SecretSignatureDefinition {
  readonly id: string;
  readonly secretClass: Exclude<SecretClass, "high-entropy">;
  readonly patternSource: string;
  readonly flags: SecretPatternFlags;
}

function signature(
  id: string,
  secretClass: Exclude<SecretClass, "high-entropy">,
  patternSource: string,
  flags: SecretPatternFlags = "u",
): SecretSignatureDefinition {
  return Object.freeze({ id, secretClass, patternSource, flags });
}

const SECRET_ASSIGNMENT_KEY_PATTERN_SOURCE =
  "[A-Za-z0-9_.-]*(?:password|passwd|pwd|secret(?:[_-]?(?:access[_-]?)?(?:key|token))?|api[_-]?key|access[_-]?token|auth[_-]?token)";
const SECRET_ASSIGNMENT_KEY_BOUNDARY =
  "(?<![\\p{L}\\p{N}\\p{M}_.-])";
const DOUBLE_QUOTED_SECRET_VALUE_PATTERN_SOURCE =
  '"(?:\\\\.|[^"\\\\\\r\\n]){1,512}"';
const SINGLE_QUOTED_SECRET_VALUE_PATTERN_SOURCE =
  "'(?:\\\\.|[^'\\\\\\r\\n]){1,512}'";

const ADJACENT_MARKER_WRAPPER_SUFFIX =
  "(?:[,;:.'\"`()\\[\\]{}<>]\\s*)*$";
const ADJACENT_MARKER_BOUNDARY = "(?<![\\p{L}\\p{N}\\p{M}_-])";
const ADJACENT_MARKER_DELIMITER =
  "(?:\\s+(?:[:=#]\\s*)?|[:=#]\\s*)";

/**
 * Pattern sources are data so registry changes remain reviewable. Provider
 * boundaries deliberately describe ASCII token alphabets instead of using
 * Unicode word-boundary semantics.
 */
export const SECRET_SIGNATURE_REGISTRY: readonly SecretSignatureDefinition[] =
  Object.freeze([
    signature(
      "aws-access-key",
      "aws-access-key",
      "(?<![A-Za-z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Za-z0-9])",
    ),
    signature(
      "aws-secret-access-key",
      "aws-secret-access-key",
      "(?<![A-Za-z0-9_])[\"']?(?:aws_secret_access_key|aws[-_ ]?secret(?:[-_ ]?access)?[-_ ]?key)[\"']?\\s*[:=]\\s*[\"']?[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])",
      "iu",
    ),
    signature(
      "github-fine-grained-token",
      "github-token",
      "(?<![A-Za-z0-9_])github_pat_[A-Za-z0-9_]{20,255}(?![A-Za-z0-9_])",
    ),
    signature(
      "github-legacy-token",
      "github-token",
      "(?<![A-Za-z0-9_])gh[pousr]_[A-Za-z0-9]{20,255}(?![A-Za-z0-9])",
    ),
    signature(
      "gitlab-token",
      "gitlab-token",
      "(?<![A-Za-z0-9_-])glpat-[A-Za-z0-9_-]{20,255}(?![A-Za-z0-9_-])",
    ),
    signature(
      "google-api-key",
      "google-api-key",
      "(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}(?![A-Za-z0-9_-])",
    ),
    signature(
      "slack-token",
      "slack-token",
      "(?<![A-Za-z0-9-])(?:xox[baprs]-[A-Za-z0-9-]{10,255}|xapp-[A-Za-z0-9-]{10,255})(?![A-Za-z0-9-])",
    ),
    signature(
      "stripe-secret-key",
      "stripe-secret-key",
      "(?<![A-Za-z0-9_])(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,255}(?![A-Za-z0-9])",
    ),
    signature(
      "jwt",
      "jwt",
      "(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{2,}\\.[A-Za-z0-9_-]{2,}\\.[A-Za-z0-9_-]*(?![A-Za-z0-9_-])",
    ),
    signature(
      "pem-private-key",
      "private-key",
      "-----BEGIN ((?:(?:RSA|DSA|EC|OPENSSH|ENCRYPTED) PRIVATE KEY|PGP PRIVATE KEY BLOCK|PRIVATE KEY))-----[\\s\\S]*?(?:-----END \\1-----|$)",
    ),
    signature(
      "credential-url",
      "credential-url",
      "(?<![A-Za-z0-9+.-])[A-Za-z][A-Za-z0-9+.-]*://[^\\s:/?#]*:[^\\s/@?#]+@[^\\s,;]+",
      "iu",
    ),
    signature(
      "secret-assignment",
      "secret-assignment",
      SECRET_ASSIGNMENT_KEY_BOUNDARY +
        "[\"']?" +
        SECRET_ASSIGNMENT_KEY_PATTERN_SOURCE +
        "[\"']?\\s*[:=]\\s*(?:" +
        DOUBLE_QUOTED_SECRET_VALUE_PATTERN_SOURCE +
        "|" +
        SINGLE_QUOTED_SECRET_VALUE_PATTERN_SOURCE +
        "|[^\\s,;]{1,512})",
      "iu",
    ),
  ]);

export interface SecretEntropyPolicy {
  readonly minimumCodePoints: number;
  readonly minimumBitsPerCodePoint: number;
  readonly minimumCharacterClasses: number;
  readonly candidatePatternSource: string;
  readonly edgePunctuationPatternSource: string;
}

export const SECRET_ENTROPY_POLICY: SecretEntropyPolicy = Object.freeze({
  minimumCodePoints: 20,
  minimumBitsPerCodePoint: 4,
  minimumCharacterClasses: 2,
  candidatePatternSource: "[^\\p{White_Space}]{20,}",
  edgePunctuationPatternSource: "[,;:.'\"`()\\[\\]{}<>]",
});

export type EntropyAllowlistMode = "context" | "adjacent";

export interface SecretEntropyAllowlistDefinition {
  readonly id: string;
  readonly mode: EntropyAllowlistMode;
  readonly tokenPatternSource: string;
  readonly contexts: readonly SecretFieldContext[];
  readonly adjacentPrefixPatternSource?: string;
}

function allowlist(
  id: string,
  mode: EntropyAllowlistMode,
  tokenPatternSource: string,
  contexts: readonly SecretFieldContext[],
  adjacentPrefixPatternSource?: string,
): SecretEntropyAllowlistDefinition {
  return Object.freeze({
    id,
    mode,
    tokenPatternSource,
    contexts: Object.freeze(contexts.slice()),
    ...(adjacentPrefixPatternSource === undefined
      ? {}
      : { adjacentPrefixPatternSource }),
  });
}

const ADJACENCY_CONTEXTS: readonly SecretFieldContext[] =
  STORABLE_SECRET_FIELD_CONTEXT_VALUES.filter(
    (context) => context !== "metadata.actor" && context !== "metadata.branch",
  );

/**
 * Entropy allowlists never suppress signature findings. `trusted.local_git_object`
 * is a narrow seam: an adapter must verify the object against the configured local
 * repository before selecting that context. This pure detector performs no Git IO.
 */
export const SECRET_ENTROPY_ALLOWLIST_REGISTRY: readonly SecretEntropyAllowlistDefinition[] =
  Object.freeze([
    allowlist(
      "typed-uuid",
      "context",
      "[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[1-8][0-9A-Fa-f]{3}-[89ABab][0-9A-Fa-f]{3}-[0-9A-Fa-f]{12}",
      ["target.event_id", "target.entity_id", "target.claim_id"],
    ),
    allowlist(
      "typed-event-ulid",
      "context",
      "(?:ev_)?[0-7][0-9A-HJKMNP-TV-Z]{25}",
      ["target.event_id"],
    ),
    allowlist(
      "typed-hex-reference",
      "context",
      "[0-9A-Fa-f]{7,64}",
      ["reference.commit_sha", "reference.hash", "reference.checksum"],
    ),
    allowlist(
      "typed-build-identifier",
      "context",
      "(?:bld_|build[-_])(?:[0-7][0-9A-HJKMNP-TV-Z]{25}|[0-9A-Fa-f]{7,64})",
      ["reference.build_id"],
    ),
    allowlist(
      "trusted-local-git-object",
      "context",
      "[0-9A-Fa-f]{7,64}",
      ["trusted.local_git_object"],
    ),
    allowlist(
      "adjacent-commit-sha",
      "adjacent",
      "[0-9A-Fa-f]{7,64}",
      ADJACENCY_CONTEXTS,
      ADJACENT_MARKER_BOUNDARY +
        "(?:commit|sha(?:-?(?:1|224|256|384|512))?)(?:\\s+id)?" +
        ADJACENT_MARKER_DELIMITER +
        ADJACENT_MARKER_WRAPPER_SUFFIX,
    ),
    allowlist(
      "adjacent-checksum-hash",
      "adjacent",
      "[0-9A-Fa-f]{7,64}",
      ADJACENCY_CONTEXTS,
      ADJACENT_MARKER_BOUNDARY +
        "(?:checksum|hash)" +
        ADJACENT_MARKER_DELIMITER +
        ADJACENT_MARKER_WRAPPER_SUFFIX,
    ),
    allowlist(
      "adjacent-build-identifier",
      "adjacent",
      "(?:[0-9A-Fa-f]{7,64}|(?:bld_|build[-_])[0-7][0-9A-HJKMNP-TV-Z]{25})",
      ADJACENCY_CONTEXTS,
      ADJACENT_MARKER_BOUNDARY +
        "build(?:[-_ ]?id)?" +
        ADJACENT_MARKER_DELIMITER +
        ADJACENT_MARKER_WRAPPER_SUFFIX,
    ),
  ]);

export interface SecretFinding {
  readonly secretClass: SecretClass;
  /** Inclusive JavaScript UTF-16 code-unit offset for direct `String#slice`. */
  readonly startCodeUnit: number;
  /** Exclusive JavaScript UTF-16 code-unit offset for direct `String#slice`. */
  readonly endCodeUnit: number;
}

export interface SecretDetectionResult {
  readonly registryVersion: typeof SECRET_DETECTOR_VERSION;
  readonly findings: readonly SecretFinding[];
}

export type SecretDetectorErrorCode =
  | "INVALID_INPUT"
  | "INVALID_CONTEXT"
  | "INVALID_CONFIGURATION"
  | "DETECTION_FAILED";

const SECRET_DETECTOR_ERROR_MESSAGES: Readonly<
  Record<SecretDetectorErrorCode, string>
> = Object.freeze({
  INVALID_INPUT: "secret detection requires a text value",
  INVALID_CONTEXT: "secret detection requires a registered field context",
  INVALID_CONFIGURATION: "secret detector configuration is invalid",
  DETECTION_FAILED: "secret detection could not establish a safe result",
});

export class SecretDetectorError extends Error {
  public override readonly name: string = "SecretDetectorError";
  public readonly code: SecretDetectorErrorCode;

  public constructor(code: SecretDetectorErrorCode) {
    super(SECRET_DETECTOR_ERROR_MESSAGES[code]);
    this.code = code;
  }
}

export interface SecretDetectorDependencies {
  readonly calculateEntropy: (value: string) => number;
}

export interface SecretDetector {
  readonly detect: (
    value: unknown,
    context: unknown,
  ) => SecretDetectionResult;
}

interface RankedFinding extends SecretFinding {
  readonly priority: number;
}

function reject(code: SecretDetectorErrorCode): never {
  throw new SecretDetectorError(code);
}

function checkedText(value: unknown): string {
  if (typeof value !== "string") {
    return reject("INVALID_INPUT");
  }
  return value;
}

function checkedContext(value: unknown): SecretFieldContext {
  if (typeof value !== "string" || !SECRET_FIELD_CONTEXT_SET.has(value)) {
    return reject("INVALID_CONTEXT");
  }
  return value as SecretFieldContext;
}

function freezeResult(findings: readonly SecretFinding[]): SecretDetectionResult {
  return Object.freeze({
    registryVersion: SECRET_DETECTOR_VERSION,
    findings: Object.freeze(
      findings.map((finding) =>
        Object.freeze({
          secretClass: finding.secretClass,
          startCodeUnit: finding.startCodeUnit,
          endCodeUnit: finding.endCodeUnit,
        }),
      ),
    ),
  });
}

function overlaps(left: SecretFinding, right: SecretFinding): boolean {
  return (
    left.startCodeUnit < right.endCodeUnit &&
    right.startCodeUnit < left.endCodeUnit
  );
}

function patternFlags(flags: SecretPatternFlags): string {
  return flags === "iu" ? "giu" : "gu";
}

function mergeRankedFinding(
  selected: RankedFinding[],
  candidate: RankedFinding,
): void {
  const overlappingIndexes: number[] = [];
  for (let index = 0; index < selected.length; index += 1) {
    const existing = selected[index];
    if (existing !== undefined && overlaps(existing, candidate)) {
      overlappingIndexes.push(index);
    }
  }
  if (overlappingIndexes.length === 0) {
    selected.push(candidate);
    return;
  }

  const overlapping = overlappingIndexes.map((index) => {
    const existing = selected[index];
    if (existing === undefined) {
      throw new Error("unreachable selected detector position");
    }
    return existing;
  });
  const winner = [candidate, ...overlapping].sort(
    (left, right) =>
      left.priority - right.priority ||
      left.startCodeUnit - right.startCodeUnit ||
      left.endCodeUnit - right.endCodeUnit,
  )[0];
  if (winner === undefined) {
    throw new Error("overlapping detector findings have no deterministic winner");
  }
  const mergedStart = Math.min(
    candidate.startCodeUnit,
    ...overlapping.map(({ startCodeUnit }) => startCodeUnit),
  );
  const mergedEnd = Math.max(
    candidate.endCodeUnit,
    ...overlapping.map(({ endCodeUnit }) => endCodeUnit),
  );
  for (const index of overlappingIndexes.sort((left, right) => right - left)) {
    selected.splice(index, 1);
  }
  selected.push({
    secretClass: winner.secretClass,
    startCodeUnit: mergedStart,
    endCodeUnit: mergedEnd,
    priority: winner.priority,
  });
}

function scanPatterns(value: string): readonly SecretFinding[] {
  const candidates: RankedFinding[] = [];
  for (let priority = 0; priority < SECRET_SIGNATURE_REGISTRY.length; priority += 1) {
    const definition = SECRET_SIGNATURE_REGISTRY[priority];
    if (definition === undefined) {
      throw new Error("unreachable signature registry position");
    }
    const pattern = new RegExp(
      definition.patternSource,
      patternFlags(definition.flags),
    );
    for (const match of value.matchAll(pattern)) {
      if (match.index === undefined || match[0].length === 0) {
        throw new Error("signature registry produced an unsafe match");
      }
      candidates.push({
        secretClass: definition.secretClass,
        startCodeUnit: match.index,
        endCodeUnit: match.index + match[0].length,
        priority,
      });
    }
  }

  const selected: RankedFinding[] = [];
  for (const candidate of candidates.sort(
    (left, right) =>
      left.priority - right.priority ||
      left.startCodeUnit - right.startCodeUnit ||
      left.endCodeUnit - right.endCodeUnit,
  )) {
    mergeRankedFinding(selected, candidate);
  }
  return selected
    .sort(
      (left, right) =>
        left.startCodeUnit - right.startCodeUnit ||
        left.endCodeUnit - right.endCodeUnit ||
        left.priority - right.priority,
    )
    .map(({ secretClass, startCodeUnit, endCodeUnit }) => ({
      secretClass,
      startCodeUnit,
      endCodeUnit,
    }));
}

function shannonEntropy(value: string): number {
  const codePoints = Array.from(value);
  if (codePoints.length === 0) {
    return 0;
  }
  const frequencies = new Map<string, number>();
  for (const codePoint of codePoints) {
    frequencies.set(codePoint, (frequencies.get(codePoint) ?? 0) + 1);
  }
  let entropy = 0;
  for (const frequency of frequencies.values()) {
    const probability = frequency / codePoints.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function characterClassCount(value: string): number {
  return [
    /\p{Lu}/u,
    /\p{Ll}/u,
    /\p{N}/u,
    /[\p{P}\p{S}]/u,
  ].reduce((count, pattern) => count + Number(pattern.test(value)), 0);
}

function contextMatches(
  contexts: readonly SecretFieldContext[],
  context: SecretFieldContext,
): boolean {
  return contexts.includes(context);
}

function entropyCandidateIsAllowlisted(
  wholeValue: string,
  token: string,
  startCodeUnit: number,
  context: SecretFieldContext,
): boolean {
  for (const definition of SECRET_ENTROPY_ALLOWLIST_REGISTRY) {
    if (!contextMatches(definition.contexts, context)) {
      continue;
    }
    if (definition.mode === "context") {
      const tokenPattern = new RegExp(
        `^(?:${definition.tokenPatternSource})$`,
        "u",
      );
      if (tokenPattern.test(token)) {
        return true;
      }
      continue;
    }
    if (definition.adjacentPrefixPatternSource === undefined) {
      throw new Error("adjacent allowlist entry has no prefix pattern");
    }
    const tokenSuffixPattern = new RegExp(
      `(?:${definition.tokenPatternSource})$`,
      "u",
    );
    const tokenSuffix = tokenSuffixPattern.exec(token);
    if (tokenSuffix === null || tokenSuffix[0].length === 0) {
      continue;
    }
    const markerEndCodeUnit = startCodeUnit + tokenSuffix.index;
    const prefixStart = Math.max(0, markerEndCodeUnit - 96);
    const prefix = wholeValue.slice(prefixStart, markerEndCodeUnit);
    const prefixPattern = new RegExp(
      definition.adjacentPrefixPatternSource,
      "iu",
    );
    if (prefixPattern.test(prefix)) {
      return true;
    }
  }
  return false;
}

interface EntropyCandidate {
  readonly token: string;
  readonly startCodeUnit: number;
}

function trimEntropyCandidateEdges(
  token: string,
  startCodeUnit: number,
): EntropyCandidate | undefined {
  const edgePattern = SECRET_ENTROPY_POLICY.edgePunctuationPatternSource;
  const leading = new RegExp(`^(?:${edgePattern})+`, "u").exec(token);
  const leadingCodeUnits = leading?.[0].length ?? 0;
  const withoutLeading = token.slice(leadingCodeUnits);
  const trailing = new RegExp(`(?:${edgePattern})+$`, "u").exec(withoutLeading);
  const trailingCodeUnits = trailing?.[0].length ?? 0;
  const trimmed = withoutLeading.slice(
    0,
    withoutLeading.length - trailingCodeUnits,
  );
  if (trimmed.length === 0) {
    return undefined;
  }
  return {
    token: trimmed,
    startCodeUnit: startCodeUnit + leadingCodeUnits,
  };
}

function qualifiesAsHighEntropy(
  token: string,
  calculateEntropy: (value: string) => number,
): boolean {
  if (
    Array.from(token).length < SECRET_ENTROPY_POLICY.minimumCodePoints ||
    characterClassCount(token) <
      SECRET_ENTROPY_POLICY.minimumCharacterClasses
  ) {
    return false;
  }
  const entropy = calculateEntropy(token);
  if (!Number.isFinite(entropy) || entropy < 0) {
    throw new Error("entropy calculator returned an invalid score");
  }
  return entropy >= SECRET_ENTROPY_POLICY.minimumBitsPerCodePoint;
}

function scanEntropy(
  value: string,
  context: SecretFieldContext,
  calculateEntropy: (value: string) => number,
): readonly SecretFinding[] {
  const findings: SecretFinding[] = [];
  const candidatePattern = new RegExp(
    SECRET_ENTROPY_POLICY.candidatePatternSource,
    "gu",
  );
  for (const match of value.matchAll(candidatePattern)) {
    const segment = match[0];
    if (match.index === undefined || segment.length === 0) {
      throw new Error("entropy policy produced an unsafe candidate");
    }
    const candidate = trimEntropyCandidateEdges(segment, match.index);
    if (candidate === undefined) {
      continue;
    }
    const { token, startCodeUnit } = candidate;
    if (entropyCandidateIsAllowlisted(value, token, startCodeUnit, context)) {
      continue;
    }
    if (qualifiesAsHighEntropy(token, calculateEntropy)) {
      findings.push({
        secretClass: "high-entropy",
        startCodeUnit,
        endCodeUnit: startCodeUnit + token.length,
      });
      continue;
    }

    const wasTrimmed =
      startCodeUnit !== match.index || token.length !== segment.length;
    if (
      wasTrimmed &&
      !entropyCandidateIsAllowlisted(value, segment, match.index, context) &&
      qualifiesAsHighEntropy(segment, calculateEntropy)
    ) {
      findings.push({
        secretClass: "high-entropy",
        startCodeUnit: match.index,
        endCodeUnit: match.index + segment.length,
      });
    }
  }
  return findings;
}

function combineFindings(
  patterns: readonly SecretFinding[],
  entropy: readonly SecretFinding[],
): readonly SecretFinding[] {
  const selected: RankedFinding[] = [];
  patterns.forEach((finding) => {
    mergeRankedFinding(selected, { ...finding, priority: 0 });
  });
  entropy.forEach((finding, index) => {
    mergeRankedFinding(selected, {
      ...finding,
      priority: 1 + index,
    });
  });
  return selected
    .sort(
      (left, right) =>
        left.startCodeUnit - right.startCodeUnit ||
        left.endCodeUnit - right.endCodeUnit ||
        left.priority - right.priority,
    )
    .map(({ secretClass, startCodeUnit, endCodeUnit }) => ({
      secretClass,
      startCodeUnit,
      endCodeUnit,
    }));
}

function checkedEntropyCalculator(
  dependencies: unknown,
): (value: string) => number {
  if (dependencies === undefined) {
    return shannonEntropy;
  }
  if (
    dependencies === null ||
    typeof dependencies !== "object" ||
    Array.isArray(dependencies) ||
    (Object.getPrototypeOf(dependencies) !== Object.prototype &&
      Object.getPrototypeOf(dependencies) !== null)
  ) {
    return reject("INVALID_CONFIGURATION");
  }
  const keys = Reflect.ownKeys(dependencies);
  if (
    keys.length !== 1 ||
    keys[0] !== "calculateEntropy"
  ) {
    return reject("INVALID_CONFIGURATION");
  }
  const descriptor = Object.getOwnPropertyDescriptor(
    dependencies,
    "calculateEntropy",
  );
  if (
    descriptor === undefined ||
    descriptor.enumerable !== true ||
    !("value" in descriptor) ||
    typeof descriptor.value !== "function"
  ) {
    return reject("INVALID_CONFIGURATION");
  }
  return descriptor.value as (value: string) => number;
}

export function createSecretDetector(
  dependencies: unknown = undefined,
): SecretDetector {
  let calculateEntropy: (value: string) => number;
  try {
    calculateEntropy = checkedEntropyCalculator(dependencies);
  } catch (error: unknown) {
    if (error instanceof SecretDetectorError) {
      throw error;
    }
    return reject("INVALID_CONFIGURATION");
  }

  return Object.freeze({
    detect(value: unknown, contextValue: unknown): SecretDetectionResult {
      const text = checkedText(value);
      const context = checkedContext(contextValue);
      try {
        const patterns = scanPatterns(text);
        const entropy = scanEntropy(text, context, calculateEntropy);
        return freezeResult(combineFindings(patterns, entropy));
      } catch {
        return reject("DETECTION_FAILED");
      }
    },
  });
}

const DEFAULT_SECRET_DETECTOR: SecretDetector = createSecretDetector();

export function detectSecretPatterns(value: unknown): SecretDetectionResult {
  const text = checkedText(value);
  try {
    return freezeResult(scanPatterns(text));
  } catch {
    return reject("DETECTION_FAILED");
  }
}

export function detectSecretEntropy(
  value: unknown,
  contextValue: unknown,
): SecretDetectionResult {
  const text = checkedText(value);
  const context = checkedContext(contextValue);
  try {
    return freezeResult(scanEntropy(text, context, shannonEntropy));
  } catch {
    return reject("DETECTION_FAILED");
  }
}

export function detectSecrets(
  value: unknown,
  context: unknown,
): SecretDetectionResult {
  return DEFAULT_SECRET_DETECTOR.detect(value, context);
}
