// test-runner-timeout-ms: 300000
// Starts real CLIs, sandboxes or child processes: its own timeout class under load
// (scripts/test-runner.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  wrapWithNono,
  INSTALLATION_ROOT,
} from "../../server/features/nono/nono-launch.js";
import { SshIntegration } from "../../server/features/ssh/ssh-integration.js";
import { capabilityFile } from "../../server/features/ssh/ssh-capability.js";
import { RequestBroker } from "../../server/features/requests/request-broker.js";
import { NativeSessionBinding } from "../../server/features/sessions/native-session-binding.js";
import { AccountStore } from "../../server/features/accounts/account-store.js";
import { AgentBus } from "../../server/features/agentbus/agent-bus.js";
import { diffStat } from "../../server/features/changes/git-read.js";
import { setRepositoryConfinement } from "../../server/lib/git-repository-programs.js";

/**
 * The grant-composition tests assert what AgentPier puts on the command line.
 * They cannot assert that nono accepts those flags, that the subprocesses we
 * grant for actually start, or that anything ungranted is actually denied. This
 * file runs the composed command line through a real nono and observes the
 * kernel's answer, so it needs the binary and is skipped without it.
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
// The option is passed only when it applies: the runner treats a present `skip`
// key as a skip even when its value is falsy.
const options = reason ? { skip: reason } : {};

/**
 * A profile that grants nothing of its own, so every capability under test is
 * one AgentPier declared. It is written per run rather than installed into the
 * host's profile directory: a matrix test must not mutate the machine it runs
 * on. `workdir.access` is what turns `--allow-cwd` into read-write.
 */
const restrictive = {
  meta: { name: "agentpier-confinement" },
  // The two system-read groups are what let a dynamically linked binary start at
  // all: on Linux `/bin/sh` and node resolve their libraries out of
  // `/lib/<triple>/`, which nothing else here grants. Neither group reaches the
  // scratch directory this test denies against.
  groups: { include: ["system_read_macos", "system_read_linux_core"], exclude: [] },
  workdir: { access: "readwrite" },
  filesystem: { allow: [], read: [], write: [], deny: [] },
  network: { block: false },
};

/**
 * nono refuses to initialize when one of its own grants overlaps its state root
 * under `$HOME/.local/state/nono`, which rules out the system temp directory:
 * its built-in read of `/private` (macOS) or `/var` covers it. The repository's
 * own scratch directory is outside every grant AgentPier composes, because the
 * installation grants stop at `server/`, `vendor/` and `node_modules/`.
 */
function workspace(t) {
  const scratch = path.join(INSTALLATION_ROOT, ".cache");
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, "nono-confine-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const directory of ["work", "granted", "unrelated"])
    fs.mkdirSync(path.join(root, directory));
  fs.writeFileSync(path.join(root, "work", "in-workspace.txt"), "workspace");
  fs.writeFileSync(path.join(root, "granted", "granted.txt"), "granted");
  fs.writeFileSync(path.join(root, "unrelated", "secret.txt"), "secret");
  const profile = path.join(root, "profile.json");
  fs.writeFileSync(profile, JSON.stringify(restrictive));
  return { root, profile };
}

const write = (label, file) =>
  `echo "${label}:$( (echo planted > '${file}') 2>&1 && echo written)"`;
const denied = (output, labels) => {
  for (const label of labels)
    assert.match(output, new RegExp(`${label}:.*(not permitted|denied)`, "i"), label);
};

/** Runs a composed launch and returns its stdout, never throwing on a denial. */
function run({ launch, profile, cwd, stdin = "" }) {
  const wrapped = wrapWithNono({ launch, executable, profile });
  assert.equal(wrapped.command, executable, "the launch must exec through nono");
  try {
    // `-s` is a flag of `wrap`, so it follows the subcommand the adapter emits.
    return execFileSync(wrapped.command, ["wrap", "-s", ...wrapped.args.slice(1)], {
      cwd,
      input: stdin,
      encoding: "utf8",
      timeout: 60000,
      env: { ...process.env, NONO_THEME: "minimal" },
    });
  } catch (error) {
    return `${error.stdout || ""}${error.stderr || ""}`;
  }
}

