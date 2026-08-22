import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import Database from "better-sqlite3";

import { RecallReadError } from "../../../dist/application/ports/recall-read-port.js";
import { RecallSnapshotService } from "../../../dist/application/recall-snapshot-service.js";
import {
  RECALL_SNAPSHOT_SQL_SOURCE,
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

function eventId(seq) {
  return `ev_${String(seq).padStart(26, "0")}`;
}

function runtime(scopeKey = SCOPE, evaluationNow = NOW) {
  const [, userId, projectId] = /^u:([^/]+)\/p:(.+)$/u.exec(scopeKey) ?? [];
  return createDeterministicRuntimeProvider({
    nowMilliseconds: evaluationNow * 1_000,
    scope: { userId, projectId, scopeKey },
  });
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "recall-rcl-001-"));
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

function statementCommands({
  seq,
  scopeKey,
  claimId,
  subjectId,
  objectId,
  createdAt,
  expiresAt,
  claimLastSeenAt = createdAt + 999,
  relationLabel = null,
}) {
  const parsed = [
    {
      subject: subjectId,
      relation: "uses",
      object: objectId,
      ...(relationLabel === null ? {} : { relation_label: relationLabel }),
    },
  ];
  return [
    {
      kind: "run",
      sql: "INSERT INTO journal(seq,id,scope_key,kind,body,actor,branch,session,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
      parameters: [
        seq,
        eventId(seq),
        scopeKey,
        "statement",
        JSON.stringify({ raw_text: `fixture-${seq}`, parsed, provenance: "observed", ttl: expiresAt === null ? "permanent" : "session" }),
        null,
        null,
        null,
        createdAt,
      ],
    },
    {
      kind: "run",
      sql: "INSERT INTO statements(event_id,scope_key,state,order_seq,created_at,provenance,expires_at) VALUES (?,?,?,?,?,?,?)",
      parameters: [eventId(seq), scopeKey, "live", seq, createdAt, "observed", expiresAt],
    },
    {
      kind: "run",
      sql: "INSERT INTO entities(id,scope_key,name,normal_name,kind,merged_into,origin_seq) VALUES (?,?,?,?,NULL,NULL,?)",
      parameters: [subjectId, scopeKey, `subject-${seq}`, `subject-${seq}`, seq],
    },
    {
      kind: "run",
      sql: "INSERT INTO entities(id,scope_key,name,normal_name,kind,merged_into,origin_seq) VALUES (?,?,?,?,NULL,NULL,?)",
      parameters: [objectId, scopeKey, `object-${seq}`, `object-${seq}`, seq],
    },
    {
      kind: "run",
      sql: "INSERT INTO claims(id,scope_key,subject_id,relation,object_id,object_value,state,origin_seq,first_seen_at,last_seen_at) VALUES (?,?,?,?,?,NULL,'active',?,?,?)",
      parameters: [claimId, scopeKey, subjectId, "uses", objectId, seq, createdAt, claimLastSeenAt],
    },
    {
      kind: "run",
      sql: "INSERT INTO claim_support(claim_id,event_id,draft_index,live,expires_at) VALUES (?,?,0,1,?)",
      parameters: [claimId, eventId(seq), expiresAt],
    },
  ];
}

