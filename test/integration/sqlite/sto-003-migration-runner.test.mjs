import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  SqliteMigrationError,
  createSqliteConnectionFactory,
  runSqliteMigrations,
  runSqliteStartupGate,
} from "../../../dist/adapters/sqlite/index.js";

const temporaryDirectories = [];
const encoder = new TextEncoder();
const NOW_SECONDS = 1_700_000_000;

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

function createReadiness() {
  const root = mkdtempSync(join(tmpdir(), "recall-sto-003-"));
  temporaryDirectories.push(root);
  const stateDirectory = join(root, "state");
  mkdirSync(stateDirectory, { mode: 0o700 });
  chmodSync(stateDirectory, 0o700);
  return runSqliteStartupGate({
    databasePath: join(stateDirectory, "private-memory.sqlite3"),
  });
}

function migration(version, name, sql) {
  return Object.freeze({ version, name, source: encoder.encode(sql) });
}

function checksum(source) {
  return createHash("sha256").update(source).digest("hex");
}

function migrationError(code) {
  return (error) => {
    assert.ok(error instanceof SqliteMigrationError);
    assert.equal(error.code, code);
    assert.equal(error.retryable, false);
    assert.equal("cause" in error, false);
    assert.doesNotMatch(error.message, /private-memory|CREATE TABLE|checksum_probe/u);
    return true;
  };
}

async function rows(factory, sql, parameters) {
  const reader = await factory.openReader();
  try {
    const result = await reader.query({ kind: "all", sql, parameters });
    assert.equal(result.kind, "all");
    return result.rows;
  } finally {
    await reader.close();
  }
}

test("migrations apply from version 1 in order and normal reopen is idempotent", async () => {
  const readiness = createReadiness();
  const versionOne = migration(
    1,
    "create_probe",
    "CREATE TABLE migration_probe(id INTEGER PRIMARY KEY, value TEXT NOT NULL);\n" +
      "INSERT INTO migration_probe(id, value) VALUES (1, 'version-one');\n",
  );
  const versionTwo = migration(
    2,
    "extend_probe",
    "ALTER TABLE migration_probe ADD COLUMN generation INTEGER NOT NULL DEFAULT 0;\n" +
      "UPDATE migration_probe SET generation = 2 WHERE id = 1;\n",
  );

  const firstFactory = await createSqliteConnectionFactory(readiness);
  const first = await runSqliteMigrations(
    firstFactory,
    [versionTwo, versionOne],
    { appliedAtSeconds: NOW_SECONDS },
  );
  assert.deepEqual(first, { appliedVersions: [1, 2], currentVersion: 2 });
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.appliedVersions), true);

  assert.deepEqual(
    await rows(
      firstFactory,
      "SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version",
    ),
    [
      {
        version: 1,
        name: "create_probe",
        checksum: checksum(versionOne.source),
        applied_at: NOW_SECONDS,
      },
      {
        version: 2,
        name: "extend_probe",
        checksum: checksum(versionTwo.source),
        applied_at: NOW_SECONDS,
      },
    ],
  );
  assert.deepEqual(
    await rows(
      firstFactory,
      "SELECT id, value, generation FROM migration_probe ORDER BY id",
    ),
    [{ id: 1, value: "version-one", generation: 2 }],
  );
  await firstFactory.close();

  const reopenedFactory = await createSqliteConnectionFactory(readiness);
  try {
    assert.deepEqual(
      await runSqliteMigrations(reopenedFactory, [versionOne, versionTwo], {
        appliedAtSeconds: NOW_SECONDS + 60,
      }),
      { appliedVersions: [], currentVersion: 2 },
    );
    assert.deepEqual(
      await rows(
        reopenedFactory,
        "SELECT applied_at FROM schema_migrations ORDER BY version",
      ),
      [{ applied_at: NOW_SECONDS }, { applied_at: NOW_SECONDS }],
    );
  } finally {
    await reopenedFactory.close();
  }
});

