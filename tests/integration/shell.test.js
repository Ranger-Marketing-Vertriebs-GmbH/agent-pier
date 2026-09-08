import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  AccountStore,
  detectTools,
  resolveShell,
} from "../../server/features/accounts/account-store.js";
import { SessionManager } from "../../server/features/sessions/session-manager.js";
import { shellQuote } from "../../server/lib/launch-serialization.js";
const exec = promisify(execFile);
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-shell-"));
  const home = path.join(root, "home");
  fs.mkdirSync(home);
  const store = new AccountStore({ dataDir: path.join(root, "data"), home });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, home, store };
}
async function until(check, diagnostics = async () => "") {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  assert.fail(`Timed out waiting for isolated shell output: ${await diagnostics()}`);
}
async function exitDiagnostics(manager, id, marker) {
  const fields = await manager
    .tmux([
      "list-panes",
      "-t",
      `${manager.target(id)}:`,
      "-F",
      "#{pane_pid}|#{pane_dead}|#{pane_dead_status}|#{pane_dead_signal}|#{pane_dead_time}|#{pane_current_command}",
    ])
    .catch((error) => error.message);
  const markerValue = fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : null;
  const ids = [fields.split("|")[0], markerValue].filter(
    (value) => typeof value === "string" && /^[1-9]\d*$/.test(value),
  );
  const processes = ids.length
    ? await exec("ps", [
        "-o",
        "pid=,ppid=,stat=,comm=",
        "-p",
        [...new Set(ids)].join(","),
      ]).then(
        (result) => result.stdout,
        (error) => error.stdout || error.message,
      )
    : null;
  const screen = await manager.capture(id).catch((error) => error.message);
  return JSON.stringify({
    fields: "pid|dead|status|signal|dead_time|command",
    pane: fields,
    markerValue,
    processes,
    screen: screen.slice(-4096),
  });
}
test("shell detection prefers a valid user zsh/bash and safely falls back from arbitrary commands", (t) => {
  const { root } = fixture(t);
  const preferred = path.join(root, "zsh");
  fs.writeFileSync(preferred, "#!/bin/sh\n", { mode: 0o700 });
  assert.equal(
    detectTools({ PATH: "", HOME: root, SHELL: preferred }, false).find(
      (tool) => tool.id === "shell",
    )?.path,
    preferred,
  );
  for (const invalid of ["/bin/echo", "zsh", "/missing/zsh", `${preferred} -c echo`]) {
    const shell = detectTools({ PATH: "", HOME: root, SHELL: invalid }, false).find(
      (tool) => tool.id === "shell",
    );
    assert.equal(shell?.installed, true);
    assert.ok(
      [
        "/bin/zsh",
        "/usr/bin/zsh",
        "/bin/bash",
        "/usr/bin/bash",
        "/bin/sh",
        "/usr/bin/sh",
      ].includes(shell.path),
    );
  }
  fs.chmodSync(preferred, 0o600);
  assert.notEqual(
    detectTools({ PATH: "", SHELL: preferred }, false).find((tool) => tool.id === "shell")
      .path,
    preferred,
  );
});
test("portable shell selection falls back through zsh, bash and POSIX sh without installations", () => {
  for (const candidate of [
    "/bin/zsh",
    "/usr/bin/zsh",
    "/bin/bash",
    "/usr/bin/bash",
    "/bin/sh",
    "/usr/bin/sh",
  ])
    assert.equal(
      resolveShell({}, (file) => file === candidate),
      candidate,
    );
  assert.equal(
    resolveShell({ SHELL: "/opt/custom/sh" }, (file) =>
      ["/opt/custom/sh", "/bin/zsh"].includes(file),
    ),
    "/opt/custom/sh",
  );
  assert.equal(
    resolveShell({ SHELL: "/bin/echo" }, () => true),
    "/bin/zsh",
  );
  assert.equal(
    resolveShell({}, () => false),
    null,
  );
  assert.equal(
    resolveShell({}, (file) => ["/bin/bash", "/bin/sh"].includes(file)),
    "/bin/bash",
  );
});
test("shell uses a fixed local account with login-shell args and no coding credentials or profile paths", (t) => {
  const { store } = fixture(t);
  const shell = detectTools().find((tool) => tool.id === "shell");
  const account = store.get("local-shell");
  assert.equal(account.tool, "shell");
  assert.equal(account.kind, "local");
  assert.equal(account.hasSecret, false);
  assert.throws(() => store.create({ name: "Not managed", tool: "shell" }), {
    status: 400,
  });
  assert.throws(() => store.remove("local-shell"), { status: 400 });
  assert.throws(() => store.command("local-shell", { shell: shell.path }, true), {
    status: 400,
  });
  assert.throws(
    () => store.command("local-shell", { shell: shell.path }, false, "auto"),
    { status: 400 },
  );
  const old = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "fake-parent-secret";
  let launch;
  try {
    launch = store.command("local-shell", { shell: shell.path });
  } finally {
    if (old === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = old;
  }
  assert.deepEqual(launch.args, ["-l"]);
  assert.equal(launch.env.SHELL, shell.path);
  assert.equal(launch.env.HOME, store.home);
  assert.equal(launch.env.PATH, process.env.PATH);
  for (const key of [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "CODEX_HOME",
    "CLAUDE_CONFIG_DIR",
    "OPENCODE_CONFIG_CONTENT",
    "AGENTBUS_HOME",
  ])
    assert.equal(launch.env[key], undefined);
  assert.throws(() => store.command("local-shell", {}), { status: 409 });
});
test("isolated native and POSIX login shells support Unicode input, replay and restart without coding control", async (t) => {
  const { root, home, store } = fixture(t);
  const binary = resolveShell();
  const manager = new SessionManager({
    dataDir: path.join(root, "data"),
    tmuxPath: process.env.TMUX_PATH || "tmux",
  });
  const managers = [manager];
  let client;
  t.after(async () => {
    client?.dispose();
    for (const item of managers) await item.close();
    await exec(manager.tmuxPath, ["-S", manager.socketPath, "kill-server"]).catch(
      () => {},
    );
    fs.rmSync(path.dirname(manager.socketPath), { recursive: true, force: true });
  });
  const launch = store.command("local-shell", { shell: binary });
  const options = {
    id: "plain-shell",
    name: "Shell fixture",
    tool: "shell",
    accountId: "local-shell",
    cwd: home,
    ...launch,
    agentbus: { enabled: false },
    nativeBinding: { enabled: true, version: 1 },
    attachments: { directory: path.join(home, "attachments") },
  };
  for (const change of [
    { accountId: "managed-shell" },
    { purpose: "login" },
    { agentbus: { enabled: true } },
    { launchMode: "auto" },
  ])
    await assert.rejects(manager.create({ ...options, ...change }), { status: 400 });
  const session = await manager.create(options);
  assert.equal(session.tool, "shell");
  assert.equal(session.agentbus.enabled, false);
  assert.equal(session.nativeBinding, undefined);
  // Shell sessions never persist an attachments field: no model is involved,
  // so session-manager's `eligible` guard must drop it even when supplied.
  assert.equal(session.attachments, undefined);
  await assert.rejects(
    manager.control(session.id, () => assert.fail("Model control must never run")),
    { status: 409 },
  );
  let output = "";
  client = await manager.attach(session.id, {
    onData: (chunk) => {
      output += chunk;
    },
  });
  const sample = "Änderungen · 日本語 ❯";
  await client.write(`printf '\\nSHELL_UNICODE:%s\\n' '${sample}'\r`);
  await until(() => output.includes(`SHELL_UNICODE:${sample}`));
  await manager.input(session.id, "printf '\\nHOME_CHECK:%s\\n' \"$HOME\"", true);
  await until(async () =>
    (await manager.screen(session.id)).includes(`HOME_CHECK:${home}`),
  );
  client.dispose();
  await manager.close();
  const resumed = new SessionManager({
    dataDir: path.join(root, "data"),
    tmuxPath: manager.tmuxPath,
  });
  managers.push(resumed);
  assert.equal((await resumed.get(session.id)).status, "running");
  assert.match(await resumed.screen(session.id), /SHELL_UNICODE:Änderungen/);
  const nativeExitMarker = path.join(root, "native-shell-exit-requested");
  await resumed.input(
    session.id,
    `printf '%s' "$$" > ${shellQuote(nativeExitMarker)}; exit 0`,
    true,
  );
  await until(
    async () => (await resumed.get(session.id)).status === "stopped",
    () => exitDiagnostics(resumed, session.id, nativeExitMarker),
  );
  assert.equal((await resumed.get(session.id)).exitCode, 0);
  const posix = resolveShell(
    {},
    (file) => ["/bin/sh", "/usr/bin/sh"].includes(file) && fs.existsSync(file),
  );
  assert.ok(posix, "Unix POSIX sh exists");
  const fallback = await resumed.create({
    ...options,
    id: "posix-shell",
    ...store.command("local-shell", { shell: posix }),
  });
  const posixExitMarker = path.join(root, "posix-shell-exit-requested");
  await resumed.input(
    fallback.id,
    `printf '\\nPOSIX_OK:%s\\n' '日本語'; printf '%s' "$$" > ${shellQuote(posixExitMarker)}; exit 0`,
    true,
  );
  await until(
    async () => (await resumed.get(fallback.id)).status === "stopped",
    () => exitDiagnostics(resumed, fallback.id, posixExitMarker),
  );
  assert.match(await resumed.screen(fallback.id), /POSIX_OK:日本語/);
});
