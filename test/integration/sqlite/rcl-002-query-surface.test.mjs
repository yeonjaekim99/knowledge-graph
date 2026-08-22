import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import Database from "better-sqlite3";

import { RecallReadError } from "../../../dist/application/ports/recall-read-port.js";
import { resolveRecallQuerySurface } from "../../../dist/application/recall-query-surface.js";
import { RecallSnapshotService } from "../../../dist/application/recall-snapshot-service.js";
import {
  SqliteConnectionError,
  createSqliteConnectionFactory,
  createSqliteRecallReadPort,
  runBundledSqliteMigrations,
  runSqliteStartupGate,
} from "../../../dist/adapters/sqlite/index.js";
import { createDeterministicRuntimeProvider } from "../../support/deterministic-runtime-provider.mjs";

const NOW = 1_700_100_000;
const SCOPE = "u:alice/p:recall";
const OTHER_SCOPE = "u:bob/p:recall";
const temporaryDirectories = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

function runtime(scopeKey = SCOPE) {
  const [, userId, projectId] = /^u:([^/]+)\/p:(.+)$/u.exec(scopeKey) ?? [];
  return createDeterministicRuntimeProvider({
    nowMilliseconds: NOW * 1_000,
    scope: { userId, projectId, scopeKey },
  });
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "recall-rcl-002-"));
  temporaryDirectories.push(root);
  const stateDirectory = join(root, "state");
  mkdirSync(stateDirectory, { mode: 0o700 });
  chmodSync(stateDirectory, 0o700);
  const databasePath = join(stateDirectory, "recall.sqlite3");
  const readiness = runSqliteStartupGate({ databasePath });
  const factory = await createSqliteConnectionFactory(readiness);
  await runBundledSqliteMigrations(factory, { appliedAtSeconds: NOW });
  return { databasePath, factory };
}

function entityCommand(id, scopeKey, mergedInto = null) {
  return {
    kind: "run",
    sql: "INSERT INTO entities(id,scope_key,name,normal_name,kind,merged_into,origin_seq) VALUES (?,?,?,?,NULL,?,?)",
    parameters: [id, scopeKey, `name-${id}`, `name${id}`, mergedInto, Number(id.slice(1).split(".")[0])],
  };
}

function surfaceCommand(scopeKey, surfaceNorm, entityId) {
  return {
    kind: "run",
    sql: "INSERT INTO surface_forms(scope_key,surface_norm,entity_id,origin) VALUES (?,?,?,'confirmed')",
    parameters: [scopeKey, surfaceNorm, entityId],
  };
}

function redirectCommand(oldId, newId, reason = "merge") {
  return {
    kind: "run",
    sql: "INSERT INTO id_redirects(old_id,new_id,kind,reason) VALUES (?,?,'entity',?)",
    parameters: [oldId, newId, reason],
  };
}

function permanentDump(database) {
  const tables = [
    "journal",
    "statements",
    "entities",
    "surface_forms",
    "claims",
    "claim_support",
    "id_redirects",
    "projection_meta",
    "journal_fts",
  ];
  return JSON.stringify(
    Object.fromEntries(
      tables.map((table) => [
        table,
        database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      ]),
    ),
  );
}

function assertDeepFrozen(value) {
  if (value === null || typeof value !== "object") {
    return;
  }
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) {
    assertDeepFrozen(child);
  }
}

