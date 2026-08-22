import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import Database from "better-sqlite3";

import {
  RECALL_OVERVIEW_NOTE_TEXT,
  selectRecallOverviewCandidates,
} from "../../../dist/application/recall-overview.js";
import { RecallReadError } from "../../../dist/application/ports/recall-read-port.js";
import { RecallSnapshotService } from "../../../dist/application/recall-snapshot-service.js";
import {
  RECALL_OVERVIEW_SQL_SOURCE,
  createSqliteConnectionFactory,
  createSqliteRecallReadPort,
  runBundledSqliteMigrations,
  runSqliteStartupGate,
} from "../../../dist/adapters/sqlite/index.js";
import { createDeterministicRuntimeProvider } from "../../support/deterministic-runtime-provider.mjs";

const NOW = 1_700_200_000;
const SCOPE = "u:alice/p:rcl-004";
const OTHER_SCOPE = "u:bob/p:rcl-004";
const temporaryDirectories = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

function eventId(seq) {
  return `ev_${String(seq).padStart(26, "0")}`;
}

function runtime(scopeKey = SCOPE, evaluationNow = NOW) {
  const [, userId, projectId] = /^u:([^/]+)\/p:(.+)$/u.exec(scopeKey) ?? [];
  return createDeterministicRuntimeProvider({
    nowMilliseconds: evaluationNow * 1_000,
    scope: { userId, projectId, scopeKey },
  });
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "recall-rcl-004-"));
  temporaryDirectories.push(root);
  const stateDirectory = join(root, "state");
  mkdirSync(stateDirectory, { mode: 0o700 });
  chmodSync(stateDirectory, 0o700);
  const databasePath = join(stateDirectory, "recall.sqlite3");
  const readiness = runSqliteStartupGate({ databasePath });
  const factory = await createSqliteConnectionFactory(readiness);
  await runBundledSqliteMigrations(factory, { appliedAtSeconds: NOW });
  return { databasePath, factory };
}

function rawStatementCommands({
  seq,
  rawText,
  scopeKey = SCOPE,
  state = "live",
  createdAt = NOW - seq,
  recordedAt = createdAt,
  expiresAt = null,
  parsed = [],
  provenance = "observed",
}) {
  return [
    {
      kind: "run",
      sql: "INSERT INTO journal(seq,id,scope_key,kind,body,actor,branch,session,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
      parameters: [
        seq,
        eventId(seq),
        scopeKey,
        "statement",
        JSON.stringify({
          raw_text: rawText,
          parsed,
          provenance,
          ttl: expiresAt === null ? "permanent" : "session",
        }),
        "rcl-004-test",
        "rcl-004-overview-seeds",
        null,
        recordedAt,
      ],
    },
    {
      kind: "run",
      sql: "INSERT INTO statements(event_id,scope_key,state,order_seq,created_at,provenance,expires_at) VALUES (?,?,?,?,?,?,?)",
      parameters: [
        eventId(seq),
        scopeKey,
        state,
        seq,
        createdAt,
        provenance,
        expiresAt,
      ],
    },
  ];
}

function graphStatementCommands({
  seq,
  subjectId = `e${seq}.0`,
  subjectName = `entity-${seq}`,
  rawText = `graph-${seq}`,
  scopeKey = SCOPE,
  claimId = `c${seq}.0`,
  relation = "relates_to",
  objectValue = `value-${seq}`,
  claimState = "active",
  supportLive = 1,
  statementState = "live",
  createdAt = NOW - seq,
  recordedAt = createdAt,
  expiresAt = null,
  provenance = "observed",
}) {
  const parsed = [
    {
      subject: subjectName,
      relation,
      relation_label: "related",
      object_value: objectValue,
    },
  ];
  return [
    ...rawStatementCommands({
      seq,
      rawText,
      scopeKey,
      state: statementState,
      createdAt,
      recordedAt,
      expiresAt,
      parsed,
      provenance,
    }),
    {
      kind: "run",
      sql: "INSERT OR IGNORE INTO entities(id,scope_key,name,normal_name,kind,merged_into,origin_seq) VALUES (?,?,?,?,NULL,NULL,?)",
      parameters: [
        subjectId,
        scopeKey,
        subjectName,
        subjectName.toLowerCase(),
        Number(/^e([0-9]+)/u.exec(subjectId)?.[1] ?? seq),
      ],
    },
    {
      kind: "run",
      sql: "INSERT INTO claims(id,scope_key,subject_id,relation,object_id,object_value,state,origin_seq,first_seen_at,last_seen_at) VALUES (?,?,?, ?,NULL,?,?,?,?,?)",
      parameters: [
        claimId,
        scopeKey,
        subjectId,
        relation,
        objectValue,
        claimState,
        seq,
        createdAt,
        createdAt,
      ],
    },
    {
      kind: "run",
      sql: "INSERT INTO claim_support(claim_id,event_id,draft_index,live,expires_at) VALUES (?,?,0,?,?)",
      parameters: [claimId, eventId(seq), supportLive, expiresAt],
    },
  ];
}

