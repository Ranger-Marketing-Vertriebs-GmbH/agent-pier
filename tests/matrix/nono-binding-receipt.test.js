// test-runner-timeout-ms: 300000
// Starts a real sandbox and child processes: its own timeout class under load
// (scripts/test-runner.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  wrapWithNono,
  INSTALLATION_ROOT,
} from "../../server/features/nono/nono-launch.js";
import { AccountStore } from "../../server/features/accounts/account-store.js";
import { RequestBroker } from "../../server/features/requests/request-broker.js";
import { NativeSessionBinding } from "../../server/features/sessions/native-session-binding.js";
import { resolveAgentBusProcess } from "../../server/features/agentbus/agentbus-process.js";

/**
 * A sandboxed session's binding receipt, through a real nono. On macOS nono denies
 * the setuid `ps`, so the session's hook cannot name the CLI process and its start;
 * it asks the server over the request channel, and the server reads both from
 * outside (native-session-binding.js, `claim`). The stand-in CLI is Node running a
 * script that starts the real hook the way Claude Code does. Skipped without the
 * binary, like nono-confinement.test.js.
 */
function nonoExecutable() {
  for (const directory of (process.env.PATH || "").split(path.delimiter).filter(Boolean))
    try {
      const candidate = path.join(directory, "nono");
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {}
  return null;
}
const executable = nonoExecutable();
const reason = !executable
  ? "nono is not installed"
  : !["darwin", "linux"].includes(process.platform)
    ? `nono does not support ${process.platform}`
    : null;
const options = reason ? { skip: reason } : {};

const restrictive = {
  meta: { name: "agentpier-binding-receipt" },
  groups: { include: ["system_read_macos", "system_read_linux_core"], exclude: [] },
  workdir: { access: "readwrite" },
  filesystem: { allow: [], read: [], write: [], deny: [] },
  network: { block: false },
};

// The stand-in CLI: runs the hook command with a SessionStart payload on its stdin,
// reports how it ended and whether `ps` can be run, then stays until stdin closes.
const cli = `
import { spawn, spawnSync } from "node:child_process";
const hook = spawn("/bin/sh", ["-c", process.argv[2]], { stdio: ["pipe", "pipe", "pipe"] });
let output = "";
hook.stdout.on("data", (chunk) => (output += chunk));
hook.stderr.on("data", (chunk) => (output += chunk));
hook.stdin.end(JSON.stringify({
  hook_event_name: "SessionStart", session_id: "native-sandboxed", cwd: process.cwd(),
}));
hook.on("close", (code) => {
  const ps = spawnSync("/bin/ps", ["-o", "lstart=", "-p", String(process.pid)]);
  console.log(JSON.stringify({ cli: process.pid, code, output, ps: ps.status === 0 }));
});
process.stdin.resume();
`;

test(
  "a sandboxed session gets its binding receipt although the sandbox denies ps",
  options,
  async (t) => {
    const scratch = path.join(INSTALLATION_ROOT, ".cache");
    fs.mkdirSync(scratch, { recursive: true });
    const root = fs.realpathSync(fs.mkdtempSync(path.join(scratch, "nono-receipt-")));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const cwd = path.join(root, "work");
    fs.mkdirSync(cwd);
    const profile = path.join(root, "profile.json");
    fs.writeFileSync(profile, JSON.stringify(restrictive));
    const script = path.join(cwd, "cli.mjs");
    fs.writeFileSync(script, cli);

    const accounts = new AccountStore({ dataDir: path.join(root, "data"), home: root });
    const account = accounts.create({ name: "one", tool: "claude" });
    const session = {
      id: "one",
      tool: "claude",
      accountId: account.id,
      cwd,
      status: "running",
    };
    let pane = 0;
    const claims = [];
    const sessions = {
      get: async () => ({ ...session }),
      target: (id) => `agentpier-${id}`,
      tmux: async () => String(pane),
    };
    const bindings = new NativeSessionBinding({
      dataDir: accounts.dataDir,
      accounts,
      sessions,
      processOptions: {
        // The server's own reading, with the stand-in as the CLI the account runs.
        resolveRuntime: (input) => {
          claims.push(input.claimedPid);
          return resolveAgentBusProcess({
            session: input.session,
            launch: { id: "one", tool: "claude", command: process.execPath },
            claimedPid: input.claimedPid,
            sessions,
          });
        },
      },
    });
    const broker = new RequestBroker({
      dataDir: accounts.dataDir,
      sessions,
      onNative: (sessionId, push) =>
        push.type === "binding" ? bindings.claim(sessionId, push) : undefined,
    });
    await broker.ready;
    t.after(() => broker.close());
    const input = { id: "one", account, cwd };
    let launch = { command: "claude", args: [], env: {}, cliVersion: "2.1.322" };
    launch = await bindings.prepare({ ...input, launch });
    launch = await broker.prepare({ ...input, launch });
    Object.assign(session, {
      nativeBinding: launch.nativeBinding,
      nativeRequests: launch.nativeRequests,
    });
    const hooks = JSON.parse(
      fs.readFileSync(
        path.join(accounts.dataDir, "native-sessions/one/one.claude/hooks/hooks.json"),
        "utf8",
      ),
    );
    const hookCommand = hooks.hooks.SessionStart[0].hooks[0].command;
    assert.match(hookCommand, /native-session-binding\.js' '?--record/);

    const wrapped = wrapWithNono({
      launch: {
        command: process.execPath,
        args: [script, hookCommand],
        env: launch.env,
        sandboxGrants: [
          ...launch.sandboxGrants,
          { access: "read", path: process.execPath },
        ],
      },
      executable,
      profile,
    });
    const child = spawn(wrapped.command, ["wrap", "-s", ...wrapped.args.slice(1)], {
      cwd,
      env: { ...process.env, NONO_THEME: "minimal", ...wrapped.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    t.after(() => child.kill("SIGKILL"));
    pane = child.pid;
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const report = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(Error(`no report from the sandbox: ${stdout}${stderr}`)),
        60000,
      );
      const done = (value) => {
        clearTimeout(timer);
        resolve(value);
      };
      child.stdout.on("data", () => {
        const line = stdout.split("\n").find((value) => value.startsWith('{"cli"'));
        if (line) done(JSON.parse(line));
      });
      child.on("close", () => done(null));
    });
    assert.ok(report, `the sandboxed CLI ended early: ${stdout}${stderr}`);
    assert.equal(report.code, 0, report.output);
    assert.equal(report.output, "", "the hook reports no failure");

    // Read while the CLI still runs: a receipt counts only for a live process.
    const receipt = bindings.verifiedReceipt(session);
    assert.ok(receipt, "the session has a verified receipt");
    assert.equal(receipt.providerSessionId, "native-sandboxed");
    assert.equal(receipt.pid, report.cli, "the receipt names the CLI, not its hook");
    assert.deepEqual(await bindings.resolve(session), {
      id: "native-sandboxed",
      updatedAt: receipt.updatedAt,
    });
    // Where the sandbox denies `ps` (macOS), the server wrote it for the hook.
    if (!report.ps) {
      assert.equal(claims.length, 1);
      assert.notEqual(claims[0], report.cli);
    }
    if (process.platform === "darwin")
      assert.equal(report.ps, false, "nono denies the setuid ps on macOS");
    child.stdin.end();
  },
);
