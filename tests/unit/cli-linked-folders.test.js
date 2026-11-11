import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { cliDriver } from "../../server/features/clis/drivers.js";
import {
  SHARED_FOLDERS,
  linkedFolderTargets,
} from "../../server/features/clis/linked-folders.js";
import { assetDirectories } from "../../server/features/cli-profiles/assets.js";

// Linux has no system bundle to name, so the Codex launch carries the links alone.
const linux = { platform: "linux", exists: () => false };

/** Where each CLI keeps a managed account's config root and its own profile. */
const layouts = {
  codex: {
    native: ".codex",
    account: "codex",
    env: (home, root) => ({ HOME: home, CODEX_HOME: path.join(root, "codex") }),
  },
  opencode: {
    native: ".config/opencode",
    account: "config/opencode",
    env: (home, root) => ({ HOME: home, XDG_CONFIG_HOME: path.join(root, "config") }),
  },
};

/** A managed account whose asset folders link to the CLI's own profile (linkAssets). */
function sharedProfile(t, tool) {
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/aplf-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const layout = layouts[tool];
  const home = path.join(root, "home");
  const shared = path.join(home, layout.native);
  const account = path.join(root, "profiles/one");
  const config = path.join(account, layout.account);
  for (const name of assetDirectories(tool)) {
    fs.mkdirSync(path.join(shared, name), { recursive: true });
    fs.mkdirSync(path.dirname(path.join(config, name)), { recursive: true });
    fs.symlinkSync(path.join(shared, name), path.join(config, name), "dir");
  }
  fs.writeFileSync(path.join(shared, "auth.json"), "{}");
  const launch = { command: `/bin/${tool}`, args: [], env: layout.env(home, account) };
  const grants = (value = launch) =>
    cliDriver(tool).sandboxLaunch(value, linux).sandboxGrants || [];
  return { root, home, shared, config, launch, grants };
}

for (const tool of ["codex", "opencode"]) {
  test(`a sandboxed managed ${tool} account reads the folders linked to the CLI's own profile`, (t) => {
    const { shared, launch, grants } = sharedProfile(t, tool);
    assert.deepEqual(
      grants(),
      [...assetDirectories(tool)]
        .sort()
        .map((name) => ({ access: "read", path: path.join(shared, name) })),
    );
    // Never the profile itself (login, history, sessions), and nothing writable.
    assert.equal(
      grants().some((grant) => grant.path === shared || grant.access !== "read"),
      false,
    );
    // The launch handed in is not changed.
    assert.equal(launch.sandboxGrants, undefined);
  });

  test(`only a ${tool} link to the CLI's own profile is granted, not wherever a link points`, (t) => {
    const { root, shared, config, launch, grants } = sharedProfile(t, tool);
    // A session may write its account folder: a link it re-pointed grants nothing,
    // neither outside the profile nor at another folder inside it.
    const secret = path.join(root, "secret");
    fs.mkdirSync(secret);
    fs.rmSync(path.join(config, "plugins"));
    fs.symlinkSync(secret, path.join(config, "plugins"), "dir");
    fs.rmSync(path.join(config, "commands"));
    fs.symlinkSync(shared, path.join(config, "commands"), "dir");
    // A folder of the account's own needs no grant beyond the account folder.
    fs.rmSync(path.join(config, "skills"));
    fs.mkdirSync(path.join(config, "skills"));
    assert.deepEqual(
      grants(),
      assetDirectories(tool)
        .filter((name) => !["plugins", "commands", "skills"].includes(name))
        .sort()
        .map((name) => ({ access: "read", path: path.join(shared, name) })),
    );
    // A local account has no account folder: its profile is the operator's to grant.
    assert.deepEqual(grants({ ...launch, env: { HOME: launch.env.HOME } }), []);
    assert.deepEqual(grants({ ...launch, env: {} }), []);
  });

  test(`a ${tool} link whose target is missing grants nothing`, (t) => {
    const { shared, config, grants } = sharedProfile(t, tool);
    // The target is gone: the link dangles.
    fs.rmSync(path.join(shared, "agents"), { recursive: true });
    // The link is gone: nothing to follow.
    fs.rmSync(path.join(config, "skills"));
    // The target is a file where a folder belongs.
    fs.rmSync(path.join(shared, "commands"), { recursive: true });
    fs.writeFileSync(path.join(shared, "commands"), "");
    assert.deepEqual(
      grants().map((grant) => grant.path),
      assetDirectories(tool)
        .filter((name) => !["agents", "skills", "commands"].includes(name))
        .sort()
        .map((name) => path.join(shared, name)),
    );
    assert.equal(fs.existsSync(path.join(shared, "agents")), false);
  });
}

test("a sandboxed Codex launch keeps its CA file beside the linked folders", (t) => {
  const { shared, launch } = sharedProfile(t, "codex");
  const prepared = cliDriver("codex").sandboxLaunch(launch, {
    platform: "darwin",
    exists: () => true,
  });
  assert.equal(prepared.env.SSL_CERT_FILE, "/etc/ssl/cert.pem");
  assert.deepEqual(prepared.sandboxGrants.slice(0, 2), [
    { access: "read", path: "/etc/ssl/cert.pem" },
    { access: "read", path: path.join(shared, ".tmp/marketplaces") },
  ]);
  assert.equal(prepared.sandboxGrants.length, 1 + assetDirectories("codex").length);
});

test("the linked folders are the ones linkAssets makes, for every coding CLI", () => {
  assert.deepEqual(SHARED_FOLDERS, ["skills", "agents", "commands", "plugins"]);
  for (const tool of ["claude", "codex", "opencode"])
    assert.deepEqual(assetDirectories(tool).slice(0, 4), SHARED_FOLDERS);
});

test("the targets name the link's folder and its real path, sorted by name", (t) => {
  const { shared, config } = sharedProfile(t, "codex");
  assert.deepEqual(
    linkedFolderTargets({ account: config, native: shared, names: ["skills", "agents"] }),
    [
      { name: "agents", path: path.join(shared, "agents") },
      { name: "skills", path: path.join(shared, "skills") },
    ],
  );
  assert.deepEqual(linkedFolderTargets({ account: config, native: "" }), []);
  assert.deepEqual(linkedFolderTargets({ account: "", native: shared }), []);
});