function service(factory, scopeKey = SCOPE, evaluationNow = NOW) {
  return new RecallSnapshotService(
    runtime(scopeKey, evaluationNow),
    createSqliteRecallReadPort(factory),
  );
}

function overview(factory, limit = 10, scopeKey = SCOPE, evaluationNow = NOW) {
  return service(factory, scopeKey, evaluationNow).withSnapshot((source) =>
    selectRecallOverviewCandidates(source, limit),
  );
}

function permanentDump(database) {
  const tables = [
    "journal",
    "statements",
    "entities",
    "surface_forms",
    "claims",
    "claim_support",
    "id_redirects",
    "projection_meta",
    "journal_fts",
  ];
  return JSON.stringify(
    Object.fromEntries(
      tables.map((table) => [
        table,
        database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      ]),
    ),
  );
}

function validEntityRow(overrides = {}) {
  return {
    recall_overview_entity_id: "e1.0",
    recall_overview_entity_incident_count: 1,
    recall_overview_entity_merged_into: null,
    recall_overview_entity_name: "safe entity",
    recall_overview_entity_recent_at: NOW - 1,
    recall_overview_entity_scope_key: SCOPE,
    ...overrides,
  };
}

function validRawRow(overrides = {}) {
  return {
    recall_overview_created_at: NOW - 1,
    recall_overview_event_id: eventId(1),
    recall_overview_has_valid_graph_duplicate: 0,
    recall_overview_journal_scope_key: SCOPE,
    recall_overview_parsed_count: 0,
    recall_overview_parsed_type: "array",
    recall_overview_provenance: "observed",
    recall_overview_raw_text: "safe raw",
    recall_overview_raw_text_type: "text",
    recall_overview_recorded_at: NOW - 1,
    recall_overview_statement_expires_at: null,
    recall_overview_statement_scope_key: SCOPE,
    recall_overview_statement_seq: 1,
    recall_overview_statement_state: "live",
    ...overrides,
  };
}

async function overviewInjectedResult(factory, rawResult, limit = 10) {
  return overviewInjectedRead(
    factory,
    () => Promise.resolve(rawResult),
    limit,
  );
}

async function overviewInjectedRead(factory, readRawOverviewState, limit = 10) {
  const reader = await factory.openReader();
  Object.defineProperty(reader, "withRecallSnapshot", {
    configurable: true,
    value: async (_scopeKey, _evaluationNow, operation) =>
      operation(
        Object.freeze({
          assertActive() {},
          async listRawAggregateRows() {
            return Object.freeze([]);
          },
          readRawOverviewState,
        }),
      ),
  });
  const injectedFactory = Object.freeze({
    async openReader() {
      return reader;
    },
  });
  return overview(injectedFactory, limit);
}

function smuggledReadError(marker) {
  const error = new RecallReadError("INVALID_RECALL_OVERVIEW_CANDIDATE");
  error.name = marker;
  error.message = marker;
  error.cause = { marker };
  error.secret = marker;
  return error;
}

function payloadAdapterError(kind, marker) {
  if (kind === "typed") {
    return smuggledReadError(marker);
  }
  const error = new Error(marker);
  error.name = marker;
  error.cause = { marker };
  error.secret = marker;
  return error;
}

function freshAdapterError(injected, marker) {
  return (error) => {
    const expected = new RecallReadError("INVALID_RECALL_OVERVIEW_CANDIDATE");
    assert.ok(error instanceof RecallReadError);
    assert.notStrictEqual(error, injected);
    assert.equal(error.code, expected.code);
    assert.equal(error.name, expected.name);
    assert.equal(error.message, expected.message);
    assert.deepEqual(Reflect.ownKeys(error).sort(), Reflect.ownKeys(expected).sort());
    assert.equal("cause" in error, false);
    assert.equal(JSON.stringify(error).includes(marker), false);
    return true;
  };
}

