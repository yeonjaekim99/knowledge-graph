import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { createHmac, randomBytes as nodeRandomBytes } from "node:crypto";

import { createRuntimeProvider } from "../../application/runtime-context.js";
import type {
  ApprovalTokenProvider,
  BranchProvider,
  EventId,
  EventIdProvider,
  JournalMetadata,
  MetadataProvider,
  RandomBytesProvider,
  ReinterpretApprovalToken,
  RulesVersionProvider,
  RuntimeClock,
  RuntimeProvider,
  RuntimeScope,
  ScopeProvider,
  SessionCorrelationKey,
} from "../../application/ports/runtime-provider.js";

const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const MAX_ULID_TIMESTAMP = 0xffff_ffff_ffff;
const SCOPE_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/gu;
const RULES_CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;

export class RuntimeConfigurationError extends Error {
  public override readonly name: string = "RuntimeConfigurationError";

  public constructor(message: string) {
    super(message);
  }
}

export const systemRuntimeClock: RuntimeClock = Object.freeze({
  nowMilliseconds(): number {
    return Date.now();
  },
});

export const cryptographicRandomBytes: RandomBytesProvider = Object.freeze({
  randomBytes(length: number): Uint8Array {
    if (!Number.isSafeInteger(length) || length <= 0) {
      throw new RuntimeConfigurationError(
        "random byte length must be a positive safe integer",
      );
    }
    return Uint8Array.from(nodeRandomBytes(length));
  },
});

function requireExactRandomBytes(
  random: RandomBytesProvider,
  length: number,
): Uint8Array {
  const bytes = random.randomBytes(length);
  if (bytes.byteLength !== length) {
    throw new RuntimeConfigurationError(
      `random provider returned ${bytes.byteLength} bytes; expected ${length}`,
    );
  }
  return Uint8Array.from(bytes);
}

function encodeCrockfordBase32(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }

  const encoded = new Array<string>(26);
  for (let index = encoded.length - 1; index >= 0; index -= 1) {
    encoded[index] = CROCKFORD_BASE32.charAt(Number(value & 31n));
    value >>= 5n;
  }
  return encoded.join("");
}

export function createUlidEventIdProvider(
  clock: RuntimeClock,
  random: RandomBytesProvider,
): EventIdProvider {
  return Object.freeze({
    nextEventId(): EventId {
      const timestamp = clock.nowMilliseconds();
      if (
        !Number.isSafeInteger(timestamp) ||
        timestamp < 0 ||
        timestamp > MAX_ULID_TIMESTAMP
      ) {
        throw new RuntimeConfigurationError(
          "ULID clock must return an integer between 0 and 2^48-1 milliseconds",
        );
      }

      const bytes = new Uint8Array(16);
      let remaining = timestamp;
      for (let index = 5; index >= 0; index -= 1) {
        bytes[index] = remaining % 256;
        remaining = Math.floor(remaining / 256);
      }
      bytes.set(requireExactRandomBytes(random, 10), 6);

      return `ev_${encodeCrockfordBase32(bytes)}`;
    },
  });
}

export function createApprovalTokenProvider(
  random: RandomBytesProvider,
): ApprovalTokenProvider {
  return Object.freeze({
    nextApprovalToken(): ReinterpretApprovalToken {
      const payload = requireExactRandomBytes(random, 32);
      return `ra_${Buffer.from(payload).toString("base64url")}`;
    },
  });
}

function assertScopeId(name: "user_id" | "project_id", value: string): void {
  if (!SCOPE_ID_PATTERN.test(value)) {
    throw new RuntimeConfigurationError(
      `${name} must match [A-Za-z0-9._-]{1,64}`,
    );
  }
}

export function createFixedScopeProvider(
  userId: string,
  projectId: string,
): ScopeProvider {
  assertScopeId("user_id", userId);
  assertScopeId("project_id", projectId);

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

export function createFixedRulesVersionProvider(
  rulesVersion: string,
): RulesVersionProvider {
  if (
    rulesVersion.length === 0 ||
    rulesVersion.length > 128 ||
    rulesVersion.trim() !== rulesVersion ||
    RULES_CONTROL_CHARACTER_PATTERN.test(rulesVersion)
  ) {
    throw new RuntimeConfigurationError(
      "rules version must be a trimmed, non-empty value of at most 128 characters",
    );
  }

  return Object.freeze({
    currentRulesVersion(): string {
      return rulesVersion;
    },
  });
}

function runGit(
  projectDirectory: string,
  arguments_: readonly string[],
): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "git",
      [...arguments_],
      {
        cwd: projectDirectory,
        encoding: "utf8",
        timeout: 2_000,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        const value = stdout.trim();
        resolve(value.length > 0 ? value : null);
      },
    );
  });
}

