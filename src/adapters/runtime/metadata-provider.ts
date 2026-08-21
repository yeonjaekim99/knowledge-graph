import { execFile } from "node:child_process";
import { createHmac } from "node:crypto";
import { isAbsolute } from "node:path";

import type {
  JournalMetadata,
  MetadataProvider,
  SessionCorrelationKey,
} from "../../application/ports/runtime-provider.js";

export const RECALL_PROJECT_WORKTREE_ENV: "RECALL_PROJECT_WORKTREE" =
  "RECALL_PROJECT_WORKTREE";
export const RECALL_SESSION_HMAC_KEY_ENV: "RECALL_SESSION_HMAC_KEY" =
  "RECALL_SESSION_HMAC_KEY";

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
const CONTROL_CHARACTER_GLOBAL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/gu;
const SESSION_HMAC_KEY_PATTERN = /^[0-9a-f]{64}$/;
const SESSION_CORRELATION_PATTERN = /^hmac-sha256:[0-9a-f]{64}$/;
const GIT_OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const ACTOR_CODE_POINT_LIMIT = 128;

export type MetadataConfigurationErrorCode =
  | "DEPLOYMENT_CONFIG_INVALID"
  | "METADATA_DEPENDENCIES_INVALID"
  | "PROJECT_WORKTREE_INVALID"
  | "PROJECT_WORKTREE_REQUIRED"
  | "SESSION_HMAC_KEY_INVALID";

const ERROR_MESSAGES: Readonly<Record<MetadataConfigurationErrorCode, string>> =
  Object.freeze({
    DEPLOYMENT_CONFIG_INVALID: "metadata deployment configuration is invalid",
    METADATA_DEPENDENCIES_INVALID:
      "metadata provider dependencies do not satisfy the trusted runtime contract",
    PROJECT_WORKTREE_INVALID:
      "project worktree does not satisfy the deployment contract",
    PROJECT_WORKTREE_REQUIRED:
      "metadata deployment requires an explicit project worktree",
    SESSION_HMAC_KEY_INVALID:
      "session HMAC key must be a canonical 256-bit deployment key",
  });

export class MetadataConfigurationError extends Error {
  public override readonly name: string = "MetadataConfigurationError";
  public readonly code: MetadataConfigurationErrorCode;
  public readonly retryable: false = false;

  public constructor(code: MetadataConfigurationErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.code = code;
  }
}

export type MetadataDeploymentEnvironment = Readonly<
  Record<string, string | undefined>
>;

export interface SessionCorrelationProvider {
  correlateSession(logicalSessionId: unknown): SessionCorrelationKey | null;
}

export interface MetadataDeploymentConfig extends SessionCorrelationProvider {
  readonly projectWorkingDirectory: string;
}

export interface ObservedClientInfo {
  readonly name?: unknown;
}

/** Supplied only from transport/host observation, never from a tool payload. */
export interface TrustedRequestMetadataContext {
  readonly clientInfo?: ObservedClientInfo | null;
  readonly logicalSessionId?: unknown;
}

export type MetadataTextField = "actor" | "branch";

/**
 * REC-002/003 supplies the detector-backed implementation. A hit may return a
 * masked value; an unlocatable hit returns null; thrown failures are isolated
 * to this metadata field by STO-006.
 */
export interface MetadataTextSanitizer {
  sanitize(field: MetadataTextField, value: string): Promise<string | null>;
}

export interface ProjectBranchResolver {
  resolveBranch(projectWorkingDirectory: string): Promise<string | null>;
}

export interface RequestMetadataProviderDependencies {
  readonly sanitizer: MetadataTextSanitizer;
  readonly branchResolver?: ProjectBranchResolver;
}

interface GitCommandResult {
  readonly ok: boolean;
  readonly stdout: string;
}

function fail(code: MetadataConfigurationErrorCode): never {
  throw new MetadataConfigurationError(code);
}

function environmentValue(
  environment: MetadataDeploymentEnvironment,
  key: string,
): string | undefined {
  if (
    environment === null ||
    typeof environment !== "object" ||
    Array.isArray(environment)
  ) {
    return fail("DEPLOYMENT_CONFIG_INVALID");
  }
  const value = environment[key];
  if (value !== undefined && typeof value !== "string") {
    return fail("DEPLOYMENT_CONFIG_INVALID");
  }
  return value;
}