test("overview SQL is parameterized, TEMP-valid-rooted, numerically ordered, and read-only", () => {
  assert.equal(Object.isFrozen(RECALL_OVERVIEW_SQL_SOURCE), true);
  const sql = Object.values(RECALL_OVERVIEW_SQL_SOURCE).join("\n");
  assert.match(RECALL_OVERVIEW_SQL_SOURCE.selectEntityCandidates, /FROM temp\.recall_claim_agg/u);
  assert.match(RECALL_OVERVIEW_SQL_SOURCE.selectEntityCandidates, /COUNT\(DISTINCT/u);
  assert.match(RECALL_OVERVIEW_SQL_SOURCE.selectEntityCandidates, /:overview_seed_probe_limit/u);
  assert.match(RECALL_OVERVIEW_SQL_SOURCE.selectRawCandidates, /:overview_raw_probe_limit/u);
  assert.match(RECALL_OVERVIEW_SQL_SOURCE.selectRawCandidates, /json_array_length/u);
  assert.match(RECALL_OVERVIEW_SQL_SOURCE.selectRawCandidates, /ORDER BY[\s\S]*created_at DESC[\s\S]*seq DESC/iu);
  assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|REPLACE)\b/iu);
});

test("overview seeds use distinct incident count, recency, then numeric entity ID with canonical depth-zero display", async (t) => {
  const { factory } = await fixture();
  t.after(() => factory.close());
  const commands = [];
  let seq = 1;
  const addClaims = (entityId, entityName, count, recentAt) => {
    for (let index = 0; index < count; index += 1) {
      commands.push(
        ...graphStatementCommands({
          seq,
          subjectId: entityId,
          subjectName: entityName,
          rawText: `${entityName} claim ${index}`,
          objectValue: `${entityName}-value-${index}`,
          createdAt: index === 0 ? recentAt : recentAt - index,
        }),
      );
      seq += 1;
    }
  };
  addClaims("e10.0", "ten", 3, NOW - 50);
  addClaims("e9.0", "recent", 2, NOW - 1);
  addClaims("e2.10", "two-ten", 2, NOW - 10);
  addClaims("e2.2", "two-two", 2, NOW - 10);
  await factory.enqueueWriteTransaction(commands);

  const first = await overview(factory, 10);
  const repeated = await overview(factory, 10);
  assert.equal(JSON.stringify(repeated), JSON.stringify(first));
  assert.deepEqual(
    first.seeds.map((seed) => [
      seed.entityId,
      seed.display,
      seed.depth,
      seed.seedOrder,
      seed.incidentClaimCount,
      seed.lastSeenAt,
    ]),
    [
      ["e10.0", "ten", 0, 0, 3, NOW - 50],
      ["e9.0", "recent", 0, 1, 2, NOW - 1],
      ["e2.2", "two-two", 0, 2, 2, NOW - 10],
      ["e2.10", "two-ten", 0, 3, 2, NOW - 10],
    ],
  );
  assert.deepEqual(first.rawCandidates, []);
  assert.deepEqual(first.truncation, { reasons: [] });
  assert.deepEqual(first.notes, []);
  assert.equal(first.seeds.some((seed) => seed.kind === "entity"), false);
});

test("overview reads one seed sentinel beyond min(limit, ten) and reports deterministic truncation", async (t) => {
  const { factory } = await fixture();
  t.after(() => factory.close());
  await factory.enqueueWriteTransaction(
    Array.from({ length: 11 }, (_, index) =>
      graphStatementCommands({
        seq: index + 1,
        subjectId: `e${index + 1}.0`,
        subjectName: `entity-${index + 1}`,
        createdAt: NOW - 1,
      }),
    ).flat(),
  );

  const ten = await overview(factory, 50);
  assert.deepEqual(
    ten.seeds.map((seed) => seed.entityId),
    Array.from({ length: 10 }, (_, index) => `e${index + 1}.0`),
  );
  assert.deepEqual(ten.truncation, { reasons: ["overview_seeds"] });
  assert.deepEqual(ten.notes, [
    {
      code: "overview_seed_limit",
      text: RECALL_OVERVIEW_NOTE_TEXT.overview_seed_limit,
    },
  ]);

  const three = await overview(factory, 3);
  assert.deepEqual(
    three.seeds.map((seed) => seed.entityId),
    ["e1.0", "e2.0", "e3.0"],
  );
  assert.deepEqual(three.truncation, { reasons: ["overview_seeds"] });
});

