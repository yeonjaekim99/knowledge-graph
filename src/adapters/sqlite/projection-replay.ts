import { createHash } from "node:crypto";

import {
  ProjectionReplayContractError,
  createProjectionReplayInput,
  runProjectionReplayReducer,
  type ProjectionReplayReducer,
} from "../../domain/projection-replay.js";
import {
  enqueueSqliteProjectionReplaySession,
  type SqliteConnectionFactory,
} from "./connection-factory.js";
import {
  SqliteConnectionError,
  type SqliteProjectionMetaSnapshot,
} from "./connection-protocol.js";

const CANONICAL_FORMAT = "recall-projection-v1";

export type ProjectionReplayReason =
  | "missing_meta"
  | "rules_version_changed"
  | "journal_sequence_changed";

export interface SqliteProjectionReplayRequest {
  readonly scopeKey: string;
  readonly rulesVersion: string;
  /** Injected UTC epoch seconds; semantic projection never receives this value. */
  readonly rebuiltAt: number;
  readonly reducer: ProjectionReplayReducer;
}

export interface SqliteProjectionReplayResult {
  readonly status: "current" | "replayed";
  readonly reason: ProjectionReplayReason | null;
  readonly scopeKey: string;
  readonly rulesVersion: string;
  readonly lastSeq: number;
  readonly eventCount: number;
  readonly projectionRowCount: number | null;
}

export interface SqliteProjectionCanonicalDump {
  readonly scopeKey: string;
  readonly format: typeof CANONICAL_FORMAT;
  readonly tableCount: number;
  readonly rowCount: number;
  readonly canonical: string;
  readonly checksum: string;
}

export interface SqliteProjectionReplayService {
  replay(request: SqliteProjectionReplayRequest): Promise<SqliteProjectionReplayResult>;
  canonicalDump(scopeKey: string): Promise<SqliteProjectionCanonicalDump>;
}

interface CanonicalTableDefinition {
  readonly name: string;
  readonly primaryKey: readonly string[];
  readonly jsonColumn: string;
}

const CANONICAL_TABLES: readonly CanonicalTableDefinition[] = Object.freeze([
  Object.freeze({
    name: "statements",
    primaryKey: Object.freeze(["event_id"]),
    jsonColumn: "statements_json",
  }),
  Object.freeze({
    name: "entities",
    primaryKey: Object.freeze(["id"]),
    jsonColumn: "entities_json",
  }),
  Object.freeze({
    name: "surface_forms",
    primaryKey: Object.freeze(["scope_key", "surface_norm", "entity_id"]),
    jsonColumn: "surface_forms_json",
  }),
  Object.freeze({
    name: "claims",
    primaryKey: Object.freeze(["id"]),
    jsonColumn: "claims_json",
  }),
  Object.freeze({
    name: "claim_support",
    primaryKey: Object.freeze(["claim_id", "event_id"]),
    jsonColumn: "claim_support_json",
  }),
  Object.freeze({
    name: "id_redirects",
    primaryKey: Object.freeze(["old_id"]),
    jsonColumn: "id_redirects_json",
  }),
]);

