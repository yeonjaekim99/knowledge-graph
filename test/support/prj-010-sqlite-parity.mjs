import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createSqliteConnectionFactory,
  createSqliteProjectionDispatcher,
  runBundledSqliteMigrations,
  runSqliteStartupGate,
} from "../../dist/adapters/sqlite/index.js";
import { projectProjectionSnapshot } from "../../dist/domain/index.js";
import { runReplayParity } from "./replay-parity-harness.mjs";
import { createDeterministicRuntimeProvider } from "./deterministic-runtime-provider.mjs";
import { BASE_TIME, eventId } from "./prj-010-projection-scenarios.mjs";

const RULES_VERSION = "rules-prj-010-v1";
const METADATA = Object.freeze({
  actor: "parity-agent",
  branch: "prj-010-prefix-parity",
  session: null,
});

const TABLE_QUERIES = Object.freeze({
  statements: Object.freeze({
    primaryKey: Object.freeze(["event_id"]),
    sql: "SELECT event_id,scope_key,state,order_seq,created_at,provenance,expires_at FROM statements ORDER BY event_id",
  }),
  entities: Object.freeze({
    primaryKey: Object.freeze(["id"]),
    sql: "SELECT id,scope_key,name,normal_name,kind,merged_into,origin_seq FROM entities ORDER BY id",
  }),
  surface_forms: Object.freeze({
    primaryKey: Object.freeze(["scope_key", "surface_norm", "entity_id"]),
    sql: "SELECT scope_key,surface_norm,entity_id,origin FROM surface_forms ORDER BY scope_key,surface_norm,entity_id",
  }),
  claims: Object.freeze({
    primaryKey: Object.freeze(["id"]),
    sql: "SELECT id,scope_key,subject_id,relation,object_id,object_value,state,origin_seq,first_seen_at,last_seen_at FROM claims ORDER BY id",
  }),
  claim_support: Object.freeze({
    primaryKey: Object.freeze(["claim_id", "event_id"]),
    sql: "SELECT claim_id,event_id,draft_index,live,expires_at FROM claim_support ORDER BY claim_id,event_id",
  }),
  id_redirects: Object.freeze({
    primaryKey: Object.freeze(["old_id"]),
    sql: "SELECT old_id,new_id,kind,reason FROM id_redirects ORDER BY old_id",
  }),
});

function snapshotTables(snapshot) {
  return {
    statements: {
      primaryKey: ["event_id"],
      rows: snapshot.statements.map((row) => ({
        event_id: row.eventId,
        scope_key: row.scopeKey,
        state: row.state,
        order_seq: row.orderSeq,
        created_at: row.createdAt,
        provenance: row.provenance,
        expires_at: row.expiresAt,
      })),
    },
    entities: {
      primaryKey: ["id"],
      rows: snapshot.entities.map((row) => ({
        id: row.id,
        scope_key: row.scopeKey,
        name: row.name,
        normal_name: row.normalName,
        kind: row.kind,
        merged_into: row.mergedInto,
        origin_seq: row.originSeq,
      })),
    },
    surface_forms: {
      primaryKey: ["scope_key", "surface_norm", "entity_id"],
      rows: snapshot.surfaceForms.map((row) => ({
        scope_key: row.scopeKey,
        surface_norm: row.surfaceNorm,
        entity_id: row.entityId,
        origin: row.origin,
      })),
    },
    claims: {
      primaryKey: ["id"],
      rows: snapshot.claims.map((row) => ({
        id: row.id,
        scope_key: row.scopeKey,
        subject_id: row.subjectId,
        relation: row.relation,
        object_id: row.objectId,
        object_value: row.objectValue,
        state: row.state,
        origin_seq: row.originSeq,
        first_seen_at: row.firstSeenAt,
        last_seen_at: row.lastSeenAt,
      })),
    },
    claim_support: {
      primaryKey: ["claim_id", "event_id"],
      rows: snapshot.claimSupport.map((row) => ({
        claim_id: row.claimId,
        event_id: row.eventId,
        draft_index: row.draftIndex,
        live: row.live,
        expires_at: row.expiresAt,
      })),
    },
    id_redirects: {
      primaryKey: ["old_id"],
      rows: snapshot.idRedirects.map((row) => ({
        old_id: row.oldId,
        new_id: row.newId,
        kind: row.kind,
        reason: row.reason,
      })),
    },
  };
}

function combineSnapshots(snapshots) {
  return {
    statements: snapshots.flatMap((snapshot) => snapshot.statements),
    entities: snapshots.flatMap((snapshot) => snapshot.entities),
    surfaceForms: snapshots.flatMap((snapshot) => snapshot.surfaceForms),
    claims: snapshots.flatMap((snapshot) => snapshot.claims),
    claimSupport: snapshots.flatMap((snapshot) => snapshot.claimSupport),
    idRedirects: snapshots.flatMap((snapshot) => snapshot.idRedirects),
  };
}