test("migration work shares the FIFO writer queue and snapshots exact source bytes", async () => {
  const readiness = createReadiness();
  const factory = await createSqliteConnectionFactory(readiness);
  try {
    const source = encoder.encode(
      "INSERT INTO queue_before(value) VALUES ('from-migration');\n" +
        "CREATE TABLE queue_after(value TEXT NOT NULL);\n",
    );
    const expectedChecksum = checksum(source);
    const beforeMigration = factory.enqueueWriteTransaction([
      {
        kind: "exec",
        sql: "CREATE TABLE queue_before(value TEXT NOT NULL)",
      },
    ]);
    const migrating = runSqliteMigrations(
      factory,
      [Object.freeze({ version: 1, name: "queue_order", source })],
      { appliedAtSeconds: NOW_SECONDS },
    );
    const afterMigration = factory.enqueueWriteTransaction([
      {
        kind: "run",
        sql: "INSERT INTO queue_after(value) VALUES (?)",
        parameters: ["after-migration"],
      },
    ]);

    source.fill(0);
    await beforeMigration;
    assert.deepEqual(await migrating, {
      appliedVersions: [1],
      currentVersion: 1,
    });
    await afterMigration;

    assert.deepEqual(
      await rows(factory, "SELECT value FROM queue_before"),
      [{ value: "from-migration" }],
    );
    assert.deepEqual(
      await rows(factory, "SELECT value FROM queue_after"),
      [{ value: "after-migration" }],
    );
    assert.deepEqual(
      await rows(factory, "SELECT checksum FROM schema_migrations"),
      [{ checksum: expectedChecksum }],
    );
  } finally {
    await factory.close();
  }
});

test("exact UTF-8 byte drift, name drift, and unsupported future history fail closed", async () => {
  const readiness = createReadiness();
  const factory = await createSqliteConnectionFactory(readiness);
  try {
    const versionOne = migration(
      1,
      "checksum_probe",
      "CREATE TABLE checksum_probe(value TEXT NOT NULL);\n",
    );
    await runSqliteMigrations(factory, [versionOne], {
      appliedAtSeconds: NOW_SECONDS,
    });

    await assert.rejects(
      runSqliteMigrations(
        factory,
        [migration(1, "renamed_probe", new TextDecoder().decode(versionOne.source))],
        { appliedAtSeconds: NOW_SECONDS },
      ),
      migrationError("MIGRATION_HISTORY_MISMATCH"),
    );
    await assert.rejects(
      runSqliteMigrations(
        factory,
        [
          migration(
            1,
            "checksum_probe",
            "CREATE TABLE checksum_probe(value TEXT NOT NULL);\r\n",
          ),
        ],
        { appliedAtSeconds: NOW_SECONDS },
      ),
      migrationError("MIGRATION_HISTORY_MISMATCH"),
    );

    const versionTwo = migration(
      2,
      "new_version",
      "ALTER TABLE checksum_probe ADD COLUMN version INTEGER NOT NULL DEFAULT 2;\n",
    );
    assert.deepEqual(
      await runSqliteMigrations(factory, [versionOne, versionTwo], {
        appliedAtSeconds: NOW_SECONDS + 1,
      }),
      { appliedVersions: [2], currentVersion: 2 },
    );

    await factory.enqueueWriteTransaction([
      {
        kind: "run",
        sql: "INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
        parameters: [3, "future_version", "0".repeat(64), NOW_SECONDS + 2],
      },
    ]);
    await assert.rejects(
      runSqliteMigrations(factory, [versionOne, versionTwo], {
        appliedAtSeconds: NOW_SECONDS + 3,
      }),
      migrationError("MIGRATION_VERSION_UNSUPPORTED"),
    );
  } finally {
    await factory.close();
  }
});