const CANONICAL_DUMP_SQL = [
  "SELECT",
  "COALESCE((SELECT json_group_array(json(row_json)) FROM (",
  "  SELECT json_object('event_id',event_id,'scope_key',scope_key,'state',state,'order_seq',order_seq,'created_at',created_at,'provenance',provenance,'expires_at',expires_at) AS row_json",
  "  FROM statements WHERE scope_key=? ORDER BY event_id",
  ")), '[]') AS statements_json,",
  "COALESCE((SELECT json_group_array(json(row_json)) FROM (",
  "  SELECT json_object('id',id,'scope_key',scope_key,'name',name,'normal_name',normal_name,'kind',kind,'merged_into',merged_into,'origin_seq',origin_seq) AS row_json",
  "  FROM entities WHERE scope_key=? ORDER BY id",
  ")), '[]') AS entities_json,",
  "COALESCE((SELECT json_group_array(json(row_json)) FROM (",
  "  SELECT json_object('scope_key',scope_key,'surface_norm',surface_norm,'entity_id',entity_id,'origin',origin) AS row_json",
  "  FROM surface_forms WHERE scope_key=? ORDER BY scope_key,surface_norm,entity_id",
  ")), '[]') AS surface_forms_json,",
  "COALESCE((SELECT json_group_array(json(row_json)) FROM (",
  "  SELECT json_object('id',id,'scope_key',scope_key,'subject_id',subject_id,'relation',relation,'object_id',object_id,'object_value',object_value,'state',state,'origin_seq',origin_seq,'first_seen_at',first_seen_at,'last_seen_at',last_seen_at) AS row_json",
  "  FROM claims WHERE scope_key=? ORDER BY id",
  ")), '[]') AS claims_json,",
  "COALESCE((SELECT json_group_array(json(row_json)) FROM (",
  "  SELECT json_object('claim_id',cs.claim_id,'event_id',cs.event_id,'draft_index',cs.draft_index,'live',cs.live,'expires_at',cs.expires_at) AS row_json",
  "  FROM claim_support cs JOIN claims c ON c.id=cs.claim_id WHERE c.scope_key=? ORDER BY cs.claim_id,cs.event_id",
  ")), '[]') AS claim_support_json,",
  "COALESCE((SELECT json_group_array(json(row_json)) FROM (",
  "  SELECT json_object('old_id',r.old_id,'new_id',r.new_id,'kind',r.kind,'reason',r.reason) AS row_json",
  "  FROM id_redirects r WHERE",
  "    EXISTS (SELECT 1 FROM entities e WHERE e.id=r.new_id AND e.scope_key=?)",
  "    OR EXISTS (SELECT 1 FROM claims c WHERE c.id=r.new_id AND c.scope_key=?)",
  "  ORDER BY r.old_id",
  ")), '[]') AS id_redirects_json",
].join("\n");

function exactRequest(
  request: unknown,
): SqliteProjectionReplayRequest {
  if (request === null || typeof request !== "object" || Array.isArray(request)) {
    throw new ProjectionReplayContractError("INVALID_REPLAY_INPUT");
  }
  const keys = Reflect.ownKeys(request);
  const expected = ["rebuiltAt", "reducer", "rulesVersion", "scopeKey"].sort();
  if (
    keys.some((key) => typeof key !== "string") ||
    keys.length !== expected.length ||
    !(keys as string[])
      .slice()
      .sort()
      .every((key, index) => key === expected[index])
  ) {
    throw new ProjectionReplayContractError("INVALID_REPLAY_INPUT");
  }
  const values: Record<string, unknown> = {};
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(request, key);
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !("value" in descriptor)
    ) {
      throw new ProjectionReplayContractError("INVALID_REPLAY_INPUT");
    }
    values[key] = descriptor.value;
  }
  const canonical = createProjectionReplayInput({
    scopeKey: values["scopeKey"],
    rulesVersion: values["rulesVersion"],
    events: [],
  });
  if (
    !Number.isSafeInteger(values["rebuiltAt"]) ||
    Number(values["rebuiltAt"]) < 0 ||
    typeof values["reducer"] !== "function"
  ) {
    throw new ProjectionReplayContractError("INVALID_REPLAY_INPUT");
  }
  return Object.freeze({
    scopeKey: canonical.scopeKey,
    rulesVersion: canonical.rulesVersion,
    rebuiltAt: Number(values["rebuiltAt"]),
    reducer: values["reducer"] as ProjectionReplayReducer,
  });
}

function replayReason(
  meta: SqliteProjectionMetaSnapshot | null,
  journalLastSeq: number,
  rulesVersion: string,
): ProjectionReplayReason | null {
  if (meta === null) {
    return "missing_meta";
  }
  if (meta.rulesVersion !== rulesVersion) {
    return "rules_version_changed";
  }
  return meta.lastSeq === journalLastSeq
    ? null
    : "journal_sequence_changed";
}

