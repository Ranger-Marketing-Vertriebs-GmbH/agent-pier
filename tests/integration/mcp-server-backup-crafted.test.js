import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Backup } from "../../server/features/operations/backup.js";
import { Restore } from "../../server/features/operations/restore.js";
import {
  decryptCredentials,
  encryptCredentials,
} from "../../server/features/operations/archive.js";
import { loadArchive, encodeArchiveV2 } from "../helpers/backup-archive.js";
import { fileMember } from "../../server/features/operations/snapshot.js";
import { McpServerStore } from "../../server/features/mcp-servers/mcp-server-store.js";
import { serverMessages } from "../../server/lib/i18n/de.js";
import { backupPassphrase as passphrase, rows } from "../helpers/mcp-store-backup.js";

const sealedPath = "mcp-server-secrets/servers.json";

/** A credentials backup of one header server with an address token. */
async function backup(t) {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mcp-crafted-")));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const dataDir = path.join(folder, "data");
  fs.mkdirSync(dataDir, { mode: 0o700 });
  const servers = new McpServerStore({ dataDir, pathEnv: "/fake/bin" });
  const docs = servers.create({
    name: "docs",
    transport: "http",
    url: "https://mcp.example.test/v1?token=abc",
    headers: { Authorization: "Bearer abc" },
  });
  servers.close();
  const { file } = await new Backup({ dataDir }).create({
    includeHistory: false,
    withCredentials: true,
    passphrase,
  });
  const archive = loadArchive(file);
  const members = await decryptCredentials(archive.credentials, passphrase);
  const sealed = JSON.parse(
    Buffer.from(members.find((m) => m.path === sealedPath).content, "base64"),
  );
  return { folder, dataDir, docs, archive, members, sealed };
}
/** The archive with its sealed member replaced by `content` (bytes or a value). */
async function crafted({ archive, members }, content, { files } = {}) {
  const replaced = members.map((m) =>
    m.path === sealedPath
      ? fileMember(
          sealedPath,
          typeof content === "string" ? Buffer.from(content) : content,
        )
      : m,
  );
  return encodeArchiveV2({
    ...archive,
    ...(files ? { files } : {}),
    credentials: await encryptCredentials(replaced, passphrase),
  });
}
async function refused(context, bytes, message) {
  const target = path.join(context.folder, "restored");
  await assert.rejects(
    new Restore({ dataDir: context.dataDir }).apply({
      archive: bytes,
      targetDataDir: target,
      passphrase,
    }),
    { message },
  );
  assert.equal(fs.existsSync(target), false);
  assert.deepEqual(
    fs
      .readdirSync(context.folder)
      .filter((name) => name.startsWith(".agentpier-restore")),
    [],
  );
}
const restore = (context, bytes) =>
  new Restore({ dataDir: context.dataDir }).apply({
    archive: bytes,
    targetDataDir: path.join(context.folder, "restored"),
    passphrase,
  });

test("a restore refuses sealed MCP values the store itself would refuse", async (t) => {
  const context = await backup(t);
  const { docs, sealed } = context;
  const server = (extra) => ({
    ...sealed,
    servers: [{ ...sealed.servers[0], ...extra }],
  });
  const secret = (s) => server({ secrets: [s] });
  const variants = {
    notJson: "not json",
    noServers: { version: 1 },
    unknownServer: { ...sealed, servers: [{ id: "nope", secrets: [] }] },
    duplicateServer: { ...sealed, servers: [sealed.servers[0], sealed.servers[0]] },
    crlfHeaderName: secret({ kind: "header", name: "A\r\nX", value: "1" }),
    newlineValue: secret({ kind: "header", name: "A", value: "1\n2" }),
    longValue: secret({ kind: "header", name: "A", value: "x".repeat(16385) }),
    badEnvName: secret({ kind: "env", name: "1BAD", value: "1" }),
    badKind: secret({ kind: "cookie", name: "A", value: "1" }),
    protoHeaderCrlf: secret({ kind: "header", name: "__proto__", value: "x\r\ny" }),
    protoEnvNumber: secret({ kind: "env", name: "__proto__", value: 5 }),
    numberValue: secret({ kind: "header", name: "A", value: 5 }),
    constructorName: secret({ kind: "env", name: "constructor", value: "1" }),
    tooMany: server({
      secrets: Array.from({ length: 101 }, (_, i) => ({
        kind: "header",
        name: `H${i}`,
        value: "1",
      })),
    }),
    badCliEntry: { ...sealed, cliEntries: [{ serverId: docs.id, cli: "vim" }] },
  };
  for (const [name, content] of Object.entries(variants))
    await t.test(name, async () =>
      refused(
        context,
        await crafted(context, content),
        serverMessages.backups.invalidMcpServerValues,
      ),
    );
});

test("a sealed member without the public store, or a store without its tables, is refused", async (t) => {
  const context = await backup(t);
  const withoutStore = context.archive.files.filter(
    (m) => m.path !== "mcp-servers/servers.sqlite",
  );
  await refused(
    context,
    await crafted(context, context.sealed, { files: withoutStore }),
    serverMessages.backups.invalidMcpServerStore,
  );
  const empty = path.join(context.folder, "empty.sqlite");
  const db = new DatabaseSync(empty);
  db.exec("CREATE TABLE unrelated(a)");
  db.close();
  const files = context.archive.files.map((m) =>
    m.path === "mcp-servers/servers.sqlite"
      ? fileMember(m.path, fs.readFileSync(empty))
      : m,
  );
  await refused(
    context,
    await crafted(context, context.sealed, { files }),
    serverMessages.backups.invalidMcpServerStore,
  );
});

test("an address the store would not accept is left out and reported, not fatal", async (t) => {
  const context = await backup(t);
  const { sealed } = context;
  const bytes = await crafted(context, {
    ...sealed,
    servers: [{ ...sealed.servers[0], url: "file:///etc/passwd" }],
  });
  const report = await restore(context, bytes);
  assert.deepEqual(
    report.credentialsNeedingLogin.filter((item) => item.startsWith("mcp")),
    ["mcp-address:docs"],
  );
  const store = path.join(context.folder, "restored/mcp-servers/servers.sqlite");
  assert.deepEqual(rows(store, "SELECT url FROM servers"), [
    { url: "https://mcp.example.test/v1" },
  ]);
  assert.deepEqual(rows(store, "SELECT name,value FROM server_secrets"), [
    { name: "Authorization", value: "Bearer abc" },
  ]);
});

test("an address that percent-encoding grew past the input limit restores as stored", async (t) => {
  const context = await backup(t);
  const { sealed } = context;
  // 4000 characters in, a longer normalized href in the store.
  const url = new URL(`https://mcp.example.test/v1?q=${'"'.repeat(3960)}`).href;
  assert.ok(url.length > 4096);
  const report = await restore(
    context,
    await crafted(context, { ...sealed, servers: [{ ...sealed.servers[0], url }] }),
  );
  assert.deepEqual(
    report.credentialsNeedingLogin.filter((item) => item.startsWith("mcp")),
    [],
  );
  const store = path.join(context.folder, "restored/mcp-servers/servers.sqlite");
  assert.deepEqual(rows(store, "SELECT url FROM servers"), [{ url }]);
});
