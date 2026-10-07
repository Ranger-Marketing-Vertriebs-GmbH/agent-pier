import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildSessionLaunch } from "../../server/features/sessions/session-creation.js";
import { removeSession } from "../../server/features/sessions/session-removal.js";
import { validAdapterConfig, KEY } from "../helpers/adapter-fixture.js";

function manager(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-adapter-payload-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const saved = [];
  return {
    directory,
    saved,
    file: (id) => path.join(directory, `${id}.json`),
    save: async (session) => saved.push(session),
    // removeSession needs these five
    target: (id) => `tuiui-${id}`,
    serial: (fn) => fn(),
    current: async () => ({ status: "stopped" }),
    tmux: async () => {},
    onRemoving: async () => {},
  };
}
const options = (m, extra = {}) => ({
  name: "Adapter session",
  tool: "claude",
  accountId: "local-claude",
  cwd: m.directory,
  command: process.execPath,
  args: [],
  env: {},
  ...extra,
});

test("the adapter block reaches only the private launch payload", async (t) => {
  const m = manager(t);
  const adapter = validAdapterConfig({ diagnosticsPath: undefined });
  const { id, launchFile, session } = await buildSessionLaunch(
    m,
    options(m, { adapter }),
  );
  const payload = JSON.parse(fs.readFileSync(launchFile, "utf8"));
  assert.equal(payload.adapter.token, adapter.token);
  assert.equal(payload.adapter.upstream.apiKey, KEY);
  assert.equal(
    payload.adapter.diagnosticsPath,
    path.join(m.directory, `${id}.adapter.json`),
  );
  assert.equal(fs.statSync(launchFile).mode & 0o777, 0o600);
  assert.equal(JSON.stringify(session).includes(adapter.token), false);
  assert.equal(JSON.stringify(m.saved).includes(KEY), false);
  assert.equal(JSON.stringify(m.saved).includes(adapter.token), false);
});

test("an invalid adapter block is refused before anything is written", async (t) => {
  const m = manager(t);
  await assert.rejects(buildSessionLaunch(m, options(m, { adapter: { token: "x" } })), {
    status: 400,
  });
  assert.deepEqual(fs.readdirSync(m.directory), []);
});

test("session removal deletes the adapter diagnostics file", async (t) => {
  const m = manager(t);
  const id = "adapter-removal";
  for (const name of [`${id}.json`, `${id}.adapter.json`])
    fs.writeFileSync(path.join(m.directory, name), "{}");
  await removeSession(m, id);
  assert.deepEqual(fs.readdirSync(m.directory), []);
});
