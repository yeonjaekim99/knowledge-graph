#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";

import Database from "better-sqlite3";
import {
  McpServer,
  createMcpHandler,
  fromJsonSchema,
} from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

const require = createRequire(import.meta.url);
const DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema";
const MCP_PROTOCOL_VERSION = "2026-07-28";
const EXPECTED_VERSIONS = {
  "@modelcontextprotocol/server": "2.0.0",
  "better-sqlite3": "13.0.3",
  typescript: "7.0.2",
};
const EXPECTED_NATIVE_TARGETS = [
  "darwin-arm64.node",
  "darwin-x64.node",
  "linux-arm64.node",
  "linux-x64.node",
  "linuxmusl-arm64.node",
  "linuxmusl-x64.node",
  "win32-arm64.node",
  "win32-x64.node",
];

function packageRoot(packageName) {
  let current = dirname(require.resolve(packageName));
  const filesystemRoot = parse(current).root;

  while (current !== filesystemRoot) {
    const manifest = join(current, "package.json");
    if (existsSync(manifest)) {
      const parsed = JSON.parse(readFileSync(manifest, "utf8"));
      if (parsed.name === packageName) {
        return current;
      }
    }
    current = dirname(current);
  }

  throw new Error(`package root not found: ${packageName}`);
}

function packageManifest(packageName) {
  return JSON.parse(
    readFileSync(join(packageRoot(packageName), "package.json"), "utf8"),
  );
}

function verifyRuntimeAndPackages() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  assert.equal(major, 24, "FND-001 supports the Node.js 24 LTS line only");
  assert.ok(minor >= 19, "Node.js 24.19.0 or newer is required");

  const rootManifest = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(rootManifest.packageManager, "pnpm@11.22.0");

  for (const [packageName, expectedVersion] of Object.entries(
    EXPECTED_VERSIONS,
  )) {
    assert.equal(packageManifest(packageName).version, expectedVersion);
  }

  assert.equal(typeof serveStdio, "function");

  const driverRoot = packageRoot("better-sqlite3");
  const nativeTargets = readdirSync(join(driverRoot, "prebuilds"))
    .filter((name) => name.endsWith(".node"))
    .sort();
  assert.deepEqual(nativeTargets, EXPECTED_NATIVE_TARGETS);

  const workspacePolicy = readFileSync(
    new URL("../pnpm-workspace.yaml", import.meta.url),
    "utf8",
  );
  assert.match(workspacePolicy, /allowBuilds:\n  better-sqlite3: false(?:\n|$)/);

  return nativeTargets;
}

function verifySqlite() {
  const memory = new Database(":memory:");
  let sqliteVersion;

  try {
    sqliteVersion = memory.prepare("SELECT sqlite_version() AS version").get()
      .version;
    assert.equal(
      memory
        .prepare("SELECT sqlite_compileoption_used('ENABLE_FTS5') AS enabled")
        .get().enabled,
      1,
    );
    assert.equal(
      memory
        .prepare("SELECT json_extract('{\"ready\":true}', '$.ready') AS ready")
        .get().ready,
      1,
    );
    assert.equal(
      memory
        .prepare(
          "SELECT unixepoch('2026-08-21T00:00:00Z') AS epoch_seconds",
        )
        .get().epoch_seconds,
      1_787_270_400,
    );

    memory.exec(
      "CREATE VIRTUAL TABLE recall_fts USING fts5(value, content='', tokenize='trigram')",
    );
    memory
      .prepare("INSERT INTO recall_fts(rowid, value) VALUES (?, ?)")
      .run(1, "인증서버");
    assert.deepEqual(
      memory
        .prepare("SELECT rowid FROM recall_fts WHERE recall_fts MATCH ?")
        .all("인증서")
        .map(({ rowid }) => Number(rowid)),
      [1],
    );
  } finally {
    memory.close();
  }

  const scratch = mkdtempSync(join(tmpdir(), "recall-fnd-001-"));
  const databasePath = join(scratch, "recall.db");
  const writer = new Database(databasePath, { timeout: 5_000 });
  let reader;

  try {
    assert.equal(writer.pragma("journal_mode = WAL", { simple: true }), "wal");
    writer.pragma("synchronous = NORMAL");
    writer.pragma("busy_timeout = 5000");
    writer.pragma("foreign_keys = ON");
    assert.equal(writer.pragma("busy_timeout", { simple: true }), 5_000);
    assert.equal(writer.pragma("foreign_keys", { simple: true }), 1);

    writer.exec("CREATE TABLE tx_probe(value TEXT NOT NULL)");
    const rollback = writer.transaction(() => {
      assert.equal(writer.inTransaction, true);
      writer.prepare("INSERT INTO tx_probe VALUES (?)").run("rollback");
      throw new Error("intentional rollback");
    });
    assert.throws(rollback, /intentional rollback/);
    assert.equal(
      writer.prepare("SELECT COUNT(*) AS count FROM tx_probe").get().count,
      0,
    );

    writer.transaction(() => {
      writer.prepare("INSERT INTO tx_probe VALUES (?)").run("commit");
    })();
    assert.equal(writer.inTransaction, false);

    reader = new Database(databasePath, { readonly: true });
    assert.equal(reader.pragma("journal_mode", { simple: true }), "wal");
    assert.equal(
      reader.prepare("SELECT COUNT(*) AS count FROM tx_probe").get().count,
      1,
    );
  } finally {
    reader?.close();
    writer.close();
    rmSync(scratch, { recursive: true, force: true });
  }

  return sqliteVersion;
}

