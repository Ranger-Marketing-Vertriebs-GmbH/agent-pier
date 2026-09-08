import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AccountStore } from "../../server/features/accounts/account-store.js";
import { MemoryIntegration } from "../../server/features/memory/memory-integration.js";
for (const tool of ["codex", "claude", "opencode"])
  for (const profile of ["local", "managed"])
    for (const launchMode of ["default", "auto", "yolo"]) {
      test(`memory adapter preserves ${tool}/${profile}/${launchMode} native account launch`, async (t) => {
        const root = fs.realpathSync(
          fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-memory-matrix-")),
        );
        const home = path.join(root, "home");
        fs.mkdirSync(home);
        const dataDir = path.join(root, "data");
        const accounts = new AccountStore({ dataDir, home });
        const integration = new MemoryIntegration({ dataDir, accounts });
        t.after(() => {
          integration.close();
          fs.rmSync(root, { recursive: true, force: true });
        });
        const account =
          profile === "local"
            ? accounts.get(`local-${tool}`)
            : accounts.create({ name: "Memory fixture", tool });
        const command = () =>
          accounts.command(
            account.id,
            { [tool]: path.join(root, "inert-cli") },
            false,
            launchMode,
          );
        if (
          launchMode !== "default" &&
          launchMode !== (tool === "codex" ? "yolo" : "auto")
        ) {
          assert.throws(command, { status: 400 });
          assert.equal(integration.memory.projects().projects.length, 0);
          return;
        }
        const original = command();
        const before = structuredClone(original);
        const prepared = await integration.prepare({
          id: "matrix-session",
          account,
          cwd: home,
          launch: original,
        });
        assert.deepEqual(original, before);
        assert.equal(prepared.command, before.command);
        assert.deepEqual(prepared.args.slice(0, before.args.length), before.args);
        for (const [name, value] of Object.entries(before.env))
          if (name !== "OPENCODE_CONFIG_CONTENT") assert.equal(prepared.env[name], value);
        assert.equal(prepared.memory.enabled, true);
        assert.match(prepared.memory.projectId, /^[a-f0-9]{64}$/);
        assert.equal(JSON.stringify(prepared.memory).includes("capability"), false);
      });
    }
