import { createDeterministicRuntimeProvider } from "./deterministic-runtime-provider.mjs";
import {
  RCL_005_NOW,
  RCL_005_OTHER_SCOPE,
  RCL_005_SCOPE,
  assertDeepFrozen,
  createRcl005Fixture,
  entityCommand,
  openObserver,
  permanentDump,
} from "./rcl-005-sqlite-fixture.mjs";

import { createSqliteRecallReadPort } from "../../dist/adapters/sqlite/index.js";
import { RecallSnapshotService } from "../../dist/application/recall-snapshot-service.js";

export const RCL_006_NOW = RCL_005_NOW;
export const RCL_006_SCOPE = RCL_005_SCOPE;
export const RCL_006_OTHER_SCOPE = RCL_005_OTHER_SCOPE;

export {
  assertDeepFrozen,
  createRcl005Fixture as createRcl006Fixture,
  entityCommand,
  openObserver,
  permanentDump,
};

export function createRecallServiceAt(
  factory,
  evaluationNow = RCL_006_NOW,
  scopeKey = RCL_006_SCOPE,
) {
  const [, userId, projectId] = /^u:([^/]+)\/p:(.+)$/u.exec(scopeKey) ?? [];
  const runtime = createDeterministicRuntimeProvider({
    nowMilliseconds: evaluationNow * 1_000,
    scope: { userId, projectId, scopeKey },
  });
  return new RecallSnapshotService(runtime, createSqliteRecallReadPort(factory));
}

export function claimCommand({
  claimId,
  subjectId,
  relation = "contains",
  objectId = null,
  objectValue = null,
  scopeKey = RCL_006_SCOPE,
  state = "active",
  originSeq = Number(/^c([0-9]+)\./u.exec(claimId)?.[1] ?? 1),
}) {
  return {
    kind: "run",
    sql: "INSERT INTO claims(id,scope_key,subject_id,relation,object_id,object_value,state,origin_seq,first_seen_at,last_seen_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    parameters: [
      claimId,
      scopeKey,
      subjectId,
      relation,
      objectId,
      objectValue,
      state,
      originSeq,
      RCL_006_NOW - 10_000,
      RCL_006_NOW,
    ],
  };
}

function eventId(sequence) {
  return `ev_${String(sequence).padStart(26, "0")}`;
}

export function supportCommands({
  sequence,
  claimId,
  relationLabel = null,
  provenance = "observed",
  createdAt = RCL_006_NOW - 60,
  expiresAt = null,
  live = 1,
  statementState = "live",
  scopeKey = RCL_006_SCOPE,
  orderSeq = sequence,
}) {
  const id = eventId(sequence);
  const body = JSON.stringify({
    raw_text: `ranking fixture ${sequence}`,
    parsed: [{ relation_label: relationLabel }],
    provenance,
    ttl: expiresAt === null ? "permanent" : "session",
  });
  return [
    {
      kind: "run",
      sql: "INSERT INTO journal(seq,id,scope_key,kind,body,actor,branch,session,created_at) VALUES (?, ?,?,'statement',?,'fixture','rcl-006',NULL,?)",
      parameters: [sequence, id, scopeKey, body, createdAt],
    },
    {
      kind: "run",
      sql: "INSERT INTO statements(event_id,scope_key,state,order_seq,created_at,provenance,expires_at) VALUES (?,?,?,?,?,?,?)",
      parameters: [
        id,
        scopeKey,
        statementState,
        orderSeq,
        createdAt,
        provenance,
        expiresAt,
      ],
    },
    {
      kind: "run",
      sql: "INSERT INTO claim_support(claim_id,event_id,draft_index,live,expires_at) VALUES (?,?,0,?,?)",
      parameters: [claimId, id, live, expiresAt],
    },
  ];
}

export function reached(claimId, depth = 0, seedOrder = 0) {
  return Object.freeze({
    claimId,
    depth,
    seedOrder,
    anchorId: "e1.0",
    path: `seed → ${claimId}`,
    hops: depth,
  });
}