test("raw-only overview is scope and TTL safe and orders effective time then actual journal sequence", async (t) => {
  const { factory } = await fixture();
  t.after(() => factory.close());
  await factory.enqueueWriteTransaction([
    ...rawStatementCommands({ seq: 1, rawText: "older", createdAt: NOW - 2 }),
    ...rawStatementCommands({ seq: 2, rawText: "same-low", createdAt: NOW - 1 }),
    ...rawStatementCommands({ seq: 3, rawText: "same-high", createdAt: NOW - 1, recordedAt: NOW - 100 }),
    ...rawStatementCommands({ seq: 4, rawText: "expired", expiresAt: NOW }),
    ...rawStatementCommands({ seq: 5, rawText: "retracted", state: "retracted" }),
    ...rawStatementCommands({ seq: 6, rawText: "superseded", state: "superseded" }),
    ...rawStatementCommands({ seq: 7, rawText: "other", scopeKey: OTHER_SCOPE }),
  ]);

  const result = await overview(factory, 10);
  assert.deepEqual(result.seeds, []);
  assert.deepEqual(
    result.rawCandidates.map((raw) => [
      raw.eventId,
      raw.text,
      raw.createdAt,
      raw.recordedAt,
      raw.statementSeq,
    ]),
    [
      [eventId(3), "same-high", NOW - 1, NOW - 100, 3],
      [eventId(2), "same-low", NOW - 1, NOW - 1, 2],
      [eventId(1), "older", NOW - 2, NOW - 2, 1],
    ],
  );

  const other = await overview(factory, 10, OTHER_SCOPE);
  assert.deepEqual(other.seeds, []);
  assert.deepEqual(other.rawCandidates.map((raw) => raw.eventId), [eventId(7)]);
});

test("valid same-raw graph suppresses raw-only duplicates while dead graph history never resurrects", async (t) => {
  const { factory } = await fixture();
  t.after(() => factory.close());
  await factory.enqueueWriteTransaction([
    ...graphStatementCommands({ seq: 1, rawText: "valid duplicate", createdAt: NOW - 20 }),
    ...rawStatementCommands({ seq: 2, rawText: "valid duplicate", createdAt: NOW - 1 }),
    ...graphStatementCommands({ seq: 3, rawText: "expired duplicate", expiresAt: NOW }),
    ...rawStatementCommands({ seq: 4, rawText: "expired duplicate", createdAt: NOW - 2 }),
    ...graphStatementCommands({
      seq: 5,
      rawText: "retracted duplicate",
      claimState: "retracted",
      supportLive: 0,
    }),
    ...rawStatementCommands({ seq: 6, rawText: "retracted duplicate", createdAt: NOW - 3 }),
    ...graphStatementCommands({
      seq: 7,
      rawText: "cross-scope graph",
      scopeKey: OTHER_SCOPE,
    }),
    ...rawStatementCommands({ seq: 8, rawText: "cross-scope graph", createdAt: NOW - 4 }),
  ]);

  const result = await overview(factory, 10);
  assert.deepEqual(result.seeds.map((seed) => seed.entityId), ["e1.0"]);
  assert.deepEqual(
    result.rawCandidates.map((raw) => [raw.eventId, raw.text]),
    [
      [eventId(4), "expired duplicate"],
      [eventId(6), "retracted duplicate"],
      [eventId(8), "cross-scope graph"],
    ],
  );
  assert.equal(result.rawCandidates.some((raw) => raw.eventId === eventId(1)), false);
  assert.equal(result.rawCandidates.some((raw) => raw.eventId === eventId(3)), false);
  assert.equal(result.rawCandidates.some((raw) => raw.eventId === eventId(5)), false);
});

