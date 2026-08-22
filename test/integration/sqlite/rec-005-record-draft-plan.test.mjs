import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  sanitizeMemoryRecordSecrets,
  selectRecordDraftSurvivors,
} from "../../../dist/application/index.js";
import {
  SqliteConnectionError,
  WriteEntityResolutionError,
  createSqliteConnectionFactory,
  finalizeSqliteRecordDraftPlan,
  resolveSqliteWriteEntityDrafts,
  runBundledSqliteMigrations,
  runSqliteStartupGate,
} from "../../../dist/adapters/sqlite/index.js";
import { enqueueSqliteProjectionDispatchSession } from "../../../dist/adapters/sqlite/connection-factory.js";

const NOW = 1_700_000_000;
const SCOPE = "u:record-user/p:recall";
const SYNTHETIC_TOKEN = `ghp_${"SyntheticOnly1234567890".repeat(2)}`;
const temporaryDirectories = [];
const openFactories = new Set();

afterEach(async () => {
  await Promise.allSettled([...openFactories].map((factory) => factory.close()));
  openFactories.clear();
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

async function createStore() {
  const root = mkdtempSync(join(tmpdir(), "recall-rec-005-"));
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

async function rows(factory, sql) {
  const reader = await factory.openReader();
  try {
    const result = await reader.query({ kind: "all", sql });
    assert.equal(result.kind, "all");
    return result.rows;
  } finally {
    await reader.close();
  }
}

function resolutionDraft({ inputIndex, draft }) {
  return {
    draftIndex: inputIndex,
    subject: {
      name: draft.subject,
      kind: draft.subject_kind ?? null,
      aliases: draft.subject_aliases ?? [],
    },
    object:
      "object" in draft
        ? {
            name: draft.object,
            kind: draft.object_kind ?? null,
            aliases: draft.object_aliases ?? [],
          }
        : null,
  };
}

function statementBody(sanitized, selected, parsed = undefined) {
  return JSON.stringify({
    raw_text: sanitized.maskedRawText,
    parsed: parsed ?? selected.storedDrafts.map(({ draft }) => draft),
    provenance: "observed",
    ttl: "permanent",
  });
}

function recordInput() {
  return {
    raw_text: "인증 시스템과 테스트 명령을 기억한다",
    claims: [
      {
        subject: "폐기할 값",
        relation: "describes",
        object_value: SYNTHETIC_TOKEN,
      },
      {
        subject: "인증 시스템",
        relation: "uses",
        object: "PostgreSQL",
      },
      {
        subject: "인증-시스템",
        relation: "uses",
        object: "Postgre_SQL",
        relation_label: "depends on",
      },
      {
        subject: "테스트 명령",
        relation: "describes",
        object_value: "pnpm test",
      },
    ],
  };
}

test("feeds only canonical survivors into REC-004 finalization and leaves the transaction rollback-only", async () => {
  const factory = await createStore();
  const sanitized = sanitizeMemoryRecordSecrets(recordInput());
  assert.deepEqual(
    sanitized.approvedDrafts.map(({ inputIndex }) => inputIndex),
    [1, 2, 3],
  );

  await enqueueSqliteProjectionDispatchSession(factory, async (session) => {
    const prepared = await session.prepare(SCOPE);
    const resolutions = await resolveSqliteWriteEntityDrafts(session, {
      dispatchId: prepared.dispatchId,
      drafts: sanitized.approvedDrafts.map(resolutionDraft),
    });
    const selected = selectRecordDraftSurvivors({
      approvedDrafts: sanitized.approvedDrafts,
      rejectedClaims: sanitized.rejectedClaims,
      resolutions,
    });
    assert.deepEqual(selected.survivorDraftIndexes, [1, 3]);

    const finalized = await finalizeSqliteRecordDraftPlan(session, {
      dispatchId: prepared.dispatchId,
      plan: selected,
      statementBodyJson: statementBody(sanitized, selected),
    });
    assert.equal(finalized.expectedJournalSeq, 1);
    assert.deepEqual(finalized.mappings, [
      {
        inputIndex: 1,
        storedIndex: 0,
        claimCandidateId: "c1.0",
        subjectOccurrence: {
          position: 0,
          candidateId: "e1.0",
          canonicalId: "e1.0",
        },
        objectOccurrence: {
          position: 1,
          candidateId: "e1.1",
          canonicalId: "e1.1",
        },
      },
      {
        inputIndex: 3,
        storedIndex: 1,
        claimCandidateId: "c1.1",
        subjectOccurrence: {
          position: 2,
          candidateId: "e1.2",
          canonicalId: "e1.2",
        },
        objectOccurrence: null,
      },
    ]);
    assert.equal(finalized.outcomes[2].status, "reinforced");
    assert.equal(finalized.outcomes[1].claimCandidateId, "c1.0");
    assert.equal(finalized.outcomes[2].claimCandidateId, "c1.0");
    assert.equal("eventId" in finalized, false);
    await session.rollback(prepared.dispatchId);
  });

  assert.deepEqual(await rows(factory, "SELECT seq FROM journal"), []);
  assert.deepEqual(await rows(factory, "SELECT id FROM entities"), []);
  assert.deepEqual(await rows(factory, "SELECT old_id FROM id_redirects"), []);
});

test("binds candidate mapping to the exact survivor-only statement body", async () => {
  const factory = await createStore();
  const sanitized = sanitizeMemoryRecordSecrets(recordInput());

  await assert.rejects(
    enqueueSqliteProjectionDispatchSession(factory, async (session) => {
      const prepared = await session.prepare(SCOPE);
      const resolutions = await resolveSqliteWriteEntityDrafts(session, {
        dispatchId: prepared.dispatchId,
        drafts: sanitized.approvedDrafts.map(resolutionDraft),
      });
      const selected = selectRecordDraftSurvivors({
        approvedDrafts: sanitized.approvedDrafts,
        rejectedClaims: sanitized.rejectedClaims,
        resolutions,
      });
      await finalizeSqliteRecordDraftPlan(session, {
        dispatchId: prepared.dispatchId,
        plan: selected,
        statementBodyJson: statementBody(
          sanitized,
          selected,
          sanitized.approvedDrafts.map(({ draft }) => draft),
        ),
      });
    }),
    (error) => {
      assert.ok(error instanceof SqliteConnectionError);
      assert.equal(error.code, "SQLITE_TRANSACTION_FAILED");
      assert.equal("cause" in error, false);
      return true;
    },
  );
  assert.deepEqual(await rows(factory, "SELECT seq FROM journal"), []);
  assert.deepEqual(await rows(factory, "SELECT id FROM entities"), []);
});

test("rejects an unbranded or accessor-wrapped plan before invoking the session", async () => {
  let calls = 0;
  const fakeSession = {
    finalizeEntities: async () => {
      calls += 1;
      return { expectedJournalSeq: 1, drafts: [] };
    },
  };
  const poisoned = Object.defineProperty(
    {
      dispatchId: 1,
      statementBodyJson: "{}",
    },
    "plan",
    {
      enumerable: true,
      get() {
        throw new Error("synthetic-payload");
      },
    },
  );
  for (const value of [
    { dispatchId: 1, plan: {}, statementBodyJson: "{}" },
    poisoned,
  ]) {
    await assert.rejects(
      finalizeSqliteRecordDraftPlan(fakeSession, value),
      (error) => {
        assert.ok(error instanceof WriteEntityResolutionError);
        assert.equal(error.code, "INVALID_WRITE_ENTITY_RESOLUTION_INPUT");
        assert.equal(error.message.includes("synthetic-payload"), false);
        assert.equal("cause" in error, false);
        return true;
      },
    );
  }
  assert.equal(calls, 0);
});