function requiredProjectWorkingDirectory(
  environment: MetadataDeploymentEnvironment,
): string {
  const value = environmentValue(environment, RECALL_PROJECT_WORKTREE_ENV);
  if (value === undefined) {
    return fail("PROJECT_WORKTREE_REQUIRED");
  }
  if (value.length === 0 || !isAbsolute(value) || value.includes("\u0000")) {
    return fail("PROJECT_WORKTREE_INVALID");
  }
  return value;
}

function createSessionCorrelationProvider(
  keyHex: string | undefined,
): SessionCorrelationProvider {
  if (keyHex === undefined) {
    return Object.freeze({
      correlateSession(): null {
        return null;
      },
    });
  }
  if (!SESSION_HMAC_KEY_PATTERN.test(keyHex)) {
    return fail("SESSION_HMAC_KEY_INVALID");
  }

  const key = Uint8Array.from(Buffer.from(keyHex, "hex"));
  return Object.freeze({
    correlateSession(logicalSessionId: unknown): SessionCorrelationKey | null {
      if (typeof logicalSessionId !== "string" || logicalSessionId.length === 0) {
        return null;
      }
      const digest = createHmac("sha256", key)
        .update(logicalSessionId, "utf8")
        .digest("hex");
      return `hmac-sha256:${digest}`;
    },
  });
}

function snapshotDeploymentConfig(
  config: MetadataDeploymentConfig,
): {
  readonly projectWorkingDirectory: string;
  readonly correlateSession: SessionCorrelationProvider["correlateSession"];
} {
  if (
    config === null ||
    typeof config !== "object" ||
    Array.isArray(config) ||
    typeof config.projectWorkingDirectory !== "string" ||
    config.projectWorkingDirectory.length === 0 ||
    !isAbsolute(config.projectWorkingDirectory) ||
    config.projectWorkingDirectory.includes("\u0000") ||
    typeof config.correlateSession !== "function"
  ) {
    return fail("DEPLOYMENT_CONFIG_INVALID");
  }
  return Object.freeze({
    projectWorkingDirectory: config.projectWorkingDirectory,
    correlateSession: config.correlateSession.bind(config),
  });
}

function snapshotDependencies(
  dependencies: RequestMetadataProviderDependencies,
): {
  readonly sanitize: MetadataTextSanitizer["sanitize"];
  readonly resolveBranch: ProjectBranchResolver["resolveBranch"];
} {
  if (
    dependencies === null ||
    typeof dependencies !== "object" ||
    Array.isArray(dependencies) ||
    dependencies.sanitizer === null ||
    typeof dependencies.sanitizer !== "object" ||
    typeof dependencies.sanitizer.sanitize !== "function"
  ) {
    return fail("METADATA_DEPENDENCIES_INVALID");
  }
  const branchResolver =
    dependencies.branchResolver ?? gitProjectBranchResolver;
  if (
    branchResolver === null ||
    typeof branchResolver !== "object" ||
    typeof branchResolver.resolveBranch !== "function"
  ) {
    return fail("METADATA_DEPENDENCIES_INVALID");
  }
  return Object.freeze({
    sanitize: dependencies.sanitizer.sanitize.bind(dependencies.sanitizer),
    resolveBranch: branchResolver.resolveBranch.bind(branchResolver),
  });
}

function safeProperty(value: unknown, key: string): unknown {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }
    return (value as Readonly<Record<string, unknown>>)[key];
  } catch {
    return undefined;
  }
}

function observedActor(context: TrustedRequestMetadataContext): string | null {
  const clientInfo = safeProperty(context, "clientInfo");
  const name = safeProperty(clientInfo, "name");
  if (typeof name !== "string") {
    return null;
  }
  const withoutControls = name.replace(CONTROL_CHARACTER_GLOBAL_PATTERN, "");
  const normalized = Array.from(withoutControls)
    .slice(0, ACTOR_CODE_POINT_LIMIT)
    .join("");
  return normalized.length === 0 ? null : normalized;
}

function observedLogicalSessionId(
  context: TrustedRequestMetadataContext,
): unknown {
  return safeProperty(context, "logicalSessionId");
}

function normalizedBranch(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    return null;
  }
  return value;
}

function normalizedSanitizerResult(
  field: MetadataTextField,
  value: unknown,
): string | null {
  if (typeof value !== "string") {
    return null;
  }
  if (field === "actor") {
    const withoutControls = value.replace(CONTROL_CHARACTER_GLOBAL_PATTERN, "");
    const normalized = Array.from(withoutControls)
      .slice(0, ACTOR_CODE_POINT_LIMIT)
      .join("");
    return normalized.length === 0 ? null : normalized;
  }
  return normalizedBranch(value);
}

