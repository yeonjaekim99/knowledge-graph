import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  SqliteBusyError,
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

const RESOLUTION_ERROR_MESSAGES = Object.freeze({
  INVALID_WRITE_ENTITY_RESOLUTION_INPUT:
    "write entity resolution requires canonical transaction-bound drafts",
  INVALID_WRITE_ENTITY_RESOLUTION_RESULT:
    "write entity resolution returned an invalid transaction result",
});

const AMBIGUITY_NOTES = Object.freeze({
  subject:
    "subject matches multiple entities; retry with an exact canonical name or confirm an alias or merge",
  object:
    "object matches multiple entities; retry with an exact canonical name or confirm an alias or merge",
});

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

function payloadBearingError(label, ErrorType = Error) {
  const error =
    ErrorType === WriteEntityResolutionError
      ? new WriteEntityResolutionError("INVALID_WRITE_ENTITY_RESOLUTION_INPUT")
      : new Error("synthetic fixture failure");
  Object.defineProperties(error, {
    message: {
      configurable: true,
      value: `${label}:synthetic-payload`,
      writable: true,
    },
    cause: {
      configurable: true,
      enumerable: true,
      value: Object.freeze({ token: `${label}:cause-payload` }),
    },
    prefix: {
      configurable: true,
      enumerable: true,
      value: `${label}:prefix-payload`,
    },
    suffix: {
      configurable: true,
      enumerable: true,
      value: `${label}:suffix-payload`,
    },
  });
  return error;
}

function promiseWithControlledSpecies(settle, speciesResult) {
  class ControlledSpeciesPromise extends Promise {
    static get [Symbol.species]() {
      return function ControlledSpecies(executor) {
        executor(
          () => undefined,
          () => undefined,
        );
        return speciesResult;
      };
    }
  }
  return new ControlledSpeciesPromise(settle);
}

async function captureRejection(operation) {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  assert.fail("expected operation to reject");
}

async function assertFreshResolutionError(operation, code, original, label) {
  const error = await captureRejection(operation);
  assert.ok(error instanceof WriteEntityResolutionError);
  assert.notStrictEqual(error, original);
  assert.equal(error.code, code);
  assert.equal(error.message, RESOLUTION_ERROR_MESSAGES[code]);
  assert.equal(Object.hasOwn(error, "cause"), false);
  assert.equal(Object.hasOwn(error, "prefix"), false);
  assert.equal(Object.hasOwn(error, "suffix"), false);
  assert.equal(String(error.stack).includes(label), false);
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
      statementBodyJson: statement("current scope", [
        { subject: "Current", relation: "describes", object_value: "safe" },
      ]).bodyJson,
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
      statementBodyJson: statement("survivor", [
        {
          subject: "First survivor",
          relation: "describes",
          object_value: "safe",
        },
      ]).bodyJson,
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
      statementBodyJson: statement("kinds", [
        {
          subject: "Hyphen kind",
          subject_kind: " - ",
          relation: "describes",
          object_value: "one",
        },
        {
          subject: "Underscore kind",
          subject_kind: "_",
          relation: "describes",
          object_value: "two",
        },
        {
          subject: "Fullwidth kind",
          subject_kind: "＿",
          relation: "describes",
          object_value: "three",
        },
      ]).bodyJson,
    });
    assert.deepEqual(
      finalized.drafts.map((item) => item.subjectId),
      ["e1.0", "e1.1", "e1.2"],
    );
    await session.rollback(prepared.dispatchId);
  });
});

