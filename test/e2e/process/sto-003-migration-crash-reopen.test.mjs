import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";

import {
  createSqliteConnectionFactory,
  runSqliteMigrations,
  runSqliteStartupGate,
} from "../../../dist/adapters/sqlite/index.js";

const temporaryDirectories = [];
const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "sto-003-crash-worker.mjs",
);

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

function createDatabasePath() {
  const root = mkdtempSync(join(tmpdir(), "recall-sto-003-crash-"));
  temporaryDirectories.push(root);
  const stateDirectory = join(root, "state");
  mkdirSync(stateDirectory, { mode: 0o700 });
  chmodSync(stateDirectory, 0o700);
  return join(stateDirectory, "private-memory.sqlite3");
}

function waitForOpenTransaction(child) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("crash fixture did not open its migration transaction"));
    }, 5_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("message", (message) => {
      if (message?.type === "migration-transaction-open") {
        clearTimeout(timeout);
        resolve();
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

test("a hard process exit with an open migration transaction reopens atomically and remains idempotent", async () => {
  const databasePath = createDatabasePath();
  const child = fork(fixturePath, [databasePath], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  try {
    await waitForOpenTransaction(child);
    const exited = waitForExit(child);
    assert.equal(child.kill("SIGKILL"), true);
    assert.deepEqual(await exited, { code: null, signal: "SIGKILL" });
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }

  const readiness = runSqliteStartupGate({ databasePath });
  const source = new TextEncoder().encode(
    "CREATE TABLE crash_probe(id INTEGER PRIMARY KEY, value TEXT NOT NULL);\n" +
      "INSERT INTO crash_probe(id, value) VALUES (1, 'committed-after-reopen');\n",
  );
  const bundle = [Object.freeze({ version: 1, name: "crash_probe", source })];

  const firstFactory = await createSqliteConnectionFactory(readiness);
  assert.deepEqual(
    await runSqliteMigrations(firstFactory, bundle, {
      appliedAtSeconds: 1_700_000_100,
    }),
    { appliedVersions: [1], currentVersion: 1 },
  );
  const reader = await firstFactory.openReader();
  const values = await reader.query({
    kind: "all",
    sql: "SELECT value FROM crash_probe ORDER BY id",
  });
  assert.equal(values.kind, "all");
  assert.deepEqual(values.rows, [{ value: "committed-after-reopen" }]);
  await reader.close();
  await firstFactory.close();

  const reopenedFactory = await createSqliteConnectionFactory(readiness);
  try {
    assert.deepEqual(
      await runSqliteMigrations(reopenedFactory, bundle, {
        appliedAtSeconds: 1_700_000_200,
      }),
      { appliedVersions: [], currentVersion: 1 },
    );
  } finally {
    await reopenedFactory.close();
  }
});
