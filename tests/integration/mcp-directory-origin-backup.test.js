import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Backup } from "../../server/features/operations/backup.js";
import { Restore } from "../../server/features/operations/restore.js";
import { McpServerStore } from "../../server/features/mcp-servers/mcp-server-store.js";
import { loadArchive, encodeArchiveV2 } from "../helpers/backup-archive.js";
import { fileMember } from "../../server/features/operations/snapshot.js";

const storeMember = "mcp-servers/servers.sqlite";
const origin = { name: "ai.smithery/docs", version: "1.2.0" };

/** A public backup of one HTTP server created from the directory. */
async function backup(t) {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mcp-origin-")));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const dataDir = path.join(folder, "data");
  fs.mkdirSync(dataDir, { mode: 0o700 });
  const servers = new McpServerStore({ dataDir, pathEnv: "/fake/bin" });
  const created = servers.create({
    name: "docs",
    transport: "http",
    url: "https://mcp.example.test/mcp",
    directoryOrigin: origin,
  });
  servers.close();
  const { file } = await new Backup({ dataDir }).create({ includeHistory: false });
  return { folder, dataDir, file, created };
}

const restored = async (context, archive, name) => {
  const target = path.join(context.folder, name);
  await new Restore({ dataDir: context.dataDir }).apply({
    archive,
    targetDataDir: target,
  });
  return new McpServerStore({ dataDir: target, pathEnv: "/fake/bin" });
};

test("the directory origin is part of the public backup and comes back", async (t) => {
  const context = await backup(t);
  const servers = await restored(context, context.file, "restored");
  t.after(() => servers.close());
  assert.deepEqual(servers.get(context.created.id).directoryOrigin, origin);
});

test("a crafted directory origin is dropped on restore", async (t) => {
  const context = await backup(t);
  const archive = loadArchive(context.file);
  const values = ['{"name":"x","version":"1"}', "not json", '{"name":"a/b"}', "[]"];
  for (const [index, value] of values.entries()) {
    const files = archive.files.map((member) => {
      if (member.path !== storeMember) return member;
      const scratch = path.join(context.folder, `crafted-${index}.sqlite`);
      fs.writeFileSync(scratch, Buffer.from(member.content, "base64"));
      const db = new DatabaseSync(scratch);
      db.prepare("UPDATE servers SET directory_origin=?").run(value);
      db.close();
      return fileMember(storeMember, fs.readFileSync(scratch));
    });
    const bytes = await encodeArchiveV2({ ...archive, files });
    const servers = await restored(context, bytes, `restored-${index}`);
    const server = servers.get(context.created.id);
    assert.equal(server.directoryOrigin, undefined, value);
    assert.equal(server.name, "docs", value);
    const raw = servers.db.prepare("SELECT directory_origin FROM servers").get();
    assert.equal(raw.directory_origin, null, value);
    servers.close();
  }
});