test("rejects ill-formed kind scalars at both adapter and worker boundaries while preserving astral text", async (context) => {
  await context.test("adapter rejects lone high and low surrogates before invoking the session", async () => {
    let calls = 0;
    for (const malformed of ["\ud800", "\udc00"]) {
      await assert.rejects(
        resolveSqliteWriteEntityDrafts(
          {
            resolveEntities: async () => {
              calls += 1;
              return [];
            },
          },
          {
            dispatchId: 1,
            drafts: [draft(0, reference("Safe subject", { kind: malformed }))],
          },
        ),
        (error) => {
          assert.ok(error instanceof WriteEntityResolutionError);
          assert.equal(error.code, "INVALID_WRITE_ENTITY_RESOLUTION_INPUT");
          assert.equal(error.message, RESOLUTION_ERROR_MESSAGES[error.code]);
          assert.equal("cause" in error, false);
          return true;
        },
      );
    }
    assert.equal(calls, 0);
  });

  await context.test("adapter keeps a valid astral kind after canonical normalization", async () => {
    let capturedKind;
    const result = await resolveSqliteWriteEntityDrafts(
      {
        resolveEntities: async (_dispatchId, drafts) => {
          capturedKind = drafts[0].subject.kind;
          return [
            {
              draftIndex: 0,
              status: "resolved",
              subjectId: "e1.0",
              objectId: null,
            },
          ];
        },
      },
      {
        dispatchId: 1,
        drafts: [draft(0, reference("Safe subject", { kind: " Service😀 " }))],
      },
    );
    assert.equal(capturedKind, "service😀");
    assert.equal(result[0].status, "resolved");
  });

  await context.test("worker independently rejects lone surrogates and remains reusable", async () => {
    const factory = await createStore();
    for (const malformed of ["\ud800", "\udc00"]) {
      await assert.rejects(
        enqueueSqliteProjectionDispatchSession(factory, async (session) => {
          const prepared = await session.prepare(SCOPE);
          await session.resolveEntities(prepared.dispatchId, [
            draft(0, reference("Safe subject", { kind: malformed })),
          ]);
        }),
        (error) => {
          assert.ok(error instanceof SqliteConnectionError);
          assert.equal(error.code, "SQLITE_TRANSACTION_FAILED");
          assert.equal("cause" in error, false);
          return true;
        },
      );
    }

    await enqueueSqliteProjectionDispatchSession(factory, async (session) => {
      const prepared = await session.prepare(SCOPE);
      assert.deepEqual(
        await session.resolveEntities(prepared.dispatchId, [
          draft(0, reference("Safe subject", { kind: "Service😀" })),
        ]),
        [
          {
            draftIndex: 0,
            status: "resolved",
            subjectId: "e1.0",
            objectId: null,
          },
        ],
      );
      await session.rollback(prepared.dispatchId);
    });
    assert.deepEqual(await rows(factory, "SELECT id FROM entities"), []);
    assert.deepEqual(await rows(factory, "SELECT seq FROM journal"), []);
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

test("rejects payload-bearing notes and results that disagree with the expected draft shape", async (context) => {
  const candidates = [
    { entityId: "e1.0", name: "Alpha" },
    { entityId: "e2.0", name: "Beta" },
  ];
  const subjectOnlyInput = {
    dispatchId: 1,
    drafts: [draft(0, reference("Safe subject"))],
  };
  const objectInput = {
    dispatchId: 1,
    drafts: [draft(0, reference("Safe subject"), reference("Safe object"))],
  };

  await context.test("arbitrary rejected notes cannot echo a path or token", async () => {
    const payload = "SQL failure at /private/recall.sqlite3 token=synthetic-secret";
    await assertFreshResolutionError(
      () =>
        resolveSqliteWriteEntityDrafts(
          {
            resolveEntities: async () => [
              {
                draftIndex: 0,
                status: "rejected",
                reason: "ambiguous_entity",
                field: "subject",
                candidates,
                note: payload,
              },
            ],
          },
          subjectOnlyInput,
        ),
      "INVALID_WRITE_ENTITY_RESOLUTION_RESULT",
      payload,
      "synthetic-secret",
    );
  });

  await context.test("a subject-only draft cannot report object ambiguity", async () => {
    await assertFreshResolutionError(
      () =>
        resolveSqliteWriteEntityDrafts(
          {
            resolveEntities: async () => [
              {
                draftIndex: 0,
                status: "rejected",
                reason: "ambiguous_entity",
                field: "object",
                candidates,
                note: AMBIGUITY_NOTES.object,
              },
            ],
          },
          subjectOnlyInput,
        ),
      "INVALID_WRITE_ENTITY_RESOLUTION_RESULT",
      null,
      "private/recall.sqlite3",
    );
  });

  await context.test("a subject-only resolved draft cannot gain an object ID", async () => {
    await assertFreshResolutionError(
      () =>
        resolveSqliteWriteEntityDrafts(
          {
            resolveEntities: async () => [
              {
                draftIndex: 0,
                status: "resolved",
                subjectId: "e1.0",
                objectId: "e2.0",
              },
            ],
          },
          subjectOnlyInput,
        ),
      "INVALID_WRITE_ENTITY_RESOLUTION_RESULT",
      null,
      "private/recall.sqlite3",
    );
  });

  await context.test("an entity-object draft cannot lose its object ID", async () => {
    await assertFreshResolutionError(
      () =>
        resolveSqliteWriteEntityDrafts(
          {
            resolveEntities: async () => [
              {
                draftIndex: 0,
                status: "resolved",
                subjectId: "e1.0",
                objectId: null,
              },
            ],
          },
          objectInput,
        ),
      "INVALID_WRITE_ENTITY_RESOLUTION_RESULT",
      null,
      "private/recall.sqlite3",
    );
  });

  await context.test("canonical rejected output reconstructs its fixed actionable note", async () => {
    const result = await resolveSqliteWriteEntityDrafts(
      {
        resolveEntities: async () => [
          {
            draftIndex: 0,
            status: "rejected",
            reason: "ambiguous_entity",
            field: "subject",
            candidates,
            note: AMBIGUITY_NOTES.subject,
          },
        ],
      },
      subjectOnlyInput,
    );
    assert.deepEqual(result, [
      {
        draftIndex: 0,
        status: "rejected",
        reason: "ambiguous_entity",
        field: "subject",
        candidates,
        note: AMBIGUITY_NOTES.subject,
      },
    ]);
  });
});

test("replaces input reflection failures with fresh payload-redacted input errors", async (context) => {
  await context.test("top-level input object prototype trap", async () => {
    const original = payloadBearingError("input-object");
    const input = new Proxy(
      { dispatchId: 1, drafts: [] },
      {
        getPrototypeOf() {
          throw original;
        },
      },
    );
    await assertFreshResolutionError(
      () =>
        resolveSqliteWriteEntityDrafts(
          { resolveEntities: async () => [] },
          input,
        ),
      "INVALID_WRITE_ENTITY_RESOLUTION_INPUT",
      original,
      "input-object",
    );
  });

  await context.test("draft array length and descriptor traps", async () => {
    const original = payloadBearingError(
      "input-drafts",
      WriteEntityResolutionError,
    );
    const drafts = new Proxy([], {
      get(target, property, receiver) {
        if (property === "length") {
          throw original;
        }
        return Reflect.get(target, property, receiver);
      },
      getOwnPropertyDescriptor(target, property) {
        if (property === "length") {
          throw original;
        }
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });
    await assertFreshResolutionError(
      () =>
        resolveSqliteWriteEntityDrafts(
          { resolveEntities: async () => [] },
          { dispatchId: 1, drafts },
        ),
      "INVALID_WRITE_ENTITY_RESOLUTION_INPUT",
      original,
      "input-drafts",
    );
  });

  await context.test("session method accessor trap", async () => {
    const original = payloadBearingError("input-session-method");
    const session = new Proxy(
      {},
      {
        get(_target, property) {
          if (property === "resolveEntities") {
            throw original;
          }
          return undefined;
        },
      },
    );
    await assertFreshResolutionError(
      () =>
        resolveSqliteWriteEntityDrafts(session, {
          dispatchId: 1,
          drafts: [],
        }),
      "INVALID_WRITE_ENTITY_RESOLUTION_INPUT",
      original,
      "input-session-method",
    );
  });
});

test("replaces session and result inspection failures with fresh payload-redacted result errors", async (context) => {
  const input = {
    dispatchId: 1,
    drafts: [draft(0, reference("Safe subject"))],
  };

  await context.test("result array reflection trap", async () => {
    const original = payloadBearingError("result-array");
    const result = new Proxy([], {
      get(target, property, receiver) {
        if (property === "length") {
          throw original;
        }
        return Reflect.get(target, property, receiver);
      },
      getOwnPropertyDescriptor(target, property) {
        if (property === "length") {
          throw original;
        }
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });
    await assertFreshResolutionError(
      () =>
        resolveSqliteWriteEntityDrafts(
          { resolveEntities: async () => result },
          input,
        ),
      "INVALID_WRITE_ENTITY_RESOLUTION_RESULT",
      original,
      "result-array",
    );
  });

  await context.test("result array index accessor", async () => {
    const original = payloadBearingError("result-index-accessor");
    let accessorCalls = 0;
    const result = [];
    Object.defineProperty(result, "0", {
      configurable: true,
      enumerable: true,
      get() {
        accessorCalls += 1;
        throw original;
      },
    });
    await assertFreshResolutionError(
      () =>
        resolveSqliteWriteEntityDrafts(
          { resolveEntities: async () => result },
          input,
        ),
      "INVALID_WRITE_ENTITY_RESOLUTION_RESULT",
      original,
      "result-index-accessor",
    );
    assert.equal(accessorCalls, 0);
  });

  await context.test("result object descriptor trap", async () => {
    const original = payloadBearingError("result-object");
    const result = new Proxy(
      {
        draftIndex: 0,
        status: "resolved",
        subjectId: "e1.0",
        objectId: null,
      },
      {
        getOwnPropertyDescriptor() {
          throw original;
        },
      },
    );
    await assertFreshResolutionError(
      () =>
        resolveSqliteWriteEntityDrafts(
          { resolveEntities: async () => [result] },
          input,
        ),
      "INVALID_WRITE_ENTITY_RESOLUTION_RESULT",
      original,
      "result-object",
    );
  });

  await context.test("synchronous session call failure", async () => {
    const original = payloadBearingError("session-call");
    await assertFreshResolutionError(
      () =>
        resolveSqliteWriteEntityDrafts(
          {
            resolveEntities() {
              throw original;
            },
          },
          input,
        ),
      "INVALID_WRITE_ENTITY_RESOLUTION_RESULT",
      original,
      "session-call",
    );
  });

  await context.test("asynchronous session rejection", async () => {
    const original = payloadBearingError(
      "session-rejection",
      WriteEntityResolutionError,
    );
    await assertFreshResolutionError(
      () =>
        resolveSqliteWriteEntityDrafts(
          { resolveEntities: async () => Promise.reject(original) },
          input,
        ),
      "INVALID_WRITE_ENTITY_RESOLUTION_RESULT",
      original,
      "session-rejection",
    );
  });

  await context.test("session thenable accessor failure", async () => {
    const original = payloadBearingError("session-thenable");
    await assertFreshResolutionError(
      () =>
        resolveSqliteWriteEntityDrafts(
          {
            resolveEntities: () => ({
              get then() {
                throw original;
              },
            }),
          },
          input,
        ),
      "INVALID_WRITE_ENTITY_RESOLUTION_RESULT",
      original,
      "session-thenable",
    );
  });

  await context.test("session Promise then accessor failure", async () => {
    const original = payloadBearingError("session-promise-then");
    const result = new Proxy(Promise.resolve([]), {
      get(target, property, receiver) {
        if (property === "then") {
          throw original;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    await assertFreshResolutionError(
      () =>
        resolveSqliteWriteEntityDrafts(
          { resolveEntities: () => result },
          input,
        ),
      "INVALID_WRITE_ENTITY_RESOLUTION_RESULT",
      original,
      "session-promise-then",
    );
  });

  await context.test("finalization result reflection trap", async () => {
    const original = payloadBearingError("finalization-result");
    const result = new Proxy(
      { expectedJournalSeq: 1, drafts: [] },
      {
        ownKeys() {
          throw original;
        },
      },
    );
    await assertFreshResolutionError(
      () =>
        finalizeSqliteWriteEntityDrafts(
          { finalizeEntities: async () => result },
          {
            dispatchId: 1,
            survivorDraftIndexes: [],
            statementBodyJson: "{}",
          },
        ),
      "INVALID_WRITE_ENTITY_RESOLUTION_RESULT",
      original,
      "finalization-result",
    );
  });

  await context.test("finalization session rejection", async () => {
    const original = payloadBearingError(
      "finalization-rejection",
      WriteEntityResolutionError,
    );
    await assertFreshResolutionError(
      () =>
        finalizeSqliteWriteEntityDrafts(
          { finalizeEntities: async () => Promise.reject(original) },
          {
            dispatchId: 1,
            survivorDraftIndexes: [],
            statementBodyJson: "{}",
          },
        ),
      "INVALID_WRITE_ENTITY_RESOLUTION_RESULT",
      original,
      "finalization-rejection",
    );
  });
});

test("keeps Promise species objects behind a native public settlement boundary", async (context) => {
  await context.test("resolve success returns a native Promise and frozen validated result", async () => {
    const speciesResult = Object.freeze({ label: "resolve-species-result" });
    const operation = resolveSqliteWriteEntityDrafts(
      {
        resolveEntities: () =>
          promiseWithControlledSpecies((resolve) => resolve([]), speciesResult),
      },
      { dispatchId: 1, drafts: [] },
    );

    assert.ok(operation instanceof Promise);
    assert.equal(Object.getPrototypeOf(operation), Promise.prototype);
    assert.notStrictEqual(operation, speciesResult);
    const result = await operation;
    assert.deepEqual(result, []);
    assert.ok(Object.isFrozen(result));
  });

  await context.test("finalization success returns a native Promise and frozen validated result", async () => {
    const speciesResult = Object.freeze({ label: "finalize-species-result" });
    const operation = finalizeSqliteWriteEntityDrafts(
      {
        finalizeEntities: () =>
          promiseWithControlledSpecies(
            (resolve) => resolve({ expectedJournalSeq: 1, drafts: [] }),
            speciesResult,
          ),
      },
      {
        dispatchId: 1,
        survivorDraftIndexes: [],
        statementBodyJson: "{}",
      },
    );

    assert.ok(operation instanceof Promise);
    assert.equal(Object.getPrototypeOf(operation), Promise.prototype);
    assert.notStrictEqual(operation, speciesResult);
    const result = await operation;
    assert.deepEqual(result, { expectedJournalSeq: 1, drafts: [] });
    assert.ok(Object.isFrozen(result));
    assert.ok(Object.isFrozen(result.drafts));
  });

  await context.test("a species return object's then getter is never exposed or evaluated", async () => {
    const original = payloadBearingError("species-return-then");
    let thenReads = 0;
    const speciesResult = {};
    Object.defineProperty(speciesResult, "then", {
      configurable: true,
      get() {
        thenReads += 1;
        throw original;
      },
    });
    const operation = resolveSqliteWriteEntityDrafts(
      {
        resolveEntities: () =>
          promiseWithControlledSpecies((resolve) => resolve([]), speciesResult),
      },
      { dispatchId: 1, drafts: [] },
    );

    assert.equal(Object.getPrototypeOf(operation), Promise.prototype);
    assert.deepEqual(await operation, []);
    assert.equal(thenReads, 0);
  });

  await context.test("a species getter failure becomes a fresh fixed result error", async () => {
    const original = payloadBearingError("species-getter");
    class ThrowingSpeciesPromise extends Promise {
      static get [Symbol.species]() {
        throw original;
      }
    }
    await assertFreshResolutionError(
      () =>
        resolveSqliteWriteEntityDrafts(
          {
            resolveEntities: () =>
              new ThrowingSpeciesPromise((resolve) => resolve([])),
          },
          { dispatchId: 1, drafts: [] },
        ),
      "INVALID_WRITE_ENTITY_RESOLUTION_RESULT",
      original,
      "species-getter",
    );
  });

  await context.test("a species-controlled rejection becomes a fresh fixed result error", async () => {
    const original = payloadBearingError(
      "species-settlement",
      WriteEntityResolutionError,
    );
    const speciesResult = Object.freeze({ label: "rejected-species-result" });
    await assertFreshResolutionError(
      () =>
        resolveSqliteWriteEntityDrafts(
          {
            resolveEntities: () =>
              promiseWithControlledSpecies(
                (_resolve, reject) => reject(original),
                speciesResult,
              ),
          },
          { dispatchId: 1, drafts: [] },
        ),
      "INVALID_WRITE_ENTITY_RESOLUTION_RESULT",
      original,
      "species-settlement",
    );
  });

  await context.test("a species-controlled SQLite rejection keeps only fresh retry semantics", async () => {
    const original = new SqliteBusyError();
    const speciesResult = Object.freeze({ label: "busy-species-result" });
    const error = await captureRejection(() =>
      resolveSqliteWriteEntityDrafts(
        {
          resolveEntities: () =>
            promiseWithControlledSpecies(
              (_resolve, reject) => reject(original),
              speciesResult,
            ),
        },
        { dispatchId: 1, drafts: [] },
      ),
    );

    assert.ok(error instanceof SqliteBusyError);
    assert.notStrictEqual(error, original);
    assert.equal(error.code, "SQLITE_BUSY");
    assert.equal(error.retryable, true);
    assert.equal(error.timeoutMs, 5000);
    assert.equal(Object.hasOwn(error, "cause"), false);
  });
});

test("preserves factory-redacted SQLite connection errors across the adapter boundary", async () => {
  const original = new SqliteConnectionError("SQLITE_TRANSACTION_FAILED");
  const error = await captureRejection(() =>
    resolveSqliteWriteEntityDrafts(
      { resolveEntities: async () => Promise.reject(original) },
      { dispatchId: 1, drafts: [] },
    ),
  );
  assert.ok(error instanceof SqliteConnectionError);
  assert.notStrictEqual(error, original);
  assert.equal(error.code, "SQLITE_TRANSACTION_FAILED");
  assert.equal(error.retryable, false);
  assert.equal(error.message, "SQLite write transaction failed and was rolled back");
  assert.equal(Object.hasOwn(error, "cause"), false);
});

test("reconstructs a fresh connection error without inheriting a poisoned prototype", async () => {
  const original = new SqliteConnectionError("SQLITE_TRANSACTION_FAILED");
  const poisonedPrototype = Object.create(SqliteConnectionError.prototype, {
    cause: {
      configurable: true,
      get: () => Object.freeze({ token: "prototype:cause-payload" }),
    },
    path: {
      configurable: true,
      get: () => "prototype:path-payload",
    },
    prefix: {
      configurable: true,
      get: () => "prototype:prefix-payload",
    },
  });
  Object.setPrototypeOf(original, poisonedPrototype);

  const error = await captureRejection(() =>
    resolveSqliteWriteEntityDrafts(
      { resolveEntities: async () => Promise.reject(original) },
      { dispatchId: 1, drafts: [] },
    ),
  );
  assert.ok(error instanceof SqliteConnectionError);
  assert.notStrictEqual(error, original);
  assert.equal(Object.getPrototypeOf(error), SqliteConnectionError.prototype);
  assert.equal("cause" in error, false);
  assert.equal("path" in error, false);
  assert.equal("prefix" in error, false);
});

test("reconstructs a fresh connection error without invoking transparent Proxy getters", async () => {
  const target = new SqliteConnectionError("SQLITE_TRANSACTION_FAILED");
  let getterCalls = 0;
  const original = new Proxy(target, {
    get(value, property, receiver) {
      getterCalls += 1;
      if (property === "cause" || property === "path" || property === "prefix") {
        return `proxy:${String(property)}-payload`;
      }
      return Reflect.get(value, property, receiver);
    },
  });

  const error = await captureRejection(() =>
    resolveSqliteWriteEntityDrafts(
      { resolveEntities: async () => Promise.reject(original) },
      { dispatchId: 1, drafts: [] },
    ),
  );
  assert.ok(error instanceof SqliteConnectionError);
  assert.notStrictEqual(error, original);
  assert.equal(error.code, "SQLITE_TRANSACTION_FAILED");
  assert.equal(getterCalls, 0);
  assert.equal("cause" in error, false);
  assert.equal("path" in error, false);
  assert.equal("prefix" in error, false);
});

test("rejects a runtime-invalid connection error code", async () => {
  const original = new SqliteConnectionError("NOT_A_CONNECTION_CODE");
  await assertFreshResolutionError(
    () =>
      resolveSqliteWriteEntityDrafts(
        { resolveEntities: async () => Promise.reject(original) },
        { dispatchId: 1, drafts: [] },
      ),
    "INVALID_WRITE_ENTITY_RESOLUTION_RESULT",
    original,
    "NOT_A_CONNECTION_CODE",
  );
});

test("reconstructs canonical SQLITE_BUSY retry semantics in a fresh error", async () => {
  const original = new SqliteBusyError();
  const error = await captureRejection(() =>
    resolveSqliteWriteEntityDrafts(
      { resolveEntities: async () => Promise.reject(original) },
      { dispatchId: 1, drafts: [] },
    ),
  );
  assert.ok(error instanceof SqliteBusyError);
  assert.notStrictEqual(error, original);
  assert.equal(error.code, "SQLITE_BUSY");
  assert.equal(error.retryable, true);
  assert.equal(error.timeoutMs, 5000);
  assert.equal(error.message, "SQLite writer lock was not available within five seconds");
  assert.equal(Object.hasOwn(error, "cause"), false);
});

test("replaces mutated SQLite errors that are no longer payload-redacted", async () => {
  const original = new SqliteConnectionError("SQLITE_TRANSACTION_FAILED");
  Object.defineProperties(original, {
    message: {
      configurable: true,
      value: "sqlite-mutated:synthetic-payload",
      writable: true,
    },
    cause: {
      configurable: true,
      enumerable: true,
      value: Object.freeze({ token: "sqlite-mutated:cause-payload" }),
    },
    prefix: {
      configurable: true,
      enumerable: true,
      value: "sqlite-mutated:prefix-payload",
    },
    suffix: {
      configurable: true,
      enumerable: true,
      value: "sqlite-mutated:suffix-payload",
    },
  });
  await assertFreshResolutionError(
    () =>
      resolveSqliteWriteEntityDrafts(
        { resolveEntities: async () => Promise.reject(original) },
        { dispatchId: 1, drafts: [] },
      ),
    "INVALID_WRITE_ENTITY_RESOLUTION_RESULT",
    original,
    "sqlite-mutated",
  );
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
        statementBodyJson: statement("expected", [
          {
            subject: "Expected",
            relation: "describes",
            object_value: "safe",
          },
        ]).bodyJson,
      });
      await session.append(prepared.dispatchId, [
        appendEvent(
          "1",
          statement("mismatch", [
            {
              subject: "Expected",
              relation: "describes",
              object_value: "safe",
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