function objectSchema(property) {
  return {
    $schema: DRAFT_2020_12,
    type: "object",
    properties: { [property]: { type: "string" } },
    required: [property],
    additionalProperties: false,
  };
}

function modernRequest(id, method, params = {}, headers = {}) {
  const metadata = {
    "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
    "io.modelcontextprotocol/clientInfo": {
      name: "recall-fnd-001-probe",
      version: "0.0.0",
    },
    "io.modelcontextprotocol/clientCapabilities": {},
  };

  return new Request("http://localhost/mcp", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "mcp-method": method,
      "mcp-protocol-version": MCP_PROTOCOL_VERSION,
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params: { ...params, _meta: metadata },
    }),
  });
}

async function post(handler, request) {
  const response = await handler.fetch(request);
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body;
}

async function verifyMcp() {
  const inputSchema = objectSchema("value");
  const outputSchema = objectSchema("echo");
  const handler = createMcpHandler(
    () => {
      const server = new McpServer({
        name: "recall-fnd-001-probe",
        version: "0.0.0",
      });
      server.registerTool(
        "memory_probe",
        {
          description: "FND-001 compatibility probe",
          inputSchema: fromJsonSchema(inputSchema),
          outputSchema: fromJsonSchema(outputSchema),
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
        },
        async ({ value }) => {
          const result = { echo: value };
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
            structuredContent: result,
          };
        },
      );
      return server;
    },
    { legacy: "reject" },
  );

  try {
    const discover = await post(
      handler,
      modernRequest(1, "server/discover"),
    );
    assert.deepEqual(discover.result.supportedVersions, [MCP_PROTOCOL_VERSION]);
    assert.equal(discover.result.resultType, "complete");

    const list = await post(handler, modernRequest(2, "tools/list"));
    const tool = list.result.tools.find(({ name }) => name === "memory_probe");
    assert.ok(tool);
    assert.equal(tool.inputSchema.$schema, DRAFT_2020_12);
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.equal(tool.outputSchema.$schema, DRAFT_2020_12);
    assert.equal(tool.outputSchema.additionalProperties, false);
    assert.deepEqual(tool.annotations, {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });

    const call = await post(
      handler,
      modernRequest(
        3,
        "tools/call",
        { name: "memory_probe", arguments: { value: "ok" } },
        { "mcp-name": "memory_probe" },
      ),
    );
    assert.equal(call.result.resultType, "complete");
    assert.deepEqual(call.result.structuredContent, { echo: "ok" });
    assert.deepEqual(call.result.content, [
      { type: "text", text: '{"echo":"ok"}' },
    ]);
  } finally {
    await handler.close();
  }
}

const nativeTargets = verifyRuntimeAndPackages();
const sqliteVersion = verifySqlite();
await verifyMcp();

console.log(
  JSON.stringify(
    {
      status: "PASS",
      node: process.versions.node,
      packageManager: "pnpm@11.22.0",
      typescript: EXPECTED_VERSIONS.typescript,
      mcp: {
        package: `@modelcontextprotocol/server@${EXPECTED_VERSIONS["@modelcontextprotocol/server"]}`,
        protocol: MCP_PROTOCOL_VERSION,
        jsonSchema: "2020-12",
        structuredContent: true,
      },
      sqlite: {
        driver: `better-sqlite3@${EXPECTED_VERSIONS["better-sqlite3"]}`,
        library: sqliteVersion,
        fts5Trigram: true,
        json: true,
        unixepoch: true,
        wal: true,
        transactions: true,
      },
      nativeTargets,
    },
    null,
    2,
  ),
);