async function sanitizedMetadataText(
  field: MetadataTextField,
  value: string | null,
  sanitize: MetadataTextSanitizer["sanitize"],
): Promise<string | null> {
  if (value === null) {
    return null;
  }
  try {
    return normalizedSanitizerResult(field, await sanitize(field, value));
  } catch {
    return null;
  }
}

function parseSingleGitLine(stdout: string): string | null {
  const withoutTerminator = stdout.endsWith("\r\n")
    ? stdout.slice(0, -2)
    : stdout.endsWith("\n")
      ? stdout.slice(0, -1)
      : stdout;
  if (
    withoutTerminator.length === 0 ||
    withoutTerminator.includes("\n") ||
    withoutTerminator.includes("\r")
  ) {
    return null;
  }
  return withoutTerminator;
}

function runGitCommand(
  projectWorkingDirectory: string,
  args: readonly string[],
): Promise<GitCommandResult> {
  return new Promise((resolve) => {
    execFile(
      "git",
      [...args],
      {
        cwd: projectWorkingDirectory,
        encoding: "utf8",
        maxBuffer: 8_192,
        timeout: 5_000,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error !== null || typeof stdout !== "string") {
          resolve(Object.freeze({ ok: false, stdout: "" }));
          return;
        }
        resolve(Object.freeze({ ok: true, stdout }));
      },
    );
  });
}

export const gitProjectBranchResolver: ProjectBranchResolver = Object.freeze({
  async resolveBranch(
    projectWorkingDirectory: string,
  ): Promise<string | null> {
    const symbolic = await runGitCommand(projectWorkingDirectory, [
      "symbolic-ref",
      "--quiet",
      "--short",
      "HEAD",
    ]);
    if (symbolic.ok) {
      return normalizedBranch(parseSingleGitLine(symbolic.stdout));
    }

    const detached = await runGitCommand(projectWorkingDirectory, [
      "rev-parse",
      "--verify",
      "HEAD",
    ]);
    if (!detached.ok) {
      return null;
    }
    const objectId = parseSingleGitLine(detached.stdout);
    return objectId !== null && GIT_OBJECT_ID_PATTERN.test(objectId)
      ? `detached:${objectId}`
      : null;
  },
});

export function loadMetadataDeploymentConfig(
  environment: MetadataDeploymentEnvironment,
): MetadataDeploymentConfig {
  const projectWorkingDirectory = requiredProjectWorkingDirectory(environment);
  const sessionCorrelation = createSessionCorrelationProvider(
    environmentValue(environment, RECALL_SESSION_HMAC_KEY_ENV),
  );
  return Object.freeze({
    projectWorkingDirectory,
    correlateSession(
      logicalSessionId: unknown,
    ): SessionCorrelationKey | null {
      return sessionCorrelation.correlateSession(logicalSessionId);
    },
  });
}

export function createRequestMetadataProvider(
  config: MetadataDeploymentConfig,
  context: TrustedRequestMetadataContext,
  dependencies: RequestMetadataProviderDependencies,
): MetadataProvider {
  const configSnapshot = snapshotDeploymentConfig(config);
  const dependencySnapshot = snapshotDependencies(dependencies);
  const actor = observedActor(context);
  const logicalSessionId = observedLogicalSessionId(context);
  let session: SessionCorrelationKey | null = null;
  try {
    const candidate = configSnapshot.correlateSession(logicalSessionId);
    session =
      candidate !== null && SESSION_CORRELATION_PATTERN.test(candidate)
        ? candidate
        : null;
  } catch {
    session = null;
  }

  let snapshot: Promise<JournalMetadata> | undefined;
  return Object.freeze({
    resolveMetadata(): Promise<JournalMetadata> {
      snapshot ??= (async (): Promise<JournalMetadata> => {
        const actorResult = sanitizedMetadataText(
          "actor",
          actor,
          dependencySnapshot.sanitize,
        );
        let branch: string | null = null;
        try {
          branch = normalizedBranch(
            await dependencySnapshot.resolveBranch(
              configSnapshot.projectWorkingDirectory,
            ),
          );
        } catch {
          branch = null;
        }
        const branchResult = sanitizedMetadataText(
          "branch",
          branch,
          dependencySnapshot.sanitize,
        );
        return Object.freeze({
          actor: await actorResult,
          branch: await branchResult,
          session,
        });
      })();
      return snapshot;
    },
  });
}
