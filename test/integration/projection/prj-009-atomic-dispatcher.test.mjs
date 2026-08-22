import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  SqliteProjectionDispatcherError,
  createSqliteConnectionFactory,
  createSqliteProjectionDispatcher,
  runBundledSqliteMigrations,
  runSqliteStartupGate,
} from "../../../dist/adapters/sqlite/index.js";
import { createDeterministicRuntimeProvider } from "../../support/deterministic-runtime-provider.mjs";

const NOW = 1_700_000_000;
const SCOPE = Object.freeze({
  userId: "projection-user",
  projectId: "prj-009",
  scopeKey: "u:projection-user/p:prj-009",
});
const OTHER_SCOPE = "u:other-user/p:prj-009";
const temporaryDirectories = [];
const openFactories = new Set();

function eventId(suffix) {
  return `ev_${"0".repeat(25)}${suffix}`;
}

function statement(rawText, parsed, supersedes) {
  const body = {
    raw_text: rawText,
    parsed,
    provenance: "user_stated",
    ttl: "permanent",
  };
  if (supersedes !== undefined) {
    body.supersedes = supersedes;
  }
  return { kind: "statement", bodyJson: JSON.stringify(body) };
}

function decision(kind, body) {
  return { kind, bodyJson: JSON.stringify(body) };
}