async function seed(factory) {
  await factory.enqueueWriteTransaction([
    ...statementCommands({
      seq: 1,
      scopeKey: SCOPE,
      claimId: "c1.0",
      subjectId: "e1.0",
      objectId: "e1.1",
      createdAt: NOW - 100,
      expiresAt: null,
      claimLastSeenAt: NOW + 9_999,
      relationLabel: "사용",
    }),
    ...statementCommands({
      seq: 2,
      scopeKey: SCOPE,
      claimId: "c2.0",
      subjectId: "e2.0",
      objectId: "e2.1",
      createdAt: NOW - 43_200,
      expiresAt: NOW,
    }),
    ...statementCommands({
      seq: 3,
      scopeKey: OTHER_SCOPE,
      claimId: "c3.0",
      subjectId: "e3.0",
      objectId: "e3.1",
      createdAt: NOW - 50,
      expiresAt: null,
    }),
  ]);
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

function readError(code) {
  return (error) => {
    assert.ok(error instanceof RecallReadError);
    assert.equal(error.code, code);
    assert.equal("cause" in error, false);
    return true;
  };
}

test("one parameterized source explicitly aliases aggregate columns and exposes only TEMP-valid rows", async (t) => {
  const { factory } = await fixture();
  t.after(() => factory.close());
  await seed(factory);

  assert.equal(Object.isFrozen(RECALL_SNAPSHOT_SQL_SOURCE), true);
  assert.match(RECALL_SNAPSHOT_SQL_SOURCE.createTempAggregate, /:scope_key/u);
  assert.match(RECALL_SNAPSHOT_SQL_SOURCE.createTempAggregate, /:now/u);
  for (const alias of [
    "claim_id",
    "support_count",
    "strongest_rank",
    "last_seen_at",
    "relation_label",
    "effective_expires_at",
  ]) {
    assert.match(
      RECALL_SNAPSHOT_SQL_SOURCE.createTempAggregate,
      new RegExp(`AS ${alias}\\b`, "u"),
    );
  }
  assert.match(
    RECALL_SNAPSHOT_SQL_SOURCE.selectValidClaimAggregates,
    /FROM temp\.recall_claim_agg AS recall_agg/u,
  );

  const service = new RecallSnapshotService(
    runtime(),
    createSqliteRecallReadPort(factory),
  );
  const rows = await service.withSnapshot((source) =>
    source.listValidClaimAggregates(),
  );

  assert.deepEqual(rows, [
    {
      claimId: "c1.0",
      supportCount: 1,
      strongestRank: 2,
      lastSeenAt: NOW - 100,
      relationLabel: "사용",
      effectiveExpiresAt: null,
    },
  ]);
  assert.equal(Object.isFrozen(rows), true);
  assert.equal(Object.isFrozen(rows[0]), true);

  const otherRows = await new RecallSnapshotService(
    runtime(OTHER_SCOPE),
    createSqliteRecallReadPort(factory),
  ).withSnapshot((source) => source.listValidClaimAggregates());
  assert.deepEqual(otherRows.map((row) => row.claimId), ["c3.0"]);
});

test("the same deferred read transaction and fixed now survive a concurrent WAL commit", async (t) => {
  const { factory } = await fixture();
  t.after(() => factory.close());
  await seed(factory);

  const service = new RecallSnapshotService(
    runtime(),
    createSqliteRecallReadPort(factory),
  );
  const observations = await service.withSnapshot(async (source) => {
    const before = await source.listValidClaimAggregates();
    await factory.enqueueWriteTransaction([
      {
        kind: "run",
        sql: "UPDATE claims SET state='retracted' WHERE id=?",
        parameters: ["c1.0"],
      },
    ]);
    const after = await source.listValidClaimAggregates();
    return { before, after };
  });

  assert.deepEqual(observations.before, observations.after);
  assert.deepEqual(observations.after.map((row) => row.claimId), ["c1.0"]);

  const nextCall = await new RecallSnapshotService(
    runtime(),
    createSqliteRecallReadPort(factory),
  ).withSnapshot((source) => source.listValidClaimAggregates());
  assert.deepEqual(nextCall, []);

  const justBeforeExpiry = await new RecallSnapshotService(
    runtime(SCOPE, NOW - 1),
    createSqliteRecallReadPort(factory),
  ).withSnapshot((source) => source.listValidClaimAggregates());
  assert.deepEqual(justBeforeExpiry.map((row) => row.claimId), ["c2.0"]);
});

test("TEMP materialization and cleanup never change persistent product state or external data_version", async (t) => {
  const { databasePath, factory } = await fixture();
  t.after(() => factory.close());
  await seed(factory);

  const observer = new Database(databasePath, { readonly: true, fileMustExist: true });
  t.after(() => observer.close());
  const beforeDump = permanentDump(observer);
  const beforeVersion = observer.pragma("data_version", { simple: true });

  const port = createSqliteRecallReadPort(factory);
  let staleSource = null;
  await new RecallSnapshotService(runtime(), port).withSnapshot(async (source) => {
    staleSource = source;
    await source.listValidClaimAggregates();
    await source.listValidClaimAggregates();
  });
  await assert.rejects(staleSource.listValidClaimAggregates(), (error) => {
    assert.ok(error instanceof SqliteConnectionError);
    assert.equal(error.code, "RECALL_SNAPSHOT_FAILED");
    assert.equal("cause" in error, false);
    return true;
  });
  await assert.rejects(
    new RecallSnapshotService(runtime(), port).withSnapshot(async (source) => {
      await source.listValidClaimAggregates();
      throw new Error("consumer-failure");
    }),
    /consumer-failure/u,
  );

  assert.equal(permanentDump(observer), beforeDump);
  assert.equal(observer.pragma("data_version", { simple: true }), beforeVersion);
  assert.deepEqual(
    await new RecallSnapshotService(runtime(), port).withSnapshot((source) =>
      source.listValidClaimAggregates(),
    ),
    [
      {
        claimId: "c1.0",
        supportCount: 1,
        strongestRank: 2,
        lastSeenAt: NOW - 100,
        relationLabel: "사용",
        effectiveExpiresAt: null,
      },
    ],
  );
});

test("invalid scope and aggregate corruption fail closed without echoing payloads", async (t) => {
  const { factory } = await fixture();
  t.after(() => factory.close());
  await factory.enqueueWriteTransaction(
    statementCommands({
      seq: 9,
      scopeKey: SCOPE,
      claimId: "secret-corrupt-claim-id",
      subjectId: "e9.0",
      objectId: "e9.1",
      createdAt: NOW - 1,
      expiresAt: null,
    }),
  );
  const port = createSqliteRecallReadPort(factory);

  await assert.rejects(
    port.withSnapshot(
      { scopeKey: "u:alice/p:recall' OR 1=1 --", evaluationNow: NOW },
      async () => null,
    ),
    readError("INVALID_RECALL_CONTEXT"),
  );

  await assert.rejects(
    new RecallSnapshotService(runtime(), port).withSnapshot((source) =>
      source.listValidClaimAggregates(),
    ),
    (error) => {
      assert.ok(readError("INVALID_RECALL_AGGREGATE")(error));
      assert.doesNotMatch(error.message, /secret-corrupt-claim-id/u);
      assert.equal(
        JSON.stringify(error).includes("secret-corrupt-claim-id"),
        false,
      );
      return true;
    },
  );
});
