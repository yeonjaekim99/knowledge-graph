import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";

import {
  SqliteConnectionError,
  createSqliteConnectionFactory,
  createSqliteProjectionReplayService,
  runBundledSqliteMigrations,
  runSqliteStartupGate,
} from "../../../dist/adapters/sqlite/index.js";
import { ProjectionReplayContractError } from "../../../dist/domain/index.js";
import { canonicalProjectionDump } from "../../support/canonical-projection.mjs";
import { storageFixtureEventId } from "../../support/sqlite-mixed-client-fixture.mjs";

const NOW_SECONDS = 1_700_000_000;
const SCOPE_A = "u:projection-a/p:prj-001";
const SCOPE_B = "u:projection-b/p:prj-001";
const EVENT_A1 = storageFixtureEventId(101);
const EVENT_B1 = storageFixtureEventId(102);
const EVENT_A2 = storageFixtureEventId(103);
const lockProbePath = fileURLToPath(
  new URL("./fixtures/prj-001-replay-lock-probe.mjs", import.meta.url),
);
const temporaryDirectories = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

async function createDatabase() {
  const root = mkdtempSync(join(tmpdir(), "recall-prj-001-"));
  temporaryDirectories.push(root);
  const stateDirectory = join(root, "state");
  mkdirSync(stateDirectory, { mode: 0o700 });
  chmodSync(stateDirectory, 0o700);
  const databasePath = join(stateDirectory, "projection.sqlite3");
  const readiness = runSqliteStartupGate({ databasePath });
  const factory = await createSqliteConnectionFactory(readiness);
  await runBundledSqliteMigrations(factory, {
    appliedAtSeconds: NOW_SECONDS,
  });
  return { databasePath, factory };
}

async function query(factory, kind, sql, parameters) {
  const reader = await factory.openReader();
  try {
    return await reader.query({ kind, sql, parameters });
  } finally {
    await reader.close();
  }
}

async function all(factory, sql, parameters) {
  const result = await query(factory, "all", sql, parameters);
  assert.equal(result.kind, "all");
  return result.rows;
}

async function get(factory, sql, parameters) {
  const result = await query(factory, "get", sql, parameters);
  assert.equal(result.kind, "get");
  return result.row;
}

function journalInsert(eventId, scopeKey, rawText, createdAt) {
  return {
    kind: "run",
    sql: [
      "INSERT INTO journal(id, scope_key, kind, body, actor, branch, session, created_at)",
      "VALUES (?, ?, 'statement', ?, 'integration-agent', 'prj-001', NULL, ?)",
    ].join(" "),
    parameters: [
      eventId,
      scopeKey,
      JSON.stringify({
        raw_text: rawText,
        parsed: [],
        provenance: "user_stated",
        ttl: "permanent",
      }),
      createdAt,
    ],
  };
}

async function seedInterleavedJournal(factory) {
  await factory.enqueueWriteTransaction([
    journalInsert(EVENT_A1, SCOPE_A, "scope A first", NOW_SECONDS + 1),
    journalInsert(EVENT_B1, SCOPE_B, "scope B first", NOW_SECONDS + 2),
  ]);
}