afterEach(async () => {
  await Promise.allSettled([...openFactories].map((factory) => factory.close()));
  openFactories.clear();
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

async function createStore({ eventIds, rulesVersion = "rules-v1" }) {
  const root = mkdtempSync(join(tmpdir(), "recall-prj-009-"));
  temporaryDirectories.push(root);
  const stateDirectory = join(root, "state");
  mkdirSync(stateDirectory, { mode: 0o700 });
  chmodSync(stateDirectory, 0o700);
  const readiness = runSqliteStartupGate({
    databasePath: join(stateDirectory, "projection.sqlite3"),
  });
  const factory = await createSqliteConnectionFactory(readiness);
  openFactories.add(factory);
  await runBundledSqliteMigrations(factory, { appliedAtSeconds: NOW - 1 });
  const runtime = createDeterministicRuntimeProvider({
    nowMilliseconds: NOW * 1_000,
    eventIds,
    rulesVersion,
    scope: SCOPE,
    metadata: {
      actor: "integration-agent",
      branch: "prj-009",
      session: null,
    },
  });
  return {
    factory,
    dispatcher: createSqliteProjectionDispatcher({ factory, runtime }),
  };
}

async function rows(factory, sql, parameters = []) {
  const reader = await factory.openReader();
  try {
    const result = await reader.query({ kind: "all", sql, parameters });
    assert.equal(result.kind, "all");
    return result.rows;
  } finally {
    await reader.close();
  }
}

async function row(factory, sql, parameters = []) {
  const reader = await factory.openReader();
  try {
    const result = await reader.query({ kind: "get", sql, parameters });
    assert.equal(result.kind, "get");
    return result.row;
  } finally {
    await reader.close();
  }
}

test("journal, FTS, projection and meta commit atomically across incremental and replay routes", async () => {
  const ids = ["1", "2", "3", "4", "5", "6", "7", "8"].map(eventId);
  const { factory, dispatcher } = await createStore({ eventIds: ids });
  await factory.enqueueWriteTransaction([
    {
      kind: "run",
      sql: "INSERT INTO entities(id, scope_key, name, normal_name, kind, merged_into, origin_seq) VALUES ('e99.0', ?, 'sentinel', 'sentinel', NULL, NULL, 99)",
      parameters: [OTHER_SCOPE],
    },
  ]);
  const alreadyOpenReader = await factory.openReader();
  try {
    const first = await dispatcher.execute([
      statement("auth uses db", [
        {
          subject: "Auth Server",
          subject_kind: "service",
          subject_aliases: ["Auth"],
          relation: "uses",
          object: "Database",
        },
      ]),
    ]);
    assert.equal(first.mode, "replay");
    assert.equal(first.reason, "missing_meta");
    assert.deepEqual(first.events, [{ index: 0, eventId: ids[0], seq: 1 }]);

    const sameReaderResult = await alreadyOpenReader.query({
      kind: "get",
      sql: "SELECT state FROM claims WHERE id='c1.0'",
    });
    assert.deepEqual(sameReaderResult.row, { state: "active" });
    assert.deepEqual(
      await rows(
        factory,
        "SELECT rowid FROM journal_fts WHERE journal_fts MATCH 'auth' ORDER BY rowid",
      ),
      [{ rowid: 1 }],
    );

    const second = await dispatcher.execute([
      statement("auth api mode", [
        {
          subject: "Auth API",
          subject_kind: "api",
          relation: "describes",
          object_value: "mode-one",
        },
      ]),
    ]);
    assert.equal(second.mode, "incremental");
    assert.equal(second.reason, "safe_suffix");

    const alias = await dispatcher.execute([
      decision("alias", { surface: "login", entity_id: "e1.0" }),
    ]);
    assert.equal(alias.mode, "incremental");

    const viaAlias = await dispatcher.execute([
      statement("login uses cache", [
        { subject: "login", relation: "uses", object: "Cache" },
      ]),
    ]);
    assert.equal(viaAlias.mode, "incremental");
    assert.equal(
      (await row(factory, "SELECT subject_id FROM claims WHERE id='c4.0'"))
        .subject_id,
      "e1.0",
    );

    const merge = await dispatcher.execute([
      decision("merge", { keep: "e2.0", absorb: "e1.0" }),
    ]);
    assert.equal(merge.mode, "incremental");
    assert.equal(
      (await row(factory, "SELECT kind FROM entities WHERE id='e2.0'"))?.kind,
      "service",
      "the earliest live kind survives an explicit later keep",
    );

    const retraction = await dispatcher.execute([
      decision("retraction", {
        target: { claim_id: "c1.0" },
        note: "obsolete",
      }),
    ]);
    assert.equal(retraction.mode, "incremental");
    assert.equal(
      (await row(factory, "SELECT state FROM claims WHERE id='c1.0'"))?.state,
      "retracted",
    );

    const reinterpret = await dispatcher.execute([
      statement(
        "auth api mode",
        [
          {
            subject: "Auth API",
            relation: "describes",
            object_value: "mode-two",
          },
        ],
        ids[1],
      ),
    ]);
    assert.equal(reinterpret.mode, "replay");
    assert.equal(reinterpret.reason, "historical_event");

    const retractAlias = await dispatcher.execute([
      decision("retraction", { target: { event_id: ids[2] } }),
    ]);
    assert.equal(retractAlias.mode, "replay");
    assert.equal(retractAlias.reason, "historical_event");

    assert.deepEqual(
      await row(
        factory,
        "SELECT last_seq, rules_version FROM projection_meta WHERE scope_key=?",
        [SCOPE.scopeKey],
      ),
      { last_seq: 8, rules_version: "rules-v1" },
    );
    assert.deepEqual(
      await rows(factory, "SELECT id FROM entities WHERE scope_key=?", [OTHER_SCOPE]),
      [{ id: "e99.0" }],
      "scope replay never replaces another scope",
    );
    assert.equal(
      (await row(
        factory,
        "SELECT COUNT(*) AS count FROM claims c WHERE c.scope_key=? AND c.state='active' AND NOT EXISTS (SELECT 1 FROM claim_support cs JOIN statements s ON s.event_id=cs.event_id WHERE cs.claim_id=c.id AND cs.live=1 AND s.state='live')",
        [SCOPE.scopeKey],
      ))?.count,
      0,
    );
  } finally {
    await alreadyOpenReader.close();
  }
});

test("a projection failure rolls journal and FTS back and leaves the writer queue reusable", async () => {
  const { factory, dispatcher } = await createStore({
    eventIds: [eventId("1"), eventId("2"), eventId("3")],
  });
  await factory.enqueueWriteTransaction([
    {
      kind: "exec",
      sql: "CREATE TRIGGER prj009_fail_claim BEFORE INSERT ON claims BEGIN SELECT RAISE(ABORT, 'projection failure'); END",
    },
  ]);

  await assert.rejects(
    dispatcher.execute([
      statement("must rollback", [
        { subject: "A", relation: "uses", object: "B" },
      ]),
      decision("alias", { surface: "A alias", entity_id: "e1.0" }),
    ]),
    (error) => {
      assert.equal(error.code, "SQLITE_TRANSACTION_FAILED");
      assert.doesNotMatch(String(error), /projection failure/u);
      return true;
    },
  );
  assert.deepEqual(await rows(factory, "SELECT seq FROM journal"), []);
  assert.deepEqual(await rows(factory, "SELECT rowid FROM journal_fts"), []);
  assert.deepEqual(await rows(factory, "SELECT scope_key FROM projection_meta"), []);

  await factory.enqueueWriteTransaction([
    { kind: "exec", sql: "DROP TRIGGER prj009_fail_claim" },
  ]);
  const retry = await dispatcher.execute([
    statement("retry succeeds", [
      { subject: "A", relation: "uses", object: "B" },
    ]),
  ]);
  assert.deepEqual(retry.events, [
    { index: 0, eventId: eventId("3"), seq: 1 },
  ]);
  assert.equal(retry.mode, "replay");
});

test("meta drift and projection invariant drift force a scope replay before success", async () => {
  const { factory, dispatcher } = await createStore({
    eventIds: [eventId("1")],
  });
  await dispatcher.execute([
    statement("root", [{ subject: "A", relation: "uses", object: "B" }]),
  ]);
  const rulesV2 = createSqliteProjectionDispatcher({
    factory,
    runtime: createDeterministicRuntimeProvider({
      nowMilliseconds: (NOW + 1) * 1_000,
      eventIds: [eventId("2"), eventId("3"), eventId("4")],
      rulesVersion: "rules-v2",
      scope: SCOPE,
    }),
  });
  const upgraded = await rulesV2.execute([
    decision("alias", { surface: "version alias", entity_id: "e1.0" }),
  ]);
  assert.equal(upgraded.mode, "replay");
  assert.equal(upgraded.reason, "rules_version_changed");
  await factory.enqueueWriteTransaction([
    {
      kind: "run",
      sql: "UPDATE projection_meta SET last_seq=0 WHERE scope_key=?",
      parameters: [SCOPE.scopeKey],
    },
  ]);
  const caughtUp = await rulesV2.execute([
    decision("alias", { surface: "root alias", entity_id: "e1.0" }),
  ]);
  assert.equal(caughtUp.mode, "replay");
  assert.equal(caughtUp.reason, "journal_sequence_changed");

  await factory.enqueueWriteTransaction([
    {
      kind: "run",
      sql: "UPDATE claim_support SET live=0 WHERE claim_id='c1.0'",
    },
  ]);
  const repaired = await rulesV2.execute([
    decision("alias", { surface: "second alias", entity_id: "e1.0" }),
  ]);
  assert.equal(repaired.mode, "replay");
  assert.equal(repaired.reason, "projection_invariant_failed");
  assert.equal(
    (await row(factory, "SELECT live FROM claim_support WHERE claim_id='c1.0'"))
      ?.live,
    1,
  );
});

test("an event ID collision retries the whole atomic dispatch without a seq hole", async () => {
  const collision = eventId("1");
  const fresh = eventId("2");
  const { factory, dispatcher } = await createStore({
    eventIds: [collision, fresh],
  });
  await factory.enqueueWriteTransaction([
    {
      kind: "run",
      sql: "INSERT INTO journal(id, scope_key, kind, body, actor, branch, session, created_at) VALUES (?, ?, 'statement', ?, NULL, NULL, NULL, ?)",
      parameters: [
        collision,
        SCOPE.scopeKey,
        JSON.stringify({
          raw_text: "existing",
          parsed: [],
          provenance: "user_stated",
          ttl: "permanent",
        }),
        NOW - 1,
      ],
    },
  ]);
  const receipt = await dispatcher.execute([
    statement("fresh", [{ subject: "A", relation: "uses", object: "B" }]),
  ]);
  assert.deepEqual(receipt.events, [{ index: 0, eventId: fresh, seq: 2 }]);
  assert.deepEqual(await rows(factory, "SELECT seq FROM journal ORDER BY seq"), [
    { seq: 1 },
    { seq: 2 },
  ]);
});

test("SQLite exposes one internal atomic journal and projection dispatcher", () => {
  assert.equal(typeof createSqliteProjectionDispatcher, "function");
  assert.equal(typeof SqliteProjectionDispatcherError, "function");
});
