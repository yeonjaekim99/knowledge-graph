import {
  constants as fileSystemConstants,
  accessSync,
  closeSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  statfsSync,
} from "node:fs";
import { createRequire } from "node:module";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  sep,
} from "node:path";

export const RECALL_DB_PATH_ENV: string = "RECALL_DB_PATH";

export interface SqliteStoragePermissions {
  readonly stateDirectory: number;
  readonly database: number;
  readonly wal: number;
  readonly sharedMemory: number;
  readonly backupDirectory: number;
  readonly backup: number;
}

export const SQLITE_STORAGE_PERMISSIONS: SqliteStoragePermissions =
  Object.freeze({
    stateDirectory: 0o700,
    database: 0o600,
    wal: 0o600,
    sharedMemory: 0o600,
    backupDirectory: 0o700,
    backup: 0o600,
  });

export type SqliteCapabilityName = "fts5" | "trigram" | "json" | "unixepoch";

export type SqliteStartupErrorCode =
  | "DATABASE_PATH_MISSING"
  | "DATABASE_PATH_UNSUPPORTED"
  | "DATABASE_PATH_NOT_ABSOLUTE"
  | "NETWORK_FILESYSTEM_UNSUPPORTED"
  | "STATE_DIRECTORY_UNAVAILABLE"
  | "STATE_DIRECTORY_PERMISSIONS_UNSAFE"
  | "STATE_DIRECTORY_ACCESS_DENIED"
  | "FILESYSTEM_INSPECTION_FAILED"
  | "DATABASE_FILE_UNSUPPORTED"
  | "DATABASE_FILE_PERMISSIONS_UNSAFE"
  | "DATABASE_FILE_CREATE_FAILED"
  | "SQLITE_CAPABILITY_CHECK_FAILED"
  | "SQLITE_CAPABILITY_MISSING";

const ERROR_MESSAGES: Readonly<Record<SqliteStartupErrorCode, string>> =
  Object.freeze({
    DATABASE_PATH_MISSING:
      "SQLite database path configuration is required before startup",
    DATABASE_PATH_UNSUPPORTED:
      "SQLite database path must name a regular local filesystem file",
    DATABASE_PATH_NOT_ABSOLUTE:
      "SQLite database path must be absolute",
    NETWORK_FILESYSTEM_UNSUPPORTED:
      "SQLite WAL on a network filesystem is unsupported; use a local filesystem path",
    STATE_DIRECTORY_UNAVAILABLE:
      "SQLite state directory must already exist as a regular directory",
    STATE_DIRECTORY_PERMISSIONS_UNSAFE:
      "SQLite state directory must use owner-only 0700 permissions",
    STATE_DIRECTORY_ACCESS_DENIED:
      "SQLite state directory must be readable, writable, and searchable by the server",
    FILESYSTEM_INSPECTION_FAILED:
      "SQLite state filesystem could not be inspected safely",
    DATABASE_FILE_UNSUPPORTED:
      "SQLite database target must be a regular file and may not be a symbolic link",
    DATABASE_FILE_PERMISSIONS_UNSAFE:
      "SQLite database file must use owner-only 0600 permissions",
    DATABASE_FILE_CREATE_FAILED:
      "SQLite database file could not be created with the required permissions",
    SQLITE_CAPABILITY_CHECK_FAILED:
      "SQLite startup capability checks could not be completed",
    SQLITE_CAPABILITY_MISSING:
      "The configured SQLite runtime is missing a required capability",
  });

export class SqliteStartupError extends Error {
  public override readonly name: string = "SqliteStartupError";
  public readonly retryable: false = false;
  public readonly code: SqliteStartupErrorCode;
  public readonly capability: SqliteCapabilityName | undefined;

  public constructor(
    code: SqliteStartupErrorCode,
    capability?: SqliteCapabilityName,
  ) {
    super(ERROR_MESSAGES[code]);
    this.code = code;
    this.capability = capability;
  }
}

export interface SqliteStartupConfig {
  readonly databasePath: string;
}

export interface SqliteFilesystemEvidence {
  readonly type: bigint;
  readonly mountType: string | null;
}

export interface SqliteCapabilityEvidence {
  readonly sqliteVersion: string;
  readonly fts5: boolean;
  readonly trigram: boolean;
  readonly json: boolean;
  readonly unixepoch: boolean;
}

export interface SqliteCapabilities {
  readonly fts5: true;
  readonly trigram: true;
  readonly json: true;
  readonly unixepoch: true;
}

export interface SqliteStartupReadiness {
  readonly databasePath: string;
  readonly sqliteVersion: string;
  readonly capabilities: SqliteCapabilities;
  readonly localFilesystemOnly: true;
  readonly filesystemType: string;
  readonly mountType: string | null;
}