test(
  "a real nono launch permits the workspace and the declared grants, and denies the rest",
  options,
  (t) => {
    const { root, profile } = workspace(t);
    const cwd = path.join(root, "work");
    const script = [
      'echo "WORKSPACE_READ:$(cat in-workspace.txt 2>&1)"',
      'echo "WORKSPACE_WRITE:$( (echo written > ./written.txt) 2>&1 && cat ./written.txt)"',
      `echo "GRANTED_READ:$(cat ${path.join(root, "granted", "granted.txt")} 2>&1)"`,
      `echo "UNRELATED_READ:$(cat ${path.join(root, "unrelated", "secret.txt")} 2>&1)"`,
    ].join("\n");
    const output = run({
      cwd,
      profile,
      launch: {
        command: "/bin/sh",
        args: ["-c", script],
        sandboxGrants: [{ access: "read", path: path.join(root, "granted") }],
      },
    });
    assert.match(output, /WORKSPACE_READ:workspace/);
    assert.match(output, /WORKSPACE_WRITE:written/);
    assert.match(output, /GRANTED_READ:granted/);
    // The secret is the control: same shape of path, same shell, no grant.
    assert.doesNotMatch(output, /UNRELATED_READ:secret/);
    assert.match(output, /UNRELATED_READ:.*(not permitted|denied)/i);
  },
);

test(
  "a script AgentPier starts inside the sandbox resolves its imports across the installation",
  options,
  (t) => {
    const { root, profile } = workspace(t);
    // Exactly the shape every integration uses: our own Node running one of our
    // own scripts, which imports across `server/`. This is what the installation
    // grants and the `package.json` file grant exist for, and a missing one shows
    // up as ERR_INVALID_PACKAGE_CONFIG or a denied import rather than as output.
    const probe = path.join(root, "work", "probe.mjs");
    fs.writeFileSync(
      probe,
      [
        `import { mergeGrants } from ${JSON.stringify(
          fileURLToPath(
            new URL("../../server/features/nono/sandbox-grants.js", import.meta.url),
          ),
        )};`,
        'console.log("IMPORTED:" + mergeGrants([{ access: "read", path: "/x" }]).length);',
      ].join("\n"),
    );
    const output = run({
      cwd: path.join(root, "work"),
      profile,
      launch: { command: process.execPath, args: [probe] },
    });
    assert.match(output, /IMPORTED:1/);
  },
);

test(
  "the SSH MCP server starts under exactly the grants the SSH adapter declares",
  options,
  async (t) => {
    const { root, profile } = workspace(t);
    const dataDir = path.join(root, "data");
    fs.mkdirSync(dataDir);
    const project = { projectId: "" };
    const integration = new SshIntegration({
      dataDir,
      accesses: { list: () => [{ id: "access-one", projectId: project.projectId }] },
      onProject: (binding) => {
        project.projectId = binding.projectId;
      },
    });
    // Two passes: the first registers the project so the access above is
    // inherited, the second is the launch whose grants are under test.
    const input = {
      id: "confined",
      account: { id: "account", tool: "codex" },
      cwd: path.join(root, "work"),
      launch: { command: process.execPath, args: [], env: {} },
      sandboxProfile: "confinement",
    };
    await integration.prepare(input);
    integration.discard(input.id);
    const prepared = await integration.prepare(input);
    assert.equal(prepared.sshTools.enabled, true);
    const folder = path.dirname(capabilityFile(dataDir, input.id));
    const credential = path.join(folder, `${prepared.sshTools.generation}.json`);
    // The MCP server is started the way the sandboxed CLI starts it, carrying
    // only what the adapter declared. Its stores create and chmod their own
    // directories as the module loads, so a missing grant is an EPERM at
    // startup rather than a failed tool call.
    const output = run({
      cwd: input.cwd,
      profile,
      launch: {
        command: process.execPath,
        args: [
          fileURLToPath(new URL("../../server/features/ssh/ssh-mcp.js", import.meta.url)),
          "--data-dir",
          dataDir,
          "--capability",
          credential,
        ],
        sandboxGrants: prepared.sandboxGrants,
      },
      stdin: `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      })}\n`,
    });
    assert.doesNotMatch(output, /EPERM|operation not permitted/i);
    assert.match(output, /"jsonrpc":"2\.0"/);
  },
);

