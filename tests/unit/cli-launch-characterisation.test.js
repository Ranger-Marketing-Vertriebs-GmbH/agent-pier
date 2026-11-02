import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AccountStore,
  cleanEnvironment,
} from "../../server/features/accounts/account-store.js";
import { resumeLaunch } from "../../server/application/session-reload-launch.js";

// Oracle for the CLI-definition refactor: launch lines and per-account
// environments recorded from the tree before any per-CLI knowledge moved.
const FIXTURE = new URL("../fixtures/cli-launch-characterisation.json", import.meta.url);
const MODES = {
  codex: ["default", "yolo"],
  claude: ["default", "auto", "bypass"],
  opencode: ["default", "auto"],
  shell: ["default"],
};
const SESSION_ID = "00000000-0000-4000-8000-000000000001";

function scrub(value, root) {
  return typeof value === "string"
    ? value
        .split(root)
        .join("<root>")
        .replace(/\/profiles\/[0-9a-f-]{36}\//g, "/profiles/<account>/")
    : value;
}

/** Only what AgentPier sets or changes; host-inherited variables stay out. */
function recordEnv(env, root) {
  const host = cleanEnvironment();
  const out = {};
  for (const key of Object.keys(env).sort()) {
    if (key === "PATH") continue;
    if (env[key] !== host[key]) out[key] = scrub(env[key], root);
  }
  const added = (env.PATH || "")
    .split(path.delimiter)
    .filter((dir) => dir.startsWith(root));
  out.PATH_added = added.map((dir) => scrub(dir, root));
  return out;
}

async function record(root, accounts, account, mode, login) {
  const executable =
    account.tool === "shell" ? "/bin/sh" : path.join(root, "fixture-bin", account.tool);
  const launch = await accounts.command(
    account.id,
    { [account.tool]: executable },
    login,
    mode,
    { cliVersion: "9.9.9" },
  );
  return {
    command: scrub(launch.command, root),
    args: launch.args.map((arg) => scrub(arg, root)),
    env: recordEnv(launch.env, root),
  };
}

async function build() {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-characterisation-")),
  );
  try {
    const accounts = new AccountStore({
      dataDir: path.join(root, "data"),
      home: root,
      uid: () => 501,
    });
    const result = { launches: {}, resume: {}, apiKeyEnv: {} };
    for (const [tool, modes] of Object.entries(MODES)) {
      const kinds = { local: accounts.get(`local-${tool}`) };
      if (tool !== "shell") {
        kinds.managed = accounts.create({ name: "Fixture", tool });
        kinds["managed-api-key"] = accounts.create({
          name: "Fixture key",
          tool,
          apiKey: "fixture-key",
        });
      }
      for (const [kind, account] of Object.entries(kinds)) {
        for (const mode of modes)
          result.launches[`${tool}/${kind}/${mode}`] = await record(
            root,
            accounts,
            account,
            mode,
            false,
          );
        if (kind === "managed")
          result.launches[`${tool}/${kind}/login`] = await record(
            root,
            accounts,
            account,
            "default",
            true,
          );
      }
    }
    for (const tool of ["codex", "claude", "opencode"]) {
      const launch = { command: "/bin/x", args: ["--base"], env: {} };
      result.resume[tool] = resumeLaunch(tool, launch, SESSION_ID).args;
      const keyed = accounts.create({ name: "Key env", tool, apiKey: "env-probe" });
      const env = accounts.environment(keyed.id);
      result.apiKeyEnv[tool] = Object.keys(env).filter((k) => env[k] === "env-probe");
    }
    return result;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("launch args and env per CLI and mode stay as recorded", async () => {
  const actual = await build();
  actual.authStatusArgs = {
    claude: ["auth", "status", "--json"],
    codex: ["login", "status"],
    opencode: ["auth", "list"],
  };
  if (process.env.UPDATE_FIXTURE === "1") {
    fs.writeFileSync(FIXTURE, JSON.stringify(actual, null, 2) + "\n");
    return;
  }
  assert.deepStrictEqual(actual, JSON.parse(fs.readFileSync(FIXTURE, "utf8")));
});
