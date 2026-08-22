import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import Database from "better-sqlite3";

import {
  RECALL_FTS_NOTE_TEXT,
} from "../../../dist/application/recall-fts-query.js";
import { RecallReadError } from "../../../dist/application/ports/recall-read-port.js";
import { RecallSnapshotService } from "../../../dist/application/recall-snapshot-service.js";
import {
  RECALL_FTS_SQL_SOURCE,
  createSqliteConnectionFactory,
  createSqliteRecallReadPort,
  runBundledSqliteMigrations,
  runSqliteStartupGate,
} from "../../../dist/adapters/sqlite/index.js";
import { createDeterministicRuntimeProvider } from "../../support/deterministic-runtime-provider.mjs";

const NOW = 1_700_100_000;
const SCOPE = "u:alice/p:rcl-003";
const OTHER_SCOPE = "u:bob/p:rcl-003";
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
  const root = mkdtempSync(join(tmpdir(), "recall-rcl-003-"));
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
        "rcl-003-test",
        "rcl-003-fts-fallback",
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
  rawText,
  scopeKey = SCOPE,
  claimId = `c${seq}.0`,
  claimState = "active",
  supportLive = 1,
  subjectId = `e${seq}.0`,
  objectId = `e${seq}.1`,
  objectValue = null,
  statementState = "live",
  createdAt = NOW - seq,
  recordedAt = createdAt,
  expiresAt = null,
  provenance = "observed",
}) {
  const parsed = [
    {
      subject: `subject-${seq}`,
      relation: objectId === null ? "describes" : "uses",
      ...(objectId === null
        ? { object_value: objectValue }
        : { object: `object-${seq}` }),
    },
  ];
  const commands = [
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
      sql: "INSERT INTO entities(id,scope_key,name,normal_name,kind,merged_into,origin_seq) VALUES (?,?,?,?,NULL,NULL,?)",
      parameters: [subjectId, scopeKey, `subject-${seq}`, `subject-${seq}`, seq],
    },
  ];
  if (objectId !== null) {
    commands.push({
      kind: "run",
      sql: "INSERT INTO entities(id,scope_key,name,normal_name,kind,merged_into,origin_seq) VALUES (?,?,?,?,NULL,NULL,?)",
      parameters: [objectId, scopeKey, `object-${seq}`, `object-${seq}`, seq],
    });
  }
  commands.push(
    {
      kind: "run",
      sql: objectId === null
        ? "INSERT INTO claims(id,scope_key,subject_id,relation,object_id,object_value,state,origin_seq,first_seen_at,last_seen_at) VALUES (?,?,?,'describes',NULL,?,?,?,?,?)"
        : "INSERT INTO claims(id,scope_key,subject_id,relation,object_id,object_value,state,origin_seq,first_seen_at,last_seen_at) VALUES (?,?,?,'uses',?,NULL,?,?,?,?)",
      parameters: objectId === null
        ? [
            claimId,
            scopeKey,
            subjectId,
            objectValue,
            claimState,
            seq,
            createdAt,
            createdAt,
          ]
        : [
            claimId,
            scopeKey,
            subjectId,
            objectId,
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
  );
  return commands;
}

function service(factory, scopeKey = SCOPE, evaluationNow = NOW) {
  return new RecallSnapshotService(
    runtime(scopeKey, evaluationNow),
    createSqliteRecallReadPort(factory),
  );
}

function search(factory, terms, scopeKey = SCOPE, evaluationNow = NOW) {
  return service(factory, scopeKey, evaluationNow).withSnapshot((source) =>
    source.searchFtsCandidates(terms),
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

test("the FTS SQL is parameterized, TEMP-valid-rooted, contentless-safe, and read-only", () => {
  assert.equal(Object.isFrozen(RECALL_FTS_SQL_SOURCE), true);
  const sql = Object.values(RECALL_FTS_SQL_SOURCE).join("\n");
  assert.match(RECALL_FTS_SQL_SOURCE.selectCandidateStatements, /journal_fts MATCH :fts_query/u);
  assert.match(RECALL_FTS_SQL_SOURCE.selectCandidateStatements, /LIMIT 21/u);
  assert.match(RECALL_FTS_SQL_SOURCE.selectCandidateStatements, /json_extract\(candidate_journal\.body, '\$\.raw_text'\)/u);
  assert.match(RECALL_FTS_SQL_SOURCE.selectCandidateSupports, /JOIN temp\.recall_claim_agg/u);
  assert.doesNotMatch(sql, /journal_fts\.raw_text/u);
  assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|REPLACE)\b/iu);
});

test("quoted phrases neutralize operators, quotes, controls, Korean, and emoji in actual trigram MATCH", async (t) => {
  const { factory } = await fixture();
  t.after(() => factory.close());
  await factory.enqueueWriteTransaction([
    ...rawStatementCommands({ seq: 1, rawText: "alpha OR beta" }),
    ...rawStatementCommands({ seq: 2, rawText: "alpha decoy only" }),
    ...rawStatementCommands({ seq: 3, rawText: "beta decoy only" }),
    ...rawStatementCommands({ seq: 4, rawText: "NEAR(foo bar)" }),
    ...rawStatementCommands({ seq: 5, rawText: "말\"인용\"검색" }),
    ...rawStatementCommands({ seq: 6, rawText: "제어문자검색" }),
    ...rawStatementCommands({
      seq: 7,
      rawText: "인증서버",
      createdAt: NOW - 700,
      recordedAt: NOW - 7,
    }),
    ...rawStatementCommands({ seq: 8, rawText: "😀😃😄" }),
    ...rawStatementCommands({ seq: 9, rawText: "  공백 원문 검색  " }),
  ]);

  const cases = [
    ["alpha OR beta", 1],
    ["NEAR(foo bar)", 4],
    ["말\"인용\"검색", 5],
    ["제어\u0000문자\u001f검색", 6],
    ["인증서버", 7],
    ["😀😃😄", 8],
    ["공백 원문 검색", 9],
  ];
  for (const [term, seq] of cases) {
    const result = await search(factory, [term]);
    assert.equal(result.kind, "searched", term);
    assert.deepEqual(result.seeds, [], term);
    assert.deepEqual(result.reachedClaims, [], term);
    assert.deepEqual(
      result.rawCandidates.map((candidate) => candidate.eventId),
      [eventId(seq)],
      term,
    );
    assert.equal(result.rawCandidates[0].matchedTerm, term.replace(/[\u0000-\u001f\u007f-\u009f]/gu, ""));
    if (seq === 7) {
      assert.equal(result.rawCandidates[0].createdAt, NOW - 700);
      assert.equal(result.rawCandidates[0].recordedAt, NOW - 7);
    }
    if (seq === 9) {
      assert.equal(result.rawCandidates[0].text, "  공백 원문 검색  ");
    }
  }
});

test("valid graph supports produce ordered endpoint seeds and fanout-independent reached pins while graph duplicates suppress raw", async (t) => {
  const { factory } = await fixture();
  t.after(() => factory.close());
  await factory.enqueueWriteTransaction([
    ...graphStatementCommands({
      seq: 1,
      rawText: "같은 원문 검색",
      subjectId: "e1.0",
      objectId: "e1.1",
      claimId: "c1.0",
    }),
    ...rawStatementCommands({ seq: 2, rawText: "같은 원문 검색" }),
    ...graphStatementCommands({
      seq: 3,
      rawText: "리터럴 검색 값",
      subjectId: "e3.0",
      objectId: null,
      objectValue: "pnpm deploy",
      claimId: "c3.0",
    }),
  ]);

  const entityResult = await search(factory, ["같은 원문 검색"]);
  assert.equal(entityResult.kind, "searched");
  assert.deepEqual(
    entityResult.seeds.map(({ ftsRank, ...seed }) => {
      assert.equal(Number.isFinite(ftsRank), true);
      return seed;
    }),
    [
      {
        entityId: "e1.0",
        endpoint: "subject",
        matchedTerm: "같은 원문 검색",
        pathLabel: "같은 원문 검색 (FTS)",
        eventId: eventId(1),
        statementSeq: 1,
      },
      {
        entityId: "e1.1",
        endpoint: "object",
        matchedTerm: "같은 원문 검색",
        pathLabel: "같은 원문 검색 (FTS)",
        eventId: eventId(1),
        statementSeq: 1,
      },
    ],
  );
  assert.deepEqual(
    entityResult.reachedClaims.map(({ ftsRank, ...claim }) => {
      assert.equal(Number.isFinite(ftsRank), true);
      return claim;
    }),
    [
      {
        claimId: "c1.0",
        depth: 0,
        anchorEntityId: "e1.0",
        seedEntityId: "e1.0",
        seedOrder: 0,
        matchedTerm: "같은 원문 검색",
        eventId: eventId(1),
        statementSeq: 1,
      },
    ],
  );
  assert.deepEqual(entityResult.rawCandidates, []);

  await factory.enqueueWriteTransaction([
    {
      kind: "run",
      sql: "UPDATE claim_support SET live=0 WHERE claim_id='c1.0'",
    },
    {
      kind: "run",
      sql: "UPDATE claims SET state='retracted' WHERE id='c1.0'",
    },
  ]);
  const afterGraphRetraction = await search(factory, ["같은 원문 검색"]);
  assert.deepEqual(afterGraphRetraction.seeds, []);
  assert.deepEqual(afterGraphRetraction.reachedClaims, []);
  assert.deepEqual(
    afterGraphRetraction.rawCandidates.map((candidate) => candidate.eventId),
    [eventId(2)],
  );

  const literalResult = await search(factory, ["리터럴 검색 값"]);
  assert.deepEqual(
    literalResult.seeds.map((seed) => [seed.entityId, seed.endpoint]),
    [["e3.0", "subject"]],
  );
  assert.deepEqual(
    literalResult.reachedClaims.map((claim) => [
      claim.claimId,
      claim.anchorEntityId,
      claim.seedOrder,
    ]),
    [["c3.0", "e3.0", 0]],
  );
});

test("scope, statement state, expiry, and valid support state gate raw fallback without reviving parsed claims", async (t) => {
  const { factory } = await fixture();
  t.after(() => factory.close());
  await factory.enqueueWriteTransaction([
    ...rawStatementCommands({ seq: 1, rawText: "필터검색 live raw" }),
    ...rawStatementCommands({
      seq: 2,
      rawText: "필터검색 expired raw",
      createdAt: NOW - 43_200,
      expiresAt: NOW,
      provenance: "inferred",
    }),
    ...rawStatementCommands({
      seq: 3,
      rawText: "필터검색 retracted raw",
      state: "retracted",
    }),
    ...rawStatementCommands({
      seq: 4,
      rawText: "필터검색 superseded raw",
      state: "superseded",
    }),
    ...rawStatementCommands({
      seq: 5,
      rawText: "필터검색 other scope raw",
      scopeKey: OTHER_SCOPE,
    }),
    ...graphStatementCommands({
      seq: 6,
      rawText: "필터검색 죽은파싱 retracted claim",
      claimState: "retracted",
      supportLive: 0,
    }),
    ...graphStatementCommands({
      seq: 7,
      rawText: "필터검색 죽은파싱 superseded claim",
      claimState: "superseded",
    }),
  ]);

  const result = await search(factory, ["필터검색"]);
  assert.deepEqual(
    result.rawCandidates.map((candidate) => candidate.eventId),
    [eventId(1)],
  );
  assert.deepEqual(result.seeds, []);
  assert.deepEqual(result.reachedClaims, []);

  const deadParsed = await search(factory, ["죽은파싱"]);
  assert.equal(deadParsed.kind, "searched");
  assert.deepEqual(deadParsed.rawCandidates, []);
  assert.deepEqual(deadParsed.seeds, []);

  const otherScope = await search(factory, ["other scope"], OTHER_SCOPE);
  assert.deepEqual(
    otherScope.rawCandidates.map((candidate) => candidate.eventId),
    [eventId(5)],
  );
});

test("21 matching statements use 20 in rank/seq order and expose deterministic truncation without persistent writes", async (t) => {
  const { databasePath, factory } = await fixture();
  t.after(() => factory.close());
  await factory.enqueueWriteTransaction(
    Array.from({ length: 21 }, (_, index) =>
      rawStatementCommands({
        seq: index + 1,
        rawText: "절단검색 동일원문",
      }),
    ).flat(),
  );

  const observer = new Database(databasePath, { readonly: true, fileMustExist: true });
  t.after(() => observer.close());
  const beforeDump = permanentDump(observer);
  const beforeVersion = observer.pragma("data_version", { simple: true });

  const first = await search(factory, ["절단검색"]);
  const repeated = await search(factory, ["절단검색"]);
  assert.equal(JSON.stringify(repeated), JSON.stringify(first));
  assert.equal(first.kind, "searched");
  assert.deepEqual(
    first.rawCandidates.map((candidate) => candidate.statementSeq),
    Array.from({ length: 20 }, (_, index) => 21 - index),
  );
  assert.deepEqual(first.truncation, { reasons: ["fts_candidates"] });
  assert.deepEqual(first.notes, [
    {
      code: "fts_candidate_limit",
      text: RECALL_FTS_NOTE_TEXT.fts_candidate_limit,
    },
  ]);
  assert.equal(permanentDump(observer), beforeDump);
  assert.equal(observer.pragma("data_version", { simple: true }), beforeVersion);

  const fixedSnapshot = await service(factory).withSnapshot(async (source) => {
    const before = await source.searchFtsCandidates(["절단검색"]);
    await factory.enqueueWriteTransaction(
      rawStatementCommands({ seq: 22, rawText: "절단검색 동일원문" }),
    );
    const after = await source.searchFtsCandidates(["절단검색"]);
    return { before, after };
  });
  assert.equal(
    JSON.stringify(fixedSnapshot.after),
    JSON.stringify(fixedSnapshot.before),
  );
  const nextCall = await search(factory, ["절단검색"]);
  assert.equal(nextCall.rawCandidates[0].statementSeq, 22);
});

test("all sub-trigram candidates skip FTS with an actionable none-note seam", async (t) => {
  const { factory } = await fixture();
  t.after(() => factory.close());

  let staleSource = null;
  const result = await service(factory).withSnapshot(async (source) => {
    staleSource = source;
    return source.searchFtsCandidates([
      "가",
      "ab",
      "Ａ_Ｂ",
      "\u0000-_\u001f",
    ]);
  });
  assert.deepEqual(result, {
    kind: "skipped",
    terms: [],
    seeds: [],
    reachedClaims: [],
    rawCandidates: [],
    truncation: { reasons: [] },
    notes: [
      {
        code: "fts_terms_too_short",
        text: RECALL_FTS_NOTE_TEXT.fts_terms_too_short,
      },
    ],
  });
  await assert.rejects(
    staleSource.searchFtsCandidates(["가"]),
    /temporary state was discarded/u,
  );
});

test("malformed candidate state fails closed without echoing stored text or driver causes", async (t) => {
  const { factory } = await fixture();
  t.after(() => factory.close());
  const privateMarker = "do-not-echo-rcl-003-corruption";
  await factory.enqueueWriteTransaction(
    rawStatementCommands({
      seq: 1,
      rawText: `corruption ${privateMarker}`,
      parsed: { invalid: true },
    }),
  );

  await assert.rejects(
    search(factory, ["corruption"]),
    (error) => {
      assert.ok(error instanceof RecallReadError);
      assert.equal(error.code, "INVALID_RECALL_FTS_CANDIDATE");
      assert.equal("cause" in error, false);
      assert.doesNotMatch(error.message, new RegExp(privateMarker, "u"));
      assert.equal(JSON.stringify(error).includes(privateMarker), false);
      return true;
    },
  );
});
