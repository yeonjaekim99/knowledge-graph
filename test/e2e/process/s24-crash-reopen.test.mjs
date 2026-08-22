import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  createSqliteConnectionFactory,
  createSqliteProjectionDispatcher,
  createSqliteProjectionReplayService,
  runBundledSqliteMigrations,
  runSqliteStartupGate,
} from "../../../dist/adapters/sqlite/index.js";
import { projectProjectionSnapshot } from "../../../dist/domain/index.js";
import { canonicalProjectionDump } from "../../support/canonical-projection.mjs";
import { createDeterministicRuntimeProvider } from "../../support/deterministic-runtime-provider.mjs";
import {
  aliasIntent,
  eventId,
  literalDraft,
  statementIntent,
} from "../../support/prj-010-projection-scenarios.mjs";
import { snapshotTables } from "../../support/prj-010-sqlite-parity.mjs";

const BASE_TIME = 1_700_000_000;
const RULES_VERSION = "rules-prj-010-v1";
const SCOPE = Object.freeze({
  userId: "crash-user",
  projectId: "recall",
  scopeKey: "u:crash-user/p:recall",
});
const METADATA = Object.freeze({
  actor: "crash-agent",
  branch: "prj-010-prefix-parity",
  session: null,
});
const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "prj-010-projection-crash-worker.mjs",
);

function baselineStatement() {
  return statementIntent({
    rawText: "crash baseline v1",
    parsed: [literalDraft("Crash Value", "describes", "v1")],
  });
}

function createDatabasePath(faultPoint) {
  const root = mkdtempSync(join(tmpdir(), `recall-prj-010-${faultPoint}-`));
  const stateDirectory = join(root, "state");
  mkdirSync(stateDirectory, { mode: 0o700 });
  chmodSync(stateDirectory, 0o700);
  return { root, databasePath: join(stateDirectory, "projection.sqlite3") };
}

async function query(factory, kind, sql, parameters = []) {
  const reader = await factory.openReader();
  try {
    return await reader.query({ kind, sql, parameters });
  } finally {
    await reader.close();
  }
}

async function rows(factory, sql, parameters = []) {
  const result = await query(factory, "all", sql, parameters);
  assert.equal(result.kind, "all");
  return result.rows;
}

async function row(factory, sql, parameters = []) {
  const result = await query(factory, "get", sql, parameters);
  assert.equal(result.kind, "get");
  return result.row;
}

function runtime(eventIds, at = BASE_TIME) {
  return createDeterministicRuntimeProvider({
    nowMilliseconds: at * 1_000,
    eventIds,
    rulesVersion: RULES_VERSION,
    scope: SCOPE,
    metadata: METADATA,
  });
}

async function seedDatabase(databasePath) {
  const readiness = runSqliteStartupGate({ databasePath });
  const factory = await createSqliteConnectionFactory(readiness);
  try {
    await runBundledSqliteMigrations(factory, {
      appliedAtSeconds: BASE_TIME - 1,
    });
    const dispatcher = createSqliteProjectionDispatcher({
      factory,
      runtime: runtime([eventId(1)]),
    });
    const receipt = await dispatcher.execute([baselineStatement()]);
    assert.deepEqual(receipt.events, [
      { index: 0, eventId: eventId(1), seq: 1 },
    ]);
  } finally {
    await factory.close();
  }
}

