import assert from "node:assert/strict";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, test } from "node:test";

import {
  SQLITE_CONNECTION_POLICY,
  SqliteBusyError,
  SqliteConnectionError,
  createSqliteConnectionFactory,
  openSqliteReader,
  runSqliteStartupGate,
} from "../../../dist/adapters/sqlite/index.js";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const temporaryDirectories = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

function createReadiness() {
  const root = mkdtempSync(join(tmpdir(), "recall-sto-002-"));
  temporaryDirectories.push(root);
  const stateDirectory = join(root, "state");
  mkdirSync(stateDirectory, { mode: 0o700 });
  chmodSync(stateDirectory, 0o700);
  const databasePath = join(stateDirectory, "private-memory.sqlite3");
  const readiness = runSqliteStartupGate({ databasePath });
  return { databasePath, readiness };
}

function connectionError(code) {
  return (error) => {
    assert.ok(error instanceof SqliteConnectionError);
    assert.equal(error.code, code);
    assert.equal(error.retryable, false);
    assert.equal("cause" in error, false);
    return true;
  };
}

function getResult(result) {
  assert.equal(result.kind, "get");
  return result.row;
}

test("the first writer enables WAL and every worker connection applies the fixed policy", async (t) => {
  const { databasePath, readiness } = createReadiness();
  const factory = await createSqliteConnectionFactory(readiness);
  t.after(() => factory.close());

  assert.deepEqual(SQLITE_CONNECTION_POLICY, {
    journalMode: "wal",
    synchronous: 1,
    busyTimeoutMs: 5000,
    cacheSize: -20000,
    tempStore: 2,
    foreignKeys: 1,
  });
  assert.equal(Object.isFrozen(SQLITE_CONNECTION_POLICY), true);
  assert.deepEqual(factory.writerConfiguration, SQLITE_CONNECTION_POLICY);
  assert.equal(Object.isFrozen(factory.writerConfiguration), true);

  await factory.enqueueWriteTransaction([
    {
      kind: "exec",
      sql: "CREATE TABLE policy_probe(id INTEGER PRIMARY KEY, value TEXT NOT NULL)",
    },
    {
      kind: "run",
      sql: "INSERT INTO policy_probe(value) VALUES (?)",
      parameters: ["committed"],
    },
  ]);

  const reader = await factory.openReader();
  t.after(() => reader.close());
  assert.deepEqual(reader.configuration, SQLITE_CONNECTION_POLICY);
  assert.equal(Object.isFrozen(reader.configuration), true);
  assert.deepEqual(
    getResult(
      await reader.query({
        kind: "get",
        sql: "SELECT value FROM policy_probe WHERE id = ?",
        parameters: [1],
      }),
    ),
    { value: "committed" },
  );

  if (process.platform !== "win32") {
    assert.equal(lstatSync(databasePath).mode & 0o777, 0o600);
    assert.equal(lstatSync(`${databasePath}-wal`).mode & 0o777, 0o600);
    assert.equal(lstatSync(`${databasePath}-shm`).mode & 0o777, 0o600);
  }
});

test("a reader verifies existing WAL mode and fails closed before writer bootstrap", async () => {
  const { databasePath, readiness } = createReadiness();

  await assert.rejects(openSqliteReader(readiness), (error) => {
    assert.ok(connectionError("WAL_MODE_REQUIRED")(error));
    assert.doesNotMatch(error.message, new RegExp(basename(databasePath), "u"));
    return true;
  });

  const untouched = new Database(databasePath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    assert.equal(untouched.pragma("journal_mode", { simple: true }), "delete");
  } finally {
    untouched.close();
  }

  const factory = await createSqliteConnectionFactory(readiness);
  try {
    await assert.rejects(
      createSqliteConnectionFactory(readiness),
      connectionError("WRITER_ALREADY_ACTIVE"),
    );
    const reader = await openSqliteReader(readiness);
    try {
      assert.equal(reader.configuration.journalMode, "wal");
    } finally {
      await reader.close();
    }
  } finally {
    await factory.close();
  }

  const reopenedFactory = await createSqliteConnectionFactory(readiness);
  assert.equal(reopenedFactory.writerConfiguration.journalMode, "wal");
  await reopenedFactory.close();
});