export function storedEventsFromOperations(operations) {
  let seq = 0;
  return operations.flatMap((entry) =>
    entry.events.map((intent) => {
      seq += 1;
      return {
        seq,
        eventId: eventId(seq),
        scopeKey: entry.scope.scopeKey,
        kind: intent.kind,
        bodyJson: intent.bodyJson,
        actor: METADATA.actor,
        branch: METADATA.branch,
        session: METADATA.session,
        createdAt: entry.at,
      };
    }),
  );
}

export function fullReplayTables(operations) {
  const stored = storedEventsFromOperations(operations);
  const scopes = [...new Set(stored.map(({ scopeKey }) => scopeKey))].sort();
  const snapshots = scopes.map((scopeKey) =>
    projectProjectionSnapshot({
      scopeKey,
      rulesVersion: RULES_VERSION,
      events: stored.filter((event) => event.scopeKey === scopeKey),
    }),
  );
  return snapshotTables(combineSnapshots(snapshots));
}

async function readerRows(reader, sql, parameters = []) {
  const result = await reader.query({ kind: "all", sql, parameters });
  assert.equal(result.kind, "all");
  return result.rows;
}

async function readerRow(reader, sql, parameters = []) {
  const result = await reader.query({ kind: "get", sql, parameters });
  assert.equal(result.kind, "get");
  return result.row;
}

async function databaseTables(factory) {
  const reader = await factory.openReader();
  try {
    const result = {};
    for (const [name, definition] of Object.entries(TABLE_QUERIES)) {
      result[name] = {
        primaryKey: [...definition.primaryKey],
        rows: await readerRows(reader, definition.sql),
      };
    }
    return result;
  } finally {
    await reader.close();
  }
}

async function assertProjectionInvariants(factory, label) {
  const reader = await factory.openReader();
  try {
    assert.deepEqual(
      await readerRows(reader, "SELECT * FROM pragma_foreign_key_check"),
      [],
      `${label}: foreign keys`,
    );
    const counts = await readerRow(
      reader,
      [
        "SELECT",
        "(SELECT COUNT(*) FROM journal WHERE kind='statement') - (SELECT COUNT(*) FROM journal_fts) AS fts_delta,",
        "(SELECT COUNT(*) FROM statements s LEFT JOIN journal j ON j.id=s.event_id WHERE j.id IS NULL OR j.kind<>'statement' OR j.scope_key<>s.scope_key) AS statement_scope,",
        "(SELECT COUNT(*) FROM surface_forms sf JOIN entities e ON e.id=sf.entity_id WHERE sf.scope_key<>e.scope_key) AS surface_scope,",
        "(SELECT COUNT(*) FROM claims c JOIN entities s ON s.id=c.subject_id LEFT JOIN entities o ON o.id=c.object_id WHERE c.scope_key<>s.scope_key OR (c.object_id IS NOT NULL AND c.scope_key<>o.scope_key)) AS claim_scope,",
        "(SELECT COUNT(*) FROM claim_support cs JOIN claims c ON c.id=cs.claim_id JOIN statements s ON s.event_id=cs.event_id WHERE c.scope_key<>s.scope_key) AS support_scope,",
        "(SELECT COUNT(*) FROM claims c WHERE c.state='active' AND NOT EXISTS (SELECT 1 FROM claim_support cs JOIN statements s ON s.event_id=cs.event_id WHERE cs.claim_id=c.id AND cs.live=1 AND s.state='live')) AS active_without_support,",
        "(SELECT COUNT(*) FROM (SELECT scope_key,subject_id FROM claims WHERE state='active' AND relation='describes' GROUP BY scope_key,subject_id HAVING COUNT(*)>1)) AS describes_duplicates,",
        "(SELECT COUNT(*) FROM claim_support cs JOIN statements s ON s.event_id=cs.event_id WHERE NOT (cs.expires_at IS s.expires_at)) AS expiry_mismatch,",
        "(SELECT COUNT(*) FROM (SELECT DISTINCT scope_key FROM journal) j LEFT JOIN projection_meta m ON m.scope_key=j.scope_key WHERE m.scope_key IS NULL) AS meta_missing,",
        "(SELECT COUNT(*) FROM projection_meta m WHERE m.last_seq<>(SELECT COALESCE(MAX(j.seq),0) FROM journal j WHERE j.scope_key=m.scope_key)) AS meta_mismatch,",
        "(SELECT COUNT(*) FROM id_redirects r WHERE r.old_id=r.new_id OR (r.kind='entity' AND NOT EXISTS (SELECT 1 FROM entities e WHERE e.id=r.new_id)) OR (r.kind='claim' AND NOT EXISTS (SELECT 1 FROM claims c WHERE c.id=r.new_id))) AS redirect_target",
      ].join(" "),
    );
    assert.deepEqual(
      counts,
      {
        fts_delta: 0,
        statement_scope: 0,
        surface_scope: 0,
        claim_scope: 0,
        support_scope: 0,
        active_without_support: 0,
        describes_duplicates: 0,
        expiry_mismatch: 0,
        meta_missing: 0,
        meta_mismatch: 0,
        redirect_target: 0,
      },
      `${label}: projection invariants`,
    );
    const redirectFailures = await readerRows(
      reader,
      [
        "WITH RECURSIVE chain(root,current,depth,path,cycle) AS (",
        "SELECT old_id,new_id,1,','||old_id||',',instr(','||old_id||',',','||new_id||',')>0 FROM id_redirects",
        "UNION ALL",
        "SELECT chain.root,r.new_id,chain.depth+1,chain.path||chain.current||',',instr(chain.path,','||r.new_id||',')>0",
        "FROM chain JOIN id_redirects r ON r.old_id=chain.current WHERE chain.cycle=0 AND chain.depth<=32",
        ") SELECT root FROM chain WHERE cycle=1 OR depth>32 ORDER BY root",
      ].join(" "),
    );
    assert.deepEqual(redirectFailures, [], `${label}: redirect chain`);
  } finally {
    await reader.close();
  }
}

