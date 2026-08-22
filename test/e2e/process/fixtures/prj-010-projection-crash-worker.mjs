import {
  createSqliteConnectionFactory,
  runBundledSqliteMigrations,
  runSqliteStartupGate,
} from "../../../../dist/adapters/sqlite/index.js";
import { enqueueSqliteProjectionDispatchSession } from "../../../../dist/adapters/sqlite/connection-factory.js";
import { projectProjectionSnapshot } from "../../../../dist/domain/index.js";

const databasePath = process.argv[2];
const faultPoint = process.argv[3];
const SCOPE_KEY = "u:crash-user/p:recall";
const RULES_VERSION = "rules-prj-010-v1";
const CREATED_AT = 1_700_000_060;
const RECORD_EVENT_ID = `ev_${String(2).padStart(26, "0")}`;
const CORRECT_EVENT_IDS = Object.freeze([
  `ev_${String(2).padStart(26, "0")}`,
  `ev_${String(3).padStart(26, "0")}`,
]);
const RECORD_BODY = JSON.stringify({
  raw_text: "crash candidate v2",
  parsed: [
    { subject: "Crash Value", relation: "describes", object_value: "v2" },
  ],
  provenance: "user_stated",
  ttl: "permanent",
});

const allowedFaults = new Set([
  "before-journal-insert",
  "after-journal-insert",
  "before-projection-publish",
  "commit-race-0",
  "commit-race-1",
  "commit-race-8",
  "after-commit",
  "correct-after-journal-insert",
]);

if (
  typeof databasePath !== "string" ||
  databasePath.length === 0 ||
  !allowedFaults.has(faultPoint) ||
  process.send === undefined
) {
  process.exit(2);
}

function appendEvent(eventId, kind, bodyJson) {
  return Object.freeze({
    eventId,
    kind,
    bodyJson,
    actor: "crash-agent",
    branch: "prj-010-prefix-parity",
    session: null,
    createdAt: CREATED_AT,
  });
}

function recordEvents() {
  return Object.freeze([
    appendEvent(RECORD_EVENT_ID, "statement", RECORD_BODY),
  ]);
}

function correctEvents() {
  return Object.freeze([
    appendEvent(
      CORRECT_EVENT_IDS[0],
      "retraction",
      JSON.stringify({ target: { claim_id: "c1.0" } }),
    ),
    appendEvent(CORRECT_EVENT_IDS[1], "statement", RECORD_BODY),
  ]);
}

function signal(type, extra = {}) {
  process.send({ type, faultPoint, ...extra });
}

function waitForever() {
  return new Promise(() => {});
}

function waitForContinue() {
  return new Promise((resolve) => {
    process.on("message", (message) => {
      if (message?.type === "continue") {
        resolve();
      }
    });
  });
}

const readiness = runSqliteStartupGate({ databasePath });
const factory = await createSqliteConnectionFactory(readiness);
await runBundledSqliteMigrations(factory, { appliedAtSeconds: CREATED_AT });

if (faultPoint === "before-journal-insert") {
  signal("fault-ready");
  await waitForever();
}

const events =
  faultPoint === "correct-after-journal-insert"
    ? correctEvents()
    : recordEvents();

await enqueueSqliteProjectionDispatchSession(factory, async (session) => {
  const begin = await session.begin(SCOPE_KEY, events);
  if (begin.collision || begin.appendedEvents.length !== events.length) {
    throw new Error("crash fixture could not append its complete event batch");
  }
  if (
    faultPoint === "after-journal-insert" ||
    faultPoint === "correct-after-journal-insert"
  ) {
    signal("fault-ready", { appended: begin.appendedEvents.length });
    return waitForever();
  }

  const snapshot = projectProjectionSnapshot({
    scopeKey: SCOPE_KEY,
    rulesVersion: RULES_VERSION,
    events: begin.events,
  });
  if (faultPoint === "before-projection-publish") {
    signal("fault-ready", { projected: snapshot.claims.length });
    return waitForever();
  }
  if (faultPoint.startsWith("commit-race-")) {
    signal("fault-ready", { projected: snapshot.claims.length });
    await waitForContinue();
  }

  await session.commit(
    begin.dispatchId,
    "replay",
    RULES_VERSION,
    CREATED_AT,
    snapshot,
  );

  if (faultPoint.startsWith("commit-race-")) {
    signal("commit-complete");
    return waitForever();
  }
  if (faultPoint === "after-commit") {
    signal("fault-ready", { committed: true });
    return waitForever();
  }
  throw new Error("unknown crash fixture control path");
});
