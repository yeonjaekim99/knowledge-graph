import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  SqliteConnectionError,
  createSqliteConnectionFactory,
  createSqliteProjectionDispatcher,
  runBundledSqliteMigrations,
  runSqliteStartupGate,
} from "../../../dist/adapters/sqlite/index.js";
import { reduceIncrementalProjection } from "../../../dist/domain/index.js";
import { enqueueSqliteProjectionDispatchSession } from "../../../dist/adapters/sqlite/connection-factory.js";
import {
  WriteEntityResolutionError,
  resolveSqliteWriteEntityDrafts,
} from "../../../dist/adapters/sqlite/write-entity-resolver.js";
import { createDeterministicRuntimeProvider } from "../../support/deterministic-runtime-provider.mjs";

const NOW = 1_700_000_000;
const SCOPE = "u:record-user/p:recall";
const OTHER_SCOPE = "u:other-user/p:recall";
const temporaryDirectories = [];
const openFactories = new Set();

afterEach(async () => {
  await Promise.allSettled([...openFactories].map((factory) => factory.close()));
  openFactories.clear();
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

async function createStore() {
  const root = mkdtempSync(join(tmpdir(), "recall-rec-004-"));
  temporaryDirectories.push(root);
  const stateDirectory = join(root, "state");
  mkdirSync(stateDirectory, { mode: 0o700 });
  chmodSync(stateDirectory, 0o700);
  const readiness = runSqliteStartupGate({
    databasePath: join(stateDirectory, "recall.sqlite3"),
  });
  const factory = await createSqliteConnectionFactory(readiness);
  openFactories.add(factory);
  await runBundledSqliteMigrations(factory, { appliedAtSeconds: NOW });
  return factory;
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

function reference(candidateId, name, options = {}) {
  return {
    candidateId,
    name,
    kind: options.kind ?? null,
    aliases: options.aliases ?? [],
  };
}

function draft(draftIndex, subject, object = null) {
  return { draftIndex, subject, object };
}

function eventId(suffix) {
  return `ev_${"0".repeat(25)}${suffix}`;
}

function statement(rawText, parsed) {
  return {
    kind: "statement",
    bodyJson: JSON.stringify({
      raw_text: rawText,
      parsed,
      provenance: "user_stated",
      ttl: "permanent",
    }),
  };
}

async function resolveInRollback(factory, drafts) {
  return enqueueSqliteProjectionDispatchSession(factory, async (session) => {
    const prepared = await session.prepare(SCOPE);
    try {
      return await resolveSqliteWriteEntityDrafts(session, {
        dispatchId: prepared.dispatchId,
        drafts,
      });
    } finally {
      await session.rollback(prepared.dispatchId);
    }
  });
}

async function seedEntityState(factory) {
  await factory.enqueueWriteTransaction([
    {
      kind: "run",
      sql: "INSERT INTO entities(id, scope_key, name, normal_name, kind, merged_into, origin_seq) VALUES ('e1.0', ?, 'Auth Service', 'authservice', 'service', NULL, 1)",
      parameters: [SCOPE],
    },
    {
      kind: "run",
      sql: "INSERT INTO entities(id, scope_key, name, normal_name, kind, merged_into, origin_seq) VALUES ('e2.0', ?, 'Legacy Auth', 'legacyauth', NULL, 'e1.0', 2)",
      parameters: [SCOPE],
    },
    {
      kind: "run",
      sql: "INSERT INTO id_redirects(old_id, new_id, kind, reason) VALUES ('e2.0', 'e1.0', 'entity', 'merge')",
    },
    {
      kind: "run",
      sql: "INSERT INTO surface_forms(scope_key, surface_norm, entity_id, origin) VALUES (?, 'login', 'e2.0', 'confirmed')",
      parameters: [SCOPE],
    },
  ]);
}

test("resolves every surface candidate through redirects before exact-name fallback and never changes an existing kind", async () => {
  const factory = await createStore();
  await seedEntityState(factory);

  const result = await resolveInRollback(factory, [
    draft(
      0,
      reference("e90.0", "login", {
        kind: "different-kind",
        aliases: ["entry"],
      }),
      reference("e90.1", "Session Store", { kind: "database" }),
    ),
  ]);

  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result[0]), true);
  assert.deepEqual(result, [
    {
      draftIndex: 0,
      status: "resolved",
      subjectId: "e1.0",
      objectId: "e90.1",
    },
  ]);
  assert.deepEqual(
    await rows(
      factory,
      "SELECT id, kind FROM entities WHERE scope_key=? ORDER BY id",
      [SCOPE],
    ),
    [
      { id: "e1.0", kind: "service" },
      { id: "e2.0", kind: null },
    ],
    "pre-resolution staging is always rolled back",
  );
  assert.deepEqual(
    await rows(
      factory,
      "SELECT surface_norm, entity_id, origin FROM surface_forms WHERE scope_key=? ORDER BY surface_norm, entity_id",
      [SCOPE],
    ),
    [{ surface_norm: "login", entity_id: "e2.0", origin: "confirmed" }],
    "confirmed origin and existing homonym rows are never overwritten",
  );
});

test("uses an exact active normal name as the only tie-break and otherwise rejects just that draft", async () => {
  const factory = await createStore();
  await factory.enqueueWriteTransaction([
    {
      kind: "run",
      sql: "INSERT INTO entities(id, scope_key, name, normal_name, kind, merged_into, origin_seq) VALUES ('e1.0', ?, 'Authentication', 'authentication', NULL, NULL, 1)",
      parameters: [SCOPE],
    },
    {
      kind: "run",
      sql: "INSERT INTO entities(id, scope_key, name, normal_name, kind, merged_into, origin_seq) VALUES ('e2.0', ?, 'Login', 'login', NULL, NULL, 2)",
      parameters: [SCOPE],
    },
    {
      kind: "run",
      sql: "INSERT INTO entities(id, scope_key, name, normal_name, kind, merged_into, origin_seq) VALUES ('e3.0', ?, 'Payments', 'payments', NULL, NULL, 3)",
      parameters: [SCOPE],
    },
    {
      kind: "run",
      sql: "INSERT INTO surface_forms(scope_key, surface_norm, entity_id, origin) VALUES (?, 'login', 'e1.0', 'agent_supplied')",
      parameters: [SCOPE],
    },
    {
      kind: "run",
      sql: "INSERT INTO surface_forms(scope_key, surface_norm, entity_id, origin) VALUES (?, 'login', 'e2.0', 'confirmed')",
      parameters: [SCOPE],
    },
    {
      kind: "run",
      sql: "INSERT INTO surface_forms(scope_key, surface_norm, entity_id, origin) VALUES (?, 'shared', 'e1.0', 'confirmed')",
      parameters: [SCOPE],
    },
    {
      kind: "run",
      sql: "INSERT INTO surface_forms(scope_key, surface_norm, entity_id, origin) VALUES (?, 'shared', 'e3.0', 'agent_supplied')",
      parameters: [SCOPE],
    },
  ]);

  const result = await resolveInRollback(factory, [
    draft(0, reference("e90.0", "login")),
    draft(1, reference("e90.1", "shared")),
    draft(2, reference("e90.2", "Safe Entity")),
  ]);

  assert.deepEqual(result[0], {
    draftIndex: 0,
    status: "resolved",
    subjectId: "e2.0",
    objectId: null,
  });
  assert.deepEqual(result[1], {
    draftIndex: 1,
    status: "rejected",
    reason: "ambiguous_entity",
    field: "subject",
    candidates: [
      { entityId: "e1.0", name: "Authentication" },
      { entityId: "e3.0", name: "Payments" },
    ],
    note:
      "subject matches multiple entities; retry with an exact canonical name or confirm an alias or merge",
  });
  assert.equal(Object.isFrozen(result[1].candidates), true);
  assert.equal(Object.isFrozen(result[1].candidates[0]), true);
  assert.deepEqual(result[2], {
    draftIndex: 2,
    status: "resolved",
    subjectId: "e90.2",
    objectId: null,
  });
});

test("rolls an ambiguous draft savepoint back without removing prior accepted state or contaminating later drafts", async () => {
  const factory = await createStore();
  await factory.enqueueWriteTransaction([
    {
      kind: "run",
      sql: "INSERT INTO entities(id, scope_key, name, normal_name, kind, merged_into, origin_seq) VALUES ('e1.0', ?, 'Alpha', 'alpha', NULL, NULL, 1)",
      parameters: [SCOPE],
    },
    {
      kind: "run",
      sql: "INSERT INTO entities(id, scope_key, name, normal_name, kind, merged_into, origin_seq) VALUES ('e2.0', ?, 'Beta', 'beta', NULL, NULL, 2)",
      parameters: [SCOPE],
    },
    {
      kind: "run",
      sql: "INSERT INTO surface_forms(scope_key, surface_norm, entity_id, origin) VALUES (?, 'shared', 'e1.0', 'agent_supplied')",
      parameters: [SCOPE],
    },
    {
      kind: "run",
      sql: "INSERT INTO surface_forms(scope_key, surface_norm, entity_id, origin) VALUES (?, 'shared', 'e2.0', 'confirmed')",
      parameters: [SCOPE],
    },
  ]);

  const result = await resolveInRollback(factory, [
    draft(0, reference("e90.0", "Prior", { aliases: ["prior-alias"] })),
    draft(
      1,
      reference("e90.1", "Transient"),
      reference("e90.2", "shared"),
    ),
    draft(2, reference("e90.3", "Transient")),
    draft(3, reference("e90.4", "prior-alias")),
  ]);

  assert.deepEqual(result, [
    {
      draftIndex: 0,
      status: "resolved",
      subjectId: "e90.0",
      objectId: null,
    },
    {
      draftIndex: 1,
      status: "rejected",
      reason: "ambiguous_entity",
      field: "object",
      candidates: [
        { entityId: "e1.0", name: "Alpha" },
        { entityId: "e2.0", name: "Beta" },
      ],
      note:
        "object matches multiple entities; retry with an exact canonical name or confirm an alias or merge",
    },
    {
      draftIndex: 2,
      status: "resolved",
      subjectId: "e90.3",
      objectId: null,
    },
    {
      draftIndex: 3,
      status: "resolved",
      subjectId: "e90.0",
      objectId: null,
    },
  ]);
});

test("keeps alias homonyms separate and makes a later write deterministically ambiguous", async () => {
  const factory = await createStore();

  const result = await resolveInRollback(factory, [
    draft(
      0,
      reference("e90.0", "Alpha", { aliases: ["shared"] }),
      reference("e90.1", "Beta", { aliases: ["shared"] }),
    ),
    draft(1, reference("e90.2", "shared")),
  ]);

  assert.deepEqual(result, [
    {
      draftIndex: 0,
      status: "resolved",
      subjectId: "e90.0",
      objectId: "e90.1",
    },
    {
      draftIndex: 1,
      status: "rejected",
      reason: "ambiguous_entity",
      field: "subject",
      candidates: [
        { entityId: "e90.0", name: "Alpha" },
        { entityId: "e90.1", name: "Beta" },
      ],
      note:
        "subject matches multiple entities; retry with an exact canonical name or confirm an alias or merge",
    },
  ]);
});

test("rereads the unique normal-name winner after an INSERT OR IGNORE constraint collision", async () => {
  const factory = await createStore();
  await factory.enqueueWriteTransaction([
    {
      kind: "exec",
      sql: [
        "CREATE TRIGGER rec004_competing_entity BEFORE INSERT ON entities",
        "WHEN new.id = 'e90.0' BEGIN",
        `INSERT INTO entities(id, scope_key, name, normal_name, kind, merged_into, origin_seq) VALUES ('e80.0', '${SCOPE}', 'Collision Name', new.normal_name, 'winner-kind', NULL, 80);`,
        "END",
      ].join(" "),
    },
  ]);

  const result = await resolveInRollback(factory, [
    draft(0, reference("e90.0", "Collision Name", { kind: "loser-kind" })),
    draft(1, reference("e90.1", "Collision-Name")),
  ]);

  assert.deepEqual(result, [
    {
      draftIndex: 0,
      status: "resolved",
      subjectId: "e80.0",
      objectId: null,
    },
    {
      draftIndex: 1,
      status: "resolved",
      subjectId: "e80.0",
      objectId: null,
    },
  ]);
  assert.deepEqual(
    await rows(factory, "SELECT id FROM entities WHERE id IN ('e80.0','e90.0','e90.1')"),
    [],
    "the defensive insert and collision winner stay inside the outer savepoint",
  );
});

test("ignores other-scope candidates and redacts cross-scope identifier collisions", async () => {
  const factory = await createStore();
  const otherName = "other-scope-private-name";
  await factory.enqueueWriteTransaction([
    {
      kind: "run",
      sql: "INSERT INTO entities(id, scope_key, name, normal_name, kind, merged_into, origin_seq) VALUES ('e70.0', ?, ?, 'sharedprivate', NULL, NULL, 70)",
      parameters: [OTHER_SCOPE, otherName],
    },
    {
      kind: "run",
      sql: "INSERT INTO surface_forms(scope_key, surface_norm, entity_id, origin) VALUES (?, 'sharedprivate', 'e70.0', 'confirmed')",
      parameters: [OTHER_SCOPE],
    },
  ]);

  assert.deepEqual(
    await resolveInRollback(factory, [
      draft(0, reference("e90.0", "shared private")),
    ]),
    [
      {
        draftIndex: 0,
        status: "resolved",
        subjectId: "e90.0",
        objectId: null,
      },
    ],
  );

  await assert.rejects(
    resolveInRollback(factory, [
      draft(0, reference("e70.0", "current-scope-name")),
    ]),
    (error) => {
      assert.ok(
        error instanceof SqliteConnectionError ||
          error instanceof WriteEntityResolutionError,
      );
      assert.doesNotMatch(error.message, /other-scope|private-name|e70\.0/u);
      assert.equal("cause" in error, false);
      return true;
    },
  );

  assert.deepEqual(
    await resolveInRollback(factory, [
      draft(1, reference("e91.0", "queue remains usable")),
    ]),
    [
      {
        draftIndex: 1,
        status: "resolved",
        subjectId: "e91.0",
        objectId: null,
      },
    ],
  );
});

test("rejects malformed resolver input without opening a projection-only commit path", async () => {
  const factory = await createStore();

  await enqueueSqliteProjectionDispatchSession(factory, async (session) => {
    const prepared = await session.prepare(SCOPE);
    await assert.rejects(
      resolveSqliteWriteEntityDrafts(session, {
        dispatchId: prepared.dispatchId,
        drafts: [
          draft(0, reference("not-an-entity-id", "payload-must-not-echo")),
        ],
      }),
      (error) => {
        assert.ok(error instanceof WriteEntityResolutionError);
        assert.equal(error.code, "INVALID_WRITE_ENTITY_RESOLUTION_INPUT");
        assert.doesNotMatch(error.message, /payload-must-not-echo/u);
        assert.equal("cause" in error, false);
        return true;
      },
    );
    await assert.rejects(
      session.commit(
        prepared.dispatchId,
        "incremental",
        "projection-v1",
        NOW,
        prepared.current,
      ),
      (error) => {
        assert.ok(error instanceof SqliteConnectionError);
        assert.equal(error.code, "SQLITE_TRANSACTION_FAILED");
        return true;
      },
    );
  });

  assert.deepEqual(await rows(factory, "SELECT id FROM entities"), []);
  assert.deepEqual(await rows(factory, "SELECT seq FROM journal"), []);
});

test("rolls all pre-resolution staging back before append and permits only journal plus projection commit", async () => {
  const factory = await createStore();
  const rulesVersion = "projection-v1";
  const dispatcher = createSqliteProjectionDispatcher({
    factory,
    runtime: createDeterministicRuntimeProvider({
      nowMilliseconds: NOW * 1_000,
      eventIds: [eventId("1")],
      rulesVersion,
      scope: {
        userId: "record-user",
        projectId: "recall",
        scopeKey: SCOPE,
      },
    }),
  });
  await dispatcher.execute([
    statement("seed", [
      { subject: "Seed", relation: "describes", object_value: "ready" },
    ]),
  ]);

  await enqueueSqliteProjectionDispatchSession(factory, async (session) => {
    const prepared = await session.prepare(SCOPE);
    assert.deepEqual(
      await resolveSqliteWriteEntityDrafts(session, {
        dispatchId: prepared.dispatchId,
        drafts: [
          draft(
            0,
            reference("e2.0", "Must Roll Back", {
              aliases: ["must-not-persist"],
            }),
          ),
        ],
      }),
      [
        {
          draftIndex: 0,
          status: "resolved",
          subjectId: "e2.0",
          objectId: null,
        },
      ],
    );
    const appended = await session.append(prepared.dispatchId, [
      {
        eventId: eventId("2"),
        kind: "statement",
        bodyJson: statement("raw only", []).bodyJson,
        actor: null,
        branch: null,
        session: null,
        createdAt: NOW + 1,
      },
    ]);
    const desired = reduceIncrementalProjection({
      scopeKey: SCOPE,
      rulesVersion,
      current: prepared.current,
      events: appended.appendedEvents,
      history: appended.events,
    });
    await session.commit(
      prepared.dispatchId,
      "incremental",
      rulesVersion,
      NOW + 1,
      desired,
    );
  });

  assert.deepEqual(
    await rows(factory, "SELECT seq FROM journal ORDER BY seq"),
    [{ seq: 1 }, { seq: 2 }],
  );
  assert.deepEqual(
    await rows(
      factory,
      "SELECT id, name FROM entities WHERE scope_key=? ORDER BY id",
      [SCOPE],
    ),
    [{ id: "e1.0", name: "Seed" }],
  );
  assert.deepEqual(
    await rows(
      factory,
      "SELECT surface_norm FROM surface_forms WHERE surface_norm='mustnotpersist'",
    ),
    [],
  );
});