test("a failed migration rolls back all of its schema and history before a new version succeeds", async () => {
  const readiness = createReadiness();
  const factory = await createSqliteConnectionFactory(readiness);
  try {
    const versionOne = migration(
      1,
      "stable_base",
      "CREATE TABLE stable_base(id INTEGER PRIMARY KEY);\n",
    );
    await runSqliteMigrations(factory, [versionOne], {
      appliedAtSeconds: NOW_SECONDS,
    });

    const brokenVersionTwo = migration(
      2,
      "broken_extension",
      "CREATE TABLE must_roll_back(id INTEGER PRIMARY KEY);\n" +
        "INSERT INTO missing_table(value) VALUES ('fail');\n",
    );
    await assert.rejects(
      runSqliteMigrations(factory, [versionOne, brokenVersionTwo], {
        appliedAtSeconds: NOW_SECONDS + 1,
      }),
      migrationError("MIGRATION_APPLICATION_FAILED"),
    );
    assert.deepEqual(
      await rows(
        factory,
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'must_roll_back'",
      ),
      [],
    );
    assert.deepEqual(
      await rows(factory, "SELECT version FROM schema_migrations ORDER BY version"),
      [{ version: 1 }],
    );

    const versionTwo = migration(
      2,
      "stable_extension",
      "CREATE TABLE stable_extension(id INTEGER PRIMARY KEY);\n",
    );
    assert.deepEqual(
      await runSqliteMigrations(factory, [versionOne, versionTwo], {
        appliedAtSeconds: NOW_SECONDS + 2,
      }),
      { appliedVersions: [2], currentVersion: 2 },
    );
  } finally {
    await factory.close();
  }
});

test("malformed, non-contiguous, duplicate, non-UTF-8, and transaction-owning bundles are rejected", async () => {
  const readiness = createReadiness();
  const factory = await createSqliteConnectionFactory(readiness);
  try {
    const valid = migration(1, "valid", "CREATE TABLE valid(id INTEGER);\n");
    const invalidBundles = [
      [migration(2, "starts_at_two", "SELECT 1;\n")],
      [valid, migration(1, "duplicate_version", "SELECT 1;\n")],
      [valid, migration(2, "valid", "SELECT 1;\n")],
      [Object.freeze({ version: 1, name: "invalid_utf8", source: Uint8Array.of(0xff) })],
      [migration(1, "empty", "   \n")],
      [migration(1, "owns_transaction", "BEGIN; CREATE TABLE invalid(id INTEGER); COMMIT;\n")],
    ];

    for (const bundle of invalidBundles) {
      await assert.rejects(
        runSqliteMigrations(factory, bundle, {
          appliedAtSeconds: NOW_SECONDS,
        }),
        migrationError("MIGRATION_BUNDLE_INVALID"),
      );
    }
    assert.deepEqual(
      await rows(
        factory,
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'schema_migrations'",
      ),
      [],
    );

    const triggerMigration = migration(
      1,
      "trigger_body_is_not_transaction_control",
      "CREATE TABLE trigger_source(id INTEGER PRIMARY KEY, value TEXT NOT NULL);\n" +
        "CREATE TABLE trigger_log(source_id INTEGER NOT NULL);\n" +
        "CREATE TRIGGER trigger_source_ai AFTER INSERT ON trigger_source BEGIN\n" +
        "  INSERT INTO trigger_log(source_id)\n" +
        "    VALUES (CASE WHEN new.id > 0 THEN new.id ELSE 0 END);\n" +
        "END;\n" +
        "INSERT INTO trigger_source(id, value) VALUES (1, 'accepted');\n",
    );
    assert.deepEqual(
      await runSqliteMigrations(factory, [triggerMigration], {
        appliedAtSeconds: NOW_SECONDS,
      }),
      { appliedVersions: [1], currentVersion: 1 },
    );
    assert.deepEqual(
      await rows(factory, "SELECT source_id FROM trigger_log ORDER BY source_id"),
      [{ source_id: 1 }],
    );
  } finally {
    await factory.close();
  }
});
