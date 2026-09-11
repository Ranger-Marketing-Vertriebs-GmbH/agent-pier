import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, stat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SessionManager } from "../../server/features/sessions/session-manager.js";

const exec = promisify(execFile);
const tmuxPath = process.env.TMUX_PATH || "tmux";
async function eventually(fn, message = "condition", timeout = 5000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  assert.fail(`Timed out waiting for ${message}`);
}
async function fixture(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "tuiui-sessions-"));
  const manager = new SessionManager({ dataDir, tmuxPath });
  const managers = [manager];
  t.after(async () => {
    try {
      for (const m of managers) await m.close();
      for (const session of await manager.list()) {
        await manager.stop(session.id);
        await manager.remove(session.id);
      }
    } finally {
      await exec(tmuxPath, ["-S", manager.socketPath, "kill-server"]).catch(() => {});
      await rm(dataDir, { recursive: true, force: true });
      await rm(path.dirname(manager.socketPath), { recursive: true, force: true });
    }
  });
  const start = (extra = {}) =>
    manager.create({
      id: "test-session",
      name: "Test",
      tool: "codex",
      accountId: "test-account",
      cwd: dataDir,
      command: "/bin/sh",
      args: [
        "-c",
        'printf "\\033[32mREADY\\033[0m\\n"; printf "PID:%s\\n" "$$"; while IFS= read -r line; do case "$line" in quit) echo GOODBYE; exit 7;; size) stty size;; *) printf "REPLY:%s\\n" "$line";; esac; done',
      ],
      env: {
        PATH: "/usr/bin:/bin",
        HOME: dataDir,
        FIXTURE_SECRET: "never-in-session-metadata",
      },
      ...extra,
    });
  return { manager, dataDir, start, managers };
}