export function createGitBranchProvider(
  projectDirectory: string,
): BranchProvider {
  if (projectDirectory.length === 0) {
    throw new RuntimeConfigurationError(
      "project directory must be configured for branch metadata",
    );
  }

  return Object.freeze({
    async currentBranch(): Promise<string | null> {
      const symbolic = await runGit(projectDirectory, [
        "symbolic-ref",
        "--quiet",
        "--short",
        "HEAD",
      ]);
      if (symbolic !== null) {
        return symbolic;
      }

      const objectId = await runGit(projectDirectory, [
        "rev-parse",
        "--verify",
        "HEAD",
      ]);
      return objectId === null ? null : `detached:${objectId}`;
    },
  });
}

function normalizeActor(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  const withoutControls = value.replace(CONTROL_CHARACTER_PATTERN, "");
  const bounded = Array.from(withoutControls).slice(0, 128).join("");
  return bounded.length === 0 ? null : bounded;
}

function sessionCorrelationKey(
  logicalSessionId: string | null | undefined,
  hmacKey: Uint8Array | null,
): SessionCorrelationKey | null {
  if (
    logicalSessionId === null ||
    logicalSessionId === undefined ||
    logicalSessionId.length === 0 ||
    hmacKey === null
  ) {
    return null;
  }
  if (hmacKey.byteLength === 0) {
    throw new RuntimeConfigurationError(
      "session metadata HMAC key must not be empty",
    );
  }

  const digest = createHmac("sha256", hmacKey)
    .update(logicalSessionId, "utf8")
    .digest("hex");
  return `hmac-sha256:${digest}`;
}

export interface JournalMetadataProviderOptions {
  readonly clientName?: string | null;
  readonly logicalSessionId?: string | null;
  readonly sessionHmacKey?: Uint8Array | null;
  readonly branch: BranchProvider;
}

export function createJournalMetadataProvider(
  options: JournalMetadataProviderOptions,
): MetadataProvider {
  const actor = normalizeActor(options.clientName);
  const hmacKey =
    options.sessionHmacKey === undefined || options.sessionHmacKey === null
      ? null
      : Uint8Array.from(options.sessionHmacKey);
  if (hmacKey !== null && hmacKey.byteLength === 0) {
    throw new RuntimeConfigurationError(
      "session metadata HMAC key must not be empty",
    );
  }
  const session = sessionCorrelationKey(options.logicalSessionId, hmacKey);

  return Object.freeze({
    async resolveMetadata(): Promise<JournalMetadata> {
      let branch: string | null = null;
      try {
        branch = await options.branch.currentBranch();
      } catch {
        // Metadata failure must not discard the memory body.
      }

      if (
        branch !== null &&
        (branch.length === 0 ||
          RULES_CONTROL_CHARACTER_PATTERN.test(branch))
      ) {
        branch = null;
      }

      return Object.freeze({ actor, branch, session });
    },
  });
}

export interface NodeRuntimeDeploymentConfig {
  readonly projectId: string;
  readonly projectDirectory: string;
  readonly rulesVersion: string;
  readonly localUserId?: string | null;
  readonly sessionHmacKey?: Uint8Array | null;
}

/** Values supplied by authenticated transport/host state, never tool arguments. */
export interface TrustedHostRequestContext {
  readonly authenticatedUserId?: string | null;
  readonly clientName?: string | null;
  readonly logicalSessionId?: string | null;
}

export function createNodeRuntimeProvider(
  deployment: NodeRuntimeDeploymentConfig,
  request: TrustedHostRequestContext,
): RuntimeProvider {
  const userId = request.authenticatedUserId ?? deployment.localUserId;
  if (userId === undefined || userId === null) {
    throw new RuntimeConfigurationError(
      "an authenticated or explicitly configured local user_id is required",
    );
  }

  return createRuntimeProvider({
    clock: systemRuntimeClock,
    eventIds: createUlidEventIdProvider(
      systemRuntimeClock,
      cryptographicRandomBytes,
    ),
    approvalTokens: createApprovalTokenProvider(cryptographicRandomBytes),
    rules: createFixedRulesVersionProvider(deployment.rulesVersion),
    scope: createFixedScopeProvider(userId, deployment.projectId),
    metadata: createJournalMetadataProvider({
      clientName: request.clientName ?? null,
      logicalSessionId: request.logicalSessionId ?? null,
      sessionHmacKey: deployment.sessionHmacKey ?? null,
      branch: createGitBranchProvider(deployment.projectDirectory),
    }),
  });
}
