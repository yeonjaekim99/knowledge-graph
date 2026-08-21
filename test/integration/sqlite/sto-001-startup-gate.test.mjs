import assert from "node:assert/strict";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  RECALL_DB_PATH_ENV,
  SQLITE_STORAGE_PERMISSIONS,
  SqliteStartupError,
  createSqliteStartupGate,
  loadSqliteStartupConfig,
  runSqliteStartupGate,
} from "../../../dist/adapters/sqlite/index.js";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const temporaryDirectories = [];
const storageDeploymentGuide = new URL(
  "../../../docs/operations/storage.md",
  import.meta.url,
);

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

function createStateDirectory(mode = 0o700) {
  const root = mkdtempSync(join(tmpdir(), "recall-sto-001-"));
  temporaryDirectories.push(root);
  const stateDirectory = join(root, "state");
  mkdirSync(stateDirectory, { mode });
  chmodSync(stateDirectory, mode);
  return { databasePath: join(stateDirectory, "recall.sqlite3"), stateDirectory };
}

function startupError(code, capability) {
  return (error) => {
    assert.ok(error instanceof SqliteStartupError);
    assert.equal(error.code, code);
    assert.equal(error.retryable, false);
    assert.equal(error.capability, capability);
    return true;
  };
}

test("explicit configuration opens a real file DB and returns frozen readiness", () => {
  const { databasePath } = createStateDirectory();
  const config = loadSqliteStartupConfig({ [RECALL_DB_PATH_ENV]: databasePath });

  const readiness = runSqliteStartupGate(config);

  assert.equal(RECALL_DB_PATH_ENV, "RECALL_DB_PATH");
  assert.equal(config.databasePath, databasePath);
  assert.equal(Object.isFrozen(config), true);
  assert.equal(readiness.databasePath, databasePath);
  assert.deepEqual(readiness.capabilities, {
    fts5: true,
    trigram: true,
    json: true,
    unixepoch: true,
  });
  assert.match(readiness.sqliteVersion, /^3\./);
  assert.equal(readiness.localFilesystemOnly, true);
  assert.equal(Object.isFrozen(readiness), true);
  assert.equal(Object.isFrozen(readiness.capabilities), true);
  assert.equal(lstatSync(databasePath).mode & 0o777, 0o600);

  const database = new Database(databasePath, { readonly: true });
  try {
    const persistedObjects = database
      .prepare("SELECT name FROM sqlite_master ORDER BY name")
      .all();
    assert.deepEqual(persistedObjects, []);
  } finally {
    database.close();
  }
});

test("the startup gate is idempotent for an existing safe empty database", () => {
  const { databasePath } = createStateDirectory();
  const config = loadSqliteStartupConfig({ [RECALL_DB_PATH_ENV]: databasePath });

  const first = runSqliteStartupGate(config);
  const second = runSqliteStartupGate(config);

  assert.deepEqual(second, first);
  assert.equal(lstatSync(databasePath).mode & 0o777, 0o600);
});

test("missing and unsafe database path forms fail closed without echoing values", () => {
  assert.throws(
    () => loadSqliteStartupConfig({}),
    startupError("DATABASE_PATH_MISSING"),
  );

  const unsafeValues = [
    ["   ", "DATABASE_PATH_MISSING"],
    [":memory:", "DATABASE_PATH_UNSUPPORTED"],
    ["file:recall.sqlite3?mode=memory", "DATABASE_PATH_UNSUPPORTED"],
    ["relative/recall.sqlite3", "DATABASE_PATH_NOT_ABSOLUTE"],
    ["//network-host/private-share/secret.sqlite3", "NETWORK_FILESYSTEM_UNSUPPORTED"],
    ["/tmp/private\0secret.sqlite3", "DATABASE_PATH_UNSUPPORTED"],
  ];

  for (const [value, code] of unsafeValues) {
    assert.throws(
      () => runSqliteStartupGate({ databasePath: value }),
      (error) => {
        assert.ok(startupError(code)(error));
        assert.doesNotMatch(error.message, /private|secret|network-host|relative/);
        return true;
      },
    );
  }
});

