import { readFileSync } from "node:fs";

import type { SqliteConnectionFactory } from "./connection-factory.js";
import { SqliteMigrationError } from "./connection-protocol.js";
import {
  runSqliteMigrations,
  type SqliteMigration,
  type SqliteMigrationOptions,
  type SqliteMigrationResult,
} from "./migration.js";

interface BundledMigrationDescriptor {
  readonly version: number;
  readonly name: string;
  readonly sourceUrl: URL;
}

const BUNDLED_MIGRATIONS: readonly BundledMigrationDescriptor[] =
  Object.freeze([
    Object.freeze({
      version: 1,
      name: "v1_schema",
      sourceUrl: new URL(
        "./migrations/001-v1-schema.sql",
        import.meta.url,
      ),
    }),
  ]);

function loadBundledMigrations(): readonly SqliteMigration[] {
  try {
    return Object.freeze(
      BUNDLED_MIGRATIONS.map((migration) =>
        Object.freeze({
          version: migration.version,
          name: migration.name,
          source: new Uint8Array(readFileSync(migration.sourceUrl)),
        }),
      ),
    );
  } catch {
    throw new SqliteMigrationError("MIGRATION_BUNDLE_INVALID");
  }
}

export function runBundledSqliteMigrations(
  factory: SqliteConnectionFactory,
  options: SqliteMigrationOptions,
): Promise<SqliteMigrationResult> {
  return runSqliteMigrations(factory, loadBundledMigrations(), options);
}
