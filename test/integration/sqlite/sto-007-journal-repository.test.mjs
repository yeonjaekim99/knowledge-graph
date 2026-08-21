import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  JOURNAL_ID_COLLISION_ATTEMPT_LIMIT,
  JournalAppendError,
  SqliteConnectionError,
  createSqliteConnectionFactory,
  createSqliteJournalRepository,
  runBundledSqliteMigrations,
  runSqliteStartupGate,
} from "../../../dist/adapters/sqlite/index.js";
import { createDeterministicRuntimeProvider } from "../../support/deterministic-runtime-provider.mjs";
import * as publicApi from "@recall/mcp-server";

const NOW_SECONDS = 1_700_000_000;
const SCOPE = Object.freeze({
  userId: "journal-user",
  projectId: "journal-project",
  scopeKey: "u:journal-user/p:journal-project",
});
const METADATA = Object.freeze({
  actor: "observed-client",
  branch: "main",
  session: `hmac-sha256:${"a".repeat(64)}`,
});
const temporaryDirectories = [];
const openFactories = new Set();

function eventId(suffix) {
  assert.match(suffix, /^[0-9A-HJKMNP-TV-Z]$/u);
  return `ev_${"0".repeat(25)}${suffix}`;
}

afterEach(async () => {
  await Promise.allSettled([...openFactories].map((factory) => factory.close()));
  openFactories.clear();
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

function createReadiness() {
  const root = mkdtempSync(join(tmpdir(), "recall-sto-007-"));
  temporaryDirectories.push(root);
  const stateDirectory = join(root, "state");
  mkdirSync(stateDirectory, { mode: 0o700 });
  chmodSync(stateDirectory, 0o700);
  return runSqliteStartupGate({
    databasePath: join(stateDirectory, "private-memory.sqlite3"),
  });
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

async function createStore({
  eventIds,
  scope = SCOPE,
  metadata = METADATA,
  nowMilliseconds = NOW_SECONDS * 1_000 + 999,
} = {}) {
  const factory = await createSqliteConnectionFactory(createReadiness());
  openFactories.add(factory);
  await runBundledSqliteMigrations(factory, {
    appliedAtSeconds: NOW_SECONDS - 1,
  });
  const runtime = createDeterministicRuntimeProvider({
    eventIds,
    scope,
    metadata,
    nowMilliseconds,
  });
  return {
    factory,
    repository: createSqliteJournalRepository({ factory, runtime }),
  };
}

function journalAppendError(code, retryable = false) {
  return (error) => {
    assert.ok(error instanceof JournalAppendError);
    assert.equal(error.code, code);
    assert.equal(error.retryable, retryable);
    assert.equal("cause" in error, false);
    return true;
  };
}

test("a trusted request snapshot is appended byte-for-byte in seq order with statement FTS", async () => {
  const firstId = eventId("Z");
  const secondId = eventId("0");
  const { factory, repository } = await createStore({
    eventIds: [firstId, secondId],
  });
  const statementBody =
    '{  "raw_text" : "인증서버는\\n세션을 사용한다", "parsed" : []  }';
  const aliasBody = '{"surface":"로그인","entity_id":"e1.0"}';
  const intents = [
    { kind: "statement", bodyJson: statementBody },
    { kind: "alias", bodyJson: aliasBody },
  ];

  const pending = repository.append(intents);
  intents.reverse();
  intents[1].bodyJson = '{"raw_text":"mutated"}';
  const receipt = await pending;

  assert.deepEqual(receipt, {
    events: [
      { index: 0, eventId: firstId, seq: 1 },
      { index: 1, eventId: secondId, seq: 2 },
    ],
  });
  assert.equal(Object.isFrozen(receipt), true);
  assert.equal(Object.isFrozen(receipt.events), true);
  assert.equal(receipt.events.every(Object.isFrozen), true);
  assert.ok(firstId.localeCompare(secondId) > 0, "fixture reverses ULID sort");

  const journal = await queryRows(
    factory,
    "SELECT seq, id, scope_key, kind, body, actor, branch, session, created_at FROM journal ORDER BY seq",
  );
  assert.deepEqual(journal, [
    {
      seq: 1,
      id: firstId,
      scope_key: SCOPE.scopeKey,
      kind: "statement",
      body: statementBody,
      actor: METADATA.actor,
      branch: METADATA.branch,
      session: METADATA.session,
      created_at: NOW_SECONDS,
    },
    {
      seq: 2,
      id: secondId,
      scope_key: SCOPE.scopeKey,
      kind: "alias",
      body: aliasBody,
      actor: METADATA.actor,
      branch: METADATA.branch,
      session: METADATA.session,
      created_at: NOW_SECONDS,
    },
  ]);
  assert.deepEqual(
    await queryRows(
      factory,
      "SELECT rowid FROM journal_fts WHERE journal_fts MATCH ? ORDER BY rowid",
      ["인증서"],
    ),
    [{ rowid: 1 }],
  );
});

test("one existing event ID retries the whole unexposed batch without consuming seq or FTS rows", async () => {
  const collision = eventId("1");
  const abandoned = eventId("2");
  const freshFirst = eventId("Z");
  const freshSecond = eventId("0");
  const { factory, repository } = await createStore({
    eventIds: [collision, abandoned, freshFirst, freshSecond],
  });
  const existingBody = '{"raw_text":"기존기억"}';
  await factory.enqueueWriteTransaction([
    {
      kind: "run",
      sql: "INSERT INTO journal(id, scope_key, kind, body, created_at) VALUES (?, ?, 'statement', ?, ?)",
      parameters: [collision, SCOPE.scopeKey, existingBody, NOW_SECONDS - 10],
    },
  ]);

  const receipt = await repository.append([
    { kind: "statement", bodyJson: '{"raw_text":"새로운기억"}' },
    { kind: "alias", bodyJson: '{"surface":"새기억","entity_id":"e2.0"}' },
  ]);

  assert.deepEqual(receipt, {
    events: [
      { index: 0, eventId: freshFirst, seq: 2 },
      { index: 1, eventId: freshSecond, seq: 3 },
    ],
  });
  assert.deepEqual(
    await queryRows(factory, "SELECT seq, id FROM journal ORDER BY seq"),
    [
      { seq: 1, id: collision },
      { seq: 2, id: freshFirst },
      { seq: 3, id: freshSecond },
    ],
  );
  assert.deepEqual(
    await queryRows(factory, "SELECT rowid FROM journal_fts ORDER BY rowid"),
    [{ rowid: 1 }, { rowid: 2 }],
  );
  assert.equal(
    (await queryRows(factory, "SELECT 1 AS present FROM journal WHERE id = ?", [abandoned]))
      .length,
    0,
  );
});

test("an injected failure after a prior row rolls back the journal and FTS before later reuse", async () => {
  const failedFirst = eventId("3");
  const failedSecond = eventId("4");
  const recovered = eventId("5");
  const { factory, repository } = await createStore({
    eventIds: [failedFirst, failedSecond, recovered],
  });
  await factory.enqueueWriteTransaction([
    {
      kind: "exec",
      sql: "CREATE TRIGGER journal_test_abort BEFORE INSERT ON journal " +
        "WHEN json_extract(new.body, '$.inject_failure') = 1 " +
        "BEGIN SELECT RAISE(ABORT, 'injected test failure'); END",
    },
  ]);

  await assert.rejects(
    repository.append([
      { kind: "statement", bodyJson: '{"raw_text":"first row"}' },
      {
        kind: "statement",
        bodyJson: '{"raw_text":"second row","inject_failure":1}',
      },
    ]),
    (error) => {
      assert.ok(error instanceof SqliteConnectionError);
      assert.equal(error.code, "SQLITE_TRANSACTION_FAILED");
      assert.equal(error.retryable, false);
      assert.equal("cause" in error, false);
      assert.doesNotMatch(JSON.stringify(error), /first row|second row|injected/u);
      return true;
    },
  );
  assert.deepEqual(await queryRows(factory, "SELECT seq, id FROM journal"), []);
  assert.deepEqual(await queryRows(factory, "SELECT rowid FROM journal_fts"), []);

  await factory.enqueueWriteTransaction([
    { kind: "exec", sql: "DROP TRIGGER journal_test_abort" },
  ]);
  assert.deepEqual(
    await repository.append([
      { kind: "statement", bodyJson: '{"raw_text":"recovered"}' },
    ]),
    { events: [{ index: 0, eventId: recovered, seq: 1 }] },
  );
});

test("invalid or tool-shaped intents fail before consuming an event ID or touching SQLite", async () => {
  const firstValidId = eventId("6");
  const { factory, repository } = await createStore({
    eventIds: [firstValidId],
  });
  const secret = "SHOULD_NOT_APPEAR";
  let accessorCalls = 0;
  const accessorIntent = { kind: "statement" };
  Object.defineProperty(accessorIntent, "bodyJson", {
    enumerable: true,
    get() {
      accessorCalls += 1;
      return "{}";
    },
  });
  const invalidBatches = [
    [],
    [{ kind: "unknown", bodyJson: "{}" }],
    [{ kind: "statement", bodyJson: `{"raw_text":"${secret}"` }],
    [{ kind: "statement", bodyJson: "[]" }],
    [{ kind: "statement", bodyJson: "null" }],
    [{ kind: "statement", bodyJson: "{}", id: eventId("7") }],
    [{ kind: "statement", bodyJson: "{}", scope_key: "u:other/p:other" }],
    [accessorIntent],
  ];

  for (const batch of invalidBatches) {
    await assert.rejects(repository.append(batch), (error) => {
      assert.ok(error instanceof JournalAppendError);
      assert.equal(error.code, "INVALID_EVENT_BATCH");
      assert.equal(error.retryable, false);
      assert.equal("cause" in error, false);
      assert.doesNotMatch(JSON.stringify(error), new RegExp(secret));
      return true;
    });
  }
  assert.equal(accessorCalls, 0);
  assert.deepEqual(await queryRows(factory, "SELECT seq, id FROM journal"), []);

  const trustedSnapshot = createDeterministicRuntimeProvider({
    scope: SCOPE,
    metadata: METADATA,
    nowMilliseconds: NOW_SECONDS * 1_000,
  });
  const invalidIdRepository = createSqliteJournalRepository({
    factory,
    runtime: Object.freeze({
      capture() {
        return trustedSnapshot.capture();
      },
      nextEventId() {
        return "ev_noncanonical";
      },
      nextApprovalToken() {
        return trustedSnapshot.nextApprovalToken();
      },
    }),
  });
  await assert.rejects(
    invalidIdRepository.append([
      { kind: "statement", bodyJson: '{"raw_text":"invalid id"}' },
    ]),
    journalAppendError("INVALID_EVENT_ID"),
  );
  assert.deepEqual(await queryRows(factory, "SELECT seq, id FROM journal"), []);

  assert.deepEqual(
    await repository.append([
      { kind: "statement", bodyJson: '{"raw_text":"valid after rejects"}' },
    ]),
    { events: [{ index: 0, eventId: firstValidId, seq: 1 }] },
  );
});

test("repeated ID collisions stop at the fixed retry boundary without appending", async () => {
  const collision = eventId("8");
  const { factory, repository } = await createStore({
    eventIds: Array.from(
      { length: JOURNAL_ID_COLLISION_ATTEMPT_LIMIT },
      () => collision,
    ),
  });
  await factory.enqueueWriteTransaction([
    {
      kind: "run",
      sql: "INSERT INTO journal(id, scope_key, kind, body, created_at) VALUES (?, ?, 'alias', '{}', ?)",
      parameters: [collision, SCOPE.scopeKey, NOW_SECONDS - 10],
    },
  ]);

  await assert.rejects(
    repository.append([{ kind: "alias", bodyJson: "{}" }]),
    journalAppendError("EVENT_ID_COLLISION_EXHAUSTED", true),
  );
  assert.deepEqual(
    await queryRows(factory, "SELECT seq, id FROM journal ORDER BY seq"),
    [{ seq: 1, id: collision }],
  );
});

test("the private repository exposes append only and cannot accept identity metadata selectors", async () => {
  const { repository } = await createStore({ eventIds: [eventId("9")] });

  assert.deepEqual(Object.keys(repository), ["append"]);
  assert.equal(Object.isFrozen(repository), true);
  assert.equal(repository.append.length, 1);
  assert.equal("appendAndProject" in repository, false);
  assert.equal("update" in repository, false);
  assert.equal("delete" in repository, false);
  assert.equal("scope" in repository, false);
  assert.deepEqual(Object.keys(publicApi), []);
});
