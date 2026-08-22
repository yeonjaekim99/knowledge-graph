import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  SqliteConnectionError,
  WriteEntityResolutionError,
  createSqliteConnectionFactory,
  createSqliteProjectionDispatcher,
  finalizeSqliteWriteEntityDrafts,
  resolveSqliteWriteEntityDrafts,
  runBundledSqliteMigrations,
  runSqliteStartupGate,
} from "../../../dist/adapters/sqlite/index.js";
import { enqueueSqliteProjectionDispatchSession } from "../../../dist/adapters/sqlite/connection-factory.js";
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
  const root = mkdtempSync(join(tmpdir(), "recall-rec-004-finalize-"));
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

function eventId(suffix) {
  return `ev_${"0".repeat(25)}${suffix}`;
}

function reference(name, options = {}) {
  return {
    name,
    kind: options.kind ?? null,
    aliases: options.aliases ?? [],
  };
}

function draft(draftIndex, subject, object = null) {
  return { draftIndex, subject, object };
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

function appendEvent(suffix, value) {
  return {
    eventId: eventId(suffix),
    kind: value.kind,
    bodyJson: value.bodyJson,
    actor: null,
    branch: null,
    session: null,
    createdAt: NOW,
  };
}

async function seedStatements(factory, scope, values) {
  const runtime = createDeterministicRuntimeProvider({
    nowMilliseconds: NOW * 1_000,
    eventIds: values.map((_, index) => eventId(String(index + 1))),
    rulesVersion: "projection-v1",
    scope:
      scope === SCOPE
        ? { userId: "record-user", projectId: "recall", scopeKey: SCOPE }
        : {
            userId: "other-user",
            projectId: "recall",
            scopeKey: OTHER_SCOPE,
          },
  });
  const dispatcher = createSqliteProjectionDispatcher({ factory, runtime });
  await dispatcher.execute(values);
}

test("allocates occurrence candidates from the database-global next journal seq across scopes", async () => {
  const factory = await createStore();
  await seedStatements(factory, OTHER_SCOPE, [
    statement("other scope", [
      { subject: "Other", relation: "describes", object_value: "private" },
    ]),
  ]);

  await enqueueSqliteProjectionDispatchSession(factory, async (session) => {
    const prepared = await session.prepare(SCOPE);
    assert.equal(prepared.expectedJournalSeq, 2);
    const resolved = await resolveSqliteWriteEntityDrafts(session, {
      dispatchId: prepared.dispatchId,
      drafts: [draft(7, reference("Current"))],
    });
    assert.equal(resolved[0].status, "resolved");

    const finalized = await finalizeSqliteWriteEntityDrafts(session, {
      dispatchId: prepared.dispatchId,
      survivorDraftIndexes: [7],
    });
    assert.deepEqual(finalized, {
      expectedJournalSeq: 2,
      drafts: [
        {
          draftIndex: 7,
          status: "resolved",
          subjectId: "e2.0",
          objectId: null,
        },
      ],
    });

    const appended = await session.append(prepared.dispatchId, [
      appendEvent(
        "2",
        statement("current scope", [
          { subject: "Current", relation: "describes", object_value: "safe" },
        ]),
      ),
    ]);
    assert.deepEqual(
      appended.appendedEvents.map((event) => event.seq),
      [2],
    );
    await session.rollback(prepared.dispatchId);
  });
});

test("compacts rejected occurrences and lets REC-005 choose survivors before final IDs and append parity", async () => {
  const factory = await createStore();
  await seedStatements(factory, SCOPE, [
    statement("alpha", [
      {
        subject: "Alpha",
        subject_aliases: ["shared"],
        relation: "describes",
        object_value: "one",
      },
    ]),
    statement("beta", [
      {
        subject: "Beta",
        subject_aliases: ["shared"],
        relation: "describes",
        object_value: "two",
      },
    ]),
  ]);

  await enqueueSqliteProjectionDispatchSession(factory, async (session) => {
    const prepared = await session.prepare(SCOPE);
    const resolved = await resolveSqliteWriteEntityDrafts(session, {
      dispatchId: prepared.dispatchId,
      drafts: [
        draft(10, reference("shared")),
        draft(11, reference("First survivor")),
        draft(12, reference("First-survivor")),
      ],
    });
    assert.equal(resolved[0].status, "rejected");
    assert.equal(resolved[1].status, "resolved");
    assert.equal(resolved[2].status, "resolved");

    const finalized = await finalizeSqliteWriteEntityDrafts(session, {
      dispatchId: prepared.dispatchId,
      survivorDraftIndexes: [11],
    });
    assert.deepEqual(finalized.drafts, [
      {
        draftIndex: 11,
        status: "resolved",
        subjectId: "e3.0",
        objectId: null,
      },
    ]);

    const appended = await session.append(prepared.dispatchId, [
      appendEvent(
        "3",
        statement("survivor", [
          {
            subject: "First survivor",
            relation: "describes",
            object_value: "safe",
          },
        ]),
      ),
    ]);
    assert.equal(appended.appendedEvents[0].seq, 3);
    await session.rollback(prepared.dispatchId);
  });
});

test("normalizes kind independently from entity names and accepts separator-only kinds", async () => {
  const factory = await createStore();
  await enqueueSqliteProjectionDispatchSession(factory, async (session) => {
    const prepared = await session.prepare(SCOPE);
    const resolved = await resolveSqliteWriteEntityDrafts(session, {
      dispatchId: prepared.dispatchId,
      drafts: [
        draft(0, reference("Hyphen kind", { kind: " - " })),
        draft(1, reference("Underscore kind", { kind: "_" })),
        draft(2, reference("Fullwidth kind", { kind: "＿" })),
      ],
    });
    assert.deepEqual(
      resolved.map((item) => item.status),
      ["resolved", "resolved", "resolved"],
    );
    const finalized = await finalizeSqliteWriteEntityDrafts(session, {
      dispatchId: prepared.dispatchId,
      survivorDraftIndexes: [0, 1, 2],
    });
    assert.deepEqual(
      finalized.drafts.map((item) => item.subjectId),
      ["e1.0", "e1.1", "e1.2"],
    );
    await session.rollback(prepared.dispatchId);
  });
});

test("rejects duplicate, out-of-order, and malformed ambiguity candidates at the adapter boundary", async () => {
  const input = {
    dispatchId: 1,
    drafts: [draft(0, reference("shared"))],
  };
  const result = (candidates) => [
    {
      draftIndex: 0,
      status: "rejected",
      reason: "ambiguous_entity",
      field: "subject",
      candidates,
      note: "safe retry note",
    },
  ];
  const invalidCandidates = [
    [
      { entityId: "e1.0", name: "Alpha" },
      { entityId: "e1.0", name: "Duplicate" },
    ],
    [
      { entityId: "e2.0", name: "Beta" },
      { entityId: "e1.0", name: "Alpha" },
    ],
    [
      { entityId: "e1.0", name: "Alpha" },
      { entityId: "e2.0", name: "" },
    ],
  ];

  for (const candidates of invalidCandidates) {
    const fakeSession = {
      resolveEntities: async () => result(candidates),
    };
    await assert.rejects(
      resolveSqliteWriteEntityDrafts(fakeSession, input),
      (error) => {
        assert.ok(error instanceof WriteEntityResolutionError);
        assert.equal(error.code, "INVALID_WRITE_ENTITY_RESOLUTION_RESULT");
        return true;
      },
    );
  }
});

test("fails closed on journal sequence drift and on finalized body mismatch", async () => {
  const drifted = await createStore();
  await seedStatements(drifted, SCOPE, [statement("seed", [])]);
  await drifted.enqueueWriteTransaction([
    { kind: "run", sql: "UPDATE sqlite_sequence SET seq=9 WHERE name='journal'" },
  ]);
  await assert.rejects(
    enqueueSqliteProjectionDispatchSession(drifted, async (session) => {
      await session.prepare(SCOPE);
    }),
    (error) => {
      assert.ok(error instanceof SqliteConnectionError);
      assert.equal(error.code, "SQLITE_TRANSACTION_FAILED");
      return true;
    },
  );

  const mismatched = await createStore();
  await assert.rejects(
    enqueueSqliteProjectionDispatchSession(mismatched, async (session) => {
      const prepared = await session.prepare(SCOPE);
      await resolveSqliteWriteEntityDrafts(session, {
        dispatchId: prepared.dispatchId,
        drafts: [draft(0, reference("Expected"))],
      });
      await finalizeSqliteWriteEntityDrafts(session, {
        dispatchId: prepared.dispatchId,
        survivorDraftIndexes: [0],
      });
      await session.append(prepared.dispatchId, [
        appendEvent(
          "1",
          statement("mismatch", [
            {
              subject: "Different",
              relation: "describes",
              object_value: "unsafe",
            },
          ]),
        ),
      ]);
    }),
    (error) => {
      assert.ok(error instanceof SqliteConnectionError);
      assert.equal(error.code, "SQLITE_TRANSACTION_FAILED");
      return true;
    },
  );
  assert.deepEqual(await rows(mismatched, "SELECT seq FROM journal"), []);
});
