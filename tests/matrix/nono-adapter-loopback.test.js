import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  wrapWithNono,
  INSTALLATION_ROOT,
} from "../../server/features/nono/nono-launch.js";
import { ADAPTER_URL_PLACEHOLDER } from "../../server/features/providers/adapter-launch.js";
import { scriptedUpstream, sse } from "../helpers/scripted-upstream.js";
import { loadFixture } from "../helpers/protocol-adapter.js";
import { KEY, TOKEN, validAdapterConfig } from "../helpers/adapter-fixture.js";

const launcher = fileURLToPath(
  new URL("../../server/terminal-launcher.js", import.meta.url),
);
const fakeCli = fileURLToPath(new URL("../helpers/fake-cli.mjs", import.meta.url));

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
// Fact R1b verified --open-port on macOS only.
const blockNet = reason
  ? { skip: reason }
  : process.platform === "linux"
    ? { skip: "--open-port under a blocking profile is unverified on Linux (facts R1b)" }
    : {};

// Same capability set as nono-confinement.test.js's `restrictive`, network chosen per test.
const restrictive = (network) => ({
  meta: { name: "agentpier-adapter-loopback" },
  groups: { include: ["system_read_macos", "system_read_linux_core"], exclude: [] },
  workdir: { access: "readwrite" },
  filesystem: { allow: [], read: [], write: [], deny: [] },
  network,
});

/** Scratch dir under the repo's .cache (nono refuses grants overlapping its state root). */
function workspace(t, profileJson) {
  const scratch = path.join(INSTALLATION_ROOT, ".cache");
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, "nono-adapter-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "work"));
  let profile = "default";
  if (profileJson) {
    profile = path.join(root, "profile.json");
    fs.writeFileSync(profile, JSON.stringify(profileJson));
  }
  return { root, profile };
}

/**
 * Asynchronous on purpose: the scripted upstream lives in this process, so a
 * `spawnSync` would block its event loop and the adapter's upstream call would hang.
 */
function runLauncher(payload, cwd) {
  const child = spawn(process.execPath, [launcher, payload], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
  return new Promise((resolve) =>
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    }),
  );
}

async function runSandboxed(t, profileJson) {
  const { root, profile } = workspace(t, profileJson);
  const up = await scriptedUpstream(t, (_e, res) =>
    sse(res, loadFixture("upstreams/chat/text.sse")),
  );
  const work = path.join(root, "work");
  const out = path.join(work, "out.json");
  // The adapter block is on the launch BEFORE wrapping, as in the real chain (nono is last).
  const wrapped = wrapWithNono({
    executable,
    profile,
    launch: {
      command: process.execPath,
      args: [fakeCli, out, "call"],
      env: {
        PATH: process.env.PATH,
        HOME: root,
        ANTHROPIC_BASE_URL: ADAPTER_URL_PLACEHOLDER,
        ANTHROPIC_AUTH_TOKEN: TOKEN,
        FAKE_CLI_BODY: JSON.stringify(loadFixture("clients/claude-code/text.json").body),
      },
      // The default profile's `--allow-cwd` is read-only; the fake CLI writes its record.
      sandboxGrants: [
        { access: "read", path: fakeCli },
        { access: "allow", path: work },
      ],
      adapter: validAdapterConfig({
        upstream: { baseUrl: `${up.base}/v1`, authHeader: null, apiKey: KEY },
        diagnosticsPath: path.join(root, "s.adapter.json"),
      }),
    },
  });
  assert.ok(wrapped.args.includes("--open-port"));
  const payload = path.join(root, "s.launch.json");
  fs.writeFileSync(payload, JSON.stringify({ ...wrapped, cwd: work }), { mode: 0o600 });
  const result = await runLauncher(payload, work);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const record = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.match(record.calls[0].text, /message_stop/);
  assert.equal(up.seen[0].headers.authorization, `Bearer ${KEY}`);
}

test(
  "a CLI under the default nono profile reaches the adapter on loopback (R1a)",
  options,
  (t) => runSandboxed(t, null),
);

test("a restrictive profile with an open network reaches the adapter", options, (t) =>
  runSandboxed(t, restrictive({ block: false })),
);

test(
  "a network-blocking profile reaches the adapter through --open-port (R1b)",
  blockNet,
  (t) => runSandboxed(t, restrictive({ block: true })),
);
