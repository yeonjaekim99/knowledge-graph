import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";

import {
  SqliteConnectionError,
  createSqliteConnectionFactory,
  runBundledSqliteMigrations,
  runSqliteStartupGate,
} from "../../../dist/adapters/sqlite/index.js";

const NOW_SECONDS = 1_700_000_000;
const temporaryDirectories = [];
const sourceMigrationUrl = new URL(
  "../../../src/adapters/sqlite/migrations/001-v1-schema.sql",
  import.meta.url,
);
const builtMigrationUrl = new URL(
  "../../../dist/adapters/sqlite/migrations/001-v1-schema.sql",
  import.meta.url,
);

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

function createReadiness() {
  const root = mkdtempSync(join(tmpdir(), "recall-sto-004-"));
  temporaryDirectories.push(root);
  const stateDirectory = join(root, "state");
  mkdirSync(stateDirectory, { mode: 0o700 });
  chmodSync(stateDirectory, 0o700);
  return runSqliteStartupGate({
    databasePath: join(stateDirectory, "private-memory.sqlite3"),
  });
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

async function applySchema(factory) {
  return runBundledSqliteMigrations(factory, {
    appliedAtSeconds: NOW_SECONDS,
  });
}

function transactionFailure(error) {
  assert.ok(error instanceof SqliteConnectionError);
  assert.equal(error.code, "SQLITE_TRANSACTION_FAILED");
  assert.equal(error.retryable, false);
  assert.equal("cause" in error, false);
  return true;
}

async function expectConstraintFailure(factory, sql, parameters) {
  await assert.rejects(
    factory.enqueueWriteTransaction([{ kind: "run", sql, parameters }]),
    transactionFailure,
  );
}

function columnNames(tableInfo) {
  return tableInfo.map(({ name }) => name);
}

function foreignKeyTargets(foreignKeys) {
  return foreignKeys
    .map((foreignKey) => ({
      from: foreignKey.from,
      table: foreignKey.table,
      to: foreignKey.to,
    }))
    .sort((left, right) => left.from.localeCompare(right.from));
}

test("the exact bundled v1 migration creates the complete ADR schema and reopens idempotently", async () => {
  const sourceBytes = readFileSync(fileURLToPath(sourceMigrationUrl));
  const builtBytes = readFileSync(fileURLToPath(builtMigrationUrl));
  assert.deepEqual(builtBytes, sourceBytes);

  const readiness = createReadiness();
  const factory = await createSqliteConnectionFactory(readiness);
  assert.deepEqual(await applySchema(factory), {
    appliedVersions: [1],
    currentVersion: 1,
  });

  assert.deepEqual(
    await rows(
      factory,
      "SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version",
    ),
    [
      {
        version: 1,
        name: "v1_schema",
        checksum: createHash("sha256").update(builtBytes).digest("hex"),
        applied_at: NOW_SECONDS,
      },
    ],
  );

  const expectedColumns = {
    schema_migrations: ["version", "name", "checksum", "applied_at"],
    journal: [
      "seq",
      "id",
      "scope_key",
      "kind",
      "body",
      "actor",
      "branch",
      "session",
      "created_at",
    ],
    statements: [
      "event_id",
      "scope_key",
      "state",
      "order_seq",
      "created_at",
      "provenance",
      "expires_at",
    ],
    entities: [
      "id",
      "scope_key",
      "name",
      "normal_name",
      "kind",
      "merged_into",
      "origin_seq",
    ],
    surface_forms: ["scope_key", "surface_norm", "entity_id", "origin"],
    claims: [
      "id",
      "scope_key",
      "subject_id",
      "relation",
      "object_id",
      "object_value",
      "state",
      "origin_seq",
      "first_seen_at",
      "last_seen_at",
    ],
    claim_support: [
      "claim_id",
      "event_id",
      "draft_index",
      "live",
      "expires_at",
    ],
    id_redirects: ["old_id", "new_id", "kind", "reason"],
    projection_meta: ["scope_key", "last_seq", "rules_version", "rebuilt_at"],
  };
  for (const [table, expected] of Object.entries(expectedColumns)) {
    assert.deepEqual(
      columnNames(await rows(factory, `PRAGMA table_info(${table})`)),
      expected,
      table,
    );
  }
  const expectedForeignKeys = {
    statements: [{ from: "event_id", table: "journal", to: "id" }],
    entities: [{ from: "merged_into", table: "entities", to: "id" }],
    surface_forms: [{ from: "entity_id", table: "entities", to: "id" }],
    claims: [
      { from: "object_id", table: "entities", to: "id" },
      { from: "subject_id", table: "entities", to: "id" },
    ],
    claim_support: [
      { from: "claim_id", table: "claims", to: "id" },
      { from: "event_id", table: "statements", to: "event_id" },
    ],
  };
  for (const [table, expected] of Object.entries(expectedForeignKeys)) {
    assert.deepEqual(
      foreignKeyTargets(await rows(factory, `PRAGMA foreign_key_list(${table})`)),
      expected,
      table,
    );
  }

  const expectedIndexes = [
    "idx_claim_identity_entity_active",
    "idx_claim_identity_value_active",
    "idx_claims_describes_single",
    "idx_claims_object",
    "idx_claims_subject",
    "idx_entities_normal",
    "idx_journal_scope",
    "idx_redirect_new",
    "idx_statements_live",
    "idx_support_event",
    "idx_surface_lookup",
  ];
  assert.deepEqual(
    await rows(
      factory,
      "SELECT name FROM sqlite_schema WHERE type='index' AND name LIKE 'idx_%' ORDER BY name",
    ),
    expectedIndexes.map((name) => ({ name })),
  );
  assert.deepEqual(
    await rows(
      factory,
      "SELECT name FROM sqlite_schema WHERE type='trigger' ORDER BY name",
    ),
    [{ name: "journal_ai" }],
  );
  assert.deepEqual(await rows(factory, "PRAGMA foreign_key_check"), []);
  await factory.close();

  const reopenedFactory = await createSqliteConnectionFactory(readiness);
  try {
    assert.deepEqual(
      await runBundledSqliteMigrations(reopenedFactory, {
        appliedAtSeconds: NOW_SECONDS + 60,
      }),
      { appliedVersions: [], currentVersion: 1 },
    );
    assert.deepEqual(
      await rows(reopenedFactory, "SELECT applied_at FROM schema_migrations"),
      [{ applied_at: NOW_SECONDS }],
    );
  } finally {
    await reopenedFactory.close();
  }
});

test("contentless trigram FTS fixes the Korean three-code-point boundary and rebuild procedure", async () => {
  const factory = await createSqliteConnectionFactory(createReadiness());
  try {
    await applySchema(factory);
    await factory.enqueueWriteTransaction([
      {
        kind: "run",
        sql: "INSERT INTO journal(id, scope_key, kind, body, created_at) VALUES (?, ?, 'statement', ?, ?)",
        parameters: [
          "ev_statement",
          "u:user/p:project",
          JSON.stringify({ raw_text: "인증서버는 서버 세션을 사용한다" }),
          NOW_SECONDS,
        ],
      },
      {
        kind: "run",
        sql: "INSERT INTO journal(id, scope_key, kind, body, created_at) VALUES (?, ?, 'alias', ?, ?)",
        parameters: [
          "ev_alias",
          "u:user/p:project",
          JSON.stringify({ surface: "인증서버", entity_id: "e1.0" }),
          NOW_SECONDS + 1,
        ],
      },
    ]);

    assert.deepEqual(
      await rows(
        factory,
        "SELECT rowid FROM journal_fts WHERE journal_fts MATCH ? ORDER BY rowid",
        ["인증서"],
      ),
      [{ rowid: 1 }],
    );
    assert.deepEqual(
      await rows(
        factory,
        "SELECT rowid FROM journal_fts WHERE journal_fts MATCH ? ORDER BY rowid",
        ["인증"],
      ),
      [],
    );
    assert.deepEqual(
      await rows(factory, "SELECT rowid, raw_text FROM journal_fts ORDER BY rowid"),
      [{ rowid: 1, raw_text: null }],
    );

    await factory.enqueueWriteTransaction([
      {
        kind: "exec",
        sql: "INSERT INTO journal_fts(journal_fts) VALUES('delete-all')",
      },
    ]);
    assert.deepEqual(
      await rows(
        factory,
        "SELECT rowid FROM journal_fts WHERE journal_fts MATCH ?",
        ["인증서"],
      ),
      [],
    );

    await factory.enqueueWriteTransaction([
      {
        kind: "exec",
        sql: "INSERT INTO journal_fts(rowid, raw_text) " +
          "SELECT seq, json_extract(body, '$.raw_text') FROM journal " +
          "WHERE kind = 'statement' ORDER BY seq",
      },
      {
        kind: "exec",
        sql: "INSERT INTO journal_fts(journal_fts) VALUES('optimize')",
      },
    ]);
    assert.deepEqual(
      await rows(
        factory,
        "SELECT rowid FROM journal_fts WHERE journal_fts MATCH ? ORDER BY rowid",
        ["인증서"],
      ),
      [{ rowid: 1 }],
    );
    assert.deepEqual(await rows(factory, "PRAGMA foreign_key_check"), []);
  } finally {
    await factory.close();
  }
});

test("active partial uniqueness and the claim object XOR reject invalid projection states", async () => {
  const factory = await createSqliteConnectionFactory(createReadiness());
  try {
    await applySchema(factory);
    await factory.enqueueWriteTransaction([
      {
        kind: "run",
        sql: "INSERT INTO entities(id, scope_key, name, normal_name, origin_seq) VALUES (?, ?, ?, ?, ?)",
        parameters: ["e1.0", "u:user/p:project", "subject", "subject", 1],
      },
      {
        kind: "run",
        sql: "INSERT INTO entities(id, scope_key, name, normal_name, origin_seq) VALUES (?, ?, ?, ?, ?)",
        parameters: ["e1.1", "u:user/p:project", "object", "object", 1],
      },
      {
        kind: "run",
        sql: "INSERT INTO claims(id, scope_key, subject_id, relation, object_value, state, origin_seq, first_seen_at, last_seen_at) VALUES (?, ?, ?, 'describes', ?, 'active', ?, ?, ?)",
        parameters: ["c1.0", "u:user/p:project", "e1.0", "first", 1, NOW_SECONDS, NOW_SECONDS],
      },
      {
        kind: "run",
        sql: "INSERT INTO claims(id, scope_key, subject_id, relation, object_id, state, origin_seq, first_seen_at, last_seen_at) VALUES (?, ?, ?, 'uses', ?, 'active', ?, ?, ?)",
        parameters: ["c1.1", "u:user/p:project", "e1.0", "e1.1", 1, NOW_SECONDS, NOW_SECONDS],
      },
      {
        kind: "run",
        sql: "INSERT INTO claims(id, scope_key, subject_id, relation, object_value, state, origin_seq, first_seen_at, last_seen_at) VALUES (?, ?, ?, 'relates_to', ?, 'active', ?, ?, ?)",
        parameters: ["c1.2", "u:user/p:project", "e1.0", "literal", 1, NOW_SECONDS, NOW_SECONDS],
      },
    ]);

    await expectConstraintFailure(
      factory,
      "INSERT INTO entities(id, scope_key, name, normal_name, origin_seq) VALUES (?, ?, ?, ?, ?)",
      ["e2.0", "u:user/p:project", "duplicate", "subject", 2],
    );
    await factory.enqueueWriteTransaction([
      {
        kind: "run",
        sql: "INSERT INTO entities(id, scope_key, name, normal_name, merged_into, origin_seq) VALUES (?, ?, ?, ?, ?, ?)",
        parameters: ["e2.0", "u:user/p:project", "absorbed", "subject", "e1.0", 2],
      },
    ]);
    await expectConstraintFailure(
      factory,
      "INSERT INTO claims(id, scope_key, subject_id, relation, object_value, state, origin_seq, first_seen_at, last_seen_at) VALUES (?, ?, ?, 'describes', ?, 'active', ?, ?, ?)",
      ["c2.0", "u:user/p:project", "e1.0", "second", 2, NOW_SECONDS, NOW_SECONDS],
    );
    await expectConstraintFailure(
      factory,
      "INSERT INTO claims(id, scope_key, subject_id, relation, object_id, state, origin_seq, first_seen_at, last_seen_at) VALUES (?, ?, ?, 'uses', ?, 'active', ?, ?, ?)",
      ["c2.1", "u:user/p:project", "e1.0", "e1.1", 2, NOW_SECONDS, NOW_SECONDS],
    );
    await expectConstraintFailure(
      factory,
      "INSERT INTO claims(id, scope_key, subject_id, relation, object_value, state, origin_seq, first_seen_at, last_seen_at) VALUES (?, ?, ?, 'relates_to', ?, 'active', ?, ?, ?)",
      ["c2.2", "u:user/p:project", "e1.0", "literal", 2, NOW_SECONDS, NOW_SECONDS],
    );
    await expectConstraintFailure(
      factory,
      "INSERT INTO claims(id, scope_key, subject_id, relation, state, origin_seq, first_seen_at, last_seen_at) VALUES (?, ?, ?, 'uses', 'active', ?, ?, ?)",
      ["c2.3", "u:user/p:project", "e1.0", 2, NOW_SECONDS, NOW_SECONDS],
    );
    await expectConstraintFailure(
      factory,
      "INSERT INTO claims(id, scope_key, subject_id, relation, object_id, object_value, state, origin_seq, first_seen_at, last_seen_at) VALUES (?, ?, ?, 'uses', ?, ?, 'active', ?, ?, ?)",
      ["c2.4", "u:user/p:project", "e1.0", "e1.1", "both", 2, NOW_SECONDS, NOW_SECONDS],
    );

    await factory.enqueueWriteTransaction([
      {
        kind: "run",
        sql: "INSERT INTO claims(id, scope_key, subject_id, relation, object_value, state, origin_seq, first_seen_at, last_seen_at) VALUES (?, ?, ?, 'describes', ?, 'retracted', ?, ?, ?)",
        parameters: ["c2.0", "u:user/p:project", "e1.0", "second", 2, NOW_SECONDS, NOW_SECONDS],
      },
      {
        kind: "run",
        sql: "INSERT INTO claims(id, scope_key, subject_id, relation, object_id, state, origin_seq, first_seen_at, last_seen_at) VALUES (?, ?, ?, 'uses', ?, 'retracted', ?, ?, ?)",
        parameters: ["c2.1", "u:user/p:project", "e1.0", "e1.1", 2, NOW_SECONDS, NOW_SECONDS],
      },
    ]);
    assert.deepEqual(await rows(factory, "PRAGMA foreign_key_check"), []);
  } finally {
    await factory.close();
  }
});

test("CHECK and foreign-key constraints reject malformed journal and projection rows", async () => {
  const factory = await createSqliteConnectionFactory(createReadiness());
  try {
    await applySchema(factory);
    await factory.enqueueWriteTransaction([
      {
        kind: "run",
        sql: "INSERT INTO journal(id, scope_key, kind, body, created_at) VALUES (?, ?, 'statement', ?, ?)",
        parameters: ["ev_statement", "u:user/p:project", JSON.stringify({ raw_text: "valid" }), NOW_SECONDS],
      },
      {
        kind: "run",
        sql: "INSERT INTO journal(id, scope_key, kind, body, created_at) VALUES (?, ?, 'alias', ?, ?)",
        parameters: ["ev_alias", "u:user/p:project", JSON.stringify({}), NOW_SECONDS],
      },
      {
        kind: "run",
        sql: "INSERT INTO statements(event_id, scope_key, state, order_seq, created_at, provenance) VALUES (?, ?, 'live', ?, ?, 'user_stated')",
        parameters: ["ev_statement", "u:user/p:project", 1, NOW_SECONDS],
      },
      {
        kind: "run",
        sql: "INSERT INTO entities(id, scope_key, name, normal_name, origin_seq) VALUES (?, ?, ?, ?, ?)",
        parameters: ["e1.0", "u:user/p:project", "subject", "subject", 1],
      },
      {
        kind: "run",
        sql: "INSERT INTO claims(id, scope_key, subject_id, relation, object_value, state, origin_seq, first_seen_at, last_seen_at) VALUES (?, ?, ?, 'describes', ?, 'active', ?, ?, ?)",
        parameters: ["c1.0", "u:user/p:project", "e1.0", "value", 1, NOW_SECONDS, NOW_SECONDS],
      },
      {
        kind: "run",
        sql: "INSERT INTO claims(id, scope_key, subject_id, relation, object_value, state, origin_seq, first_seen_at, last_seen_at) VALUES (?, ?, ?, 'relates_to', ?, 'active', ?, ?, ?)",
        parameters: ["c1.1", "u:user/p:project", "e1.0", "second", 1, NOW_SECONDS, NOW_SECONDS],
      },
      {
        kind: "run",
        sql: "INSERT INTO claim_support(claim_id, event_id, draft_index) VALUES (?, ?, ?)",
        parameters: ["c1.0", "ev_statement", 0],
      },
    ]);

    const invalidRows = [
      [
        "INSERT INTO journal(id, scope_key, kind, body, created_at) VALUES (?, ?, ?, ?, ?)",
        ["ev_bad_kind", "u:user/p:project", "update", "{}", NOW_SECONDS],
      ],
      [
        "INSERT INTO journal(id, scope_key, kind, body, created_at) VALUES (?, ?, 'statement', ?, ?)",
        ["ev_bad_json", "u:user/p:project", "not-json", NOW_SECONDS],
      ],
      [
        "INSERT INTO statements(event_id, scope_key, state, order_seq, created_at, provenance) VALUES (?, ?, ?, ?, ?, ?)",
        ["ev_alias", "u:user/p:project", "unknown", 2, NOW_SECONDS, "observed"],
      ],
      [
        "INSERT INTO statements(event_id, scope_key, state, order_seq, created_at, provenance) VALUES (?, ?, 'live', ?, ?, ?)",
        ["ev_alias", "u:user/p:project", 2, NOW_SECONDS, "guessed"],
      ],
      [
        "INSERT INTO surface_forms(scope_key, surface_norm, entity_id, origin) VALUES (?, ?, ?, ?)",
        ["u:user/p:project", "surface", "e1.0", "unknown"],
      ],
      [
        "INSERT INTO claims(id, scope_key, subject_id, relation, object_value, state, origin_seq, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)",
        ["c_bad_relation", "u:user/p:project", "e1.0", "configures", "value", 1, NOW_SECONDS, NOW_SECONDS],
      ],
      [
        "INSERT INTO claims(id, scope_key, subject_id, relation, object_value, state, origin_seq, first_seen_at, last_seen_at) VALUES (?, ?, ?, 'uses', ?, ?, ?, ?, ?)",
        ["c_bad_state", "u:user/p:project", "e1.0", "value", "unknown", 1, NOW_SECONDS, NOW_SECONDS],
      ],
      [
        "INSERT INTO claim_support(claim_id, event_id, draft_index, live) VALUES (?, ?, ?, ?)",
        ["c1.0", "ev_statement", 1, 2],
      ],
      [
        "INSERT INTO claim_support(claim_id, event_id, draft_index) VALUES (?, ?, ?)",
        ["c1.1", "ev_statement", 0],
      ],
      [
        "INSERT INTO id_redirects(old_id, new_id, kind, reason) VALUES (?, ?, ?, ?)",
        ["e1.0", "e1.0", "entity", "merge"],
      ],
      [
        "INSERT INTO id_redirects(old_id, new_id, kind, reason) VALUES (?, ?, ?, ?)",
        ["old", "new", "event", "merge"],
      ],
      [
        "INSERT INTO id_redirects(old_id, new_id, kind, reason) VALUES (?, ?, ?, ?)",
        ["old", "new", "entity", "manual"],
      ],
      [
        "INSERT INTO statements(event_id, scope_key, state, order_seq, created_at, provenance) VALUES (?, ?, 'live', ?, ?, 'observed')",
        ["ev_missing", "u:user/p:project", 2, NOW_SECONDS],
      ],
      [
        "INSERT INTO surface_forms(scope_key, surface_norm, entity_id, origin) VALUES (?, ?, ?, 'confirmed')",
        ["u:user/p:project", "orphan", "e_missing"],
      ],
      [
        "INSERT INTO claims(id, scope_key, subject_id, relation, object_value, state, origin_seq, first_seen_at, last_seen_at) VALUES (?, ?, ?, 'describes', ?, 'active', ?, ?, ?)",
        ["c_orphan", "u:user/p:project", "e_missing", "value", 2, NOW_SECONDS, NOW_SECONDS],
      ],
      [
        "INSERT INTO claim_support(claim_id, event_id, draft_index) VALUES (?, ?, ?)",
        ["c_missing", "ev_statement", 1],
      ],
      [
        "INSERT INTO claim_support(claim_id, event_id, draft_index) VALUES (?, ?, ?)",
        ["c1.0", "ev_alias", 1],
      ],
    ];
    for (const [sql, parameters] of invalidRows) {
      await expectConstraintFailure(factory, sql, parameters);
    }

    assert.deepEqual(await rows(factory, "PRAGMA foreign_key_check"), []);
    assert.deepEqual(
      await rows(factory, "SELECT claim_id, event_id, draft_index, live FROM claim_support"),
      [{ claim_id: "c1.0", event_id: "ev_statement", draft_index: 0, live: 1 }],
    );
  } finally {
    await factory.close();
  }
});