test("scoped surface candidates resolve through redirect chains with deterministic polysemy and no writes", async (t) => {
  const { databasePath, factory } = await fixture();
  t.after(() => factory.close());
  await factory.enqueueWriteTransaction([
    entityCommand("e3.0", SCOPE),
    entityCommand("e10.0", SCOPE),
    entityCommand("e2.0", SCOPE, "e3.0"),
    entityCommand("e1.0", SCOPE, "e2.0"),
    entityCommand("e20.0", OTHER_SCOPE),
    redirectCommand("e1.0", "e2.0"),
    redirectCommand("e2.0", "e3.0"),
    surfaceCommand(SCOPE, "로그인", "e2.0"),
    surfaceCommand(SCOPE, "로그인", "e10.0"),
    surfaceCommand(SCOPE, "로그인", "e1.0"),
    surfaceCommand(SCOPE, "인증", "e3.0"),
    surfaceCommand(OTHER_SCOPE, "로그인", "e20.0"),
  ]);

  const observer = new Database(databasePath, { readonly: true, fileMustExist: true });
  t.after(() => observer.close());
  const beforeDump = permanentDump(observer);
  const beforeVersion = observer.pragma("data_version", { simple: true });
  const service = new RecallSnapshotService(
    runtime(),
    createSqliteRecallReadPort(factory),
  );
  let staleSource;
  const result = await service.withSnapshot(async (source) => {
    staleSource = source;
    assert.deepEqual(Object.keys(source), [
      "listValidClaimAggregates",
      "resolveSurfaceSeeds",
      "searchFtsCandidates",
      "selectOverviewCandidates",
    ]);
    assert.equal("query" in source, false);
    assert.equal("sql" in source, false);
    assert.equal("connection" in source, false);
    const first = await resolveRecallQuerySurface(source, {
      query: "ignored query",
      terms: [" 로-그_인 ", "인증", "로그인"],
    });
    const second = await resolveRecallQuerySurface(source, {
      query: "ignored query",
      terms: [" 로-그_인 ", "인증", "로그인"],
    });
    assert.equal(JSON.stringify(second), JSON.stringify(first));
    return first;
  });

  assert.deepEqual(result, {
    terms: [
      { text: "로-그_인", surfaceNorm: "로그인" },
      { text: "인증", surfaceNorm: "인증" },
      { text: "로그인", surfaceNorm: "로그인" },
    ],
    seeds: [
      { entityId: "e10.0", matchedTerm: "로-그_인", surfaceNorm: "로그인" },
      { entityId: "e3.0", matchedTerm: "로-그_인", surfaceNorm: "로그인" },
    ],
    truncated: false,
  });
  assert.equal(result.seeds.some(({ entityId }) => entityId === "e20.0"), false);
  assertDeepFrozen(result);
  assert.equal(permanentDump(observer), beforeDump);
  assert.equal(observer.pragma("data_version", { simple: true }), beforeVersion);

  await assert.rejects(
    resolveRecallQuerySurface(staleSource, { query: "로그인" }),
    (error) => {
      assert.ok(error instanceof SqliteConnectionError);
      assert.equal(error.code, "RECALL_SNAPSHOT_FAILED");
      assert.equal("cause" in error, false);
      return true;
    },
  );
});

test("surface reads remain on one snapshot across a concurrent WAL commit", async (t) => {
  const { factory } = await fixture();
  t.after(() => factory.close());
  await factory.enqueueWriteTransaction([
    entityCommand("e1.0", SCOPE),
    surfaceCommand(SCOPE, "로그인", "e1.0"),
  ]);
  const service = new RecallSnapshotService(runtime(), createSqliteRecallReadPort(factory));

  const observations = await service.withSnapshot(async (source) => {
    const before = await resolveRecallQuerySurface(source, { query: "로그인" });
    await factory.enqueueWriteTransaction([
      entityCommand("e2.0", SCOPE),
      surfaceCommand(SCOPE, "로그인", "e2.0"),
    ]);
    const after = await resolveRecallQuerySurface(source, { query: "로그인" });
    return { before, after };
  });

  assert.equal(JSON.stringify(observations.after), JSON.stringify(observations.before));
  assert.deepEqual(observations.after.seeds.map(({ entityId }) => entityId), ["e1.0"]);

  const next = await service.withSnapshot((source) =>
    resolveRecallQuerySurface(source, { query: "로그인" }));
  assert.deepEqual(next.seeds.map(({ entityId }) => entityId), ["e1.0", "e2.0"]);
});

