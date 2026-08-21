import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, test } from "node:test";

import {
  createSqliteConnectionFactory,
  createSqliteJournalRepository,
  runBundledSqliteMigrations,
  runSqliteStartupGate,
} from "../../../dist/adapters/sqlite/index.js";
import { createDeterministicRuntimeProvider } from "../../support/deterministic-runtime-provider.mjs";
import {
  runEightClientStorageFixture,
  storageFixtureEventId,
} from "../../support/sqlite-mixed-client-fixture.mjs";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const temporaryDirectories = [];
const openFactories = new Set();

afterEach(async () => {
  await Promise.allSettled([...openFactories].map((factory) => factory.close()));
  openFactories.clear();
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

function createReadiness() {
  const root = mkdtempSync(join(tmpdir(), "recall-s20-wal-"));
  temporaryDirectories.push(root);
  const stateDirectory = join(root, "state");
  mkdirSync(stateDirectory, { mode: 0o700 });
  chmodSync(stateDirectory, 0o700);
  const databasePath = join(stateDirectory, "private-memory.sqlite3");
  return { databasePath, readiness: runSqliteStartupGate({ databasePath }) };
}

async function createStorage() {
  const { databasePath, readiness } = createReadiness();
  const factory = await createSqliteConnectionFactory(readiness);
  openFactories.add(factory);
  await runBundledSqliteMigrations(factory, { appliedAtSeconds: 1_700_000_000 });
  return { databasePath, factory };
}

function getRow(result) {
  assert.equal(result.kind, "get");
  assert.notEqual(result.row, null);
  return result.row;
}

async function waitForProductionWriterLock(databasePath) {
  const probe = new Database(databasePath, { fileMustExist: true });
  probe.pragma("busy_timeout = 0");
  const deadline = Date.now() + 5_000;
  try {
    while (Date.now() < deadline) {
      try {
        probe.exec("BEGIN IMMEDIATE");
        probe.exec("ROLLBACK");
      } catch (error) {
        if (error?.code === "SQLITE_BUSY") {
          return;
        }
        throw error;
      }
      await delay(2);
    }
  } finally {
    if (probe.inTransaction) {
      probe.exec("ROLLBACK");
    }
    probe.close();
  }
  throw new Error("production writer did not acquire its transaction before the deadline");
}

test("four WAL readers keep the old complete snapshot until one production writer commits", async (t) => {
  const { databasePath, factory } = await createStorage();
  const baselineId = storageFixtureEventId(900);
  const pendingId = storageFixtureEventId(901);
  const repository = createSqliteJournalRepository({
    factory,
    runtime: createDeterministicRuntimeProvider({
      eventIds: [baselineId],
      nowMilliseconds: 1_700_000_000_000,
      scope: {
        userId: "wal-user",
        projectId: "sto-008",
        scopeKey: "u:wal-user/p:sto-008",
      },
    }),
  });
  await repository.append([
    {
      kind: "statement",
      bodyJson: JSON.stringify({ raw_text: "WAL 기준 문장", parsed: [] }),
    },
  ]);

  const readers = await Promise.all(Array.from({ length: 4 }, () => factory.openReader()));
  t.after(() => Promise.allSettled(readers.map((reader) => reader.close())));
  let writerCommitted = false;
  const pendingBody = JSON.stringify({ raw_text: "WAL 커밋 문장", parsed: [] });
  const write = factory
    .enqueueWriteTransaction([
      {
        kind: "run",
        sql: "INSERT INTO journal(id, scope_key, kind, body, actor, branch, session, created_at) VALUES (?, ?, 'statement', ?, NULL, NULL, NULL, ?)",
        parameters: [pendingId, "u:wal-user/p:sto-008", pendingBody, 1_700_000_001],
      },
      {
        kind: "get",
        sql: "WITH RECURSIVE delay(n) AS (VALUES(0) UNION ALL SELECT n + 1 FROM delay WHERE n < 5000000) SELECT max(n) AS n FROM delay",
      },
    ])
    .then((result) => {
      writerCommitted = true;
      return result;
    });

  await waitForProductionWriterLock(databasePath);
  assert.equal(writerCommitted, false);
  const beforeCommit = await Promise.all(
    readers.map((reader) =>
      reader.query({
        kind: "get",
        sql: "SELECT (SELECT COUNT(*) FROM journal) AS journal_count, (SELECT COUNT(*) FROM journal_fts) AS fts_count",
      }),
    ),
  );
  assert.equal(writerCommitted, false);
  assert.deepEqual(
    beforeCommit.map((result) => getRow(result)),
    Array.from({ length: 4 }, () => ({ journal_count: 1, fts_count: 1 })),
  );

  await write;
  const afterCommit = await Promise.all(
    readers.map((reader) =>
      reader.query({
        kind: "get",
        sql: "SELECT (SELECT COUNT(*) FROM journal) AS journal_count, (SELECT COUNT(*) FROM journal_fts) AS fts_count",
      }),
    ),
  );
  assert.deepEqual(
    afterCommit.map((result) => getRow(result)),
    Array.from({ length: 4 }, () => ({ journal_count: 2, fts_count: 2 })),
  );
});

test("four logical writers and four WAL readers share one server writer without tears or scope leaks", async () => {
  const { factory } = await createStorage();
  const evidence = await runEightClientStorageFixture({
    factory,
    eventsPerWriter: 8,
    firstEventOrdinal: 1_000,
  });

  assert.deepEqual(
    {
      clientCount: evidence.clientCount,
      writerClients: evidence.writerClients,
      readerClients: evidence.readerClients,
      expectedEvents: evidence.expectedEvents,
    },
    { clientCount: 8, writerClients: 4, readerClients: 4, expectedEvents: 32 },
  );
  assert.equal(evidence.readers.length, 4);
  for (const reader of evidence.readers) {
    assert.ok(reader.observations > 0);
    assert.equal(reader.observedBeforeCompletion, true);
    assert.deepEqual(reader.finalSnapshot, {
      journalCount: 32,
      ftsCount: 32,
      fkViolationCount: 0,
      scopeCounts: [8, 8, 8, 8],
    });
  }
  assert.deepEqual(
    evidence.journal.map(({ seq }) => seq),
    Array.from({ length: 32 }, (_, index) => index + 1),
  );
  assert.equal(new Set(evidence.journal.map(({ id }) => id)).size, 32);
  assert.deepEqual(
    evidence.fts.map(({ rowid }) => rowid),
    evidence.journal.map(({ seq }) => seq),
  );
  assert.deepEqual(
    [...new Set(evidence.journal.map(({ scope_key }) => scope_key))].sort(),
    evidence.scopes.map(({ scopeKey }) => scopeKey).sort(),
  );
});