test("PTY input, resize and reconnect preserve a running CLI across manager restart", async (t) => {
  const { manager, dataDir, start, managers } = await fixture(t);
  const created = await start();
  assert.equal(created.status, "running");
  assert.equal(created.env, undefined);
  await eventually(
    async () => (await manager.screen(created.id)).includes("READY"),
    "shell startup",
  );
  let output = "";
  const client = await manager.attach(created.id, {
    cols: 100,
    rows: 35,
    onData: (data) => {
      output += data;
    },
  });
  await eventually(() => output.includes("READY"), "ANSI attachment replay");
  assert.match(output, /\x1b\[/);
  client.resize(111, 37);
  await eventually(
    async () =>
      (
        await exec(tmuxPath, [
          "-S",
          manager.socketPath,
          "display-message",
          "-p",
          "-t",
          `=tuiui-${created.id}:0.0`,
          "#{pane_height}x#{pane_width}",
        ])
      ).stdout.trim() === "37x111",
    "resize delivery",
  );
  await eventually(async () => {
    client.write("size\r");
    return /37\s+111/.test(await manager.screen(created.id));
  }, "terminal dimensions");
  client.dispose();
  const pid = Number((await manager.screen(created.id)).match(/PID:(\d+)/)[1]);
  await manager.close();
  assert.doesNotThrow(() => process.kill(pid, 0));
  const next = new SessionManager({ dataDir, tmuxPath });
  managers.push(next);
  assert.equal((await next.get(created.id)).status, "running");
  await next.input(created.id, "hello world", true);
  await eventually(
    async () => (await next.screen(created.id)).includes("REPLY:hello world"),
    "input after restart",
  );
  await next.rename(created.id, "Renamed");
  assert.equal((await next.list())[0].name, "Renamed");
  let replay = "";
  await next.attach(created.id, {
    cols: 90,
    rows: 30,
    onData: (data) => {
      replay += data;
    },
  });
  await eventually(() => replay.includes("REPLY:hello world"), "reconnect replay");
  await next.close();
  assert.equal((await manager.get(created.id)).status, "running");
  const metadata = await readFile(
    path.join(dataDir, "sessions", `${created.id}.json`),
    "utf8",
  );
  assert.ok(!metadata.includes("never-in-session-metadata"));
  assert.equal(
    (await stat(path.join(dataDir, "sessions", `${created.id}.json`))).mode & 0o777,
    0o600,
  );
  const args = await exec(tmuxPath, [
    "-S",
    manager.socketPath,
    "display-message",
    "-p",
    "-t",
    `tuiui-${created.id}`,
    "#{pane_start_command}",
  ]);
  assert.ok(!args.stdout.includes("never-in-session-metadata"));
  assert.ok(
    !(await readdir(path.join(dataDir, "sessions"))).some((name) =>
      name.endsWith(".launch.json"),
    ),
  );
});

test("terminal attachments preserve Unicode without a UTF-8 service locale", async (t) => {
  const { manager, start } = await fixture(t);
  const sample = "Änderungen · ❯ ● ▐▛███▜▌";
  const session = await start({
    args: ["-c", 'printf "%s\\nREADY\\n" "$1"; read -r line', "fixture", sample],
  });
  await eventually(
    async () => (await manager.screen(session.id)).includes(sample),
    "Unicode stored in pane",
  );
  const localeKeys = ["LANG", "LC_ALL", "LC_CTYPE"];
  const original = Object.fromEntries(localeKeys.map((key) => [key, process.env[key]]));
  try {
    for (const key of localeKeys) delete process.env[key];
    for (let attempt = 0; attempt < 2; attempt++) {
      let output = "";
      const client = await manager.attach(session.id, {
        onData: (data) => {
          output += data;
        },
      });
      await eventually(() => output.includes("READY"), "terminal replay");
      client.dispose();
      assert.ok(
        output.includes(sample),
        `Unicode was lost during attachment: ${JSON.stringify(output)}`,
      );
    }
  } finally {
    for (const key of localeKeys) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  }
});

test("exited sessions retain output and exit code; stopped sessions alone can be deleted", async (t) => {
  const { manager, start } = await fixture(t);
  const first = await start();
  const other = await start({ id: "test-session-extra" });
  await assert.rejects(manager.remove(first.id), /stop|running/i);
  await manager.input(first.id, "quit", true);
  await eventually(
    async () => (await manager.get(first.id)).status === "stopped",
    "process exit",
  );
  assert.equal((await manager.get(first.id)).exitCode, 7);
  assert.match(await manager.screen(first.id), /GOODBYE/);
  let output = "";
  const viewer = await manager.attach(first.id, {
    cols: 80,
    rows: 24,
    onData: (data) => {
      output += data;
    },
  });
  await eventually(() => output.includes("GOODBYE"), "exited pane replay");
  viewer.dispose();
  await manager.stop(first.id);
  assert.match(await manager.screen(first.id), /GOODBYE/);
  assert.equal((await manager.get(other.id)).status, "running");
  await manager.remove(first.id);
  await assert.rejects(manager.get(first.id), /not found/i);
  await manager.stop(other.id);
  assert.equal((await manager.get(other.id)).status, "stopped");
  await manager.remove(other.id);
  assert.deepEqual(await manager.list(), []);
});

test("invalid IDs and launch inputs fail without creating sessions", async (t) => {
  const { manager, start } = await fixture(t);
  for (const id of ["../victim", "-a", "x:y", "*", "", "x".repeat(100)]) {
    await assert.rejects(start({ id }), /invalid/i);
    for (const operation of ["get", "stop", "remove", "screen"])
      await assert.rejects(manager[operation](id), /invalid/i);
  }
  for (const input of [
    { cwd: "/definitely/missing" },
    { cwd: "relative" },
    { name: "" },
    { command: "sh" },
    { command: "/missing/command" },
    { args: ["ok", 2] },
    { env: { BAD: 7 } },
  ]) {
    await assert.rejects(start(input), { status: 400 });
  }
  assert.deepEqual(await manager.list(), []);
  const live = await start();
  await assert.rejects(manager.input(live.id, {}, true), /invalid/i);
  await assert.rejects(manager.attach(live.id, { cols: 0, rows: 24 }), /invalid/i);
  await assert.rejects(manager.rename(live.id, " \n "), /invalid/i);
  await assert.rejects(start(), /exists/i);
});

test("a login session never persists an attachments field", async (t) => {
  const { start, dataDir } = await fixture(t);
  // Login sessions carry no model turn to attach an image to; session-manager's
  // `eligible` guard must drop the field even when a caller supplies one.
  const session = await start({
    purpose: "login",
    attachments: { directory: path.join(dataDir, "attachments") },
  });
  assert.equal(session.attachments, undefined);
});

test("lost tmux server marks metadata stopped without automatically relaunching", async (t) => {
  const { manager, dataDir, start, managers } = await fixture(t);
  const created = await start();
  await eventually(async () => (await manager.screen(created.id)).includes("READY"));
  const { stdout } = await exec(tmuxPath, [
    "-S",
    manager.socketPath,
    "display-message",
    "-p",
    "#{pid}",
  ]);
  const serverPid = Number(stdout.trim());
  assert.ok(Number.isSafeInteger(serverPid) && serverPid > 1);
  await exec(tmuxPath, ["-S", manager.socketPath, "kill-server"]);
  // The command client can exit while the server is still closing connections.
  await eventually(() => {
    try {
      process.kill(serverPid, 0);
      return false;
    } catch (error) {
      if (error.code === "ESRCH") return true;
      throw error;
    }
  }, "owned tmux server shutdown");
  const next = new SessionManager({ dataDir, tmuxPath });
  managers.push(next);
  assert.equal((await next.get(created.id)).status, "stopped");
  assert.match(await next.screen(created.id), /READY/);
  await assert.rejects(next.input(created.id, "hello", true), { status: 409 });
  await assert.rejects(next.get("unknown"), { status: 404 });
});

test("launch environment is replaced and stopping terminates the owned process", async (t) => {
  const { manager, start } = await fixture(t);
  process.env.TUIUI_INHERITED_CREDENTIAL_TEST = "must-not-reach-child";
  t.after(() => {
    delete process.env.TUIUI_INHERITED_CREDENTIAL_TEST;
  });
  const session = await start({
    args: [
      "-c",
      'printf "PID:%s\\nINHERITED:%s\\nOWN:%s\\n" "$$" "$TUIUI_INHERITED_CREDENTIAL_TEST" "$FIXTURE_SECRET"; read value',
    ],
  });
  await eventually(async () =>
    (await manager.screen(session.id)).includes("OWN:never-in-session-metadata"),
  );
  const screen = await manager.screen(session.id);
  assert.ok(!screen.includes("must-not-reach-child"));
  const pid = Number(screen.match(/PID:(\d+)/)[1]);
  await manager.stop(session.id);
  await eventually(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      return error.code === "ESRCH";
    }
  }, "owned process termination");
});

