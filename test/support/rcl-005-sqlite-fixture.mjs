import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";

import {
  createSqliteConnectionFactory,
  createSqliteRecallReadPort,
  runBundledSqliteMigrations,
  runSqliteStartupGate,
} from "../../dist/adapters/sqlite/index.js";
import { RecallSnapshotService } from "../../dist/application/recall-snapshot-service.js";
import { createDeterministicRuntimeProvider } from "./deterministic-runtime-provider.mjs";

export const RCL_005_NOW = 1_700_200_000;
export const RCL_005_SCOPE = "u:alice/p:recall";
export const RCL_005_OTHER_SCOPE = "u:bob/p:recall";

export function runtime(scopeKey = RCL_005_SCOPE) {
  const [, userId, projectId] = /^u:([^/]+)\/p:(.+)$/u.exec(scopeKey) ?? [];
  return createDeterministicRuntimeProvider({
    nowMilliseconds: RCL_005_NOW * 1_000,
    scope: { userId, projectId, scopeKey },
  });
}

export async function createRcl005Fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "recall-rcl-005-"));
  const stateDirectory = join(root, "state");
  mkdirSync(stateDirectory, { mode: 0o700 });
  chmodSync(stateDirectory, 0o700);
  const databasePath = join(stateDirectory, "recall.sqlite3");
  const readiness = runSqliteStartupGate({ databasePath });
  const factory = await createSqliteConnectionFactory(readiness);
  await runBundledSqliteMigrations(factory, {
    appliedAtSeconds: RCL_005_NOW,
  });
  t.after(async () => {
    await factory.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { databasePath, factory };
}

export function createRecallService(factory, scopeKey = RCL_005_SCOPE) {
  return new RecallSnapshotService(
    runtime(scopeKey),
    createSqliteRecallReadPort(factory),
  );
}

export function entityCommand(id, name, scopeKey = RCL_005_SCOPE) {
  return {
    kind: "run",
    sql: "INSERT INTO entities(id,scope_key,name,normal_name,kind,merged_into,origin_seq) VALUES (?,?,?,?,NULL,NULL,?)",
    parameters: [
      id,
      scopeKey,
      name,
      `${scopeKey}-${id}`,
      Number(/^e([0-9]+)\./u.exec(id)?.[1] ?? 1),
    ],
  };
}

export function claimCommands({
  claimId,
  scopeKey = RCL_005_SCOPE,
  subjectId,
  objectId = null,
  objectValue = null,
  relation = objectId === null ? "describes" : "relates_to",
  provenance = "observed",
  createdAt = RCL_005_NOW - 60,
  expiresAt = null,
  originSeq = Number(/^c([0-9]+)\./u.exec(claimId)?.[1] ?? 1),
}) {
  const eventId = `ev_fixture_${claimId.replace(".", "_")}`;
  const body = JSON.stringify({
    raw_text: `fixture statement ${claimId}`,
    parsed: [{ relation_label: null }],
    provenance,
    ttl: expiresAt === null ? "permanent" : "weeks",
  });
  return [
    {
      kind: "run",
      sql: "INSERT INTO journal(id,scope_key,kind,body,actor,branch,session,created_at) VALUES (?,?,'statement',?,NULL,NULL,NULL,?)",
      parameters: [eventId, scopeKey, body, createdAt],
    },
    {
      kind: "run",
      sql: "INSERT INTO statements(event_id,scope_key,state,order_seq,created_at,provenance,expires_at) VALUES (?,?,'live',?,?,?,?)",
      parameters: [eventId, scopeKey, originSeq, createdAt, provenance, expiresAt],
    },
    {
      kind: "run",
      sql: "INSERT INTO claims(id,scope_key,subject_id,relation,object_id,object_value,state,origin_seq,first_seen_at,last_seen_at) VALUES (?,?,?,?,?,?,'active',?,?,?)",
      parameters: [
        claimId,
        scopeKey,
        subjectId,
        relation,
        objectId,
        objectValue,
        originSeq,
        createdAt,
        createdAt,
      ],
    },
    {
      kind: "run",
      sql: "INSERT INTO claim_support(claim_id,event_id,draft_index,live,expires_at) VALUES (?,?,0,1,?)",
      parameters: [claimId, eventId, expiresAt],
    },
  ];
}

export function openObserver(databasePath) {
  return new Database(databasePath, { readonly: true, fileMustExist: true });
}

export function permanentDump(database) {
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

export function assertDeepFrozen(assert, value) {
  if (value === null || typeof value !== "object") {
    return;
  }
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) {
    assertDeepFrozen(assert, child);
  }
}
