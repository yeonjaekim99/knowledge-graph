import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";

import Database from "better-sqlite3";

import { CLAIM_AGGREGATE_SQL_SOURCE } from "../../../dist/adapters/sqlite/index.js";

const NOW = 1_700_100_000;
const SCOPE = "u:aggregate-user/p:recall";
const OTHER_SCOPE = "u:other-user/p:recall";
const temporaryDirectories = [];
const schemaSql = readFileSync(
  fileURLToPath(
    new URL(
      "../../../src/adapters/sqlite/migrations/001-v1-schema.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    await rm(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

function eventId(seq) {
  return `ev_${String(seq).padStart(26, "0")}`;
}

function openFixture() {
  return mkdtemp(join(tmpdir(), "recall-prj-008-")).then((directory) => {
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "aggregate.sqlite3");
    const database = new Database(databasePath);
    database.pragma("journal_mode = WAL");
    database.pragma("foreign_keys = ON");
    database.exec(schemaSql);
    database.function(
      "unixepoch",
      { deterministic: true, varargs: true },
      () => NOW,
    );
    return { database, databasePath };
  });
}

function insertStatement(database, {
  seq,
  scopeKey = SCOPE,
  parsed = [],
  provenance,
  ttl,
  createdAt,
  state = "live",
  orderSeq = seq,
}) {
  const expiresAt =
    ttl === "permanent"
      ? null
      : createdAt + (ttl === "session" ? 43_200 : 2_592_000);
  database
    .prepare(
      "INSERT INTO journal(seq,id,scope_key,kind,body,actor,branch,session,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
    )
    .run(
      seq,
      eventId(seq),
      scopeKey,
      "statement",
      JSON.stringify({
        raw_text: `statement ${seq}`,
        parsed,
        provenance,
        ttl,
      }),
      "integration-agent",
      "prj-008",
      null,
      createdAt,
    );
  database
    .prepare(
      "INSERT INTO statements(event_id,scope_key,state,order_seq,created_at,provenance,expires_at) VALUES (?,?,?,?,?,?,?)",
    )
    .run(
      eventId(seq),
      scopeKey,
      state,
      orderSeq,
      createdAt,
      provenance,
      expiresAt,
    );
  return { eventId: eventId(seq), expiresAt };
}

function insertEntity(database, id, scopeKey, name) {
  database
    .prepare(
      "INSERT INTO entities(id,scope_key,name,normal_name,kind,merged_into,origin_seq) VALUES (?,?,?,?,NULL,NULL,?)",
    )
    .run(id, scopeKey, name, `${scopeKey}:${name}`, Number(id.match(/\d+/u)?.[0] ?? 1));
}

function insertClaim(database, {
  id,
  scopeKey = SCOPE,
  subjectId,
  relation,
  objectId = null,
  objectValue = null,
  state = "active",
}) {
  database
    .prepare(
      "INSERT INTO claims(id,scope_key,subject_id,relation,object_id,object_value,state,origin_seq,first_seen_at,last_seen_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    )
    .run(
      id,
      scopeKey,
      subjectId,
      relation,
      objectId,
      objectValue,
      state,
      Number(id.match(/\d+/u)?.[0] ?? 1),
      NOW - 50_000,
      NOW,
    );
}

function insertSupport(database, claimId, statement, draftIndex, live = 1) {
  database
    .prepare(
      "INSERT INTO claim_support(claim_id,event_id,draft_index,live,expires_at) VALUES (?,?,?,?,?)",
    )
    .run(claimId, statement.eventId, draftIndex, live, statement.expiresAt);
}

function seedAggregateFixture(database) {
  insertEntity(database, "e1.0", SCOPE, "인증");
  insertEntity(database, "e1.1", SCOPE, "JWT");
  insertEntity(database, "e4.0", SCOPE, "테스트 명령");
  insertEntity(database, "e10.0", OTHER_SCOPE, "다른 인증");
  insertEntity(database, "e10.1", OTHER_SCOPE, "다른 토큰");

  insertClaim(database, {
    id: "c1.0",
    subjectId: "e1.0",
    relation: "uses",
    objectId: "e1.1",
  });
  insertClaim(database, {
    id: "c3.0",
    subjectId: "e1.0",
    relation: "rejects",
    objectId: "e1.1",
  });
  insertClaim(database, {
    id: "c4.0",
    subjectId: "e4.0",
    relation: "describes",
    objectValue: "pnpm test",
  });
  insertClaim(database, {
    id: "c10.0",
    scopeKey: OTHER_SCOPE,
    subjectId: "e10.0",
    relation: "uses",
    objectId: "e10.1",
  });

  const old = insertStatement(database, {
    seq: 1,
    parsed: [
      { subject: "인증", relation: "uses", object: "JWT", relation_label: "예전에 사용" },
    ],
    provenance: "observed",
    ttl: "permanent",
    createdAt: NOW - 1_000,
  });
  insertSupport(database, "c1.0", old, 0);

  const recentExpired = insertStatement(database, {
    seq: 2,
    parsed: [
      { subject: "인증", relation: "uses", object: "JWT", relation_label: "최근 채택" },
    ],
    provenance: "user_stated",
    ttl: "session",
    createdAt: NOW - 43_200,
  });
  insertSupport(database, "c1.0", recentExpired, 0);

  const oppositeExpired = insertStatement(database, {
    seq: 3,
    parsed: [{ subject: "인증", relation: "rejects", object: "JWT" }],
    provenance: "user_stated",
    ttl: "session",
    createdAt: NOW - 43_200,
  });
  insertSupport(database, "c3.0", oppositeExpired, 0);

  const literal = insertStatement(database, {
    seq: 4,
    parsed: [
      {
        subject: "테스트 명령",
        relation: "describes",
        object_value: "pnpm test",
        relation_label: "=",
      },
    ],
    provenance: "user_stated",
    ttl: "permanent",
    createdAt: NOW - 500,
  });
  insertSupport(database, "c4.0", literal, 0);

  insertStatement(database, {
    seq: 5,
    parsed: [],
    provenance: "inferred",
    ttl: "session",
    createdAt: NOW - 100,
  });

  const retracted = insertStatement(database, {
    seq: 6,
    parsed: [
      { subject: "인증", relation: "uses", object: "JWT", relation_label: "철회된 표현" },
    ],
    provenance: "observed",
    ttl: "weeks",
    createdAt: NOW - 5,
    state: "retracted",
  });
  insertSupport(database, "c1.0", retracted, 0, 0);

  const other = insertStatement(database, {
    seq: 7,
    scopeKey: OTHER_SCOPE,
    parsed: [
      {
        subject: "다른 인증",
        relation: "uses",
        object: "다른 토큰",
        relation_label: "다른 scope 표현",
      },
    ],
    provenance: "observed",
    ttl: "permanent",
    createdAt: NOW - 20,
  });
  insertSupport(database, "c10.0", other, 0);

  const emptyLatest = insertStatement(database, {
    seq: 8,
    parsed: [
      { subject: "인증", relation: "uses", object: "JWT", relation_label: "   " },
    ],
    provenance: "inferred",
    ttl: "weeks",
    createdAt: NOW - 50,
  });
  insertSupport(database, "c1.0", emptyLatest, 0);
}

function persistentCounts(database) {
  return Object.fromEntries(
    ["journal", "statements", "entities", "claims", "claim_support"].map((table) => [
      table,
      database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count,
    ]),
  );
}

function recreateRecallAggregate(database, now = NOW, scopeKey = SCOPE) {
  database.exec(CLAIM_AGGREGATE_SQL_SOURCE.dropRecallTempTable);
  database
    .prepare(CLAIM_AGGREGATE_SQL_SOURCE.createRecallTempTable)
    .run({ now, scope_key: scopeKey });
}

function scopedDiagnosticRows(database, scopeKey) {
  return database
    .prepare(
      "SELECT a.* FROM claim_agg a JOIN claims c ON c.id=a.claim_id WHERE c.scope_key=? ORDER BY a.claim_id",
    )
    .all(scopeKey);
}

test("one aggregate template generates the diagnostic view and fixed-now scope TEMP query", async () => {
  const { database, databasePath } = await openFixture();
  try {
    seedAggregateFixture(database);
    assert.equal(Object.isFrozen(CLAIM_AGGREGATE_SQL_SOURCE), true);
    assert.equal(
      CLAIM_AGGREGATE_SQL_SOURCE.createDiagnosticView,
      `CREATE VIEW claim_agg AS\n${CLAIM_AGGREGATE_SQL_SOURCE.diagnosticSelect}`,
    );
    assert.equal(
      CLAIM_AGGREGATE_SQL_SOURCE.createRecallTempTable,
      `CREATE TEMP TABLE recall_claim_agg AS\n${CLAIM_AGGREGATE_SQL_SOURCE.recallSelect}`,
    );
    assert.match(CLAIM_AGGREGATE_SQL_SOURCE.diagnosticSelect, /unixepoch\('now'\)/u);
    assert.doesNotMatch(CLAIM_AGGREGATE_SQL_SOURCE.diagnosticSelect, /:scope_key/u);
    assert.match(CLAIM_AGGREGATE_SQL_SOURCE.recallSelect, /:now/u);
    assert.match(CLAIM_AGGREGATE_SQL_SOURCE.recallSelect, /c\.scope_key = :scope_key/u);

    database.exec(CLAIM_AGGREGATE_SQL_SOURCE.createDiagnosticView);
    const countsBefore = persistentCounts(database);
    const observer = new Database(databasePath, { readonly: true, fileMustExist: true });
    try {
      const dataVersionBefore = observer.pragma("data_version", { simple: true });
      recreateRecallAggregate(database);
      assert.deepEqual(
        database.prepare("SELECT * FROM recall_claim_agg ORDER BY claim_id").all(),
        scopedDiagnosticRows(database, SCOPE),
      );
      assert.deepEqual(
        database.prepare("SELECT claim_id FROM recall_claim_agg ORDER BY claim_id").all(),
        [{ claim_id: "c1.0" }, { claim_id: "c4.0" }],
      );
      assert.deepEqual(persistentCounts(database), countsBefore);
      assert.equal(observer.pragma("data_version", { simple: true }), dataVersionBefore);
      assert.deepEqual(
        database
          .prepare(
            `SELECT c.id, ${CLAIM_AGGREGATE_SQL_SOURCE.diagnosticContestedExpression} AS contested
               FROM claims c
               JOIN claim_agg a ON a.claim_id=c.id
              WHERE c.id='c1.0'`,
          )
          .get(),
        { id: "c1.0", contested: 0 },
      );
    } finally {
      observer.close();
    }

    recreateRecallAggregate(database, NOW, "u:no-match/p:recall' OR 1=1 --");
    assert.deepEqual(database.prepare("SELECT * FROM recall_claim_agg").all(), []);
  } finally {
    database.close();
  }
});

test("count, strength, recency, latest non-empty label, expiry and contested share one valid support set", async () => {
  const { database } = await openFixture();
  try {
    seedAggregateFixture(database);

    recreateRecallAggregate(database, NOW - 1);
    const before = database
      .prepare("SELECT * FROM recall_claim_agg WHERE claim_id='c1.0'")
      .get();
    assert.deepEqual(before, {
      claim_id: "c1.0",
      support_count: 3,
      strongest_rank: 3,
      last_seen_at: NOW - 50,
      relation_label: "최근 채택",
      effective_expires_at: null,
    });
    assert.deepEqual(
      database.prepare("SELECT * FROM recall_claim_agg WHERE claim_id='c3.0'").get(),
      {
        claim_id: "c3.0",
        support_count: 1,
        strongest_rank: 3,
        last_seen_at: NOW - 43_200,
        relation_label: null,
        effective_expires_at: NOW,
      },
    );
    assert.deepEqual(
      database
        .prepare(
          `SELECT c.id, ${CLAIM_AGGREGATE_SQL_SOURCE.recallContestedExpression} AS contested
             FROM claims c
             JOIN recall_claim_agg a ON a.claim_id=c.id
            WHERE c.scope_key=:scope_key
            ORDER BY c.id`,
        )
        .all({ scope_key: SCOPE }),
      [
        { id: "c1.0", contested: 1 },
        { id: "c3.0", contested: 1 },
        { id: "c4.0", contested: 0 },
      ],
    );

    recreateRecallAggregate(database, NOW);
    assert.deepEqual(
      database.prepare("SELECT * FROM recall_claim_agg WHERE claim_id='c1.0'").get(),
      {
        claim_id: "c1.0",
        support_count: 2,
        strongest_rank: 2,
        last_seen_at: NOW - 50,
        relation_label: "예전에 사용",
        effective_expires_at: null,
      },
    );
    assert.equal(
      database.prepare("SELECT 1 FROM recall_claim_agg WHERE claim_id='c3.0'").get(),
      undefined,
    );
    assert.deepEqual(
      database
        .prepare(
          `SELECT c.id, ${CLAIM_AGGREGATE_SQL_SOURCE.recallContestedExpression} AS contested
             FROM claims c
             JOIN recall_claim_agg a ON a.claim_id=c.id
            WHERE c.id='c1.0'`,
        )
        .get(),
      { id: "c1.0", contested: 0 },
    );
  } finally {
    database.close();
  }
});

test("the projection invariant detects statement and support expiry divergence", async () => {
  const { database } = await openFixture();
  try {
    seedAggregateFixture(database);
    const invariant = () =>
      database
        .prepare(CLAIM_AGGREGATE_SQL_SOURCE.projectionValidityInvariant)
        .get({ scope_key: SCOPE });

    assert.deepEqual(invariant(), {
      statement_expiry_mismatch_count: 0,
      support_expiry_mismatch_count: 0,
      scope_mismatch_count: 0,
    });
    database
      .prepare("UPDATE claim_support SET expires_at=? WHERE claim_id='c1.0' AND event_id=?")
      .run(NOW + 1, eventId(1));
    assert.deepEqual(invariant(), {
      statement_expiry_mismatch_count: 0,
      support_expiry_mismatch_count: 1,
      scope_mismatch_count: 0,
    });
    database
      .prepare("UPDATE statements SET expires_at=NULL WHERE event_id=?")
      .run(eventId(5));
    assert.deepEqual(invariant(), {
      statement_expiry_mismatch_count: 1,
      support_expiry_mismatch_count: 1,
      scope_mismatch_count: 0,
    });
  } finally {
    database.close();
  }
});

test("cross-scope structural corruption is reported and cannot enter the aggregate", async () => {
  const { database } = await openFixture();
  try {
    seedAggregateFixture(database);
    database
      .prepare(
        "INSERT INTO claim_support(claim_id,event_id,draft_index,live,expires_at) VALUES ('c1.0',?,1,1,NULL)",
      )
      .run(eventId(7));

    recreateRecallAggregate(database);
    assert.equal(
      database.prepare("SELECT support_count FROM recall_claim_agg WHERE claim_id='c1.0'").get()
        .support_count,
      2,
    );
    assert.deepEqual(
      database
        .prepare(CLAIM_AGGREGATE_SQL_SOURCE.projectionValidityInvariant)
        .get({ scope_key: SCOPE }),
      {
        statement_expiry_mismatch_count: 0,
        support_expiry_mismatch_count: 0,
        scope_mismatch_count: 1,
      },
    );
  } finally {
    database.close();
  }
});