test("overview raw candidates use limit plus one without letting suppressed rows consume the cap", async (t) => {
  const { factory } = await fixture();
  t.after(() => factory.close());
  await factory.enqueueWriteTransaction([
    ...graphStatementCommands({ seq: 1, rawText: "suppressed common", createdAt: NOW - 100 }),
    ...Array.from({ length: 20 }, (_, index) =>
      rawStatementCommands({
        seq: index + 2,
        rawText: "suppressed common",
        createdAt: NOW - index,
      }),
    ).flat(),
    ...Array.from({ length: 4 }, (_, index) =>
      rawStatementCommands({
        seq: index + 22,
        rawText: `eligible-${index}`,
        createdAt: NOW - 30 - index,
      }),
    ).flat(),
  ]);

  const result = await overview(factory, 3);
  assert.deepEqual(
    result.rawCandidates.map((raw) => raw.eventId),
    [eventId(22), eventId(23), eventId(24)],
  );
  assert.deepEqual(result.truncation.reasons, ["overview_raw_candidates"]);
  assert.deepEqual(result.notes, [
    {
      code: "overview_raw_limit",
      text: RECALL_OVERVIEW_NOTE_TEXT.overview_raw_limit,
    },
  ]);
});

test("overview stays in one fixed read snapshot and never mutates persistent state", async (t) => {
  const { databasePath, factory } = await fixture();
  t.after(() => factory.close());
  await factory.enqueueWriteTransaction([
    ...rawStatementCommands({ seq: 1, rawText: "snapshot-one" }),
  ]);
  const observer = new Database(databasePath, { readonly: true, fileMustExist: true });
  t.after(() => observer.close());
  const beforeDump = permanentDump(observer);
  const beforeVersion = observer.pragma("data_version", { simple: true });

  const first = await overview(factory, 10);
  const repeated = await overview(factory, 10);
  assert.equal(JSON.stringify(repeated), JSON.stringify(first));
  assert.equal(permanentDump(observer), beforeDump);
  assert.equal(observer.pragma("data_version", { simple: true }), beforeVersion);

  let staleSource;
  const fixed = await service(factory).withSnapshot(async (source) => {
    staleSource = source;
    const before = await selectRecallOverviewCandidates(source, 10);
    await factory.enqueueWriteTransaction([
      ...rawStatementCommands({ seq: 2, rawText: "snapshot-two", createdAt: NOW }),
    ]);
    const after = await selectRecallOverviewCandidates(source, 10);
    return { before, after };
  });
  assert.equal(JSON.stringify(fixed.after), JSON.stringify(fixed.before));
  await assert.rejects(
    staleSource.selectOverviewCandidates(10),
    /temporary state was discarded/u,
  );
  const next = await overview(factory, 10);
  assert.deepEqual(next.rawCandidates.map((raw) => raw.eventId), [eventId(2), eventId(1)]);
});

test("malformed raw and entity projection state fail closed without echoing stored payload", async (t) => {
  const { factory } = await fixture();
  t.after(() => factory.close());
  const marker = "do-not-echo-rcl-004-corruption";
  await factory.enqueueWriteTransaction([
    ...rawStatementCommands({
      seq: 1,
      rawText: marker,
      parsed: { malformed: true },
      createdAt: NOW,
    }),
  ]);
  await assert.rejects(
    overview(factory, 10),
    (error) => {
      assert.ok(error instanceof RecallReadError);
      assert.equal(error.code, "INVALID_RECALL_OVERVIEW_CANDIDATE");
      assert.equal("cause" in error, false);
      assert.equal(JSON.stringify(error).includes(marker), false);
      return true;
    },
  );

  await factory.enqueueWriteTransaction([
    {
      kind: "run",
      sql: "UPDATE statements SET state='retracted' WHERE event_id=?",
      parameters: [eventId(1)],
    },
    ...graphStatementCommands({ seq: 2, rawText: "entity corruption" }),
    {
      kind: "run",
      sql: "UPDATE entities SET scope_key=? WHERE id='e2.0'",
      parameters: [OTHER_SCOPE],
    },
  ]);
  await assert.rejects(
    overview(factory, 10),
    (error) => {
      assert.ok(error instanceof RecallReadError);
      assert.equal(error.code, "INVALID_RECALL_OVERVIEW_CANDIDATE");
      assert.equal("cause" in error, false);
      assert.equal(JSON.stringify(error).includes("entity corruption"), false);
      return true;
    },
  );
});