async function createDatabase(scenarioId) {
  const root = mkdtempSync(join(tmpdir(), `recall-${scenarioId.toLowerCase()}-`));
  const stateDirectory = join(root, "state");
  mkdirSync(stateDirectory, { mode: 0o700 });
  chmodSync(stateDirectory, 0o700);
  const databasePath = join(stateDirectory, "projection.sqlite3");
  const readiness = runSqliteStartupGate({ databasePath });
  const factory = await createSqliteConnectionFactory(readiness);
  try {
    await runBundledSqliteMigrations(factory, {
      appliedAtSeconds: BASE_TIME - 1,
    });
    return { root, factory };
  } catch (error) {
    await factory.close();
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

export async function createSqliteParityRunner({ scenarioId }) {
  const store = await createDatabase(scenarioId);
  let nextSeq = 1;
  let disposed = false;

  return {
    async apply(entry, metadata = {}) {
      const firstSeq = nextSeq;
      const ids = entry.events.map((_, index) => eventId(firstSeq + index));
      const dispatcher = createSqliteProjectionDispatcher({
        factory: store.factory,
        runtime: createDeterministicRuntimeProvider({
          nowMilliseconds: entry.at * 1_000,
          eventIds: ids,
          rulesVersion: RULES_VERSION,
          scope: entry.scope,
          metadata: METADATA,
        }),
      });
      const receipt = await dispatcher.execute(entry.events);
      assert.deepEqual(
        receipt.events,
        ids.map((id, index) => ({
          index,
          eventId: id,
          seq: firstSeq + index,
        })),
        `${scenarioId} prefix ${metadata.prefix_length}: journal receipt`,
      );
      nextSeq += entry.events.length;
    },
    async snapshot(metadata = {}) {
      await assertProjectionInvariants(
        store.factory,
        `${scenarioId} prefix ${metadata.prefix_length ?? 0}`,
      );
      return databaseTables(store.factory);
    },
    async journal() {
      const reader = await store.factory.openReader();
      try {
        return readerRows(
          reader,
          "SELECT seq,id,scope_key,kind,body,actor,branch,session,created_at FROM journal ORDER BY seq",
        );
      } finally {
        await reader.close();
      }
    },
    async dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      await store.factory.close();
      rmSync(store.root, { recursive: true, force: true });
    },
  };
}

export function runProductionScenarioParity(scenario, context) {
  return runReplayParity({
    scenarioId: scenario.id,
    events: scenario.operations,
    context,
    createIncrementalRunner: ({ scenarioId }) =>
      createSqliteParityRunner({ scenarioId }),
    fullReplayRunner: async ({ events }) => fullReplayTables(events),
  });
}

export async function executeProductionOperations(operations, scenarioId) {
  const runner = await createSqliteParityRunner({ scenarioId });
  try {
    for (const [index, entry] of operations.entries()) {
      await runner.apply(entry, { prefix_length: index + 1 });
    }
    return {
      tables: await runner.snapshot({ prefix_length: operations.length }),
      journal: await runner.journal(),
    };
  } finally {
    await runner.dispose();
  }
}

export { RULES_VERSION, snapshotTables };
