import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";

import {
  RuntimeBoundaryError,
  createRuntimeProvider,
} from "../../dist/application/runtime-context.js";
import {
  RuntimeConfigurationError,
  createApprovalTokenProvider,
  createFixedScopeProvider,
  createJournalMetadataProvider,
  createNodeRuntimeProvider,
  createUlidEventIdProvider,
} from "../../dist/adapters/runtime/index.js";
import { validateArchitecture } from "../../scripts/check-module-boundaries.mjs";
import { createDeterministicRuntimeProvider } from "../support/deterministic-runtime-provider.mjs";

const temporaryDirectories = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

function temporaryDirectory(prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function zeroRandomBytes() {
  return {
    randomBytes(length) {
      return new Uint8Array(length);
    },
  };
}

function validDependencies(overrides = {}) {
  return {
    clock: { nowMilliseconds: () => 1_700_000_000_999 },
    eventIds: { nextEventId: () => `ev_${"0".repeat(26)}` },
    approvalTokens: {
      nextApprovalToken: () => `ra_${"A".repeat(43)}`,
    },
    rules: { currentRulesVersion: () => "rules-v1" },
    scope: {
      resolveScope: () => ({
        userId: "user",
        projectId: "project",
        scopeKey: "u:user/p:project",
      }),
    },
    metadata: {
      resolveMetadata: async () => ({
        actor: null,
        branch: null,
        session: null,
      }),
    },
    ...overrides,
  };
}

function createDomainGuardFixture(domainSource) {
  const root = temporaryDirectory("recall-runtime-architecture-");
  const files = {
    "src/index.ts": 'export { marker } from "./application/index.js";\n',
    "src/application/index.ts": "export const marker = 1;\n",
    "src/application/ports/journal-commit-port.ts": [
      "export interface JournalCommitPort<Intent, Receipt> {",
      "  appendAndProject(events: readonly Intent[]): Promise<Receipt>;",
      "}",
      "",
    ].join("\n"),
    "src/domain/index.ts": domainSource,
  };

  for (const [relativePath, contents] of Object.entries(files)) {
    const absolutePath = join(root, relativePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, contents);
  }

  writeFileSync(
    join(root, "architecture.config.json"),
    JSON.stringify({
      version: 2,
      sourceRoot: "src",
      publicEntry: "src/index.ts",
      publicApiFiles: ["src/index.ts", "src/application/index.ts"],
      privatePublicTargets: ["src/application/ports", "src/domain"],
      forbiddenImportFragments: ["spikes/adr-behavior"],
      requiredFiles: Object.keys(files),
      atomicWritePort: {
        file: "src/application/ports/journal-commit-port.ts",
        interface: "JournalCommitPort",
        method: "appendAndProject",
      },
      layers: [
        {
          name: "domain",
          root: "src/domain",
          mayImport: ["domain"],
          externalPackages: [],
          forbiddenIdentifiers: [
            "Date",
            "fetch",
            "globalThis",
            "process",
          ],
          forbiddenMemberAccess: ["Math.random"],
        },
        {
          name: "application",
          root: "src/application",
          mayImport: ["application", "domain"],
          externalPackages: [],
        },
      ],
      publicEntryRule: {
        mayImport: ["application"],
        externalPackages: [],
      },
    }),
  );

  return root;
}

test("deterministic provider injects one fixed request snapshot, IDs, and approval tokens", async () => {
  const eventId = "ev_01K2ZFFTTT0000000000000000";
  const approvalToken = `ra_${"B".repeat(42)}E`;
  const provider = createDeterministicRuntimeProvider({
    nowMilliseconds: 1_700_000_000_999,
    eventIds: [eventId],
    approvalTokens: [approvalToken],
    rulesVersion: "rules-test-7",
    scope: {
      userId: "alice",
      projectId: "recall",
      scopeKey: "u:alice/p:recall",
    },
    metadata: {
      actor: "fixture-agent",
      branch: "feature/test",
      session: `hmac-sha256:${"a".repeat(64)}`,
    },
  });

  const first = await provider.capture();
  const second = await provider.capture();

  assert.strictEqual(second, first);
  assert.deepEqual(first, {
    recordedAt: 1_700_000_000,
    evaluationNow: 1_700_000_000,
    rulesVersion: "rules-test-7",
    scope: {
      userId: "alice",
      projectId: "recall",
      scopeKey: "u:alice/p:recall",
    },
    metadata: {
      actor: "fixture-agent",
      branch: "feature/test",
      session: `hmac-sha256:${"a".repeat(64)}`,
    },
  });
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.scope), true);
  assert.equal(Object.isFrozen(first.metadata), true);
  assert.equal(provider.nextEventId(), eventId);
  assert.equal(provider.nextApprovalToken(), approvalToken);
});