test("overview envelope, array, row, accessor, and typed-error traps are payload redacted", async (t) => {
  const { factory } = await fixture();
  t.after(() => factory.close());
  for (const boundary of ["envelope", "array", "row", "accessor"]) {
    const marker = `do-not-smuggle-rcl-004-${boundary}`;
    const injected = smuggledReadError(marker);
    let rawResult;
    if (boundary === "envelope") {
      rawResult = new Proxy(
        { entityRows: [], rawRows: [] },
        { ownKeys() { throw injected; } },
      );
    } else if (boundary === "array") {
      rawResult = {
        entityRows: new Proxy([], {
          getOwnPropertyDescriptor() { throw injected; },
        }),
        rawRows: [],
      };
    } else if (boundary === "row") {
      rawResult = {
        entityRows: [new Proxy(validEntityRow(), { ownKeys() { throw injected; } })],
        rawRows: [],
      };
    } else {
      let accessorRead = false;
      const row = validRawRow();
      Object.defineProperty(row, "recall_overview_raw_text", {
        enumerable: true,
        get() {
          accessorRead = true;
          throw injected;
        },
      });
      rawResult = { entityRows: [], rawRows: [row] };
      await assert.rejects(
        overviewInjectedResult(factory, rawResult),
        (error) => {
          assert.equal(accessorRead, false);
          const expected = new RecallReadError("INVALID_RECALL_OVERVIEW_CANDIDATE");
          assert.ok(error instanceof RecallReadError);
          assert.notStrictEqual(error, injected);
          assert.equal(error.code, expected.code);
          assert.equal(error.name, expected.name);
          assert.equal(error.message, expected.message);
          assert.equal(JSON.stringify(error).includes(marker), false);
          return true;
        },
      );
      continue;
    }

    await assert.rejects(
      overviewInjectedResult(factory, rawResult),
      (error) => {
        const expected = new RecallReadError("INVALID_RECALL_OVERVIEW_CANDIDATE");
        assert.ok(error instanceof RecallReadError);
        assert.notStrictEqual(error, injected);
        assert.equal(error.code, expected.code);
        assert.equal(error.name, expected.name);
        assert.equal(error.message, expected.message);
        assert.deepEqual(Reflect.ownKeys(error).sort(), Reflect.ownKeys(expected).sort());
        assert.equal(JSON.stringify(error).includes(marker), false);
        return true;
      },
    );
  }
});

test("overview snapshot sync throws, rejections, and hostile thenables become fresh fixed adapter errors", async (t) => {
  const { factory } = await fixture();
  t.after(() => factory.close());
  for (const mode of ["sync", "reject", "then-getter"]) {
    for (const kind of ["typed", "ordinary"]) {
      const marker = `do-not-echo-rcl-004-adapter-${mode}-${kind}`;
      const injected = payloadAdapterError(kind, marker);
      const readRawOverviewState = () => {
        if (mode === "sync") {
          throw injected;
        }
        if (mode === "reject") {
          return Promise.reject(injected);
        }
        return Object.create(null, {
          then: {
            enumerable: true,
            get() {
              throw injected;
            },
          },
        });
      };

      await assert.rejects(
        overviewInjectedRead(factory, readRawOverviewState),
        freshAdapterError(injected, marker),
      );
    }
  }
});

test("out-of-order or malformed overview sentinel rows fail closed", async (t) => {
  const { factory } = await fixture();
  t.after(() => factory.close());
  await assert.rejects(
    overviewInjectedResult(factory, {
      entityRows: [
        validEntityRow({ recall_overview_entity_id: "e10.0" }),
        validEntityRow({ recall_overview_entity_id: "e2.0" }),
      ],
      rawRows: [],
    }),
    (error) => {
      assert.ok(error instanceof RecallReadError);
      assert.equal(error.code, "INVALID_RECALL_OVERVIEW_CANDIDATE");
      return true;
    },
  );

  await assert.rejects(
    overviewInjectedResult(factory, {
      entityRows: [],
      rawRows: [
        validRawRow({
          recall_overview_parsed_count: 1,
          recall_overview_raw_text: "must not resurrect",
        }),
      ],
    }),
    (error) => {
      assert.ok(error instanceof RecallReadError);
      assert.equal(error.code, "INVALID_RECALL_OVERVIEW_CANDIDATE");
      assert.equal(JSON.stringify(error).includes("must not resurrect"), false);
      return true;
    },
  );
});
