import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ToolInstaller } from "../../server/features/tools/tool-installer.js";
import { toolBinDirectories } from "../../server/features/tools/tool-paths.js";
import {
  detectTools,
  AccountStore,
} from "../../server/features/accounts/account-store.js";
async function fixture(t, body) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-install-test-"));
  const home = path.join(dir, "home");
  await fs.mkdir(home);
  const npmCli = path.join(dir, "npm.js");
  await fs.writeFile(
    npmCli,
    body ||
      `const fs=require('node:fs'),path=require('node:path');const a=process.argv.slice(2),prefix=a[a.indexOf('--prefix')+1];const pkg=a.at(-1);const tool=pkg.startsWith('@openai/')?'codex':pkg.startsWith('@anthropic-ai/')?'claude':'opencode';fs.mkdirSync(path.join(prefix,'bin'),{recursive:true});fs.writeFileSync(path.join(prefix,'bin',tool),'#!'+process.execPath+'\\nconsole.log("1.2.3 fixture")\\n',{mode:0o700});fs.writeFileSync(path.join(prefix,'trace.json'),JSON.stringify({args:a,env:process.env}));`,
  );
  const detect = () =>
    detectTools({ PATH: "", HOME: home }, false, toolBinDirectories(dir));
  const installer = new ToolInstaller({
    dataDir: dir,
    home,
    npmCli,
    detect,
    timeout: 1500,
  });
  t.after(async () => {
    await installer.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { dir, home, npmCli, installer, detect };
}
async function finished(installer, tool) {
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    const job = installer.list().installations.find((x) => x.tool === tool);
    if (job.status !== "running") return job;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail("Installer did not finish");
}
for (const tool of ["codex", "claude", "opencode"])
  test(`${tool} install verifies executable and persists availability without global prefix`, async (t) => {
    const { dir, home, installer, detect } = await fixture(t);
    const started = installer.start(tool, "npm");
    assert.equal(started.status, "running");
    assert.throws(() => installer.start(tool, "npm"), /läuft/);
    const result = await finished(installer, tool);
    assert.equal(result.status, "succeeded");
    assert.match(result.version, /1\.2\.3/);
    assert.ok(detect().find((x) => x.id === tool).installed);
    const trace = JSON.parse(
      await fs.readFile(path.join(dir, "clis", tool, "trace.json"), "utf8"),
    );
    assert.ok(trace.args.includes("--global"));
    assert.ok(trace.args.includes("--include=optional"));
    assert.ok(trace.args.includes("--registry=https://registry.npmjs.org"));
    assert.notEqual(trace.args[trace.args.indexOf("--prefix") + 1], home);
    assert.equal(trace.env.NODE_OPTIONS, undefined);
    assert.equal(trace.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(trace.env.NPM_TOKEN, undefined);
    assert.throws(() => installer.start(tool, "npm"), /installiert/);
    const next = new ToolInstaller({
      dataDir: dir,
      home,
      detect,
      npmCli: path.join(dir, "npm.js"),
    });
    assert.equal(
      next.list().installations.find((x) => x.tool === tool).status,
      "succeeded",
    );
    await next.close();
    const account = new AccountStore({ dataDir: dir, home });
    assert.ok(
      account
        .environment("local-" + tool)
        .PATH.includes(path.join(dir, "clis", tool, "bin")),
    );
  });
test("unknown tools and preexisting destinations fail without running a command", async (t) => {
  const { dir, installer } = await fixture(t);
  assert.throws(() => installer.start("claude;echo hacked", "npm"), /Unbekannt/);
  await fs.mkdir(path.join(dir, "clis", "codex"), { recursive: true });
  await fs.writeFile(path.join(dir, "clis", "codex", "owned"), "keep");
  assert.throws(() => installer.start("codex", "npm"), /vorhanden/);
  assert.equal(
    await fs.readFile(path.join(dir, "clis", "codex", "owned"), "utf8"),
    "keep",
  );
});
test("exit zero without a working CLI is failure and only staging files are removed", async (t) => {
  const { dir, installer } = await fixture(t, 'console.log("fake success");');
  installer.start("claude", "npm");
  const result = await finished(installer, "claude");
  assert.equal(result.status, "failed");
  assert.match(result.message, /Prüfung|ausführbar/);
  assert.equal(await fs.stat(path.join(dir, "clis", "claude")).catch(() => null), null);
  assert.deepEqual(
    (await fs.readdir(path.join(dir, "clis"))).filter((x) => x.startsWith(".install-")),
    [],
  );
});
test("failed installer can be retried and nonzero exit is not success", async (t) => {
  const { installer, npmCli } = await fixture(t, "process.exit(7)");
  installer.start("codex", "npm");
  assert.equal((await finished(installer, "codex")).status, "failed");
  await fs.writeFile(npmCli, "process.exit(8)");
  assert.equal(installer.start("codex", "npm").status, "running");
  assert.equal((await finished(installer, "codex")).status, "failed");
});
test("shutdown aborts a pending installer and prevents new jobs", async (t) => {
  const { dir, installer } = await fixture(t, "setInterval(()=>{},1000)");
  installer.start("opencode", "npm");
  await new Promise((r) => setTimeout(r, 80));
  await installer.close();
  assert.equal(
    installer.list().installations.find((x) => x.tool === "opencode").status,
    "failed",
  );
  assert.throws(() => installer.start("codex", "npm"), /beendet/);
  assert.deepEqual(
    (await fs.readdir(path.join(dir, "clis"))).filter((x) => x.startsWith(".install-")),
    [],
  );
});
test("missing npm exposes a manual setup reason without accepting an install", async (t) => {
  const { dir, home, detect } = await fixture(t);
  const installer = new ToolInstaller({ dataDir: dir, home, detect, npmCli: null });
  assert.equal(installer.list().installations[0].available, true);
  assert.equal(installer.list().installations[0].reason, null);
  assert.throws(() => installer.start("codex", "npm"), /npm/);
  await installer.close();
});
test("real npm accepts the isolated user/global configuration without downloading packages", async (t) => {
  const { dir, installer } = await fixture(t);
  installer.start("codex", "npm");
  assert.equal((await finished(installer, "codex")).status, "succeeded");
  const trace = JSON.parse(
    await fs.readFile(path.join(dir, "clis/codex/trace.json"), "utf8"),
  );
  assert.notEqual(trace.env.NPM_CONFIG_USERCONFIG, trace.env.NPM_CONFIG_GLOBALCONFIG);
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const npm = await fs
    .realpath(path.join(path.dirname(process.execPath), "npm"))
    .catch(() => null);
  if (!npm) {
    t.skip("npm is not installed next to node");
    return;
  }
  const staging = path.dirname(trace.env.NPM_CONFIG_USERCONFIG);
  await fs.mkdir(staging, { recursive: true });
  await fs.writeFile(trace.env.NPM_CONFIG_USERCONFIG, "");
  await fs.writeFile(trace.env.NPM_CONFIG_GLOBALCONFIG, "");
  const options = trace.args.slice(1, -1);
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [npm, "config", "get", "prefix", ...options],
    { env: trace.env, cwd: staging, timeout: 10000 },
  );
  assert.equal(stdout.trim(), trace.args[trace.args.indexOf("--prefix") + 1]);
});
test("installed npm wrappers can find Node in a session with a minimal service PATH", async (t) => {
  const { dir, home, installer } = await fixture(t);
  installer.start("codex", "npm");
  assert.equal((await finished(installer, "codex")).status, "succeeded");
  const binary = path.join(dir, "clis/codex/bin/codex");
  await fs.writeFile(binary, '#!/usr/bin/env node\nconsole.log("fixture works")\n', {
    mode: 0o700,
  });
  const saved = process.env.PATH;
  let env;
  try {
    process.env.PATH = "/usr/bin:/bin";
    env = new AccountStore({ dataDir: dir, home }).environment("local-codex");
  } finally {
    process.env.PATH = saved;
  }
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  assert.equal(
    (await promisify(execFile)(binary, [], { env, timeout: 10000 })).stdout.trim(),
    "fixture works",
  );
});