test("production and deterministic providers expose the same request-scoped contract", async () => {
  const projectDirectory = temporaryDirectory("recall-runtime-contract-");
  const production = createNodeRuntimeProvider(
    {
      projectId: "recall",
      projectDirectory,
      rulesVersion: "rules-v1",
      localUserId: "local-user",
    },
    {},
  );
  const deterministic = createDeterministicRuntimeProvider();

  assert.deepEqual(Object.keys(production), [
    "capture",
    "nextEventId",
    "nextApprovalToken",
  ]);
  assert.deepEqual(Object.keys(deterministic), Object.keys(production));
  assert.equal(production.capture.length, 0);
  assert.equal(production.nextEventId.length, 0);
  assert.equal(production.nextApprovalToken.length, 0);
  const productionSnapshot = await production.capture();
  assert.deepEqual(productionSnapshot, {
    recordedAt: productionSnapshot.recordedAt,
    evaluationNow: productionSnapshot.recordedAt,
    rulesVersion: "rules-v1",
    scope: {
      userId: "local-user",
      projectId: "recall",
      scopeKey: "u:local-user/p:recall",
    },
    metadata: { actor: null, branch: null, session: null },
  });
});

test("production provider derives scope and metadata only from deployment and trusted host context", async () => {
  const projectDirectory = temporaryDirectory("recall-runtime-git-");
  execFileSync("git", ["init", "--quiet"], { cwd: projectDirectory });
  execFileSync(
    "git",
    ["symbolic-ref", "HEAD", "refs/heads/feature/runtime"],
    { cwd: projectDirectory },
  );

  const sessionHmacKey = new Uint8Array(32).fill(7);
  const before = Math.floor(Date.now() / 1_000);
  const provider = createNodeRuntimeProvider(
    {
      projectId: "recall",
      projectDirectory,
      rulesVersion: "rules-v1",
      localUserId: "local-user",
      sessionHmacKey,
    },
    {
      authenticatedUserId: "authenticated-user",
      clientName: "claude\u0000\n",
      logicalSessionId: "transport-session-bearer",
    },
  );

  const snapshot = await provider.capture();
  const after = Math.floor(Date.now() / 1_000);
  const expectedSession = createHmac("sha256", sessionHmacKey)
    .update("transport-session-bearer", "utf8")
    .digest("hex");

  assert.deepEqual(snapshot.scope, {
    userId: "authenticated-user",
    projectId: "recall",
    scopeKey: "u:authenticated-user/p:recall",
  });
  assert.deepEqual(snapshot.metadata, {
    actor: "claude",
    branch: "feature/runtime",
    session: `hmac-sha256:${expectedSession}`,
  });
  assert.ok(snapshot.recordedAt >= before && snapshot.recordedAt <= after);
  assert.equal(snapshot.evaluationNow, snapshot.recordedAt);
  assert.match(provider.nextEventId(), /^ev_[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
  assert.match(provider.nextApprovalToken(), /^ra_[A-Za-z0-9_-]{43}$/);
  assert.doesNotMatch(snapshot.metadata.session, /transport-session-bearer/);
});

test("metadata failures degrade nullable fields without losing the runtime snapshot", async () => {
  const actor = `${"가".repeat(140)}\u0000`;
  const metadata = createJournalMetadataProvider({
    clientName: actor,
    logicalSessionId: "not-persisted",
    branch: {
      async currentBranch() {
        throw new Error("git unavailable");
      },
    },
  });

  assert.deepEqual(await metadata.resolveMetadata(), {
    actor: "가".repeat(128),
    branch: null,
    session: null,
  });
});

test("git metadata reports a detached HEAD with its full object ID", async () => {
  const projectDirectory = temporaryDirectory("recall-runtime-detached-");
  execFileSync("git", ["init", "--quiet"], { cwd: projectDirectory });
  writeFileSync(join(projectDirectory, "tracked.txt"), "runtime fixture\n");
  execFileSync("git", ["add", "tracked.txt"], { cwd: projectDirectory });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Recall Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ],
    { cwd: projectDirectory },
  );
  const objectId = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: projectDirectory,
    encoding: "utf8",
  }).trim();
  execFileSync("git", ["checkout", "--quiet", "--detach", objectId], {
    cwd: projectDirectory,
  });

  const provider = createNodeRuntimeProvider(
    {
      projectId: "recall",
      projectDirectory,
      rulesVersion: "rules-v1",
      localUserId: "local-user",
    },
    {},
  );

  assert.equal(
    (await provider.capture()).metadata.branch,
    `detached:${objectId}`,
  );
});

test("ULID and approval generators are deterministic under injected clock and random bytes", () => {
  const timestamp = 1_700_000_000_123;
  const eventIds = createUlidEventIdProvider(
    { nowMilliseconds: () => timestamp },
    zeroRandomBytes(),
  );
  const approvals = createApprovalTokenProvider(zeroRandomBytes());
  const eventId = eventIds.nextEventId();
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let decoded = 0n;
  for (const character of eventId.slice(3)) {
    decoded = decoded * 32n + BigInt(alphabet.indexOf(character));
  }

  assert.equal(Number(decoded >> 80n), timestamp);
  assert.equal(approvals.nextApprovalToken(), `ra_${"A".repeat(43)}`);
});