async function seedOldProjection(factory) {
  await factory.enqueueWriteTransaction([
    {
      kind: "run",
      sql: "INSERT INTO statements(event_id, scope_key, state, order_seq, created_at, provenance, expires_at) VALUES (?, ?, 'live', 1, ?, 'user_stated', NULL)",
      parameters: [EVENT_A1, SCOPE_A, NOW_SECONDS + 1],
    },
    {
      kind: "run",
      sql: "INSERT INTO statements(event_id, scope_key, state, order_seq, created_at, provenance, expires_at) VALUES (?, ?, 'live', 2, ?, 'user_stated', NULL)",
      parameters: [EVENT_B1, SCOPE_B, NOW_SECONDS + 2],
    },
    {
      kind: "run",
      sql: "INSERT INTO entities(id, scope_key, name, normal_name, kind, merged_into, origin_seq) VALUES ('e-old-a', ?, 'old A', 'olda', NULL, NULL, 1)",
      parameters: [SCOPE_A],
    },
    {
      kind: "run",
      sql: "INSERT INTO entities(id, scope_key, name, normal_name, kind, merged_into, origin_seq) VALUES ('e-old-b', ?, 'old B', 'oldb', NULL, NULL, 2)",
      parameters: [SCOPE_B],
    },
    {
      kind: "run",
      sql: "INSERT INTO id_redirects(old_id, new_id, kind, reason) VALUES ('e-gone-a', 'e-old-a', 'entity', 'rule_change')",
    },
    {
      kind: "run",
      sql: "INSERT INTO id_redirects(old_id, new_id, kind, reason) VALUES ('e-gone-b', 'e-old-b', 'entity', 'rule_change')",
    },
    {
      kind: "run",
      sql: "INSERT INTO projection_meta(scope_key, last_seq, rules_version, rebuilt_at) VALUES (?, 1, 'rules-v1', ?)",
      parameters: [SCOPE_A, NOW_SECONDS + 10],
    },
    {
      kind: "run",
      sql: "INSERT INTO projection_meta(scope_key, last_seq, rules_version, rebuilt_at) VALUES (?, 2, 'rules-v1', ?)",
      parameters: [SCOPE_B, NOW_SECONDS + 10],
    },
  ]);
}

function snapshotFrom(events, scopeKey) {
  const first = events[0];
  if (first === undefined) {
    return {
      statements: [],
      entities: [],
      surfaceForms: [],
      claims: [],
      claimSupport: [],
      idRedirects: [],
    };
  }
  const subjectId = `e${first.seq}.0`;
  const objectId = `e${first.seq}.1`;
  const claimId = `c${first.seq}.0`;
  return {
    statements: events.map((event) => ({
      eventId: event.eventId,
      scopeKey,
      state: "live",
      orderSeq: event.seq,
      createdAt: event.createdAt,
      provenance: "user_stated",
      expiresAt: null,
    })),
    entities: [
      {
        id: objectId,
        scopeKey,
        name: "Object",
        normalName: "object",
        kind: "component",
        mergedInto: null,
        originSeq: first.seq,
      },
      {
        id: subjectId,
        scopeKey,
        name: "Subject",
        normalName: "subject",
        kind: "system",
        mergedInto: null,
        originSeq: first.seq,
      },
    ],
    surfaceForms: [
      {
        scopeKey,
        surfaceNorm: "object",
        entityId: objectId,
        origin: "name",
      },
      {
        scopeKey,
        surfaceNorm: "subject",
        entityId: subjectId,
        origin: "name",
      },
    ],
    claims: [
      {
        id: claimId,
        scopeKey,
        subjectId,
        relation: "uses",
        objectId,
        objectValue: null,
        state: "active",
        originSeq: first.seq,
        firstSeenAt: first.createdAt,
        lastSeenAt: first.createdAt,
      },
    ],
    claimSupport: [
      {
        claimId,
        eventId: first.eventId,
        draftIndex: 0,
        live: 1,
        expiresAt: null,
      },
    ],
    idRedirects: [
      {
        oldId: scopeKey === SCOPE_A ? "e-obsolete-a" : "e-obsolete-b",
        newId: subjectId,
        kind: "entity",
        reason: "rule_change",
      },
    ],
  };
}

