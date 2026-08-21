import { Buffer } from "node:buffer";
import { randomBytes as nodeRandomBytes } from "node:crypto";

import { createRuntimeProvider } from "../../application/runtime-context.js";
import type {
  ApprovalTokenProvider,
  EventId,
  EventIdProvider,
  MetadataProvider,
  RandomBytesProvider,
  ReinterpretApprovalToken,
  RulesVersionProvider,
  RuntimeClock,
  RuntimeProvider,
  ScopeProvider,
} from "../../application/ports/runtime-provider.js";

const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const MAX_ULID_TIMESTAMP = 0xffff_ffff_ffff;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;

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
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== length) {
    const actual =
      bytes instanceof Uint8Array
        ? `${bytes.byteLength} bytes`
        : "a non-Uint8Array value";
    throw new RuntimeConfigurationError(
      `random provider returned ${actual}; expected ${length} bytes`,
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

export function createFixedRulesVersionProvider(
  rulesVersion: string,
): RulesVersionProvider {
  if (
    rulesVersion.length === 0 ||
    rulesVersion.length > 128 ||
    rulesVersion.trim() !== rulesVersion ||
    CONTROL_CHARACTER_PATTERN.test(rulesVersion)
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

export interface NodeRuntimeProviderOptions {
  readonly rulesVersion: string;
  /** Bound by STO-005 from immutable deployment config and trusted principal. */
  readonly scope: ScopeProvider;
  /** Bound by STO-006 from observed client/Git/session context. */
  readonly metadata: MetadataProvider;
}

/**
 * Supplies production clock and entropy while requiring request-scoped trusted
 * scope/metadata providers. Tool payload values are not accepted here.
 */
export function createNodeRuntimeProvider(
  options: NodeRuntimeProviderOptions,
): RuntimeProvider {
  return createRuntimeProvider({
    clock: systemRuntimeClock,
    eventIds: createUlidEventIdProvider(
      systemRuntimeClock,
      cryptographicRandomBytes,
    ),
    approvalTokens: createApprovalTokenProvider(cryptographicRandomBytes),
    rules: createFixedRulesVersionProvider(options.rulesVersion),
    scope: options.scope,
    metadata: options.metadata,
  });
}