test("runtime snapshot captures the clock exactly once for a stable evaluation_now", async () => {
  let clockCalls = 0;
  const provider = createRuntimeProvider(
    validDependencies({
      clock: {
        nowMilliseconds() {
          clockCalls += 1;
          return 1_700_000_000_999 + clockCalls;
        },
      },
    }),
  );

  const [first, second] = await Promise.all([
    provider.capture(),
    provider.capture(),
  ]);

  assert.strictEqual(first, second);
  assert.equal(clockCalls, 1);
  assert.equal(first.recordedAt, first.evaluationNow);
});

test("invalid provider output fails closed at the application boundary", async () => {
  const invalidClock = createRuntimeProvider(
    validDependencies({ clock: { nowMilliseconds: () => Number.NaN } }),
  );
  await assert.rejects(
    invalidClock.capture(),
    (error) =>
      error instanceof RuntimeBoundaryError && error.code === "invalid_clock",
  );

  const invalidId = createRuntimeProvider(
    validDependencies({ eventIds: { nextEventId: () => "ev_invalid" } }),
  );
  assert.throws(
    () => invalidId.nextEventId(),
    (error) =>
      error instanceof RuntimeBoundaryError && error.code === "invalid_event_id",
  );

  const invalidApproval = createRuntimeProvider(
    validDependencies({
      approvalTokens: { nextApprovalToken: () => "ra_too-short" },
    }),
  );
  assert.throws(
    () => invalidApproval.nextApprovalToken(),
    (error) =>
      error instanceof RuntimeBoundaryError &&
      error.code === "invalid_approval_token",
  );

  const nonCanonicalApproval = createRuntimeProvider(
    validDependencies({
      approvalTokens: {
        nextApprovalToken: () => `ra_${"B".repeat(43)}`,
      },
    }),
  );
  assert.throws(
    () => nonCanonicalApproval.nextApprovalToken(),
    (error) =>
      error instanceof RuntimeBoundaryError &&
      error.code === "invalid_approval_token",
  );

  const invalidScope = createRuntimeProvider(
    validDependencies({
      scope: {
        resolveScope: () => ({
          userId: "user",
          projectId: "project",
          scopeKey: "u:other/p:project",
        }),
      },
    }),
  );
  await assert.rejects(
    invalidScope.capture(),
    (error) =>
      error instanceof RuntimeBoundaryError && error.code === "invalid_scope",
  );

  const invalidMetadata = createRuntimeProvider(
    validDependencies({
      metadata: {
        resolveMetadata: async () => ({
          actor: null,
          branch: null,
          session: "transport-session-bearer",
        }),
      },
    }),
  );
  await assert.rejects(
    invalidMetadata.capture(),
    (error) =>
      error instanceof RuntimeBoundaryError && error.code === "invalid_metadata",
  );
});

test("invalid scope configuration and absent user identity fail before tools can run", () => {
  assert.throws(
    () => createFixedScopeProvider("user/escape", "project"),
    RuntimeConfigurationError,
  );
  assert.throws(
    () =>
      createJournalMetadataProvider({
        logicalSessionId: "session",
        sessionHmacKey: new Uint8Array(),
        branch: { currentBranch: async () => null },
      }),
    /HMAC key must not be empty/,
  );
  assert.throws(
    () =>
      createNodeRuntimeProvider(
        {
          projectId: "project",
          projectDirectory: temporaryDirectory("recall-runtime-missing-user-"),
          rulesVersion: "rules-v1",
        },
        {},
      ),
    /user_id is required/,
  );
});

test("random providers with wrong byte counts and invalid ULID clocks are rejected", () => {
  const shortRandom = {
    randomBytes(length) {
      return new Uint8Array(length - 1);
    },
  };

  assert.throws(
    () =>
      createUlidEventIdProvider(
        { nowMilliseconds: () => 0 },
        shortRandom,
      ).nextEventId(),
    /expected 10/,
  );
  assert.throws(
    () => createApprovalTokenProvider(shortRandom).nextApprovalToken(),
    /expected 32/,
  );
  assert.throws(
    () =>
      createUlidEventIdProvider(
        { nowMilliseconds: () => 0x1_0000_0000_0000 },
        zeroRandomBytes(),
      ).nextEventId(),
    /2\^48-1/,
  );
});

test("domain architecture rejects ambient clock, random, network, process, and global access", () => {
  const forbiddenSources = [
    "export const value = Date.now();\n",
    'export const value = fetch("https://example.invalid");\n',
    "export const value = Math.random();\n",
    "export const value = process.cwd();\n",
    "export const value = globalThis.crypto;\n",
  ];

  for (const source of forbiddenSources) {
    const result = validateArchitecture({
      projectRoot: createDomainGuardFixture(source),
    });
    assert.match(result.errors.join("\n"), /may not reference runtime global/);
  }

  const allowed = validateArchitecture({
    projectRoot: createDomainGuardFixture(
      'export const note = "Date.now, fetch, and Math.random are not executed";\n',
    ),
  });
  assert.deepEqual(allowed.errors, []);
});
