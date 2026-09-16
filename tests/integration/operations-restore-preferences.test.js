import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Backup } from "../../server/features/operations/backup.js";
import { Restore } from "../../server/features/operations/restore.js";
import { ProjectMemory } from "../../server/features/memory/project-memory.js";

for (const mapped of [false, true]) {
  test(`restore preserves eligible default accounts with project mapping ${mapped}`, async (t) => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "restore-preferences-")),
    );
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const source = path.join(root, "source"),
      target = path.join(root, "target");
    const project = path.join(root, "project"),
      destination = path.join(root, "destination");
    await fs.mkdir(project);
    await fs.mkdir(destination);
    const memory = new ProjectMemory({ dataDir: source });
    t.after(() => memory.close());
    const scope = await memory.register(project);
    await fs.writeFile(
      path.join(source, "accounts.json"),
      JSON.stringify([
        { id: "codex-default", tool: "codex", kind: "managed" },
        { id: "claude-default", tool: "claude", kind: "local" },
        { id: "opencode-default", tool: "opencode", kind: "managed" },
      ]),
    );
    const defaultAccountIds = {
      codex: "codex-default",
      claude: "claude-default",
      opencode: "opencode-default",
    };
    await fs.writeFile(
      path.join(source, "preferences.json"),
      JSON.stringify({ defaultCwd: scope.cwd, defaultAccountIds }),
    );
    const backup = await new Backup({ dataDir: source, home: root }).create();
    await new Restore({ dataDir: source }).apply({
      archive: backup.file,
      targetDataDir: target,
      projectMap: mapped ? { [scope.id]: destination } : {},
    });
    const restored = JSON.parse(await fs.readFile(path.join(target, "preferences.json")));
    assert.deepEqual(restored.defaultAccountIds, defaultAccountIds);
    assert.equal(restored.defaultCwd, mapped ? destination : undefined);
  });
}

for (const account of [
  null,
  { tool: "claude", kind: "managed" },
  { tool: "codex", kind: "remote" },
  { tool: "codex", kind: "managed", provider: "openai" },
  { tool: "codex", kind: "managed", internal: true },
]) {
  test(`restore filters an ineligible saved account ${JSON.stringify(account)}`, async (t) => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "restore-default-")),
    );
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const source = path.join(root, "source"),
      target = path.join(root, "target");
    await fs.mkdir(source);
    await fs.writeFile(
      path.join(source, "accounts.json"),
      JSON.stringify(account ? [{ id: "default", ...account }] : []),
    );
    await fs.writeFile(
      path.join(source, "preferences.json"),
      JSON.stringify({ defaultAccountIds: { codex: "default" } }),
    );
    const backup = await new Backup({ dataDir: source, home: root }).create();
    await new Restore({ dataDir: source }).apply({
      archive: backup.file,
      targetDataDir: target,
    });
    assert.deepEqual(
      JSON.parse(await fs.readFile(path.join(target, "preferences.json")))
        .defaultAccountIds,
      {},
    );
  });
}