function databaseTables(snapshot) {
  return {
    statements: {
      primaryKey: ["event_id"],
      rows: snapshot.statements.map((row) => ({
        event_id: row.eventId,
        scope_key: row.scopeKey,
        state: row.state,
        order_seq: row.orderSeq,
        created_at: row.createdAt,
        provenance: row.provenance,
        expires_at: row.expiresAt,
      })),
    },
    entities: {
      primaryKey: ["id"],
      rows: snapshot.entities.map((row) => ({
        id: row.id,
        scope_key: row.scopeKey,
        name: row.name,
        normal_name: row.normalName,
        kind: row.kind,
        merged_into: row.mergedInto,
        origin_seq: row.originSeq,
      })),
    },
    surface_forms: {
      primaryKey: ["scope_key", "surface_norm", "entity_id"],
      rows: snapshot.surfaceForms.map((row) => ({
        scope_key: row.scopeKey,
        surface_norm: row.surfaceNorm,
        entity_id: row.entityId,
        origin: row.origin,
      })),
    },
    claims: {
      primaryKey: ["id"],
      rows: snapshot.claims.map((row) => ({
        id: row.id,
        scope_key: row.scopeKey,
        subject_id: row.subjectId,
        relation: row.relation,
        object_id: row.objectId,
        object_value: row.objectValue,
        state: row.state,
        origin_seq: row.originSeq,
        first_seen_at: row.firstSeenAt,
        last_seen_at: row.lastSeenAt,
      })),
    },
    claim_support: {
      primaryKey: ["claim_id", "event_id"],
      rows: snapshot.claimSupport.map((row) => ({
        claim_id: row.claimId,
        event_id: row.eventId,
        draft_index: row.draftIndex,
        live: row.live,
        expires_at: row.expiresAt,
      })),
    },
    id_redirects: {
      primaryKey: ["old_id"],
      rows: snapshot.idRedirects.map((row) => ({
        old_id: row.oldId,
        new_id: row.newId,
        kind: row.kind,
        reason: row.reason,
      })),
    },
  };
}

function transactionFailure(error) {
  assert.ok(error instanceof SqliteConnectionError);
  assert.equal(error.code, "SQLITE_TRANSACTION_FAILED");
  assert.equal(error.retryable, false);
  assert.equal("cause" in error, false);
  return true;
}

test("scope replay holds one writer transaction, replaces only its scope, and publishes deterministic meta", async () => {
  const { databasePath, factory } = await createDatabase();
  try {
    await seedInterleavedJournal(factory);
    await seedOldProjection(factory);
    const service = createSqliteProjectionReplayService({ factory });
    let receivedEvents;

    const result = await service.replay({
      scopeKey: SCOPE_A,
      rulesVersion: "rules-v2",
      rebuiltAt: NOW_SECONDS + 20,
      reducer(input) {
        receivedEvents = input.events;
        const probe = JSON.parse(
          execFileSync(
            process.execPath,
            [lockProbePath, databasePath, SCOPE_A],
            { encoding: "utf8" },
          ),
        );
        assert.equal(probe.oldProjectionCount, 1);
        assert.match(probe.writeCode, /^SQLITE_BUSY/u);
        return snapshotFrom(input.events, input.scopeKey);
      },
    });

    assert.deepEqual(receivedEvents.map(({ seq }) => seq), [1]);
    assert.deepEqual(result, {
      status: "replayed",
      reason: "rules_version_changed",
      scopeKey: SCOPE_A,
      rulesVersion: "rules-v2",
      lastSeq: 1,
      eventCount: 1,
      projectionRowCount: 8,
    });
    assert.deepEqual(
      await all(
        factory,
        "SELECT id, name FROM entities WHERE scope_key = ? ORDER BY id",
        [SCOPE_A],
      ),
      [
        { id: "e1.0", name: "Subject" },
        { id: "e1.1", name: "Object" },
      ],
    );
    assert.deepEqual(
      await all(
        factory,
        "SELECT id, name FROM entities WHERE scope_key = ? ORDER BY id",
        [SCOPE_B],
      ),
      [{ id: "e-old-b", name: "old B" }],
    );
    assert.deepEqual(
      await all(factory, "SELECT old_id, new_id FROM id_redirects ORDER BY old_id"),
      [
        { old_id: "e-gone-b", new_id: "e-old-b" },
        { old_id: "e-obsolete-a", new_id: "e1.0" },
      ],
    );
    assert.deepEqual(
      await get(
        factory,
        "SELECT last_seq, rules_version, rebuilt_at FROM projection_meta WHERE scope_key = ?",
        [SCOPE_A],
      ),
      {
        last_seq: 1,
        rules_version: "rules-v2",
        rebuilt_at: NOW_SECONDS + 20,
      },
    );
    assert.deepEqual(
      await get(
        factory,
        "SELECT COUNT(*) AS journal_count, (SELECT COUNT(*) FROM journal_fts) AS fts_count, (SELECT COUNT(*) FROM pragma_foreign_key_check) AS fk_count FROM journal",
      ),
      { journal_count: 2, fts_count: 2, fk_count: 0 },
    );
  } finally {
    await factory.close();
  }
});

