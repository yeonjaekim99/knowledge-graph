import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import * as publicApi from "@recall/mcp-server";
import {
  RECALL_PROJECT_WORKTREE_ENV,
  RECALL_SESSION_HMAC_KEY_ENV,
  MetadataConfigurationError,
  createRequestMetadataProvider,
  gitProjectBranchResolver,
  loadMetadataDeploymentConfig,
} from "../../dist/adapters/runtime/index.js";

const temporaryDirectories = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

function temporaryDirectory(prefix = "recall-sto-006-") {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function runGit(directory, args) {
  return execFileSync("git", args, {
    cwd: directory,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).replace(/\r?\n$/u, "");
}

function createRepository(branch = "feature/metadata") {
  const directory = temporaryDirectory();
  runGit(directory, ["init", "--quiet"]);
  runGit(directory, ["config", "user.name", "Recall Fixture"]);
  runGit(directory, ["config", "user.email", "fixture@example.invalid"]);
  writeFileSync(join(directory, "README.md"), "fixture\n");
  runGit(directory, ["add", "README.md"]);
  runGit(directory, ["commit", "--quiet", "-m", "fixture"]);
  runGit(directory, ["switch", "--quiet", "-c", branch]);
  return directory;
}

const passThroughSanitizer = Object.freeze({
  async sanitize(_field, value) {
    return value;
  },
});

function metadataError(code, submittedValues = []) {
  return (error) => {
    assert.ok(error instanceof MetadataConfigurationError);
    assert.equal(error.code, code);
    assert.equal(error.retryable, false);
    assert.equal("cause" in error, false);
    for (const value of submittedValues) {
      if (value.length > 0) {
        assert.equal(error.message.includes(value), false);
        assert.equal(JSON.stringify(error).includes(value), false);
      }
    }
    return true;
  };
}

test("observed client and symbolic branch are normalized into one immutable request snapshot", async () => {
  assert.equal(RECALL_PROJECT_WORKTREE_ENV, "RECALL_PROJECT_WORKTREE");
  assert.equal(RECALL_SESSION_HMAC_KEY_ENV, "RECALL_SESSION_HMAC_KEY");

  const repository = createRepository();
  const environment = { RECALL_PROJECT_WORKTREE: repository };
  const config = loadMetadataDeploymentConfig(environment);
  environment.RECALL_PROJECT_WORKTREE = temporaryDirectory();

  const actorPrefix = "claude-code-";
  const context = {
    clientInfo: { name: `cl\u0000aude\u001f-code-${"가".repeat(140)}` },
  };
  const provider = createRequestMetadataProvider(config, context, {
    sanitizer: passThroughSanitizer,
  });
  context.clientInfo.name = "mutated-client";

  const first = await provider.resolveMetadata();
  const second = await provider.resolveMetadata();

  assert.strictEqual(second, first);
  assert.equal(first.actor, actorPrefix + "가".repeat(128 - actorPrefix.length));
  assert.equal(Array.from(first.actor).length, 128);
  assert.deepEqual(first, {
    actor: first.actor,
    branch: "feature/metadata",
    session: null,
  });
  assert.equal(Object.isFrozen(config), true);
  assert.equal(Object.isFrozen(provider), true);
  assert.equal(Object.isFrozen(first), true);
});

test("detached HEAD and trusted logical session become full OID and keyed correlation only", async () => {
  const repository = createRepository();
  const objectId = runGit(repository, ["rev-parse", "--verify", "HEAD"]);
  runGit(repository, ["switch", "--quiet", "--detach"]);

  const keyHex = "11".repeat(32);
  const rawSession = "transport-session-do-not-store";
  const environment = {
    RECALL_PROJECT_WORKTREE: repository,
    RECALL_SESSION_HMAC_KEY: keyHex,
  };
  const config = loadMetadataDeploymentConfig(environment);
  environment.RECALL_SESSION_HMAC_KEY = "22".repeat(32);
  const sanitizerCalls = [];
  const provider = createRequestMetadataProvider(
    config,
    { logicalSessionId: rawSession },
    {
      sanitizer: {
        async sanitize(field, value) {
          sanitizerCalls.push({ field, value });
          return value;
        },
      },
    },
  );

  const metadata = await provider.resolveMetadata();
  const expected = createHmac("sha256", Buffer.from(keyHex, "hex"))
    .update(rawSession, "utf8")
    .digest("hex");

  assert.deepEqual(metadata, {
    actor: null,
    branch: `detached:${objectId}`,
    session: `hmac-sha256:${expected}`,
  });
  assert.deepEqual(sanitizerCalls, [
    { field: "branch", value: `detached:${objectId}` },
  ]);
  assert.equal(JSON.stringify(config).includes(keyHex), false);
  assert.equal(JSON.stringify(metadata).includes(rawSession), false);
  assert.equal(JSON.stringify(sanitizerCalls).includes(rawSession), false);
});

test("non-Git projects and unavailable optional request metadata resolve to NULL without fallback", async () => {
  const directory = temporaryDirectory();
  const config = loadMetadataDeploymentConfig({
    RECALL_PROJECT_WORKTREE: directory,
  });
  const provider = createRequestMetadataProvider(
    config,
    {
      clientInfo: null,
      logicalSessionId: "must-not-survive-without-key",
    },
    { sanitizer: passThroughSanitizer },
  );

  assert.equal(await gitProjectBranchResolver.resolveBranch(directory), null);
  assert.deepEqual(await provider.resolveMetadata(), {
    actor: null,
    branch: null,
    session: null,
  });
});

test("secret masking and sanitizer or Git failure are isolated to the affected metadata field", async () => {
  const repository = createRepository("feature/secret-marker");
  const keyHex = "33".repeat(32);
  const rawSession = "logical-session";
  const config = loadMetadataDeploymentConfig({
    RECALL_PROJECT_WORKTREE: repository,
    RECALL_SESSION_HMAC_KEY: keyHex,
  });
  const provider = createRequestMetadataProvider(
    config,
    {
      clientInfo: { name: "client-secret-marker" },
      logicalSessionId: rawSession,
    },
    {
      sanitizer: {
        async sanitize(field, value) {
          if (field === "actor") {
            return "[REDACTED:SECRET]";
          }
          throw new Error(`unsafe sanitizer detail: ${value}`);
        },
      },
    },
  );

  const expected = createHmac("sha256", Buffer.from(keyHex, "hex"))
    .update(rawSession, "utf8")
    .digest("hex");
  assert.deepEqual(await provider.resolveMetadata(), {
    actor: "[REDACTED:SECRET]",
    branch: null,
    session: `hmac-sha256:${expected}`,
  });

  const gitFailure = createRequestMetadataProvider(
    config,
    { clientInfo: { name: "safe-client" } },
    {
      sanitizer: passThroughSanitizer,
      branchResolver: {
        async resolveBranch() {
          throw new Error("sensitive Git failure detail");
        },
      },
    },
  );
  assert.deepEqual(await gitFailure.resolveMetadata(), {
    actor: "safe-client",
    branch: null,
    session: null,
  });
});

test("missing and malformed deployment configuration fails closed with redacted typed errors", () => {
  const invalidPath = "relative/private/project";
  const invalidKey = "session-key-must-not-echo";

  assert.throws(
    () => loadMetadataDeploymentConfig({}),
    metadataError("PROJECT_WORKTREE_REQUIRED"),
  );
  assert.throws(
    () =>
      loadMetadataDeploymentConfig({
        RECALL_PROJECT_WORKTREE: invalidPath,
      }),
    metadataError("PROJECT_WORKTREE_INVALID", [invalidPath]),
  );
  assert.throws(
    () =>
      loadMetadataDeploymentConfig({
        RECALL_PROJECT_WORKTREE: temporaryDirectory(),
        RECALL_SESSION_HMAC_KEY: invalidKey,
      }),
    metadataError("SESSION_HMAC_KEY_INVALID", [invalidKey]),
  );
  assert.throws(
    () => loadMetadataDeploymentConfig(null),
    metadataError("DEPLOYMENT_CONFIG_INVALID"),
  );
});

test("metadata providers require a secret gate and expose no tool-controlled selector", async () => {
  const repository = createRepository();
  const config = loadMetadataDeploymentConfig({
    RECALL_PROJECT_WORKTREE: repository,
  });

  assert.throws(
    () => createRequestMetadataProvider(config, {}, {}),
    metadataError("METADATA_DEPENDENCIES_INVALID"),
  );
  assert.throws(
    () =>
      createRequestMetadataProvider(config, {}, {
        sanitizer: passThroughSanitizer,
        branchResolver: {},
      }),
    metadataError("METADATA_DEPENDENCIES_INVALID"),
  );

  const provider = createRequestMetadataProvider(
    config,
    { clientInfo: { name: 42 }, logicalSessionId: 42 },
    { sanitizer: passThroughSanitizer },
  );
  assert.deepEqual(Object.keys(provider), ["resolveMetadata"]);
  assert.equal(provider.resolveMetadata.length, 0);
  assert.deepEqual(await provider.resolveMetadata(), {
    actor: null,
    branch: "feature/metadata",
    session: null,
  });
  assert.deepEqual(Object.keys(publicApi), []);
});