test(
  "a Claude launch under nono reads its own request folder and writes only its own plugin folders",
  options,
  async (t) => {
    const { root, profile } = workspace(t);
    const dataDir = path.join(root, "data");
    fs.mkdirSync(dataDir);
    const broker = new RequestBroker({ dataDir, sessions: { get: async () => null } });
    t.after(() => broker.close());
    const prepare = (id) =>
      broker.prepare({
        id,
        account: { id: "account", tool: "claude" },
        cwd: path.join(root, "work"),
        launch: { command: "claude", args: [], env: {}, cliVersion: "2.1.300" },
      });
    await prepare("other");
    const prepared = await prepare("mine");
    const requests = path.join(dataDir, "requests");
    const dispatcher = prepared.env.AGENTPIER_CLAUDE_HOOK_DISPATCHER;
    const script = [
      `echo "OTHER_TOKEN:$(cat '${path.join(requests, "other/other.launch.json")}' 2>&1)"`,
      `echo "SHARED_LIST:$(ls '${requests}' 2>&1)"`,
      `echo "OWN_LAUNCH:$(grep -c '"id":"mine"' '${prepared.env.AGENTPIER_REQUEST_FILE}' 2>&1)"`,
      `echo "DISPATCHER:$(head -n 1 '${dispatcher}' 2>&1)"`,
      write(
        "OWN_BRIDGE",
        path.join(requests, "mine/mine.claude-bridge/hooks/types.d.ts"),
      ),
      write("OWN_PLUGIN", path.join(requests, "mine/mine.claude/note")),
      write("OWN_LAUNCH_WRITE", prepared.env.AGENTPIER_REQUEST_FILE),
      write("NEW_DISPATCHER", dispatcher),
      write("OLD_DISPATCHER", path.join(requests, "claude-hook.sh")),
      write("OTHER_HOOKS", path.join(requests, "other/other.claude/hooks/hooks.json")),
      write("OTHER_LAUNCH", path.join(requests, "other/other.launch.json")),
      write("OLD_APPROVALS", path.join(requests, "remembered-approvals.json")),
      write("APPROVALS", path.join(dataDir, "request-state/remembered-approvals.json")),
      `echo "READ_APPROVALS:$(cat '${path.join(dataDir, "request-state/remembered-approvals.json")}' 2>&1)"`,
    ].join("\n");
    const output = run({
      cwd: path.join(root, "work"),
      profile,
      launch: {
        command: "/bin/sh",
        args: ["-c", script],
        sandboxGrants: prepared.sandboxGrants,
      },
    });
    assert.match(output, /OWN_LAUNCH:1/);
    assert.match(output, /DISPATCHER:#!\/bin\/sh/);
    assert.match(output, /OWN_BRIDGE:written/);
    assert.match(output, /OWN_PLUGIN:written/);
    // Another session's request token is not readable, nor is the folder's listing.
    assert.doesNotMatch(output, /OTHER_TOKEN:.*"token"/);
    for (const label of [
      "OTHER_TOKEN",
      "SHARED_LIST",
      "OWN_LAUNCH_WRITE",
      "NEW_DISPATCHER",
      "OLD_DISPATCHER",
      "OTHER_HOOKS",
      "OTHER_LAUNCH",
      "OLD_APPROVALS",
      "APPROVALS",
      "READ_APPROVALS",
    ])
      assert.match(output, new RegExp(`${label}:.*(not permitted|denied)`, "i"), label);
    assert.doesNotMatch(
      fs.readFileSync(path.join(requests, "claude-hook.sh"), "utf8"),
      /planted/,
    );
  },
);

test(
  "a launch under nono writes its own native binding folder and reaches no other session's",
  options,
  async (t) => {
    const { root, profile } = workspace(t);
    const cwd = path.join(root, "work");
    const accounts = new AccountStore({ dataDir: path.join(root, "data"), home: root });
    const bindings = new NativeSessionBinding({ dataDir: accounts.dataDir, accounts });
    const prepare = (id) =>
      bindings.prepare({
        id,
        account: accounts.create({ name: id, tool: "claude" }),
        cwd,
        launch: { command: "claude", args: [], env: {}, cliVersion: "2.1.300" },
      });
    await prepare("other");
    const prepared = await prepare("mine");
    const shared = path.join(accounts.dataDir, "native-sessions");
    // The hook's own writer, started the way the CLI starts it: a temporary file
    // beside the report, then a rename over it.
    const probe = path.join(cwd, "activity.mjs");
    fs.writeFileSync(
      probe,
      [
        `import { recordNativeActivity } from ${JSON.stringify(
          fileURLToPath(
            new URL(
              "../../server/features/sessions/native-session-activity.js",
              import.meta.url,
            ),
          ),
        )};`,
        'console.log("ACTIVITY:" + recordNativeActivity({ state: "working", event: "UserPromptSubmit" }));',
      ].join("\n"),
    );
    const env = Object.entries({
      AGENTPIER_NATIVE_BINDING_FILE: prepared.env.AGENTPIER_NATIVE_BINDING_FILE,
      AGENTPIER_NATIVE_BINDING_TOKEN: prepared.env.AGENTPIER_NATIVE_BINDING_TOKEN,
    })
      .map(([name, value]) => `${name}='${value}'`)
      .join(" ");
    const script = [
      `${env} '${process.execPath}' '${probe}' 2>&1`,
      `echo "OWN_HOOKS:$(grep -c SessionStart '${path.join(shared, "mine/mine.claude/hooks/hooks.json")}' 2>&1)"`,
      `echo "OTHER_TOKEN:$(cat '${path.join(shared, "other/other.launch.json")}' 2>&1)"`,
      write("OTHER_HOOKS", path.join(shared, "other/other.claude/hooks/hooks.json")),
      write("OTHER_RECEIPT", path.join(shared, "other/other.receipt.json")),
      write("SHARED_NEW", path.join(shared, "planted.launch.json")),
    ].join("\n");
    const output = run({
      cwd,
      profile,
      launch: {
        command: "/bin/sh",
        args: ["-c", script],
        sandboxGrants: [
          ...prepared.sandboxGrants,
          { access: "read", path: process.execPath },
        ],
      },
    });
    assert.match(output, /ACTIVITY:true/);
    assert.match(output, /OWN_HOOKS:1/);
    assert.doesNotMatch(output, /OTHER_TOKEN:.*"token"/);
    denied(output, ["OTHER_TOKEN", "OTHER_HOOKS", "OTHER_RECEIPT", "SHARED_NEW"]);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(shared, "mine/mine.activity.json"), "utf8"))
        .state,
      "working",
    );
  },
);

