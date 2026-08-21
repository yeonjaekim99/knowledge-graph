import { createHash } from "node:crypto";

const DEFAULT_SEED = "recall-fnd-005-v1";
const DEFAULT_NOW_SECONDS = 1_700_000_000;
const DEFAULT_TIMEZONE = "UTC";
const DEFAULT_LOCALE = "en-US";
const MAX_ENTROPY_BYTES = 4_096;

function requireText(value, label, maximumLength) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximumLength) {
    throw new TypeError(`${label} must be non-empty text up to ${maximumLength} characters`);
  }
  return value;
}

function requireNonNegativeSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function canonicalLocale(locale) {
  requireText(locale, "locale", 64);
  const [canonical] = Intl.getCanonicalLocales(locale);
  if (canonical === undefined) {
    throw new TypeError("locale must be supported");
  }
  return canonical;
}

function framed(value) {
  return `${Buffer.byteLength(value, "utf8")}:${value}`;
}

function freezeRecord(value) {
  return Object.freeze(value);
}

export function createDeterministicTestContext({
  seed = DEFAULT_SEED,
  nowSeconds = DEFAULT_NOW_SECONDS,
  timezone = DEFAULT_TIMEZONE,
  locale = DEFAULT_LOCALE,
} = {}) {
  const fixedSeed = requireText(seed, "seed", 128);
  const fixedNow = requireNonNegativeSafeInteger(nowSeconds, "nowSeconds");
  if (timezone !== "UTC") {
    throw new TypeError("timezone must be UTC");
  }
  const fixedLocale = canonicalLocale(locale);

  const clockNowSeconds = (offsetSeconds = 0) => {
    const offset = requireNonNegativeSafeInteger(offsetSeconds, "clock offset");
    const value = fixedNow + offset;
    return requireNonNegativeSafeInteger(value, "clock result");
  };
  const clock = freezeRecord({
    nowSeconds: clockNowSeconds,
    nowMilliseconds(offsetSeconds = 0) {
      const value = clockNowSeconds(offsetSeconds) * 1_000;
      return requireNonNegativeSafeInteger(value, "clock result");
    },
  });

  const entropyBytes = (label, length) => {
    const fixedLabel = requireText(label, "entropy label", 256);
    const fixedLength = requireNonNegativeSafeInteger(length, "entropy length");
    if (fixedLength > MAX_ENTROPY_BYTES) {
      throw new TypeError(`entropy length must be at most ${MAX_ENTROPY_BYTES}`);
    }

    const output = Buffer.alloc(fixedLength);
    let written = 0;
    let counter = 0;
    while (written < fixedLength) {
      const block = createHash("sha256")
        .update("recall-test-entropy-v1\0", "utf8")
        .update(framed(fixedSeed), "utf8")
        .update("\0", "utf8")
        .update(framed(fixedLabel), "utf8")
        .update("\0", "utf8")
        .update(String(counter), "utf8")
        .digest();
      written += block.copy(output, written, 0, fixedLength - written);
      counter += 1;
    }
    return new Uint8Array(output);
  };
  const entropy = freezeRecord({
    bytes: entropyBytes,
    hex(label, length) {
      return Buffer.from(entropyBytes(label, length)).toString("hex");
    },
  });

  return freezeRecord({
    seed: fixedSeed,
    nowSeconds: fixedNow,
    timezone,
    locale: fixedLocale,
    clock,
    entropy,
    reproduction({ scenarioId, prefixLength }) {
      if (
        typeof scenarioId !== "string" ||
        !/^(?:S\d{2}|[A-Z][A-Z0-9-]*)$/.test(scenarioId)
      ) {
        throw new TypeError("scenarioId must be a stable uppercase identifier");
      }
      const prefix = requireNonNegativeSafeInteger(prefixLength, "prefixLength");
      return freezeRecord({
        scenario_id: scenarioId,
        seed: fixedSeed,
        prefix_length: prefix,
        now_seconds: fixedNow,
        timezone,
        locale: fixedLocale,
      });
    },
  });
}

export function createDeterministicTestContextFromEnvironment(environment = process.env) {
  const required = [
    "RECALL_TEST_SEED",
    "RECALL_TEST_NOW_SECONDS",
    "TZ",
    "RECALL_TEST_LOCALE",
  ];
  if (
    required.some(
      (key) =>
        typeof environment[key] !== "string" || environment[key].length === 0,
    )
  ) {
    throw new TypeError("missing deterministic test environment");
  }
  return createDeterministicTestContext({
    seed: environment.RECALL_TEST_SEED,
    nowSeconds: Number(environment.RECALL_TEST_NOW_SECONDS),
    timezone: environment.TZ,
    locale: environment.RECALL_TEST_LOCALE,
  });
}