test("the FIFO queue commits complete transactions, rolls failures back, and remains usable", async (t) => {
  const { readiness } = createReadiness();
  const factory = await createSqliteConnectionFactory(readiness);
  t.after(() => factory.close());

  await factory.enqueueWriteTransaction([
    {
      kind: "exec",
      sql: "CREATE TABLE queue_probe(position INTEGER PRIMARY KEY, marker TEXT NOT NULL UNIQUE)",
    },
  ]);

  await Promise.all(
    [1, 2, 3].map((position) =>
      factory.enqueueWriteTransaction([
        {
          kind: "run",
          sql: "INSERT INTO queue_probe(position, marker) VALUES (?, ?)",
          parameters: [position, `queued-${position}`],
        },
      ]),
    ),
  );

  await assert.rejects(
    factory.enqueueWriteTransaction([
      {
        kind: "run",
        sql: "INSERT INTO queue_probe(position, marker) VALUES (?, ?)",
        parameters: [4, "must-roll-back"],
      },
      {
        kind: "run",
        sql: "INSERT INTO queue_probe(position, marker) VALUES (?, ?)",
        parameters: [5, "queued-1"],
      },
    ]),
    (error) => {
      assert.ok(connectionError("SQLITE_TRANSACTION_FAILED")(error));
      assert.doesNotMatch(error.message, /queue_probe|queued-1|UNIQUE|private/u);
      return true;
    },
  );

  await assert.rejects(
    factory.enqueueWriteTransaction([
      {
        kind: "run",
        sql: "INSERT INTO queue_probe(position, marker) VALUES (?, ?)",
        parameters: [4, "manual-commit-must-roll-back"],
      },
      { kind: "exec", sql: "/* adapter owns this boundary */ COMMIT" },
    ]),
    connectionError("INVALID_TRANSACTION_PROGRAM"),
  );

  await factory.enqueueWriteTransaction([
    {
      kind: "run",
      sql: "INSERT INTO queue_probe(position, marker) VALUES (?, ?)",
      parameters: [4, "after-failure"],
    },
  ]);

  const reader = await factory.openReader();
  t.after(() => reader.close());
  const result = await reader.query({
    kind: "all",
    sql: "SELECT position, marker FROM queue_probe ORDER BY position",
  });
  assert.equal(result.kind, "all");
  assert.deepEqual(result.rows, [
    { position: 1, marker: "queued-1" },
    { position: 2, marker: "queued-2" },
    { position: 3, marker: "queued-3" },
    { position: 4, marker: "after-failure" },
  ]);

  await assert.rejects(
    factory.enqueueWriteTransaction([]),
    connectionError("INVALID_TRANSACTION_PROGRAM"),
  );
});

