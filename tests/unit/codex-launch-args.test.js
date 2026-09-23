import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse } from "smol-toml";
import { remoteLaunchArgs } from "../../server/features/requests/codex-launch-args.js";
import { appServerArgs } from "../../server/features/requests/codex-launch.js";

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ap-codex-args-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  return { env: { CODEX_HOME: home }, cwd: home };
}
for (const resume of [false, true]) {
  test(`remote Codex moves attachment grants to the server (resume: ${resume})`, async (t) => {
    const options = await fixture(t);
    const directory = path.join(options.cwd, 'attachments "quoted"');
    const before = [
      "-c",
      'sandbox_mode="workspace-write"',
      "--add-dir",
      directory,
      ...(resume ? ["resume", "thread-id"] : []),
    ];
    const result = remoteLaunchArgs(before, options);
    assert.deepEqual(result.terminal, [
      "-c",
      'sandbox_mode="workspace-write"',
      ...(resume ? ["resume", "thread-id"] : []),
    ]);
    const server = appServerArgs([...result.terminal, ...result.overrides]);
    assert.equal(server.includes("--add-dir"), false);
    assert.deepEqual(parse(result.overrides[1]).sandbox_workspace_write.writable_roots, [
      directory,
    ]);
    assert.ok(server.includes(result.overrides[1]));
    assert.ok(server.includes('sandbox_mode="workspace-write"'));
    assert.ok(before.includes("--add-dir"));
  });
}
test("existing configured roots and explicit root overrides survive additional grants", async (t) => {
  const options = await fixture(t);
  await fs.writeFile(
    path.join(options.env.CODEX_HOME, "config.toml"),
    '[sandbox_workspace_write]\nwritable_roots=["/existing"]\nnetwork_access=false\n',
  );
  let result = remoteLaunchArgs(
    ["--add-dir=relative", "--add-dir", "relative", "-c", "model=unquoted-model"],
    options,
  );
  assert.deepEqual(parse(result.overrides[1]).sandbox_workspace_write.writable_roots, [
    "/existing",
    path.join(options.cwd, "relative"),
  ]);
  result = remoteLaunchArgs(
    [
      '--config=sandbox_workspace_write.writable_roots=["/override"]',
      "--add-dir",
      "/extra",
    ],
    options,
  );
  assert.deepEqual(parse(result.overrides[1]).sandbox_workspace_write.writable_roots, [
    "/override",
    "/extra",
  ]);
});
test("launches without grants and literal prompts retain their existing arguments", async (t) => {
  const options = await fixture(t);
  const args = [
    "--dangerously-bypass-approvals-and-sandbox",
    "--model",
    "--add-dir",
    "--",
    "--add-dir",
    "literal prompt",
  ];
  assert.deepEqual(remoteLaunchArgs(args, options), { terminal: args, overrides: [] });
  assert.throws(() => remoteLaunchArgs(["--add-dir"], options), /Missing/);
});