test("missing, sequence, and rules metadata force replay while an exact meta row skips the reducer", async () => {
  const { factory } = await createDatabase();
  try {
    await seedInterleavedJournal(factory);
    const service = createSqliteProjectionReplayService({ factory });
    let calls = 0;
    const reducer = (input) => {
      calls += 1;
      return snapshotFrom(input.events, input.scopeKey);
    };

    const missing = await service.replay({
      scopeKey: SCOPE_A,
      rulesVersion: "rules-v1",
      rebuiltAt: NOW_SECONDS + 30,
      reducer,
    });
    assert.equal(missing.status, "replayed");
    assert.equal(missing.reason, "missing_meta");
    assert.equal(calls, 1);

    const current = await service.replay({
      scopeKey: SCOPE_A,
      rulesVersion: "rules-v1",
      rebuiltAt: NOW_SECONDS + 31,
      reducer() {
        throw new Error("current projection must not invoke reducer");
      },
    });
    assert.equal(current.status, "current");
    assert.equal(current.reason, null);
    assert.equal(calls, 1);

    await factory.enqueueWriteTransaction([
      journalInsert(EVENT_A2, SCOPE_A, "scope A second", NOW_SECONDS + 3),
    ]);
    const sequence = await service.replay({
      scopeKey: SCOPE_A,
      rulesVersion: "rules-v1",
      rebuiltAt: NOW_SECONDS + 32,
      reducer,
    });
    assert.equal(sequence.reason, "journal_sequence_changed");
    assert.equal(sequence.lastSeq, 3);
    assert.equal(sequence.eventCount, 2);
    assert.equal(calls, 2);

    const rules = await service.replay({
      scopeKey: SCOPE_A,
      rulesVersion: "rules-v2",
      rebuiltAt: NOW_SECONDS + 33,
      reducer,
    });
    assert.equal(rules.reason, "rules_version_changed");
    assert.equal(calls, 3);

    const empty = await service.replay({
      scopeKey: "u:empty/p:prj-001",
      rulesVersion: "rules-v2",
      rebuiltAt: NOW_SECONDS + 34,
      reducer,
    });
    assert.equal(empty.reason, "missing_meta");
    assert.equal(empty.lastSeq, 0);
    assert.equal(empty.eventCount, 0);
    assert.equal(empty.projectionRowCount, 0);
  } finally {
    await factory.close();
  }
});

test("a projection failure after scope deletion rolls back rows and meta before a successful retry", async () => {
  const { factory } = await createDatabase();
  try {
    await seedInterleavedJournal(factory);
    await seedOldProjection(factory);
    const service = createSqliteProjectionReplayService({ factory });
    const beforeRows = await all(
      factory,
      "SELECT id, name FROM entities ORDER BY id",
    );
    const beforeMeta = await all(
      factory,
      "SELECT scope_key, last_seq, rules_version, rebuilt_at FROM projection_meta ORDER BY scope_key",
    );
    await factory.enqueueWriteTransaction([
      {
        kind: "exec",
        sql: [
          "CREATE TRIGGER prj_001_abort BEFORE INSERT ON entities",
          `WHEN new.scope_key = '${SCOPE_A}'`,
          "BEGIN SELECT RAISE(ABORT, 'projection replay abort'); END",
        ].join(" "),
      },
    ]);

    await assert.rejects(
      service.replay({
        scopeKey: SCOPE_A,
        rulesVersion: "rules-v2",
        rebuiltAt: NOW_SECONDS + 40,
        reducer: (input) => snapshotFrom(input.events, input.scopeKey),
      }),
      transactionFailure,
    );
    assert.deepEqual(
      await all(factory, "SELECT id, name FROM entities ORDER BY id"),
      beforeRows,
    );
    assert.deepEqual(
      await all(
        factory,
        "SELECT scope_key, last_seq, rules_version, rebuilt_at FROM projection_meta ORDER BY scope_key",
      ),
      beforeMeta,
    );

    await factory.enqueueWriteTransaction([
      { kind: "exec", sql: "DROP TRIGGER prj_001_abort" },
    ]);
    const retried = await service.replay({
      scopeKey: SCOPE_A,
      rulesVersion: "rules-v2",
      rebuiltAt: NOW_SECONDS + 41,
      reducer: (input) => snapshotFrom(input.events, input.scopeKey),
    });
    assert.equal(retried.status, "replayed");
    assert.deepEqual(
      await all(
        factory,
        "SELECT id FROM entities WHERE scope_key = ? ORDER BY id",
        [SCOPE_A],
      ),
      [{ id: "e1.0" }, { id: "e1.1" }],
    );
  } finally {
    await factory.close();
  }
});

