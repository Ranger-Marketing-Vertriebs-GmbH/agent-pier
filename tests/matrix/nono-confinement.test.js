import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  wrapWithNono,
  INSTALLATION_ROOT,
} from "../../server/features/nono/nono-launch.js";
import { SshIntegration } from "../../server/features/ssh/ssh-integration.js";
import { capabilityFile } from "../../server/features/ssh/ssh-capability.js";

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
