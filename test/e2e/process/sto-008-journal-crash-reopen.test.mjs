import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";

import {
  createSqliteConnectionFactory,
  createSqliteJournalRepository,
  runBundledSqliteMigrations,
  runSqliteStartupGate,
} from "../../../dist/adapters/sqlite/index.js";
import { createDeterministicRuntimeProvider } from "../../support/deterministic-runtime-provider.mjs";

const BASELINE_EVENT_ID = `ev_${"0".repeat(25)}1`;
const CRASH_EVENT_ID = `ev_${"0".repeat(25)}2`;
const RECOVERY_EVENT_ID = `ev_${"0".repeat(25)}3`;
const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "sto-008-journal-crash-worker.mjs",
);
const temporaryDirectories = [];
const openFactories = new Set();

afterEach(async () => {
  await Promise.allSettled([...openFactories].map((factory) => factory.close()));
  openFactories.clear();
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

function createDatabasePath(faultPoint) {
  const root = mkdtempSync(join(tmpdir(), `recall-sto-008-${faultPoint}-`));
  temporaryDirectories.push(root);
  const stateDirectory = join(root, "state");
  mkdirSync(stateDirectory, { mode: 0o700 });
  chmodSync(stateDirectory, 0o700);
  return join(stateDirectory, "private-memory.sqlite3");
}

async function queryRows(factory, sql, parameters) {
  const reader = await factory.openReader();
  try {
    const result = await reader.query({ kind: "all", sql, parameters });
    assert.equal(result.kind, "all");
    return result.rows;
  } finally {
    await reader.close();
  }
}

function runtime(eventIds) {
  return createDeterministicRuntimeProvider({
    eventIds,
    nowMilliseconds: 1_700_000_002_999,
    scope: {
      userId: "crash-user",
      projectId: "sto-008",
      scopeKey: "u:crash-user/p:sto-008",
    },
    metadata: { actor: "recovery-test", branch: "sto-008", session: null },
  });
}

async function seedDatabase(databasePath) {
  const readiness = runSqliteStartupGate({ databasePath });
  const factory = await createSqliteConnectionFactory(readiness);
  openFactories.add(factory);
  await runBundledSqliteMigrations(factory, { appliedAtSeconds: 1_699_999_999 });
  const repository = createSqliteJournalRepository({
    factory,
    runtime: runtime([BASELINE_EVENT_ID]),
  });
  await repository.append([
    {
      kind: "statement",
      bodyJson: JSON.stringify({ raw_text: "장애복구 기준 문장", parsed: [] }),
    },
  ]);
  const migrationRows = await queryRows(
    factory,
    "SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version",
  );
  await factory.close();
  openFactories.delete(factory);
  return migrationRows;
}

function waitForFault(child, faultPoint) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`crash worker did not reach ${faultPoint}`));
    }, 5_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("message", (message) => {
      if (message?.type === "fault-ready" && message.faultPoint === faultPoint) {
        clearTimeout(timeout);
        resolve(message);
      }
    });
  });
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

async function hardCrashAt(databasePath, faultPoint) {
  const child = fork(fixturePath, [databasePath, faultPoint], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  try {
    const message = await waitForFault(child, faultPoint);
    const exited = waitForExit(child);
    assert.equal(child.kill("SIGKILL"), true);
    const exit = await exited;
    assert.ok(exit.signal === "SIGKILL" || exit.code !== 0);
    return message;
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
}

test("hard exits before insert, after insert, and after commit reopen as old or complete new state", async (t) => {
  const cases = [
    { faultPoint: "before-journal-insert", localCount: 1, committedCount: 1 },
    { faultPoint: "after-journal-insert", localCount: 2, committedCount: 1 },
    { faultPoint: "after-commit", localCount: 2, committedCount: 2 },
  ];

  for (const crashCase of cases) {
    await t.test(crashCase.faultPoint, async () => {
      const databasePath = createDatabasePath(crashCase.faultPoint);
      const migrationBefore = await seedDatabase(databasePath);
      const fault = await hardCrashAt(databasePath, crashCase.faultPoint);
      assert.deepEqual(
        { journalCount: fault.journalCount, ftsCount: fault.ftsCount },
        { journalCount: crashCase.localCount, ftsCount: crashCase.localCount },
      );

      const readiness = runSqliteStartupGate({ databasePath });
      const factory = await createSqliteConnectionFactory(readiness);
      openFactories.add(factory);
      assert.deepEqual(
        await runBundledSqliteMigrations(factory, { appliedAtSeconds: 1_700_000_100 }),
        { appliedVersions: [], currentVersion: 1 },
      );
      assert.deepEqual(
        await queryRows(
          factory,
          "SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version",
        ),
        migrationBefore,
      );
      const expectedIds =
        crashCase.committedCount === 1
          ? [BASELINE_EVENT_ID]
          : [BASELINE_EVENT_ID, CRASH_EVENT_ID];
      assert.deepEqual(
        await queryRows(factory, "SELECT seq, id FROM journal ORDER BY seq"),
        expectedIds.map((id, index) => ({ seq: index + 1, id })),
      );
      assert.deepEqual(
        await queryRows(factory, "SELECT rowid FROM journal_fts ORDER BY rowid"),
        expectedIds.map((_, index) => ({ rowid: index + 1 })),
      );
      assert.deepEqual(
        await queryRows(factory, "SELECT * FROM pragma_foreign_key_check"),
        [],
      );

      const repository = createSqliteJournalRepository({
        factory,
        runtime: runtime([RECOVERY_EVENT_ID]),
      });
      assert.deepEqual(
        await repository.append([
          {
            kind: "statement",
            bodyJson: JSON.stringify({ raw_text: "장애복구 후속 문장", parsed: [] }),
          },
        ]),
        {
          events: [
            {
              index: 0,
              eventId: RECOVERY_EVENT_ID,
              seq: crashCase.committedCount + 1,
            },
          ],
        },
      );
      assert.deepEqual(
        await queryRows(factory, "SELECT rowid FROM journal_fts ORDER BY rowid"),
        Array.from({ length: crashCase.committedCount + 1 }, (_, index) => ({
          rowid: index + 1,
        })),
      );
      await factory.close();
      openFactories.delete(factory);
    });
  }
});