export interface SqliteStartupGate {
  verify(config: SqliteStartupConfig): SqliteStartupReadiness;
}

export interface SqliteStartupDependencyOverrides {
  readonly inspectFilesystem?: (
    directoryPath: string,
  ) => SqliteFilesystemEvidence;
  readonly probeCapabilities?: (
    databasePath: string,
  ) => SqliteCapabilityEvidence;
}

interface SqliteStatement {
  get(...parameters: unknown[]): unknown;
  run(...parameters: unknown[]): unknown;
}

interface SqliteDatabaseConnection {
  exec(sql: string): unknown;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

interface SqliteDatabaseConstructor {
  new (
    filename: string,
    options: { readonly readonly: boolean; readonly fileMustExist: boolean },
  ): SqliteDatabaseConnection;
}

const require = createRequire(import.meta.url);
const BetterSqlite3 = require("better-sqlite3") as SqliteDatabaseConstructor;
const POSIX_PERMISSION_MASK = 0o777;
const UNSIGNED_FILESYSTEM_TYPE_MASK = 0xffff_ffffn;
const NETWORK_FILESYSTEM_TYPES: ReadonlySet<bigint> = new Set([
  0x0000_564cn, // NCP
  0x0000_6969n, // NFS
  0x0000_517bn, // SMB
  0x00c3_6400n, // Ceph
  0x0102_1997n, // 9P
  0x0bd0_0bd0n, // Lustre
  0x4750_4653n, // GPFS
  0x5346_414fn, // AFS
  0x7375_7245n, // Coda
  0xff53_4d42n, // CIFS
  0xfe53_4d42n, // SMB2
]);
const NETWORK_MOUNT_TYPES: ReadonlySet<string> = new Set([
  "9p",
  "afs",
  "ceph",
  "cifs",
  "coda",
  "davfs",
  "davfs2",
  "fuse.glusterfs",
  "fuse.rclone",
  "fuse.s3fs",
  "fuse.sshfs",
  "gcsfuse",
  "gpfs",
  "lustre",
  "ncp",
  "nfs",
  "nfs4",
  "smbfs",
]);
const REQUIRED_CAPABILITIES: readonly SqliteCapabilityName[] = Object.freeze([
  "fts5",
  "trigram",
  "json",
  "unixepoch",
]);

function isErrnoCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as Error & { readonly code?: unknown }).code === code
  );
}

function decodeMountPath(value: string): string {
  return value.replace(/\\(040|011|012|134)/gu, (match, digits: string) => {
    const codePoints: Readonly<Record<string, string>> = {
      "040": " ",
      "011": "\t",
      "012": "\n",
      "134": "\\",
    };
    return codePoints[digits] ?? match;
  });
}

function isPathWithinMount(path: string, mountPoint: string): boolean {
  return (
    mountPoint === sep ||
    path === mountPoint ||
    path.startsWith(`${mountPoint}${sep}`)
  );
}

function linuxMountType(directoryPath: string): string | null {
  if (process.platform !== "linux") {
    return null;
  }

  try {
    const candidates: Array<{ readonly mountPoint: string; readonly type: string }> = [];
    for (const line of readFileSync("/proc/self/mountinfo", "utf8").split("\n")) {
      if (line.length === 0) {
        continue;
      }
      const fields = line.split(" ");
      const separatorIndex = fields.indexOf("-");
      const encodedMountPoint = fields[4];
      const mountType = fields[separatorIndex + 1];
      if (
        separatorIndex < 0 ||
        encodedMountPoint === undefined ||
        mountType === undefined
      ) {
        continue;
      }
      const mountPoint = decodeMountPath(encodedMountPoint);
      if (isPathWithinMount(directoryPath, mountPoint)) {
        candidates.push({ mountPoint, type: mountType.toLowerCase() });
      }
    }
    candidates.sort((left, right) => right.mountPoint.length - left.mountPoint.length);
    return candidates[0]?.type ?? null;
  } catch {
    return null;
  }
}

function inspectNodeFilesystem(directoryPath: string): SqliteFilesystemEvidence {
  const stats = statfsSync(directoryPath, { bigint: true });
  return Object.freeze({
    type: stats.type,
    mountType: linuxMountType(directoryPath),
  });
}

function checkCapability(operation: () => boolean): boolean {
  try {
    return operation();
  } catch {
    return false;
  }
}