test(
  "unsafe directory, database permissions, and symlink targets are rejected",
  { skip: process.platform === "win32" },
  () => {
    const unsafeDirectory = createStateDirectory(0o755);
    assert.throws(
      () => runSqliteStartupGate({ databasePath: unsafeDirectory.databasePath }),
      startupError("STATE_DIRECTORY_PERMISSIONS_UNSAFE"),
    );

    const unsafeDatabase = createStateDirectory();
    writeFileSync(unsafeDatabase.databasePath, "");
    chmodSync(unsafeDatabase.databasePath, 0o644);
    assert.throws(
      () => runSqliteStartupGate({ databasePath: unsafeDatabase.databasePath }),
      startupError("DATABASE_FILE_PERMISSIONS_UNSAFE"),
    );

    const symlinkDatabase = createStateDirectory();
    const targetPath = join(symlinkDatabase.stateDirectory, "target.sqlite3");
    writeFileSync(targetPath, "", { mode: 0o600 });
    symlinkSync(targetPath, symlinkDatabase.databasePath);
    assert.throws(
      () => runSqliteStartupGate({ databasePath: symlinkDatabase.databasePath }),
      startupError("DATABASE_FILE_UNSUPPORTED"),
    );
  },
);

test("known network filesystems stop startup before capability probing", () => {
  const { databasePath } = createStateDirectory();
  let capabilityProbeCalls = 0;
  const gate = createSqliteStartupGate({
    inspectFilesystem() {
      return Object.freeze({ type: 0x6969n, mountType: "nfs" });
    },
    probeCapabilities() {
      capabilityProbeCalls += 1;
      throw new Error("must not run");
    },
  });

  assert.throws(
    () => gate.verify({ databasePath }),
    startupError("NETWORK_FILESYSTEM_UNSUPPORTED"),
  );
  assert.equal(capabilityProbeCalls, 0);
});

test("every required SQLite capability is a fail-closed startup gate", () => {
  for (const missing of ["fts5", "trigram", "json", "unixepoch"]) {
    const { databasePath } = createStateDirectory();
    const gate = createSqliteStartupGate({
      probeCapabilities() {
        return Object.freeze({
          sqliteVersion: "3.53.4",
          fts5: missing !== "fts5",
          trigram: missing !== "trigram",
          json: missing !== "json",
          unixepoch: missing !== "unixepoch",
        });
      },
    });

    assert.throws(
      () => gate.verify({ databasePath }),
      startupError("SQLITE_CAPABILITY_MISSING", missing),
    );
  }
});

test("driver failures are redacted and never yield readiness", () => {
  const { databasePath } = createStateDirectory();
  const secret = "TOP_SECRET_SQLITE_PATH_FRAGMENT";
  const gate = createSqliteStartupGate({
    probeCapabilities() {
      throw new Error(`driver failed at ${databasePath}: ${secret}`);
    },
  });

  assert.throws(
    () => gate.verify({ databasePath }),
    (error) => {
      assert.ok(startupError("SQLITE_CAPABILITY_CHECK_FAILED")(error));
      assert.doesNotMatch(error.message, new RegExp(secret));
      assert.doesNotMatch(error.message, new RegExp(databasePath));
      assert.equal(Object.hasOwn(error, "cause"), false);
      return true;
    },
  );
});

test("storage permission policy is explicit for DB sidecars and backups", () => {
  assert.deepEqual(SQLITE_STORAGE_PERMISSIONS, {
    stateDirectory: 0o700,
    database: 0o600,
    wal: 0o600,
    sharedMemory: 0o600,
    backupDirectory: 0o700,
    backup: 0o600,
  });
  assert.equal(Object.isFrozen(SQLITE_STORAGE_PERMISSIONS), true);
});

test("deployment documentation fixes startup, filesystem, and permission boundaries", () => {
  const guide = readFileSync(storageDeploymentGuide, "utf8");

  for (const requiredText of [
    "RECALL_DB_PATH",
    "절대 경로",
    "0700",
    "0600",
    "WAL",
    "SHM",
    "backup",
    "network filesystem",
    "NFS",
    "SMB",
    "동기화 드라이브",
    "다중 writer process",
    "STO-002",
    "STO-003",
    "STO-004",
  ]) {
    assert.match(guide, new RegExp(requiredText));
  }
});
