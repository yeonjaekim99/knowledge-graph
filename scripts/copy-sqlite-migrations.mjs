#!/usr/bin/env node

import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDirectory = join(
  projectRoot,
  "src",
  "adapters",
  "sqlite",
  "migrations",
);
const destinationDirectory = join(
  projectRoot,
  "dist",
  "adapters",
  "sqlite",
  "migrations",
);
const migrationFiles = readdirSync(sourceDirectory)
  .filter((name) => /^\d{3}-[a-z0-9-]+\.sql$/u.test(name))
  .sort();

if (migrationFiles.length === 0) {
  throw new Error("No SQLite migration assets were found");
}

mkdirSync(destinationDirectory, { recursive: true });
for (const migrationFile of migrationFiles) {
  copyFileSync(
    join(sourceDirectory, migrationFile),
    join(destinationDirectory, migrationFile),
  );
}
