import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";

import {
  EmptyJournalBatchError,
  JournalWriteService,
} from "../../dist/application/index.js";
import * as publicApi from "../../dist/index.js";
import { createSqliteJournalCommitPort } from "../../dist/adapters/sqlite/index.js";
import { reduceEvents } from "../../dist/domain/index.js";
import { validateArchitecture } from "../../scripts/check-module-boundaries.mjs";

const temporaryDirectories = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

function createFixture({
  applicationIndex = "export const marker = 1;\n",
  domainIndex = "export const domainMarker = 1;\n",
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "recall-architecture-"));
  temporaryDirectories.push(root);

  const files = {
    "src/index.ts": 'export { marker } from "./application/index.js";\n',
    "src/application/index.ts": applicationIndex,
    "src/application/ports/journal-commit-port.ts": [
      "export interface JournalCommitPort<Intent, Receipt> {",
      "  appendAndProject(events: readonly Intent[]): Promise<Receipt>;",
      "}",
      "",
    ].join("\n"),
    "src/domain/index.ts": domainIndex,
  };

  for (const [relativePath, contents] of Object.entries(files)) {
    const absolutePath = join(root, relativePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, contents);
  }

  writeFileSync(
    join(root, "architecture.config.json"),
    JSON.stringify(
      {
        version: 1,
        sourceRoot: "src",
        publicEntry: "src/index.ts",
        publicApiFiles: ["src/index.ts", "src/application/index.ts"],
        privatePublicTargets: ["src/application/ports", "src/domain"],
        forbiddenImportFragments: ["spikes/adr-behavior"],
        requiredFiles: Object.keys(files),
        atomicWritePort: {
          file: "src/application/ports/journal-commit-port.ts",
          interface: "JournalCommitPort",
          method: "appendAndProject",
        },
        layers: [
          {
            name: "domain",
            root: "src/domain",
            mayImport: ["domain"],
            externalPackages: [],
          },
          {
            name: "application",
            root: "src/application",
            mayImport: ["application", "domain"],
            externalPackages: [],
          },
        ],
        publicEntryRule: {
          mayImport: ["application"],
          externalPackages: [],
        },
      },
      null,
      2,
    ),
  );

  return root;
}

test("pure reducer executes deterministically without an adapter", () => {
  const initial = Object.freeze({ total: 0, trace: Object.freeze([]) });
  const events = Object.freeze([
    Object.freeze({ seq: 1, amount: 2 }),
    Object.freeze({ seq: 2, amount: 3 }),
  ]);
  const reducer = (state, event) => ({
    total: state.total + event.amount,
    trace: [...state.trace, event.seq],
  });

  const first = reduceEvents(initial, events, reducer);
  const second = reduceEvents(initial, events, reducer);

  assert.deepEqual(first, { total: 5, trace: [1, 2] });
  assert.deepEqual(second, first);
  assert.deepEqual(initial, { total: 0, trace: [] });
});

test("write service exposes one atomic append-and-project path", async () => {
  const received = [];
  const service = new JournalWriteService({
    appendAndProject(events) {
      received.push(events);
      return Promise.resolve({ committed: events.length });
    },
  });

  const result = await service.execute([{ kind: "statement" }]);

  assert.deepEqual(result, { committed: 1 });
  assert.deepEqual(received, [[{ kind: "statement" }]]);
});

test("write service rejects an empty batch before calling its port", async () => {
  let calls = 0;
  const service = new JournalWriteService({
    appendAndProject() {
      calls += 1;
      return Promise.resolve({ committed: 0 });
    },
  });

  await assert.rejects(service.execute([]), EmptyJournalBatchError);
  assert.equal(calls, 0);
});

test("write service propagates atomic port failure without a fallback write", async () => {
  let calls = 0;
  const failure = new Error("transaction rolled back");
  const service = new JournalWriteService({
    appendAndProject() {
      calls += 1;
      return Promise.reject(failure);
    },
  });

  await assert.rejects(service.execute([{ kind: "merge" }]), failure);
  assert.equal(calls, 1);
});

test("SQLite adapter surface contains no projection-only capability", async () => {
  const batches = [];
  const port = createSqliteJournalCommitPort({
    execute(events) {
      batches.push(events);
      return Promise.resolve("ok");
    },
  });

  assert.deepEqual(Object.keys(port), ["appendAndProject"]);
  assert.equal(Object.isFrozen(port), true);
  assert.equal(await port.appendAndProject(["event"]), "ok");
  assert.deepEqual(batches, [["event"]]);
});

test("package root exposes no runtime write, port, or adapter capability", () => {
  assert.deepEqual(Object.keys(publicApi), []);
});

test("architecture guard accepts the repository and a minimal valid graph", () => {
  assert.deepEqual(validateArchitecture().errors, []);
  assert.deepEqual(validateArchitecture({ projectRoot: createFixture() }).errors, []);
});

test("architecture guard rejects an inward dependency inversion", () => {
  const root = createFixture({
    domainIndex: 'import "../application/index.js";\nexport const domainMarker = 1;\n',
  });

  const result = validateArchitecture({ projectRoot: root });

  assert.match(
    result.errors.join("\n"),
    /domain may not import application/,
  );
});

test("architecture guard rejects production imports from the behavior spike", () => {
  const root = createFixture({
    applicationIndex: [
      'import "../../../spikes/adr-behavior/reference.js";',
      "export const marker = 1;",
      "",
    ].join("\n"),
  });

  const result = validateArchitecture({ projectRoot: root });

  assert.match(result.errors.join("\n"), /forbidden spike import/);
});

test("architecture guard rejects a private write port re-export", () => {
  const root = createFixture({
    applicationIndex: [
      'export type { JournalCommitPort } from "./ports/journal-commit-port.js";',
      "export const marker = 1;",
      "",
    ].join("\n"),
  });

  const result = validateArchitecture({ projectRoot: root });

  assert.match(result.errors.join("\n"), /public API may not export private target/);
});

test("architecture guard rejects a projection-only write capability", () => {
  const root = createFixture();
  writeFileSync(
    join(root, "src/application/ports/journal-commit-port.ts"),
    [
      "export interface JournalCommitPort<Intent, Receipt> {",
      "  appendAndProject(events: readonly Intent[]): Promise<Receipt>;",
      "  writeProjection(value: unknown): Promise<void>;",
      "}",
      "",
    ].join("\n"),
  );

  const result = validateArchitecture({ projectRoot: root });

  assert.match(result.errors.join("\n"), /must expose only appendAndProject/);
});