test("a five-second external writer lock becomes a retryable safe error while WAL readers continue", async (t) => {
  const { databasePath, readiness } = createReadiness();
  const factory = await createSqliteConnectionFactory(readiness);
  t.after(() => factory.close());
  await factory.enqueueWriteTransaction([
    {
      kind: "exec",
      sql: "CREATE TABLE busy_probe(id INTEGER PRIMARY KEY, value TEXT NOT NULL)",
    },
  ]);

  const blocker = new Database(databasePath, { fileMustExist: true });
  blocker.pragma("busy_timeout = 0");
  blocker.exec(
    "BEGIN IMMEDIATE; INSERT INTO busy_probe(value) VALUES ('not-committed')",
  );
  t.after(() => {
    if (blocker.inTransaction) {
      blocker.exec("ROLLBACK");
    }
    blocker.close();
  });

  let eventLoopTicks = 0;
  const ticker = setInterval(() => {
    eventLoopTicks += 1;
  }, 25);
  const startedAt = performance.now();
  const blockedWrite = factory.enqueueWriteTransaction([
    {
      kind: "run",
      sql: "INSERT INTO busy_probe(value) VALUES (?)",
      parameters: ["must-not-commit"],
    },
  ]);

  const reader = await factory.openReader();
  t.after(() => reader.close());
  assert.deepEqual(
    getResult(
      await reader.query({
        kind: "get",
        sql: "SELECT COUNT(*) AS count FROM busy_probe",
      }),
    ),
    { count: 0 },
  );

  await assert.rejects(blockedWrite, (error) => {
    assert.ok(error instanceof SqliteBusyError);
    assert.ok(error instanceof SqliteConnectionError);
    assert.equal(error.code, "SQLITE_BUSY");
    assert.equal(error.retryable, true);
    assert.equal(error.timeoutMs, 5000);
    assert.equal("cause" in error, false);
    assert.doesNotMatch(error.message, /busy_probe|must-not-commit|private-memory/u);
    return true;
  });
  clearInterval(ticker);

  const elapsedMs = performance.now() - startedAt;
  assert.ok(elapsedMs >= 4_500, `busy timeout returned too early: ${elapsedMs}ms`);
  assert.ok(elapsedMs < 7_500, `busy timeout returned too late: ${elapsedMs}ms`);
  assert.ok(eventLoopTicks >= 20, `main event loop was blocked: ${eventLoopTicks} ticks`);

  blocker.exec("ROLLBACK");
  await factory.enqueueWriteTransaction([
    {
      kind: "run",
      sql: "INSERT INTO busy_probe(value) VALUES (?)",
      parameters: ["after-timeout"],
    },
  ]);
  assert.deepEqual(
    getResult(
      await reader.query({
        kind: "get",
        sql: "SELECT value FROM busy_probe",
      }),
    ),
    { value: "after-timeout" },
  );
});

test("close drains accepted writes, closes readers, and rejects new work", async () => {
  const { readiness } = createReadiness();
  const factory = await createSqliteConnectionFactory(readiness);
  const reader = await factory.openReader();

  const acceptedWrite = factory.enqueueWriteTransaction([
    {
      kind: "exec",
      sql: "CREATE TABLE close_probe(value INTEGER NOT NULL)",
    },
    { kind: "run", sql: "INSERT INTO close_probe VALUES (?)", parameters: [1] },
  ]);
  const closing = factory.close();

  await assert.rejects(
    factory.enqueueWriteTransaction([
      { kind: "exec", sql: "SELECT 1" },
    ]),
    connectionError("CONNECTION_FACTORY_CLOSED"),
  );
  await assert.rejects(
    factory.openReader(),
    connectionError("CONNECTION_FACTORY_CLOSED"),
  );
  await acceptedWrite;
  await closing;
  await factory.close();
  await assert.rejects(
    reader.query({ kind: "get", sql: "SELECT 1 AS value" }),
    connectionError("CONNECTION_CLOSED"),
  );
});

test("an individually closed reader is no longer owned by the factory", async () => {
  const { readiness } = createReadiness();
  const factory = await createSqliteConnectionFactory(readiness);
  const reader = await factory.openReader();

  await reader.close();
  let redundantCloseCalls = 0;
  reader.close = async () => {
    redundantCloseCalls += 1;
  };

  await factory.close();
  assert.equal(redundantCloseCalls, 0);
});

test("reader and factory close share the in-flight reader shutdown", async () => {
  const { readiness } = createReadiness();
  const factory = await createSqliteConnectionFactory(readiness);
  const reader = await factory.openReader();

  const firstClose = reader.close();
  const repeatedClose = reader.close();
  try {
    assert.strictEqual(repeatedClose, firstClose);

    let readerCloseCompleted = false;
    void firstClose.then(() => {
      readerCloseCompleted = true;
    });
    await factory.close();
    assert.equal(readerCloseCompleted, true);
  } finally {
    await Promise.allSettled([firstClose, factory.close()]);
  }
});
