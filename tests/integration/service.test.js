import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderSystemdUnit, runService } from "../../scripts/service.mjs";
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-service-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'project % "$cash"');
  fs.mkdirSync(path.join(project, "dist"), { recursive: true });
  fs.writeFileSync(path.join(project, "dist/index.html"), "fixture");
  const home = path.join(root, "home");
  const config = { dataDir: path.join(root, "data"), port: 4380 };
  const calls = [],
    logs = [];
  const options = {
    platform: "linux",
    projectDir: project,
    home,
    config,
    node: "/opt/node",
    env: { PATH: "/usr/bin:/bin" },
    run: (command, args) => {
      calls.push([command, ...args]);
      return "active fixture\n";
    },
    log: (value) => logs.push(value),
  };
  return {
    root,
    project,
    home,
    config,
    calls,
    logs,
    options,
    file: path.join(home, ".config/systemd/user/dev.agentpier.server.service"),
  };
}
test("systemd renderer keeps literal paths and environment values and stops only its main process", () => {
  const unit = renderSystemdUnit({
    projectDir: '/tmp/quote " $HOME %n \\ trailing ',
    node: "/opt/node $money%/node",
    dataDir: "/tmp/data $HOME %n",
    envPath: '/bin:/with "quote"\\$HOME%n',
  });
  assert.ok(
    unit.includes(
      'ExecStart=:"/opt/node $money%%/node" "/tmp/quote \\" $HOME %%n \\\\ trailing /server/index.js"',
    ),
  );
  assert.ok(unit.includes('WorkingDirectory=/tmp/quote " $HOME %%n \\ trailing /.\n'));
  assert.ok(unit.includes('Environment="AGENTPIER_DATA_DIR=/tmp/data $HOME %%n"'));
  assert.ok(unit.includes('Environment="PATH=/bin:/with \\"quote\\"\\\\$HOME%%n"'));
  assert.match(unit, /^KillMode=process$/m);
  assert.match(unit, /^UMask=0077$/m);
  assert.match(unit, /^WantedBy=default.target$/m);
  assert.match(unit, /^Restart=always$/m);
  assert.doesNotMatch(unit, /ExecStop=|kill-server|PrivateTmp=true/);
  for (const key of ["projectDir", "node", "dataDir", "envPath"])
    assert.throws(
      () =>
        renderSystemdUnit({
          projectDir: "/project",
          node: "/node",
          dataDir: "/data",
          envPath: "/bin",
          [key]: "/bad\nExecStart=/evil",
        }),
      /Ungültig/,
    );
});
test("Linux installation writes private unit and reloads, enables and restarts only the user service", async (t) => {
  const ctx = fixture(t);
  assert.equal(await runService({ ...ctx.options, action: "install" }), 0);
  assert.deepEqual(ctx.calls, [
    ["systemctl", "--user", "show", "--property=Version", "--value"],
    ["systemctl", "--user", "daemon-reload"],
    ["systemctl", "--user", "enable", "dev.agentpier.server.service"],
    ["systemctl", "--user", "restart", "dev.agentpier.server.service"],
  ]);
  assert.equal(fs.statSync(ctx.file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(ctx.config.dataDir).mode & 0o777, 0o700);
  assert.match(fs.readFileSync(ctx.file, "utf8"), /KillMode=process/);
  assert.match(fs.readFileSync(ctx.file, "utf8"), /\/usr\/local\/bin/);
  assert.ok(ctx.logs.at(-1).includes("4380"));
  ctx.calls.length = 0;
  assert.equal(await runService({ ...ctx.options, action: "install" }), 0);
  assert.equal(ctx.calls.length, 4);
});
test("Linux status and stop never change installation or kill detached terminals", async (t) => {
  const ctx = fixture(t);
  assert.equal(await runService({ ...ctx.options, action: "status" }), 0);
  assert.equal(await runService({ ...ctx.options, action: "stop" }), 0);
  assert.deepEqual(ctx.calls, [
    ["systemctl", "--user", "status", "--no-pager", "dev.agentpier.server.service"],
    ["systemctl", "--user", "stop", "dev.agentpier.server.service"],
  ]);
  assert.equal(fs.existsSync(ctx.file), false);
  const failed = {
    ...ctx.options,
    run: () => {
      throw Object.assign(new Error("inactive"), {
        status: 3,
        stdout: "inactive (dead)\n",
      });
    },
  };
  assert.equal(await runService({ ...failed, action: "status" }), 1);
  assert.ok(ctx.logs.at(-1).includes("inactive"));
});
test("missing build, unavailable user manager and conflicting or symlinked units are not overwritten", async (t) => {
  const ctx = fixture(t);
  fs.rmSync(path.join(ctx.project, "dist/index.html"));
  await assert.rejects(runService({ ...ctx.options, action: "install" }), /build/);
  assert.deepEqual(ctx.calls, []);
  assert.equal(fs.existsSync(ctx.file), false);
  fs.writeFileSync(path.join(ctx.project, "dist/index.html"), "fixture");
  await assert.rejects(
    runService({
      ...ctx.options,
      action: "install",
      run: () => {
        throw Object.assign(new Error("no bus"), { code: "ENOENT" });
      },
    }),
    /systemd|systemctl/,
  );
  assert.equal(fs.existsSync(ctx.file), false);
  fs.mkdirSync(path.dirname(ctx.file), { recursive: true });
  fs.writeFileSync(ctx.file, "Unrelated service");
  await assert.rejects(
    runService({ ...ctx.options, action: "install" }),
    /anderen Installation/,
  );
  assert.equal(fs.readFileSync(ctx.file, "utf8"), "Unrelated service");
  fs.rmSync(ctx.file);
  const outside = path.join(ctx.root, "outside");
  fs.writeFileSync(outside, "untouched");
  fs.symlinkSync(outside, ctx.file);
  await assert.rejects(runService({ ...ctx.options, action: "install" }), /Symlink/);
  assert.equal(fs.readFileSync(outside, "utf8"), "untouched");
});
test("Linux honors absolute XDG_CONFIG_HOME and rejects invalid actions before commands", async (t) => {
  const ctx = fixture(t);
  const configHome = path.join(ctx.root, "xdg config");
  await runService({
    ...ctx.options,
    env: { PATH: "/bin", XDG_CONFIG_HOME: configHome },
    action: "install",
  });
  assert.ok(
    fs.existsSync(path.join(configHome, "systemd/user/dev.agentpier.server.service")),
  );
  ctx.calls.length = 0;
  await assert.rejects(
    runService({ ...ctx.options, action: "delete-everything" }),
    /Verwendung/,
  );
  await assert.rejects(
    runService({
      ...ctx.options,
      action: "install",
      env: { XDG_CONFIG_HOME: "relative" },
    }),
    /XDG_CONFIG_HOME/,
  );
  assert.deepEqual(ctx.calls, []);
});
test("macOS install still validates its plist and loads only the matching LaunchAgent", async (t) => {
  const ctx = fixture(t);
  assert.equal(
    await runService({ ...ctx.options, platform: "darwin", uid: 501, action: "install" }),
    0,
  );
  const file = path.join(ctx.home, "Library/LaunchAgents/dev.agentpier.server.plist");
  assert.match(fs.readFileSync(file, "utf8"), /KeepAlive/);
  assert.match(fs.readFileSync(file, "utf8"), /\/opt\/homebrew\/bin/);
  assert.deepEqual(ctx.calls, [
    ["plutil", "-lint", file],
    ["launchctl", "bootout", "gui/501/dev.agentpier.server"],
    ["launchctl", "bootstrap", "gui/501", file],
  ]);
});
