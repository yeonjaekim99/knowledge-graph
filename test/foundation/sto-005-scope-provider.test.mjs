import assert from "node:assert/strict";
import { test } from "node:test";

import * as publicApi from "@recall/mcp-server";
import {
  RECALL_PROJECT_ID_ENV,
  RECALL_USER_ID_ENV,
  ScopeResolutionError,
  createLocalScopeProvider,
  createRemoteScopeProvider,
  loadLocalScopeDeploymentConfig,
  loadRemoteScopeDeploymentConfig,
} from "../../dist/adapters/runtime/index.js";

function scopeError(code, submittedValues = []) {
  return (error) => {
    assert.ok(error instanceof ScopeResolutionError);
    assert.equal(error.code, code);
    assert.equal(error.retryable, false);
    assert.equal("cause" in error, false);
    for (const value of submittedValues) {
      if (value.length > 0) {
        assert.doesNotMatch(error.message, new RegExp(value, "u"));
      }
    }
    return true;
  };
}

test("local deployment snapshots explicit user and project configuration into one frozen scope", () => {
  assert.equal(RECALL_PROJECT_ID_ENV, "RECALL_PROJECT_ID");
  assert.equal(RECALL_USER_ID_ENV, "RECALL_USER_ID");

  const environment = {
    RECALL_PROJECT_ID: "recall-project_1",
    RECALL_USER_ID: "alice.local",
  };
  const config = loadLocalScopeDeploymentConfig(environment);
  environment.RECALL_PROJECT_ID = "mutated-project";
  environment.RECALL_USER_ID = "mutated-user";

  assert.deepEqual(config, {
    mode: "local",
    projectId: "recall-project_1",
    userId: "alice.local",
  });
  assert.equal(Object.isFrozen(config), true);

  const provider = createLocalScopeProvider(config);
  const first = provider.resolveScope();
  const second = provider.resolveScope();
  assert.strictEqual(second, first);
  assert.deepEqual(first, {
    userId: "alice.local",
    projectId: "recall-project_1",
    scopeKey: "u:alice.local/p:recall-project_1",
  });
  assert.equal(Object.isFrozen(provider), true);
  assert.equal(Object.isFrozen(first), true);
});

test("remote deployment binds each verified request principal to the immutable project", () => {
  const environment = { RECALL_PROJECT_ID: "shared-project" };
  const config = loadRemoteScopeDeploymentConfig(environment);
  environment.RECALL_PROJECT_ID = "mutated-project";
  assert.deepEqual(config, { mode: "remote", projectId: "shared-project" });
  assert.equal(Object.isFrozen(config), true);

  const alicePrincipal = { userId: "alice" };
  const aliceProvider = createRemoteScopeProvider(config, alicePrincipal);
  const bobProvider = createRemoteScopeProvider(config, { userId: "bob" });
  alicePrincipal.userId = "mallory";

  assert.deepEqual(aliceProvider.resolveScope(), {
    userId: "alice",
    projectId: "shared-project",
    scopeKey: "u:alice/p:shared-project",
  });
  assert.deepEqual(bobProvider.resolveScope(), {
    userId: "bob",
    projectId: "shared-project",
    scopeKey: "u:bob/p:shared-project",
  });
  assert.notEqual(
    aliceProvider.resolveScope().scopeKey,
    bobProvider.resolveScope().scopeKey,
  );
});

test("the complete ASCII identifier boundary is accepted without trimming or inference", () => {
  const boundary = "A".repeat(58) + "._-z09";
  assert.equal(boundary.length, 64);
  const provider = createLocalScopeProvider(
    loadLocalScopeDeploymentConfig({
      RECALL_PROJECT_ID: "personal",
      RECALL_USER_ID: boundary,
    }),
  );

  assert.deepEqual(provider.resolveScope(), {
    userId: boundary,
    projectId: "personal",
    scopeKey: `u:${boundary}/p:personal`,
  });
});

test("missing and malformed deployment identifiers fail closed without exposing submitted values", () => {
  assert.throws(
    () => loadLocalScopeDeploymentConfig({ RECALL_USER_ID: "alice" }),
    scopeError("PROJECT_ID_REQUIRED"),
  );
  assert.throws(
    () => loadLocalScopeDeploymentConfig({ RECALL_PROJECT_ID: "project" }),
    scopeError("LOCAL_USER_ID_REQUIRED"),
  );
  assert.throws(
    () => loadRemoteScopeDeploymentConfig({}),
    scopeError("PROJECT_ID_REQUIRED"),
  );

  const invalidIds = [
    "",
    "a".repeat(65),
    "has space",
    "사용자",
    "path/name",
    "person@example.com",
  ];
  for (const invalidId of invalidIds) {
    assert.throws(
      () =>
        loadLocalScopeDeploymentConfig({
          RECALL_PROJECT_ID: invalidId,
          RECALL_USER_ID: "alice",
        }),
      scopeError("PROJECT_ID_INVALID", [invalidId]),
    );
    assert.throws(
      () =>
        loadLocalScopeDeploymentConfig({
          RECALL_PROJECT_ID: "project",
          RECALL_USER_ID: invalidId,
        }),
      scopeError("LOCAL_USER_ID_INVALID", [invalidId]),
    );
    assert.throws(
      () =>
        createRemoteScopeProvider(
          { mode: "remote", projectId: "project" },
          { userId: invalidId },
        ),
      scopeError("REMOTE_PRINCIPAL_INVALID", [invalidId]),
    );
  }
});

test("remote mode rejects local fallback and missing or malformed principal context", () => {
  assert.throws(
    () =>
      loadRemoteScopeDeploymentConfig({
        RECALL_PROJECT_ID: "project",
        RECALL_USER_ID: "must-not-fallback",
      }),
    scopeError("REMOTE_LOCAL_USER_FORBIDDEN", ["must-not-fallback"]),
  );

  const config = loadRemoteScopeDeploymentConfig({
    RECALL_PROJECT_ID: "project",
  });
  for (const missingPrincipal of [undefined, null]) {
    assert.throws(
      () => createRemoteScopeProvider(config, missingPrincipal),
      scopeError("REMOTE_PRINCIPAL_REQUIRED"),
    );
  }
  assert.throws(
    () => createRemoteScopeProvider(config, {}),
    scopeError("REMOTE_PRINCIPAL_INVALID"),
  );
  assert.throws(
    () =>
      createRemoteScopeProvider(
        { mode: "local", projectId: "project", userId: "fallback" },
        { userId: "alice" },
      ),
    scopeError("DEPLOYMENT_CONFIG_INVALID"),
  );
});

test("scope providers expose no request or tool-controlled scope selector", () => {
  const local = createLocalScopeProvider({
    mode: "local",
    projectId: "project",
    userId: "alice",
  });
  const remote = createRemoteScopeProvider(
    { mode: "remote", projectId: "project" },
    { userId: "alice" },
  );

  for (const provider of [local, remote]) {
    assert.deepEqual(Object.keys(provider), ["resolveScope"]);
    assert.equal(provider.resolveScope.length, 0);
  }
  assert.deepEqual(Object.keys(publicApi), []);
});
