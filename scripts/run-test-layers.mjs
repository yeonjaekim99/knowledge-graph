#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROJECT_ROOT = resolve(SCRIPT_DIRECTORY, "..");
const PLAN_PATH = "test/test-layers.json";

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function isInside(parent, child) {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function toPosix(path) {
  return path.split(sep).join("/");
}

function validatePlan(plan, projectRoot) {
  if (plan === null || typeof plan !== "object" || Array.isArray(plan)) {
    throw new TypeError("test plan must be an object");
  }
  if (plan.schema_version !== 1) {
    throw new TypeError("test plan schema_version must be 1");
  }
  if (typeof plan.default_suite !== "string" || plan.default_suite.length === 0) {
    throw new TypeError("test plan default_suite must be non-empty text");
  }
  if (plan.environment === null || typeof plan.environment !== "object") {
    throw new TypeError("test plan environment must be an object");
  }
  for (const key of [
    "TZ",
    "LANG",
    "LC_ALL",
    "RECALL_TEST_LOCALE",
    "RECALL_TEST_NOW_SECONDS",
    "RECALL_TEST_SEED",
  ]) {
    if (typeof plan.environment[key] !== "string" || plan.environment[key].length === 0) {
      throw new TypeError(`test plan environment is missing ${key}`);
    }
  }
  if (!Array.isArray(plan.layers) || plan.layers.length === 0) {
    throw new TypeError("test plan layers must be a non-empty array");
  }

  const layerIds = new Set();
  const roots = new Set();
  const suites = new Set();
  for (const layer of plan.layers) {
    if (
      layer === null ||
      typeof layer !== "object" ||
      typeof layer.id !== "string" ||
      !/^[a-z][a-z0-9-]*$/.test(layer.id) ||
      typeof layer.root !== "string" ||
      typeof layer.purpose !== "string" ||
      !Array.isArray(layer.suites) ||
      layer.suites.length === 0 ||
      !layer.suites.every((suite) => typeof suite === "string" && suite.length > 0)
    ) {
      throw new TypeError("test plan layer is malformed");
    }
    if (layerIds.has(layer.id) || roots.has(layer.root)) {
      throw new TypeError("test plan layer IDs and roots must be unique");
    }
    const absoluteRoot = resolve(projectRoot, layer.root);
    if (!isInside(projectRoot, absoluteRoot) || !existsSync(absoluteRoot)) {
      throw new TypeError(`test layer root is missing or outside the project: ${layer.id}`);
    }
    if (new Set(layer.suites).size !== layer.suites.length) {
      throw new TypeError(`test layer suites must be unique: ${layer.id}`);
    }
    layerIds.add(layer.id);
    roots.add(layer.root);
    for (const suite of layer.suites) {
      suites.add(suite);
    }
  }
  if (!suites.has(plan.default_suite)) {
    throw new TypeError("test plan default_suite is not assigned to a layer");
  }
}

export function loadTestPlan({ projectRoot = DEFAULT_PROJECT_ROOT } = {}) {
  const absoluteRoot = resolve(projectRoot);
  const raw = JSON.parse(readFileSync(resolve(absoluteRoot, PLAN_PATH), "utf8"));
  validatePlan(raw, absoluteRoot);
  return deepFreeze(raw);
}

function collectTestFiles(directory, projectRoot, output) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      collectTestFiles(path, projectRoot, output);
    } else if (entry.isFile() && entry.name.endsWith(".test.mjs")) {
      output.push(toPosix(relative(projectRoot, path)));
    }
  }
}

export function discoverTestFiles({
  projectRoot = DEFAULT_PROJECT_ROOT,
  plan = loadTestPlan({ projectRoot }),
  selector = plan.default_suite,
} = {}) {
  const absoluteRoot = resolve(projectRoot);
  validatePlan(plan, absoluteRoot);
  const selectedLayers = plan.layers.filter(
    (layer) => layer.id === selector || layer.suites.includes(selector),
  );
  if (selectedLayers.length === 0) {
    throw new TypeError(`unknown test suite or layer: ${selector}`);
  }

  const files = [];
  for (const layer of selectedLayers) {
    collectTestFiles(resolve(absoluteRoot, layer.root), absoluteRoot, files);
  }
  return [...new Set(files)].sort();
}

export function buildTestEnvironment(baseEnvironment, fixedEnvironment) {
  return Object.freeze({ ...baseEnvironment, ...fixedEnvironment });
}

export function runTestLayers({
  projectRoot = DEFAULT_PROJECT_ROOT,
  selector,
  baseEnvironment = process.env,
} = {}) {
  const absoluteRoot = resolve(projectRoot);
  const plan = loadTestPlan({ projectRoot: absoluteRoot });
  const selected = selector ?? plan.default_suite;
  const files = discoverTestFiles({
    projectRoot: absoluteRoot,
    plan,
    selector: selected,
  });
  const environment = buildTestEnvironment(baseEnvironment, plan.environment);

  console.log(`test_selector=${selected}`);
  console.log(`test_files=${files.length}`);
  console.log(
    `test_context=seed:${environment.RECALL_TEST_SEED} now:${environment.RECALL_TEST_NOW_SECONDS} tz:${environment.TZ} locale:${environment.RECALL_TEST_LOCALE}`,
  );
  if (files.length === 0) {
    console.log("test_result=PASS (no tests assigned yet)");
    return 0;
  }

  const child = spawnSync(process.execPath, ["--test", ...files], {
    cwd: absoluteRoot,
    env: environment,
    stdio: "inherit",
  });
  if (child.error !== undefined) {
    throw child.error;
  }
  return child.status ?? 1;
}

const executedPath = process.argv[1] === undefined ? "" : resolve(process.argv[1]);
if (executedPath === fileURLToPath(import.meta.url)) {
  process.exitCode = runTestLayers({ selector: process.argv[2] });
}