function waitForFault(child, faultPoint) {
  return new Promise((resolve, reject) => {
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const timeout = setTimeout(() => {
      reject(new Error(`projection crash fixture did not reach ${faultPoint}`));
    }, 10_000);
    const fail = (error) => {
      clearTimeout(timeout);
      reject(error);
    };
    child.once("error", fail);
    child.once("exit", (code, signal) => {
      if (code !== null || signal !== null) {
        fail(
          new Error(
            `projection crash fixture exited before ${faultPoint}: ${stderr.slice(0, 500)}`,
          ),
        );
      }
    });
    child.on("message", (message) => {
      if (message?.type === "fault-ready" && message.faultPoint === faultPoint) {
        clearTimeout(timeout);
        resolve(message);
      }
    });
  });
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

async function hardCrashAt(databasePath, faultPoint, delayMilliseconds = 0) {
  const child = fork(fixturePath, [databasePath, faultPoint], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  try {
    const fault = await waitForFault(child, faultPoint);
    if (faultPoint.startsWith("commit-race-")) {
      child.send({ type: "continue" });
      await new Promise((resolve) => setTimeout(resolve, delayMilliseconds));
    }
    const exited = waitForExit(child);
    assert.equal(child.kill("SIGKILL"), true);
    const exit = await exited;
    assert.ok(exit.signal === "SIGKILL" || exit.code !== 0);
    return fault;
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
}

async function assertCanonicalReplay(factory) {
  const journal = await rows(
    factory,
    "SELECT seq,id,scope_key,kind,body,actor,branch,session,created_at FROM journal WHERE scope_key=? ORDER BY seq",
    [SCOPE.scopeKey],
  );
  const events = journal.map((entry) => ({
    seq: entry.seq,
    eventId: entry.id,
    scopeKey: entry.scope_key,
    kind: entry.kind,
    bodyJson: entry.body,
    actor: entry.actor,
    branch: entry.branch,
    session: entry.session,
    createdAt: entry.created_at,
  }));
  const expected = projectProjectionSnapshot({
    scopeKey: SCOPE.scopeKey,
    rulesVersion: RULES_VERSION,
    events,
  });
  const actual = await createSqliteProjectionReplayService({ factory }).canonicalDump(
    SCOPE.scopeKey,
  );
  const independent = canonicalProjectionDump(snapshotTables(expected));
  assert.equal(actual.canonical, independent.canonical);
  assert.equal(actual.checksum, independent.checksum);
}

async function assertRecoveredState(databasePath, allowedStates) {
  const readiness = runSqliteStartupGate({ databasePath });
  const factory = await createSqliteConnectionFactory(readiness);
  try {
    assert.deepEqual(
      await runBundledSqliteMigrations(factory, {
        appliedAtSeconds: BASE_TIME + 600,
      }),
      { appliedVersions: [], currentVersion: 1 },
    );
    assert.deepEqual(await rows(factory, "SELECT * FROM pragma_foreign_key_check"), []);
    assert.deepEqual(await rows(factory, "PRAGMA integrity_check"), [
      { integrity_check: "ok" },
    ]);
    const journal = await rows(
      factory,
      "SELECT seq,id,kind FROM journal ORDER BY seq",
    );
    const state = journal.length === 1 ? "old" : "new";
    assert.ok(allowedStates.includes(state), `unexpected recovered state ${state}`);
    if (state === "old") {
      assert.deepEqual(journal, [
        { seq: 1, id: eventId(1), kind: "statement" },
      ]);
    } else {
      assert.deepEqual(journal, [
        { seq: 1, id: eventId(1), kind: "statement" },
        { seq: 2, id: eventId(2), kind: "statement" },
      ]);
    }
    assert.equal(
      (await row(factory, "SELECT COUNT(*) AS count FROM journal_fts"))?.count,
      state === "old" ? 1 : 2,
    );
    assert.deepEqual(
      await row(
        factory,
        "SELECT last_seq,rules_version FROM projection_meta WHERE scope_key=?",
        [SCOPE.scopeKey],
      ),
      {
        last_seq: state === "old" ? 1 : 2,
        rules_version: RULES_VERSION,
      },
    );
    assert.deepEqual(
      await rows(
        factory,
        "SELECT object_value FROM claims WHERE scope_key=? AND relation='describes' AND state='active' ORDER BY id",
        [SCOPE.scopeKey],
      ),
      [{ object_value: state === "old" ? "v1" : "v2" }],
    );
    await assertCanonicalReplay(factory);

    const recovery = createSqliteProjectionDispatcher({
      factory,
      runtime: runtime([eventId(9)], BASE_TIME + 700),
    });
    const receipt = await recovery.execute([aliasIntent("crash-recovered", "e1.0")]);
    assert.equal(receipt.events[0]?.seq, state === "old" ? 2 : 3);
    await assertCanonicalReplay(factory);
    return state;
  } finally {
    await factory.close();
  }
}

test("hard process exit leaves only an old or complete-new projection and reopen replay agrees", async (t) => {
  const cases = [
    { faultPoint: "before-journal-insert", allowed: ["old"] },
    { faultPoint: "after-journal-insert", allowed: ["old"] },
    { faultPoint: "before-projection-publish", allowed: ["old"] },
    { faultPoint: "commit-race-0", allowed: ["old", "new"], delay: 0 },
    { faultPoint: "commit-race-1", allowed: ["old", "new"], delay: 1 },
    { faultPoint: "commit-race-8", allowed: ["old", "new"], delay: 8 },
    { faultPoint: "after-commit", allowed: ["new"] },
    { faultPoint: "correct-after-journal-insert", allowed: ["old"] },
  ];

  for (const crashCase of cases) {
    await t.test(crashCase.faultPoint, async () => {
      const { root, databasePath } = createDatabasePath(crashCase.faultPoint);
      try {
        await seedDatabase(databasePath);
        await hardCrashAt(
          databasePath,
          crashCase.faultPoint,
          crashCase.delay ?? 0,
        );
        await assertRecoveredState(databasePath, crashCase.allowed);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});
