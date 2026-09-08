import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath, pathToFileURL } from "node:url";
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-main-entry-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const alias = path.join(root, "current"),
    dataDir = path.join(root, "data");
  await fs.symlink(project, alias);
  await fs.mkdir(dataDir);
  const env = {
    PATH: "/usr/bin:/bin",
    HOME: root,
    AGENTPIER_DATA_DIR: dataDir,
    AGENTPIER_TAILSCALE_SOCKET: "invalid-relative-socket",
  };
  return { root, alias, env };
}
test("CLI entrypoints execute through symlinked release paths with inert invalid arguments", async (t) => {
  const { alias, root, env } = await fixture(t);
  for (const [file, args, pattern] of [
    ["scripts/release-install.mjs", ["--invalid"], /Invalid installer option/],
    ["scripts/service.mjs", ["invalid"], /install|status|stop/],
    ["scripts/tailscale.mjs", [], /socket must be an absolute path/],
    [
      "scripts/release-package.mjs",
      [path.join(root, "missing/output.aprelease")],
      /ENOENT/,
    ],
    ["scripts/release-manifest.mjs", [root], /No packaged releases/],
    [
      "server/features/operations/release-helper.js",
      [path.join(root, "absent.json")],
      /runReleaseHelper/,
    ],
    [
      "server/features/requests/codex-launch.js",
      [path.join(root, "absent.json")],
      /Unable to start/,
    ],
  ]) {
    const child = spawnSync(process.execPath, [path.join(alias, file), ...args], {
      env,
      encoding: "utf8",
      timeout: 5000,
    });
    assert.notEqual(child.status, 0, `${file} must execute its main function`);
    assert.match(child.stderr, pattern, file);
  }
});
test("operations doctor runs through a symlink without starting a service", async (t) => {
  const { alias, env } = await fixture(t);
  const child = spawnSync(
    process.execPath,
    [path.join(alias, "scripts/operations.mjs"), "doctor"],
    { env, encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024 },
  );
  const report = JSON.parse(child.stdout);
  assert.ok(report.checks.some((check) => check.id === "platform"));
  assert.ok(report.checks.some((check) => check.id === "listener"));
});
test("native hook entrypoints keep their stdin protocol active through a symlink", async (t) => {
  const { alias, env } = await fixture(t);
  for (const [file, args] of [
    ["server/native-session-binding.js", ["--record"]],
    ["server/features/sessions/native-session-binding.js", ["--record"]],
    ["server/github-credentials.js", ["--git-credential", "get"]],
    ["server/features/repositories/github-credentials.js", ["--git-credential", "get"]],
    ["server/features/requests/claude-hook.js", []],
  ]) {
    const child = spawn(process.execPath, [path.join(alias, file), ...args], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    t.after(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    });
    child.stdout.resume();
    child.stderr.resume();
    child.stdin.on("error", () => {});
    const completed = once(child, "exit");
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(child.exitCode, null, `${file} must wait for its native stdin payload`);
    child.stdin.end(
      file.includes("github-credentials") ? "protocol=http\nhost=invalid\n\n" : "{}",
    );
    assert.equal((await completed)[0], 0, file);
  }
});
test("importing symlinked executable modules remains inert and extra helper flags stay required", async (t) => {
  const { alias, env } = await fixture(t);
  const files = [
    "scripts/release-install.mjs",
    "scripts/release-package.mjs",
    "scripts/release-manifest.mjs",
    "scripts/operations.mjs",
    "scripts/service.mjs",
    "scripts/tailscale.mjs",
    "server/native-session-binding.js",
    "server/github-credentials.js",
    "server/features/sessions/native-session-binding.js",
    "server/features/repositories/github-credentials.js",
    "server/features/requests/claude-hook.js",
    "server/features/requests/codex-launch.js",
    "server/features/operations/release-helper.js",
  ];
  const code =
    files
      .map(
        (file) =>
          `await import(${JSON.stringify(pathToFileURL(path.join(alias, file)).href)});`,
      )
      .join("\n") + '\nconsole.log("imports-only");';
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    env,
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, "imports-only\n");
  for (const file of [
    "server/native-session-binding.js",
    "server/github-credentials.js",
  ]) {
    const inert = spawnSync(process.execPath, [path.join(alias, file)], {
      env,
      encoding: "utf8",
      timeout: 3000,
    });
    assert.equal(inert.status, 0);
    assert.equal(inert.stdout, "");
    assert.equal(inert.stderr, "");
  }
});
