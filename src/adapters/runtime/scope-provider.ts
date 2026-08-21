import type {
  RuntimeScope,
  ScopeProvider,
} from "../../application/ports/runtime-provider.js";

export const RECALL_PROJECT_ID_ENV: "RECALL_PROJECT_ID" =
  "RECALL_PROJECT_ID";
export const RECALL_USER_ID_ENV: "RECALL_USER_ID" = "RECALL_USER_ID";

const SCOPE_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export type ScopeResolutionErrorCode =
  | "DEPLOYMENT_CONFIG_INVALID"
  | "LOCAL_USER_ID_INVALID"
  | "LOCAL_USER_ID_REQUIRED"
  | "PROJECT_ID_INVALID"
  | "PROJECT_ID_REQUIRED"
  | "REMOTE_LOCAL_USER_FORBIDDEN"
  | "REMOTE_PRINCIPAL_INVALID"
  | "REMOTE_PRINCIPAL_REQUIRED";

const ERROR_MESSAGES: Readonly<Record<ScopeResolutionErrorCode, string>> =
  Object.freeze({
    DEPLOYMENT_CONFIG_INVALID: "scope deployment configuration is invalid",
    LOCAL_USER_ID_INVALID: "local user ID does not satisfy the scope contract",
    LOCAL_USER_ID_REQUIRED: "local deployment requires an explicit user ID",
    PROJECT_ID_INVALID: "project ID does not satisfy the scope contract",
    PROJECT_ID_REQUIRED: "scope deployment requires an explicit project ID",
    REMOTE_LOCAL_USER_FORBIDDEN:
      "remote deployment cannot configure a local fallback user",
    REMOTE_PRINCIPAL_INVALID:
      "authenticated principal does not satisfy the scope contract",
    REMOTE_PRINCIPAL_REQUIRED:
      "remote scope resolution requires an authenticated principal",
  });

export class ScopeResolutionError extends Error {
  public override readonly name: string = "ScopeResolutionError";
  public readonly code: ScopeResolutionErrorCode;
  public readonly retryable: false = false;

  public constructor(code: ScopeResolutionErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.code = code;
  }
}

export type ScopeDeploymentEnvironment = Readonly<
  Record<string, string | undefined>
>;

export interface LocalScopeDeploymentConfig {
  readonly mode: "local";
  readonly projectId: string;
  readonly userId: string;
}

export interface RemoteScopeDeploymentConfig {
  readonly mode: "remote";
  readonly projectId: string;
}

/** Created only from the authentication boundary, never from a tool payload. */
export interface AuthenticatedUserPrincipal {
  readonly userId: string;
}

function fail(code: ScopeResolutionErrorCode): never {
  throw new ScopeResolutionError(code);
}

function environmentValue(
  environment: ScopeDeploymentEnvironment,
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

function requiredProjectId(environment: ScopeDeploymentEnvironment): string {
  const value = environmentValue(environment, RECALL_PROJECT_ID_ENV);
  if (value === undefined) {
    return fail("PROJECT_ID_REQUIRED");
  }
  if (!SCOPE_ID_PATTERN.test(value)) {
    return fail("PROJECT_ID_INVALID");
  }
  return value;
}

function requiredLocalUserId(
  environment: ScopeDeploymentEnvironment,
): string {
  const value = environmentValue(environment, RECALL_USER_ID_ENV);
  if (value === undefined) {
    return fail("LOCAL_USER_ID_REQUIRED");
  }
  if (!SCOPE_ID_PATTERN.test(value)) {
    return fail("LOCAL_USER_ID_INVALID");
  }
  return value;
}

function snapshotLocalConfig(
  config: LocalScopeDeploymentConfig,
): LocalScopeDeploymentConfig {
  if (
    config === null ||
    typeof config !== "object" ||
    config.mode !== "local" ||
    typeof config.projectId !== "string" ||
    typeof config.userId !== "string"
  ) {
    return fail("DEPLOYMENT_CONFIG_INVALID");
  }
  if (!SCOPE_ID_PATTERN.test(config.projectId)) {
    return fail("PROJECT_ID_INVALID");
  }
  if (!SCOPE_ID_PATTERN.test(config.userId)) {
    return fail("LOCAL_USER_ID_INVALID");
  }
  return Object.freeze({
    mode: "local",
    projectId: config.projectId,
    userId: config.userId,
  });
}

function snapshotRemoteConfig(
  config: RemoteScopeDeploymentConfig,
): RemoteScopeDeploymentConfig {
  if (
    config === null ||
    typeof config !== "object" ||
    config.mode !== "remote" ||
    typeof config.projectId !== "string" ||
    Object.hasOwn(config, "userId")
  ) {
    return fail("DEPLOYMENT_CONFIG_INVALID");
  }
  if (!SCOPE_ID_PATTERN.test(config.projectId)) {
    return fail("PROJECT_ID_INVALID");
  }
  return Object.freeze({ mode: "remote", projectId: config.projectId });
}

function snapshotPrincipal(
  principal: AuthenticatedUserPrincipal | null | undefined,
): AuthenticatedUserPrincipal {
  if (principal === null || principal === undefined) {
    return fail("REMOTE_PRINCIPAL_REQUIRED");
  }
  if (
    typeof principal !== "object" ||
    Array.isArray(principal) ||
    typeof principal.userId !== "string" ||
    !SCOPE_ID_PATTERN.test(principal.userId)
  ) {
    return fail("REMOTE_PRINCIPAL_INVALID");
  }
  return Object.freeze({ userId: principal.userId });
}

function createFixedScopeProvider(
  userId: string,
  projectId: string,
): ScopeProvider {
  const scope: RuntimeScope = Object.freeze({
    userId,
    projectId,
    scopeKey: `u:${userId}/p:${projectId}`,
  });
  return Object.freeze({
    resolveScope(): RuntimeScope {
      return scope;
    },
  });
}

export function loadLocalScopeDeploymentConfig(
  environment: ScopeDeploymentEnvironment,
): LocalScopeDeploymentConfig {
  return Object.freeze({
    mode: "local",
    projectId: requiredProjectId(environment),
    userId: requiredLocalUserId(environment),
  });
}

export function loadRemoteScopeDeploymentConfig(
  environment: ScopeDeploymentEnvironment,
): RemoteScopeDeploymentConfig {
  const projectId = requiredProjectId(environment);
  if (environmentValue(environment, RECALL_USER_ID_ENV) !== undefined) {
    return fail("REMOTE_LOCAL_USER_FORBIDDEN");
  }
  return Object.freeze({ mode: "remote", projectId });
}

export function createLocalScopeProvider(
  config: LocalScopeDeploymentConfig,
): ScopeProvider {
  const snapshot = snapshotLocalConfig(config);
  return createFixedScopeProvider(snapshot.userId, snapshot.projectId);
}

export function createRemoteScopeProvider(
  config: RemoteScopeDeploymentConfig,
  principal: AuthenticatedUserPrincipal | null | undefined,
): ScopeProvider {
  const configSnapshot = snapshotRemoteConfig(config);
  const principalSnapshot = snapshotPrincipal(principal);
  return createFixedScopeProvider(
    principalSnapshot.userId,
    configSnapshot.projectId,
  );
}