function canonicalScope(scopeKey: unknown): string {
  return createProjectionReplayInput({
    scopeKey,
    rulesVersion: "canonical-dump-v1",
    events: [],
  }).scopeKey;
}

function stringFrame(value: string): string {
  return `s${Buffer.byteLength(value, "utf8")}:${value}`;
}

function canonicalEncode(
  value: unknown,
  active: WeakSet<object> = new WeakSet(),
): string {
  if (value === null) {
    return "n0:";
  }
  if (typeof value === "string") {
    return stringFrame(value);
  }
  if (typeof value === "boolean") {
    return value ? "b1:1" : "b1:0";
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      throw new SqliteConnectionError("SQLITE_QUERY_FAILED");
    }
    const text = Object.is(value, -0) ? "0" : JSON.stringify(value);
    return `d${Buffer.byteLength(text, "utf8")}:${text}`;
  }
  if (typeof value !== "object" || active.has(value)) {
    throw new SqliteConnectionError("SQLITE_QUERY_FAILED");
  }
  active.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new SqliteConnectionError("SQLITE_QUERY_FAILED");
        }
      }
      return `a${value.length}:[${value
        .map((child) => canonicalEncode(child, active))
        .join("")}]`;
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new SqliteConnectionError("SQLITE_QUERY_FAILED");
    }
    const entries = Object.entries(value as Readonly<Record<string, unknown>>).sort(
      ([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right)),
    );
    return `o${entries.length}:{${entries
      .map(
        ([key, child]) =>
          `${stringFrame(key)}${canonicalEncode(child, active)}`,
      )
      .join("")}}`;
  } finally {
    active.delete(value);
  }
}

function primaryKeyEncoding(
  row: Readonly<Record<string, unknown>>,
  primaryKey: readonly string[],
): string {
  const values = primaryKey.map((column) => {
    if (!Object.hasOwn(row, column)) {
      throw new SqliteConnectionError("SQLITE_QUERY_FAILED");
    }
    const value = row[column];
    if (
      value !== null &&
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "boolean"
    ) {
      throw new SqliteConnectionError("SQLITE_QUERY_FAILED");
    }
    return value;
  });
  return canonicalEncode(values);
}

function parseRows(value: unknown): readonly Readonly<Record<string, unknown>>[] {
  if (typeof value !== "string") {
    throw new SqliteConnectionError("SQLITE_QUERY_FAILED");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new SqliteConnectionError("SQLITE_QUERY_FAILED");
  }
  if (
    !Array.isArray(parsed) ||
    !parsed.every(
      (row) =>
        row !== null &&
        typeof row === "object" &&
        !Array.isArray(row) &&
        Object.getPrototypeOf(row) === Object.prototype,
    )
  ) {
    throw new SqliteConnectionError("SQLITE_QUERY_FAILED");
  }
  return parsed as readonly Readonly<Record<string, unknown>>[];
}

function buildCanonicalDump(
  scopeKey: string,
  row: Readonly<Record<string, unknown>>,
): SqliteProjectionCanonicalDump {
  let rowCount = 0;
  const tables = CANONICAL_TABLES.map((definition) => {
    const rows = parseRows(row[definition.jsonColumn]).map((value) => ({
      value,
      primaryKey: primaryKeyEncoding(value, definition.primaryKey),
    }));
    rows.sort((left, right) =>
      Buffer.compare(
        Buffer.from(left.primaryKey, "utf8"),
        Buffer.from(right.primaryKey, "utf8"),
      ),
    );
    if (new Set(rows.map(({ primaryKey }) => primaryKey)).size !== rows.length) {
      throw new SqliteConnectionError("SQLITE_QUERY_FAILED");
    }
    rowCount += rows.length;
    return {
      name: definition.name,
      primary_key: [...definition.primaryKey],
      rows: rows.map(({ value }) => value),
    };
  }).sort((left, right) =>
    Buffer.compare(Buffer.from(left.name, "utf8"), Buffer.from(right.name, "utf8")),
  );
  const canonical = canonicalEncode({ format: CANONICAL_FORMAT, tables });
  return Object.freeze({
    scopeKey,
    format: CANONICAL_FORMAT,
    tableCount: tables.length,
    rowCount,
    canonical,
    checksum: createHash("sha256").update(canonical, "utf8").digest("hex"),
  });
}

