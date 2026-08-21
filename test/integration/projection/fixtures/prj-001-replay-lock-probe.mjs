import Database from "better-sqlite3";

const [databasePath, scopeKey] = process.argv.slice(2);
if (databasePath === undefined || scopeKey === undefined) {
  process.exitCode = 2;
} else {
  const reader = new Database(databasePath, {
    readonly: true,
    fileMustExist: true,
  });
  const oldProjectionCount = Number(
    reader
      .prepare("SELECT COUNT(*) AS count FROM entities WHERE scope_key = ?")
      .get(scopeKey).count,
  );
  reader.close();

  const writer = new Database(databasePath, {
    readonly: false,
    fileMustExist: true,
    timeout: 0,
  });
  let writeCode = null;
  try {
    writer.exec("BEGIN IMMEDIATE");
    writer.exec("ROLLBACK");
  } catch (error) {
    writeCode = error?.code ?? "UNKNOWN";
  } finally {
    writer.close();
  }

  process.stdout.write(JSON.stringify({ oldProjectionCount, writeCode }));
}