function probeNodeSqliteCapabilities(
  databasePath: string,
): SqliteCapabilityEvidence {
  const database = new BetterSqlite3(databasePath, {
    readonly: true,
    fileMustExist: true,
  });

  try {
    const versionRow = database
      .prepare("SELECT sqlite_version() AS value")
      .get() as { readonly value?: unknown } | undefined;
    if (typeof versionRow?.value !== "string" || versionRow.value.length === 0) {
      throw new TypeError("invalid sqlite version result");
    }

    const fts5 = checkCapability(() => {
      database.exec(
        "CREATE VIRTUAL TABLE temp.recall_startup_fts5 USING fts5(value)",
      );
      return true;
    });
    const trigram = checkCapability(() => {
      database.exec(
        "CREATE VIRTUAL TABLE temp.recall_startup_trigram " +
          "USING fts5(value, content='', tokenize='trigram')",
      );
      database
        .prepare(
          "INSERT INTO recall_startup_trigram(rowid, value) VALUES (?, ?)",
        )
        .run(1, "인증시스템은 서버 세션을 사용한다");
      const row = database
        .prepare(
          "SELECT rowid FROM recall_startup_trigram " +
            "WHERE recall_startup_trigram MATCH ?",
        )
        .get('"증시스"') as { readonly rowid?: unknown } | undefined;
      return row?.rowid === 1;
    });
    const json = checkCapability(() => {
      const row = database
        .prepare("SELECT json_extract(?, ?) AS value")
        .get('{"ready":1}', "$.ready") as
        | { readonly value?: unknown }
        | undefined;
      return row?.value === 1;
    });
    const unixepoch = checkCapability(() => {
      const row = database
        .prepare("SELECT unixepoch(?) AS value")
        .get("2024-01-01T00:00:00Z") as
        | { readonly value?: unknown }
        | undefined;
      return row?.value === 1_704_067_200;
    });

    return Object.freeze({
      sqliteVersion: versionRow.value,
      fts5,
      trigram,
      json,
      unixepoch,
    });
  } finally {
    database.close();
  }
}

function validatePathValue(databasePath: unknown): string {
  if (typeof databasePath !== "string" || databasePath.trim().length === 0) {
    throw new SqliteStartupError("DATABASE_PATH_MISSING");
  }
  if (
    databasePath.trim() !== databasePath ||
    databasePath.includes("\0") ||
    databasePath === ":memory:" ||
    databasePath.toLowerCase().startsWith("file:") ||
    databasePath.endsWith(sep)
  ) {
    throw new SqliteStartupError("DATABASE_PATH_UNSUPPORTED");
  }
  if (databasePath.startsWith("//") || databasePath.startsWith("\\\\")) {
    throw new SqliteStartupError("NETWORK_FILESYSTEM_UNSUPPORTED");
  }
  if (!isAbsolute(databasePath)) {
    throw new SqliteStartupError("DATABASE_PATH_NOT_ABSOLUTE");
  }
  return databasePath;
}

function validateStateDirectory(databasePath: string): string {
  const configuredDirectory = dirname(databasePath);
  let directoryStats;
  let canonicalDirectory;
  try {
    directoryStats = statSync(configuredDirectory);
    canonicalDirectory = realpathSync(configuredDirectory);
  } catch {
    throw new SqliteStartupError("STATE_DIRECTORY_UNAVAILABLE");
  }
  if (!directoryStats.isDirectory()) {
    throw new SqliteStartupError("STATE_DIRECTORY_UNAVAILABLE");
  }
  if (
    process.platform !== "win32" &&
    (directoryStats.mode & POSIX_PERMISSION_MASK) !==
      SQLITE_STORAGE_PERMISSIONS.stateDirectory
  ) {
    throw new SqliteStartupError("STATE_DIRECTORY_PERMISSIONS_UNSAFE");
  }
  try {
    accessSync(
      canonicalDirectory,
      fileSystemConstants.R_OK |
        fileSystemConstants.W_OK |
        fileSystemConstants.X_OK,
    );
  } catch {
    throw new SqliteStartupError("STATE_DIRECTORY_ACCESS_DENIED");
  }
  return join(canonicalDirectory, basename(databasePath));
}

function assertLocalFilesystem(evidence: SqliteFilesystemEvidence): void {
  if (
    evidence === null ||
    typeof evidence !== "object" ||
    typeof evidence.type !== "bigint" ||
    !(
      evidence.mountType === null ||
      typeof evidence.mountType === "string"
    )
  ) {
    throw new SqliteStartupError("FILESYSTEM_INSPECTION_FAILED");
  }
  const normalizedType = evidence.type & UNSIGNED_FILESYSTEM_TYPE_MASK;
  const mountType = evidence.mountType?.toLowerCase() ?? null;
  if (
    NETWORK_FILESYSTEM_TYPES.has(normalizedType) ||
    (mountType !== null && NETWORK_MOUNT_TYPES.has(mountType))
  ) {
    throw new SqliteStartupError("NETWORK_FILESYSTEM_UNSUPPORTED");
  }
}