async function readCanonicalDump(
  factory: SqliteConnectionFactory,
  rawScopeKey: unknown,
): Promise<SqliteProjectionCanonicalDump> {
  const scopeKey = canonicalScope(rawScopeKey);
  const reader = await factory.openReader();
  try {
    const result = await reader.query({
      kind: "get",
      sql: CANONICAL_DUMP_SQL,
      parameters: [
        scopeKey,
        scopeKey,
        scopeKey,
        scopeKey,
        scopeKey,
        scopeKey,
        scopeKey,
      ],
    });
    if (result.kind !== "get" || result.row === null) {
      throw new SqliteConnectionError("SQLITE_QUERY_FAILED");
    }
    return buildCanonicalDump(scopeKey, result.row);
  } finally {
    await reader.close();
  }
}

export function createSqliteProjectionReplayService(
  dependencies: Readonly<{ readonly factory: SqliteConnectionFactory }>,
): SqliteProjectionReplayService {
  if (
    dependencies === null ||
    typeof dependencies !== "object" ||
    dependencies.factory === null ||
    typeof dependencies.factory !== "object" ||
    typeof dependencies.factory.openReader !== "function"
  ) {
    throw new SqliteConnectionError("INVALID_TRANSACTION_PROGRAM");
  }
  const { factory } = dependencies;
  return Object.freeze({
    replay(rawRequest: SqliteProjectionReplayRequest): Promise<SqliteProjectionReplayResult> {
      let request: SqliteProjectionReplayRequest;
      try {
        request = exactRequest(rawRequest);
      } catch (error) {
        return Promise.reject(error);
      }
      return enqueueSqliteProjectionReplaySession(factory, async (session) => {
        const begin = await session.begin(request.scopeKey);
        const journalLastSeq = begin.events.at(-1)?.seq ?? 0;
        const reason = replayReason(
          begin.meta,
          journalLastSeq,
          request.rulesVersion,
        );
        if (reason === null) {
          await session.rollback(begin.replayId);
          return Object.freeze({
            status: "current",
            reason: null,
            scopeKey: request.scopeKey,
            rulesVersion: request.rulesVersion,
            lastSeq: journalLastSeq,
            eventCount: begin.events.length,
            projectionRowCount: null,
          });
        }

        let snapshot;
        try {
          snapshot = runProjectionReplayReducer(
            {
              scopeKey: request.scopeKey,
              rulesVersion: request.rulesVersion,
              events: begin.events,
            },
            request.reducer,
          );
        } catch (error) {
          await session.rollback(begin.replayId);
          if (error instanceof ProjectionReplayContractError) {
            throw error;
          }
          throw new ProjectionReplayContractError("INVALID_PROJECTION_SNAPSHOT");
        }
        const committed = await session.commit(
          begin.replayId,
          request.rulesVersion,
          request.rebuiltAt,
          snapshot,
        );
        return Object.freeze({
          status: "replayed",
          reason,
          scopeKey: request.scopeKey,
          rulesVersion: request.rulesVersion,
          lastSeq: committed.lastSeq,
          eventCount: committed.eventCount,
          projectionRowCount: committed.projectionRowCount,
        });
      });
    },
    canonicalDump(scopeKey: string): Promise<SqliteProjectionCanonicalDump> {
      return readCanonicalDump(factory, scopeKey);
    },
  });
}
