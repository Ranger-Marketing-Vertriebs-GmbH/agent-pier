import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AccountStore } from "../../server/features/accounts/account-store.js";
import { ToolInstaller } from "../../server/features/tools/tool-installer.js";

const nativeArguments = {
  codex: { default: [], yolo: ["--yolo"], login: ["login", "--device-auth"] },
  claude: {
    default: [],
    auto: ["--permission-mode", "auto"],
    login: [],
  },
  opencode: { default: [], auto: ["--auto"], login: ["auth", "login"] },
};
function accountsFixture(t) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-matrix-")),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    accounts: new AccountStore({
      dataDir: path.join(root, "data"),
      home: root,
    }),
  };
}

for (const tool of Object.keys(nativeArguments)) {
  for (const kind of ["local", "managed"]) {
    for (const mode of ["default", "auto", "yolo"]) {
      for (const login of [false, true]) {
        test(`native launch: ${tool} / ${kind} / ${mode} / ${login ? "login" : "work"}`, (t) => {
          const { root, accounts } = accountsFixture(t);
          const account =
            kind === "local"
              ? accounts.get(`local-${tool}`)
              : accounts.create({ name: "Matrix", tool });
          const executable = path.join(root, "fixture-bin", tool);
          const run = () =>
            accounts.command(account.id, { [tool]: executable }, login, mode);
          const supported =
            Object.hasOwn(nativeArguments[tool], mode) &&
            (!login || (kind === "managed" && mode === "default"));
          if (!supported) {
            assert.throws(run, (error) => error.status === 400 || error.status === 409);
            return;
          }
          const launch = run();
          assert.equal(launch.command, executable);
          assert.deepEqual(launch.args, nativeArguments[tool][login ? "login" : mode]);
          assert.equal(launch.env.HOME, root);
          assert.equal(launch.env.OPENAI_API_KEY, undefined);
          assert.equal(launch.env.ANTHROPIC_API_KEY, undefined);
          if (kind === "managed") {
            const scoped =
              tool === "codex"
                ? [launch.env.CODEX_HOME]
                : tool === "claude"
                  ? [launch.env.CLAUDE_CONFIG_DIR]
                  : [
                      launch.env.XDG_CONFIG_HOME,
                      launch.env.XDG_DATA_HOME,
                      launch.env.XDG_STATE_HOME,
                      launch.env.XDG_CACHE_HOME,
                    ];
            assert.ok(
              scoped.every((directory) =>
                directory.startsWith(accounts.profile(account.id) + path.sep),
              ),
            );
          } else {
            for (const key of ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "XDG_CONFIG_HOME"])
              assert.equal(launch.env[key], undefined);
          }
        });
      }
    }
  }
}

for (const tool of Object.keys(nativeArguments)) {
  test(`API-key ${tool} profile keeps secrets private and rejects browser login`, (t) => {
    const { root, accounts } = accountsFixture(t);
    const account = accounts.create({
      name: "Secret fixture",
      tool,
      apiKey: "fixture-native-key",
    });
    const launch = accounts.command(account.id, {
      [tool]: path.join(root, tool),
    });
    assert.equal(
      launch.env[tool === "claude" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"],
      "fixture-native-key",
    );
    assert.equal(JSON.stringify(accounts.list()).includes("fixture-native-key"), false);
    assert.throws(
      () => accounts.command(account.id, { [tool]: path.join(root, tool) }, true),
      { status: 409 },
    );
    if (tool === "codex") {
      assert.equal(
        JSON.parse(fs.readFileSync(path.join(launch.env.CODEX_HOME, "auth.json")))
          .OPENAI_API_KEY,
        "fixture-native-key",
      );
      assert.match(
        fs.readFileSync(path.join(launch.env.CODEX_HOME, "config.toml"), "utf8"),
        /cli_auth_credentials_store\s*=\s*"file"/,
      );
    }
  });
}

test("Shell is local, starts a login shell and never receives coding-agent secrets", (t) => {
  const { accounts } = accountsFixture(t);
  const launch = accounts.command("local-shell", { shell: "/bin/sh" });
  assert.deepEqual(launch.args, ["-l"]);
  assert.equal(launch.env.SHELL, "/bin/sh");
  for (const key of [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "CODEX_HOME",
    "CLAUDE_CONFIG_DIR",
  ])
    assert.equal(launch.env[key], undefined);
  for (const mode of ["auto", "yolo"])
    assert.throws(() =>
      accounts.command("local-shell", { shell: "/bin/sh" }, false, mode),
    );
  assert.throws(() => accounts.command("local-shell", { shell: "/bin/sh" }, true));
});

for (const platform of ["darwin", "linux", "win32"]) {
  for (const arch of ["arm64", "x64", "ia32"]) {
    for (const npm of [true, false]) {
      test(`installer availability: ${platform} / ${arch} / npm ${npm ? "present" : "absent"}`, (t) => {
        const { root } = accountsFixture(t);
        const installer = new ToolInstaller({
          dataDir: root,
          home: root,
          platform,
          arch,
          npmCli: npm ? "/fixture/npm-cli.js" : null,
          detect: () => [],
        });
        t.after(() => installer.close());
        const rows = installer.list().installations;
        const supported = platform !== "win32" && arch !== "ia32";
        assert.equal(rows.find((row) => row.tool === "gh").available, supported);
        for (const tool of Object.keys(nativeArguments))
          assert.equal(rows.find((row) => row.tool === tool).available, supported);
        assert.equal(fs.existsSync(path.join(root, "clis")), false);
      });
    }
  }
}