test("distinct display terms with one normalized lookup keep order and dedupe only the surface entity pair", async (t) => {
  const { factory } = await fixture();
  t.after(() => factory.close());
  await factory.enqueueWriteTransaction([
    entityCommand("e1.0", SCOPE),
    surfaceCommand(SCOPE, "authserver", "e1.0"),
  ]);

  const result = await new RecallSnapshotService(
    runtime(),
    createSqliteRecallReadPort(factory),
  ).withSnapshot((source) =>
    resolveRecallQuerySurface(source, {
      query: "ignored",
      terms: ["auth-server", "auth_server"],
    }));

  assert.deepEqual(result.terms, [
    { text: "auth-server", surfaceNorm: "authserver" },
    { text: "auth_server", surfaceNorm: "authserver" },
  ]);
  assert.deepEqual(result.seeds, [
    {
      entityId: "e1.0",
      matchedTerm: "auth-server",
      surfaceNorm: "authserver",
    },
  ]);
  assert.equal(result.truncated, false);
});

test("fifty-one canonical matches produce fifty ordered seeds plus a truncation signal", async (t) => {
  const { factory } = await fixture();
  t.after(() => factory.close());
  const ids = Array.from({ length: 51 }, (_, index) => `e${index + 1}.0`);
  await factory.enqueueWriteTransaction([
    ...ids.map((id) => entityCommand(id, SCOPE)),
    entityCommand("e100.0", OTHER_SCOPE),
    ...ids.map((id) => surfaceCommand(SCOPE, "공통", id)),
    surfaceCommand(OTHER_SCOPE, "공통", "e100.0"),
  ]);

  const result = await new RecallSnapshotService(
    runtime(),
    createSqliteRecallReadPort(factory),
  ).withSnapshot((source) =>
    resolveRecallQuerySurface(source, { query: "unused", terms: ["공통"] }));

  assert.equal(result.truncated, true);
  assert.equal(result.seeds.length, 50);
  assert.deepEqual(
    result.seeds.map(({ entityId }) => entityId),
    ids.toSorted().slice(0, 50),
  );
  assert.equal(result.seeds.some(({ entityId }) => entityId === "e100.0"), false);
});

test("corrupt redirect cycles fail with a payload-redacted typed read error and clean snapshot state", async (t) => {
  const { databasePath, factory } = await fixture();
  t.after(() => factory.close());
  const secret = "secret-cycle-surface";
  await factory.enqueueWriteTransaction([
    entityCommand("e1.0", SCOPE),
    entityCommand("e2.0", SCOPE),
    {
      kind: "run",
      sql: "UPDATE entities SET merged_into=? WHERE id=?",
      parameters: ["e2.0", "e1.0"],
    },
    {
      kind: "run",
      sql: "UPDATE entities SET merged_into=? WHERE id=?",
      parameters: ["e1.0", "e2.0"],
    },
    redirectCommand("e1.0", "e2.0"),
    redirectCommand("e2.0", "e1.0"),
    surfaceCommand(SCOPE, "secretcyclesurface", "e1.0"),
  ]);
  const observer = new Database(databasePath, { readonly: true, fileMustExist: true });
  t.after(() => observer.close());
  const beforeDump = permanentDump(observer);
  const beforeVersion = observer.pragma("data_version", { simple: true });
  const service = new RecallSnapshotService(runtime(), createSqliteRecallReadPort(factory));

  await assert.rejects(
    service.withSnapshot((source) =>
      resolveRecallQuerySurface(source, { query: secret })),
    (error) => {
      assert.ok(error instanceof RecallReadError);
      assert.equal(error.code, "INVALID_RECALL_SURFACE_STATE");
      assert.equal("cause" in error, false);
      assert.equal(error.message.includes(secret), false);
      assert.equal(JSON.stringify(error).includes(secret), false);
      return true;
    },
  );

  const cleanNextCall = await service.withSnapshot((source) =>
    resolveRecallQuerySurface(source, { query: "unrelated" }));
  assert.deepEqual(cleanNextCall.seeds, []);
  assert.equal(permanentDump(observer), beforeDump);
  assert.equal(observer.pragma("data_version", { simple: true }), beforeVersion);
});