test(
  "an AgentBus launch under nono reaches the broker and writes nothing of the project's bus",
  options,
  async (t) => {
    const { root, profile } = workspace(t);
    const cwd = path.join(root, "work");
    const accounts = new AccountStore({ dataDir: path.join(root, "data"), home: root });
    // The sessions the broker checks a caller against: running, on this bus.
    const records = new Map();
    const bus = new AgentBus({
      dataDir: accounts.dataDir,
      home: root,
      accounts,
      sessions: {
        list: async () => [...records.values()],
        get: async (id) => records.get(id) ?? null,
      },
      classifyFolder: (folder) => ({ kind: "project", cwd: folder }),
    });
    await bus.ready;
    t.after(() => bus.close());
    const prepare = async (id) => {
      const account = accounts.create({ name: id, tool: "claude" });
      const launch = await bus.prepare({
        id,
        account,
        cwd,
        launch: { command: "claude", args: [], env: {} },
      });
      records.set(id, {
        id,
        status: "running",
        tool: "claude",
        accountId: account.id,
        agentbus: launch.agentbus,
        cwd,
      });
      return launch;
    };
    await prepare("other");
    const prepared = await prepare("mine");
    const home = path.join(bus.root, "projects", prepared.agentbus.projectId);
    const env = ["AGENTPIER_AGENTBUS_SOCKET", "AGENTPIER_AGENTBUS_CAPABILITY_FILE"]
      .map((name) => `${name}='${prepared.env[name]}'`)
      .join(" ");
    const mcp = fileURLToPath(
      new URL("../../server/features/agentbus/agentbus-mcp.js", import.meta.url),
    );
    const script = [
      // The session's own bus program: its capability file, then the broker socket.
      `echo "MCP:$(${env} '${process.execPath}' '${mcp}' 2>&1)"`,
      `echo "OWN_HOOKS:$(grep -c SessionStart '${path.join(home, "adapters/mine/hooks/hooks.json")}' 2>&1)"`,
      write("OTHER_HOOKS", path.join(home, "adapters/other/hooks/hooks.json")),
      write("OTHER_LAUNCH", path.join(home, "launches/other.json")),
      write("OWN_LAUNCH", path.join(home, "launches/mine.json")),
      write("FORGED", path.join(home, "launches/forged.json")),
      `echo "BUS_LIST:$(ls '${home}' 2>&1)"`,
    ].join("\n");
    // The broker answers on this process's event loop, so the launch must not block it.
    const wrapped = wrapWithNono({
      launch: {
        command: "/bin/sh",
        args: ["-c", script],
        sandboxGrants: prepared.sandboxGrants,
      },
      executable,
      profile,
    });
    const output = await new Promise((resolve) => {
      const child = spawn(wrapped.command, ["wrap", "-s", ...wrapped.args.slice(1)], {
        cwd,
        env: { ...process.env, NONO_THEME: "minimal" },
      });
      let text = "";
      child.stdout.on("data", (chunk) => (text += chunk));
      child.stderr.on("data", (chunk) => (text += chunk));
      child.on("close", () => resolve(text));
      child.stdin.end(
        `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`,
      );
    });
    assert.match(output, /MCP:\{"jsonrpc":"2\.0","id":1,"result"/);
    assert.match(output, /OWN_HOOKS:[1-9]/);
    denied(output, ["OTHER_HOOKS", "OTHER_LAUNCH", "OWN_LAUNCH", "FORGED", "BUS_LIST"]);
  },
);

test(
  "the server's git runs a sandboxed repository's own filter inside the sandbox",
  options,
  async (t) => {
    const { root, profile } = workspace(t);
    const cwd = path.join(root, "work");
    const outside = path.join(root, "unrelated", "filter-ran");
    const inside = path.join(cwd, "filter-ran");
    // The filter a session could plant: it lives in the working tree, reports where
    // it could write, and passes the content on.
    fs.writeFileSync(
      path.join(cwd, "filter.sh"),
      `#!/bin/sh\n(echo ran >> '${outside}') 2>/dev/null\n(echo ran >> '${inside}') 2>/dev/null\ncat\n`,
      { mode: 0o700 },
    );
    const identity = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid" };
    const git = (...args) =>
      execFileSync("git", args, {
        cwd,
        env: {
          ...process.env,
          ...identity,
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@example.invalid",
        },
      });
    git("init", "--quiet", "-b", "main");
    fs.writeFileSync(path.join(cwd, ".gitattributes"), "*.txt filter=planted\n");
    fs.writeFileSync(path.join(cwd, ".gitignore"), "filter-ran\n");
    git("add", ".");
    git("commit", "--quiet", "-m", "first");
    git("config", "filter.planted.clean", "./filter.sh");
    const touch = () => {
      const later = new Date(Date.now() + 5000 + Math.random() * 100000);
      fs.utimesSync(path.join(cwd, "in-workspace.txt"), later, later);
      fs.rmSync(outside, { force: true });
      fs.rmSync(inside, { force: true });
    };
    t.after(() => setRepositoryConfinement(null));
    // The control: without a sandboxed session the filter runs as the server.
    touch();
    assert.equal((await diffStat(cwd, "HEAD")).files, 0);
    assert.equal(fs.existsSync(outside), true);
    // With one, it runs under that session's profile: the result is the same, the
    // write outside the working tree is denied.
    setRepositoryConfinement(async () => ({ executable, profile }));
    touch();
    assert.equal((await diffStat(cwd, "HEAD")).files, 0);
    assert.equal(fs.existsSync(inside), true);
    assert.equal(fs.existsSync(outside), false);
  },
);