test("Ctrl-C reaches the CLI without killing a launcher when the CLI keeps running", async (t) => {
  const { manager, start } = await fixture(t);
  const session = await start({
    command: process.execPath,
    args: [
      "-e",
      'process.on("SIGINT", () => console.log("INTERRUPTED")); console.log("READY"); setInterval(() => {}, 1000)',
    ],
  });
  let output = "";
  const client = await manager.attach(session.id, {
    cols: 80,
    rows: 24,
    onData: (text) => {
      output += text;
    },
  });
  await eventually(() => output.includes("READY"));
  client.write("\x03");
  await eventually(() => output.includes("INTERRUPTED"), "CLI interrupt handler");
  assert.equal((await manager.get(session.id)).status, "running");
  client.write("\x03");
  await eventually(() => output.split("INTERRUPTED").length >= 3, "second CLI interrupt");
  assert.equal((await manager.get(session.id)).status, "running");
});

test("stop also terminates a CLI that ignores hangup and termination", async (t) => {
  const { manager, start } = await fixture(t);
  const session = await start({
    command: process.execPath,
    args: [
      "-e",
      'process.on("SIGHUP", () => {}); process.on("SIGTERM", () => {}); console.log(`PID:${process.pid}`); setInterval(() => {}, 1000)',
    ],
  });
  await eventually(async () => /PID:\d+/.test(await manager.screen(session.id)));
  const pid = Number((await manager.screen(session.id)).match(/PID:(\d+)/)[1]);
  t.after(() => {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  });
  await manager.stop(session.id);
  await eventually(
    () => {
      try {
        process.kill(pid, 0);
        return false;
      } catch (error) {
        return error.code === "ESRCH";
      }
    },
    "stubborn CLI termination",
    3000,
  );
});

test("composer preserves multiline bytes with bracketed paste and submits only on request", async (t) => {
  const { manager, start, dataDir } = await fixture(t);
  const captured = path.join(dataDir, "raw-input");
  const session = await start({
    command: process.execPath,
    args: [
      "-e",
      'const fs = require("node:fs"); process.stdin.setRawMode(true); process.stdin.on("data", data => fs.appendFileSync(process.argv[1], data)); process.stdout.write("\\x1b[?2004hREADY\\n")',
      captured,
    ],
  });
  await eventually(
    async () => (await manager.screen(session.id)).includes("READY"),
    "bracketed paste fixture",
  );
  const multiline = "erste Zeile\nzweite Zeile\n";
  await manager.input(session.id, multiline, false);
  const expectedPaste = `\x1b[200~${multiline}\x1b[201~`;
  await eventually(
    async () =>
      (await readFile(captured).catch(() => Buffer.alloc(0))).length >=
      Buffer.byteLength(expectedPaste),
    "raw paste bytes",
  );
  assert.equal(await readFile(captured, "utf8"), expectedPaste);
  await manager.input(session.id, "weiter\nText", true);
  const expectedSubmitted = `${expectedPaste}\x1b[200~weiter\nText\x1b[201~\r`;
  await eventually(
    async () => (await readFile(captured, "utf8")).length >= expectedSubmitted.length,
    "paste then separate Enter",
  );
  assert.equal(await readFile(captured, "utf8"), expectedSubmitted);
});