function validateExistingDatabase(databasePath: string): void {
  let databaseStats;
  try {
    databaseStats = lstatSync(databasePath);
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) {
      throw error;
    }
    throw new SqliteStartupError("DATABASE_FILE_UNSUPPORTED");
  }
  if (!databaseStats.isFile() || databaseStats.isSymbolicLink()) {
    throw new SqliteStartupError("DATABASE_FILE_UNSUPPORTED");
  }
  if (
    process.platform !== "win32" &&
    (databaseStats.mode & POSIX_PERMISSION_MASK) !==
      SQLITE_STORAGE_PERMISSIONS.database
  ) {
    throw new SqliteStartupError("DATABASE_FILE_PERMISSIONS_UNSAFE");
  }
}

function ensureDatabaseFile(databasePath: string): void {
  try {
    validateExistingDatabase(databasePath);
    return;
  } catch (error) {
    if (!isErrnoCode(error, "ENOENT")) {
      throw error;
    }
  }

  try {
    const descriptor = openSync(
      databasePath,
      fileSystemConstants.O_CREAT |
        fileSystemConstants.O_EXCL |
        fileSystemConstants.O_RDWR,
      SQLITE_STORAGE_PERMISSIONS.database,
    );
    closeSync(descriptor);
  } catch (error) {
    if (isErrnoCode(error, "EEXIST")) {
      validateExistingDatabase(databasePath);
      return;
    }
    throw new SqliteStartupError("DATABASE_FILE_CREATE_FAILED");
  }
  validateExistingDatabase(databasePath);
}

function requireCapabilities(
  evidence: SqliteCapabilityEvidence,
): SqliteCapabilities {
  if (evidence === null || typeof evidence !== "object") {
    throw new SqliteStartupError("SQLITE_CAPABILITY_CHECK_FAILED");
  }
  for (const capability of REQUIRED_CAPABILITIES) {
    if (evidence[capability] !== true) {
      throw new SqliteStartupError("SQLITE_CAPABILITY_MISSING", capability);
    }
  }
  return Object.freeze({
    fts5: true,
    trigram: true,
    json: true,
    unixepoch: true,
  });
}

export function loadSqliteStartupConfig(
  environment: Readonly<Record<string, string | undefined>>,
): SqliteStartupConfig {
  const databasePath = environment[RECALL_DB_PATH_ENV];
  if (databasePath === undefined || databasePath.trim().length === 0) {
    throw new SqliteStartupError("DATABASE_PATH_MISSING");
  }
  return Object.freeze({ databasePath });
}

export function createSqliteStartupGate(
  overrides: SqliteStartupDependencyOverrides = {},
): SqliteStartupGate {
  const inspectFilesystem =
    overrides.inspectFilesystem ?? inspectNodeFilesystem;
  const probeCapabilities =
    overrides.probeCapabilities ?? probeNodeSqliteCapabilities;

  return Object.freeze({
    verify(config: SqliteStartupConfig): SqliteStartupReadiness {
      const configuredPath = validatePathValue(config?.databasePath);
      const databasePath = validateStateDirectory(configuredPath);
      let filesystem;
      try {
        filesystem = inspectFilesystem(dirname(databasePath));
      } catch (error) {
        if (error instanceof SqliteStartupError) {
          throw error;
        }
        throw new SqliteStartupError("FILESYSTEM_INSPECTION_FAILED");
      }
      assertLocalFilesystem(filesystem);
      ensureDatabaseFile(databasePath);

      let evidence;
      try {
        evidence = probeCapabilities(databasePath);
      } catch {
        throw new SqliteStartupError("SQLITE_CAPABILITY_CHECK_FAILED");
      }
      const capabilities = requireCapabilities(evidence);
      if (
        typeof evidence.sqliteVersion !== "string" ||
        evidence.sqliteVersion.length === 0
      ) {
        throw new SqliteStartupError("SQLITE_CAPABILITY_CHECK_FAILED");
      }

      return Object.freeze({
        databasePath,
        sqliteVersion: evidence.sqliteVersion,
        capabilities,
        localFilesystemOnly: true,
        filesystemType: `0x${(
          filesystem.type & UNSIGNED_FILESYSTEM_TYPE_MASK
        ).toString(16)}`,
        mountType: filesystem.mountType,
      });
    },
  });
}

const defaultSqliteStartupGate: SqliteStartupGate = createSqliteStartupGate();

export function runSqliteStartupGate(
  config: SqliteStartupConfig,
): SqliteStartupReadiness {
  return defaultSqliteStartupGate.verify(config);
}
