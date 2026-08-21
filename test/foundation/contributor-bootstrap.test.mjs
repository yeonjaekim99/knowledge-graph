import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function readText(relativePath) {
  try {
    return readFileSync(resolve(PROJECT_ROOT, relativePath), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

function requireText(text, expected, label) {
  assert.ok(text.includes(expected), `${label} must include ${expected}`);
}

function requireInOrder(text, expected, label) {
  let cursor = -1;
  for (const value of expected) {
    const next = text.indexOf(value, cursor + 1);
    assert.ok(next > cursor, `${label} must include ${value} in workflow order`);
    cursor = next;
  }
}

test("quick start publishes the exact pinned bootstrap and local gate", () => {
  const packageJson = JSON.parse(readText("package.json"));
  const nodeVersion = readText(".node-version").trim();
  const nodeMajor = Number(nodeVersion.split(".")[0]);
  const contributing = readText("CONTRIBUTING.md");
  const readme = readText("README.md");

  assert.match(nodeVersion, /^\d+\.\d+\.\d+$/);
  assert.equal(packageJson.engines.node, `>=${nodeVersion} <${nodeMajor + 1}`);
  assert.match(packageJson.packageManager, /^pnpm@\d+\.\d+\.\d+$/);
  assert.equal(packageJson.engines.pnpm, packageJson.packageManager.slice("pnpm@".length));
  assert.equal(
    packageJson.scripts["test:fnd-007"],
    "node --test test/foundation/contributor-bootstrap.test.mjs",
  );
  assert.equal(packageJson.scripts["verify:fnd-007"], "pnpm run verify:fnd-005");
  assert.equal(packageJson.scripts["verify:local"], "pnpm run verify:fnd-007");

  requireText(readme, "## 빠른 시작", "README");
  requireText(readme, "[기여 가이드](CONTRIBUTING.md)", "README");
  for (const value of [
    `Node.js \`${nodeVersion}\``,
    `pnpm \`${packageJson.engines.pnpm}\``,
    "pnpm install --frozen-lockfile",
    "pnpm verify:local",
  ]) {
    requireText(contributing, value, "CONTRIBUTING.md");
  }
});

test("contributor workflow preserves roadmap ownership, TDD, explicit staging, and review", () => {
  const contributing = readText("CONTRIBUTING.md");

  for (const value of [
    "TODO",
    "IN_PROGRESS",
    "BLOCKED",
    "DONE",
    "python3 docs/roadmap/validate.py",
    "python3 -m unittest discover -s spikes/adr-behavior -p 'test_*.py'",
    "자동 CI",
    "unresolved review thread",
  ]) {
    requireText(contributing, value, "CONTRIBUTING.md");
  }

  requireInOrder(
    contributing,
    [
      "git status --short --branch",
      "IN_PROGRESS",
      "RED",
      "GREEN",
      "git add -- <paths>",
      "Draft PR",
      "git pull --ff-only origin main",
    ],
    "CONTRIBUTING.md",
  );
});

test("local state policy isolates SQLite artifacts without hiding arbitrary fixtures", () => {
  const contributing = readText("CONTRIBUTING.md");
  const ignoreLines = new Set(
    readText(".gitignore")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#")),
  );

  assert.ok(ignoreLines.has("/.recall/"), "repository-local Recall state must be ignored");
  for (const unsafePattern of ["*.db", "*.sqlite", "*.sqlite3", "*-wal", "*-shm"]) {
    assert.equal(
      ignoreLines.has(unsafePattern),
      false,
      `${unsafePattern} would silently hide deliberate test fixtures`,
    );
  }

  for (const value of [
    "OS 임시 디렉터리",
    "`/.recall/`",
    "network filesystem",
    "다중 writer process",
    "실제 secret",
    "운영 DB",
    "STO-001",
  ]) {
    requireText(contributing, value, "CONTRIBUTING.md");
  }

  assert.doesNotMatch(contributing, /\b(?:RECALL_DB_PATH|DATABASE_URL)\b/);
});