test("invalid reducer output rolls back the held writer session and the queue remains usable", async () => {
  const { factory } = await createDatabase();
  try {
    await seedInterleavedJournal(factory);
    const service = createSqliteProjectionReplayService({ factory });
    await assert.rejects(
      service.replay({
        scopeKey: SCOPE_A,
        rulesVersion: "rules-v1",
        rebuiltAt: NOW_SECONDS + 45,
        reducer() {
          return {
            statements: [],
            entities: [
              {
                id: "e-cross-scope",
                scopeKey: SCOPE_B,
                name: "wrong",
                normalName: "wrong",
                kind: null,
                mergedInto: null,
                originSeq: 1,
              },
            ],
            surfaceForms: [],
            claims: [],
            claimSupport: [],
            idRedirects: [],
          };
        },
      }),
      (error) => {
        assert.ok(error instanceof ProjectionReplayContractError);
        assert.equal(error.code, "SCOPE_MISMATCH");
        return true;
      },
    );

    const appended = await factory.enqueueWriteTransaction([
      journalInsert(EVENT_A2, SCOPE_A, "queue remains usable", NOW_SECONDS + 3),
    ]);
    assert.equal(appended[0].kind, "run");
    const retried = await service.replay({
      scopeKey: SCOPE_A,
      rulesVersion: "rules-v1",
      rebuiltAt: NOW_SECONDS + 46,
      reducer: (input) => snapshotFrom(input.events, input.scopeKey),
    });
    assert.equal(retried.status, "replayed");
    assert.equal(retried.lastSeq, 3);
  } finally {
    await factory.close();
  }
});

test("production canonical dump matches the independent format and excludes meta, FTS, and other scopes", async () => {
  const { factory } = await createDatabase();
  try {
    await seedInterleavedJournal(factory);
    const service = createSqliteProjectionReplayService({ factory });
    let expectedSnapshot;
    await service.replay({
      scopeKey: SCOPE_A,
      rulesVersion: "rules-v1",
      rebuiltAt: NOW_SECONDS + 50,
      reducer(input) {
        expectedSnapshot = snapshotFrom(input.events, input.scopeKey);
        return expectedSnapshot;
      },
    });
    await service.replay({
      scopeKey: SCOPE_B,
      rulesVersion: "rules-v9",
      rebuiltAt: NOW_SECONDS + 51,
      reducer: (input) => snapshotFrom(input.events, input.scopeKey),
    });

    const independent = canonicalProjectionDump(databaseTables(expectedSnapshot));
    const first = await service.canonicalDump(SCOPE_A);
    assert.equal(first.format, independent.format);
    assert.equal(first.tableCount, independent.table_count);
    assert.equal(first.rowCount, independent.row_count);
    assert.equal(first.canonical, independent.canonical);
    assert.equal(first.checksum, independent.checksum);
    assert.equal(first.scopeKey, SCOPE_A);

    await factory.enqueueWriteTransaction([
      {
        kind: "run",
        sql: "UPDATE projection_meta SET rebuilt_at = ? WHERE scope_key = ?",
        parameters: [NOW_SECONDS + 999, SCOPE_A],
      },
      journalInsert(storageFixtureEventId(104), SCOPE_B, "other scope", NOW_SECONDS + 4),
    ]);
    const second = await service.canonicalDump(SCOPE_A);
    assert.deepEqual(second, first);
  } finally {
    await factory.close();
  }
});
