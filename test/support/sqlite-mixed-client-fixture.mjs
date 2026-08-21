import { setImmediate as yieldEventLoop } from "node:timers/promises";

import { createSqliteJournalRepository } from "../../dist/adapters/sqlite/index.js";
import { createDeterministicRuntimeProvider } from "./deterministic-runtime-provider.mjs";

const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const WRITER_CLIENTS = 4;
const READER_CLIENTS = 4;

export function storageFixtureEventId(ordinal) {
  if (!Number.isSafeInteger(ordinal) || ordinal < 0) {
    throw new RangeError("storage fixture event ordinal must be a non-negative safe integer");
  }
  let remaining = ordinal;
  const encoded = Array.from({ length: 26 }, () => "0");
  for (let index = encoded.length - 1; index >= 0 && remaining > 0; index -= 1) {
    encoded[index] = CROCKFORD_BASE32[remaining % 32];
    remaining = Math.floor(remaining / 32);
  }
  if (remaining !== 0 || Number(encoded[0]) > 7) {
    throw new RangeError("storage fixture event ordinal exceeds canonical ULID range");
  }
  return `ev_${encoded.join("")}`;
}

function clientScope(index) {
  const userId = `storage-client-${index}`;
  const projectId = "sto-008";
  return Object.freeze({
    userId,
    projectId,
    scopeKey: `u:${userId}/p:${projectId}`,
  });
}

function snapshotSql(scopeCount) {
  const scopeColumns = Array.from(
    { length: scopeCount },
    (_, index) =>
      `(SELECT COUNT(*) FROM journal WHERE scope_key = ?) AS scope_${index}`,
  );
  return [
    "SELECT",
    "  (SELECT COUNT(*) FROM journal) AS journal_count,",
    "  (SELECT COUNT(*) FROM journal_fts) AS fts_count,",
    "  (SELECT COUNT(*) FROM pragma_foreign_key_check) AS fk_violation_count,",
    `  ${scopeColumns.join(",\n  ")}`,
  ].join("\n");
}

async function readStorageSnapshot(reader, scopes) {
  const result = await reader.query({
    kind: "get",
    sql: snapshotSql(scopes.length),
    parameters: scopes.map(({ scopeKey }) => scopeKey),
  });
  if (result.kind !== "get" || result.row === null) {
    throw new Error("mixed-client storage snapshot was unavailable");
  }
  const scopeCounts = scopes.map((_, index) => Number(result.row[`scope_${index}`]));
  return Object.freeze({
    journalCount: Number(result.row.journal_count),
    ftsCount: Number(result.row.fts_count),
    fkViolationCount: Number(result.row.fk_violation_count),
    scopeCounts: Object.freeze(scopeCounts),
  });
}

async function readFinalRows(factory) {
  const reader = await factory.openReader();
  try {
    const journal = await reader.query({
      kind: "all",
      sql: "SELECT seq, id, scope_key FROM journal ORDER BY seq",
    });
    const fts = await reader.query({
      kind: "all",
      sql: "SELECT rowid FROM journal_fts ORDER BY rowid",
    });
    if (journal.kind !== "all" || fts.kind !== "all") {
      throw new Error("mixed-client final rows were unavailable");
    }
    return Object.freeze({
      journal: Object.freeze(journal.rows.map((row) => Object.freeze({ ...row }))),
      fts: Object.freeze(fts.rows.map((row) => Object.freeze({ ...row }))),
    });
  } finally {
    await reader.close();
  }
}

/**
 * Eight logical clients share the production factory: four request-scoped
 * appenders and four independent WAL reader connections. REL-004 can reuse the
 * same workload with a larger event count behind the future MCP transport.
 */
export async function runEightClientStorageFixture({
  factory,
  eventsPerWriter = 8,
  firstEventOrdinal = 1,
} = {}) {
  if (
    factory === null ||
    typeof factory !== "object" ||
    typeof factory.openReader !== "function" ||
    !Number.isSafeInteger(eventsPerWriter) ||
    eventsPerWriter < 1 ||
    !Number.isSafeInteger(firstEventOrdinal) ||
    firstEventOrdinal < 0
  ) {
    throw new TypeError("mixed-client fixture requires a managed factory and positive workload");
  }

  const scopes = Object.freeze(
    Array.from({ length: WRITER_CLIENTS }, (_, index) => clientScope(index)),
  );
  const repositories = scopes.map((scope, writerIndex) => {
    const first = firstEventOrdinal + writerIndex * eventsPerWriter;
    const eventIds = Array.from(
      { length: eventsPerWriter },
      (_, eventIndex) => storageFixtureEventId(first + eventIndex),
    );
    const runtime = createDeterministicRuntimeProvider({
      nowMilliseconds: (1_700_000_000 + writerIndex) * 1_000,
      eventIds,
      scope,
      metadata: {
        actor: `storage-client-${writerIndex}`,
        branch: "sto-008",
        session: null,
      },
    });
    return createSqliteJournalRepository({ factory, runtime });
  });
  const readers = await Promise.all(
    Array.from({ length: READER_CLIENTS }, () => factory.openReader()),
  );
  const expectedEvents = WRITER_CLIENTS * eventsPerWriter;
  let activeWriters = WRITER_CLIENTS;
  let releaseStart;
  const start = new Promise((resolve) => {
    releaseStart = resolve;
  });

  const writerTasks = repositories.map(async (repository, writerIndex) => {
    await start;
    try {
      for (let eventIndex = 0; eventIndex < eventsPerWriter; eventIndex += 1) {
        await repository.append([
          {
            kind: "statement",
            bodyJson: JSON.stringify({
              raw_text: `storage client ${writerIndex} event ${eventIndex}`,
              parsed: [],
            }),
          },
        ]);
      }
    } finally {
      activeWriters -= 1;
    }
  });

  const readerTasks = readers.map(async (reader) => {
    await start;
    let observations = 0;
    let previousCount = 0;
    let observedBeforeCompletion = false;
    do {
      const snapshot = await readStorageSnapshot(reader, scopes);
      if (
        snapshot.journalCount < previousCount ||
        snapshot.journalCount !== snapshot.ftsCount ||
        snapshot.fkViolationCount !== 0 ||
        snapshot.scopeCounts.reduce((sum, count) => sum + count, 0) !==
          snapshot.journalCount ||
        snapshot.scopeCounts.some((count) => count > eventsPerWriter)
      ) {
        throw new Error("mixed-client reader observed a torn or cross-scope snapshot");
      }
      previousCount = snapshot.journalCount;
      observations += 1;
      observedBeforeCompletion ||= activeWriters > 0;
      await yieldEventLoop();
    } while (activeWriters > 0);

    const finalSnapshot = await readStorageSnapshot(reader, scopes);
    return Object.freeze({ observations, observedBeforeCompletion, finalSnapshot });
  });

  releaseStart();
  try {
    await Promise.all([...writerTasks, ...readerTasks]);
    const finalRows = await readFinalRows(factory);
    return Object.freeze({
      clientCount: WRITER_CLIENTS + READER_CLIENTS,
      writerClients: WRITER_CLIENTS,
      readerClients: READER_CLIENTS,
      expectedEvents,
      scopes,
      readers: Object.freeze(await Promise.all(readerTasks)),
      ...finalRows,
    });
  } finally {
    await Promise.allSettled(readers.map((reader) => reader.close()));
  }
}
