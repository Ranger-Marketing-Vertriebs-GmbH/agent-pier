import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SessionManager } from "../../server/features/sessions/session-manager.js";
import {
  tmuxFormatLiteral,
  tmuxSocketPath,
} from "../../server/features/sessions/tmux-naming.js";

const exec = promisify(execFile);
const tmuxPath = process.env.TMUX_PATH || "tmux";

const shell = (extra) => ({
  name: "Fixture",
  tool: "codex",
  accountId: "fixture-account",
  command: "/bin/sh",
  args: ["-c", "echo READY; sleep 60"],
  env: { PATH: "/usr/bin:/bin" },
  ...extra,
});

async function fixture(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "agentpier-tmux-cwd-"));
  const work = await realpath(await mkdtemp(path.join(tmpdir(), "agentpier-tmux-dir-")));
  const socket = tmuxSocketPath(dataDir);
  const manager = new SessionManager({ dataDir, tmuxPath });
  t.after(async () => {
    await manager.close().catch(() => {});
    await exec(tmuxPath, ["-S", socket, "kill-server"]).catch(() => {});
    await rm(path.dirname(socket), { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  });
  await manager.ready;
  return { work, manager };
}

const startPath = async (manager, id) =>
  String(
    await manager.tmux([
      "display-message",
      "-p",
      "-t",
      `${manager.target(id)}:0.0`,
      "#{pane_start_path}",
    ]),
  ).trimEnd();

// Names tmux would expand as a format: a job, a variable, a literal that drops the
// name, one-letter aliases, a style, escapes and plain doubled signs.
const names = [
  "a#(touch ran)b",
  "#{host}",
  "#{l:.}.",
  "#S #H #h #W",
  "a#[b",
  "a#[fg=red]b#(touch ran)",
  "p#,q#}r",
  "a##b",
  "#",
  "plain",
];

test("a session starts in exactly the folder it names, whatever tmux reads in it", async (t) => {
  const { work, manager } = await fixture(t);
  let n = 0;
  for (const name of names) {
    const cwd = path.join(work, name);
    await mkdir(cwd);
    const created = await manager.create(shell({ id: `dir-${n++}`, cwd }));
    assert.equal(await startPath(manager, created.id), cwd, name);
  }
  // Give a job tmux might have started time to leave its file.
  await new Promise((resolve) => setTimeout(resolve, 300));
  const found = [];
  for (const dir of [work, ...names.map((name) => path.join(work, name))])
    found.push(...(await readdir(dir)).filter((entry) => entry === "ran"));
  assert.deepEqual(found, []);
});

test("a format-literal path doubles every sign tmux would read", () => {
  assert.equal(tmuxFormatLiteral("/plain/path"), "/plain/path");
  assert.equal(tmuxFormatLiteral("/a#(x)b"), "/a##(x)b");
  assert.equal(tmuxFormatLiteral("/#{host}"), "/##{host}");
  assert.equal(tmuxFormatLiteral("/#S"), "/##S");
  assert.equal(tmuxFormatLiteral("/a##b"), "/a####b");
  assert.equal(tmuxFormatLiteral("/a#"), "/a##");
  // tmux leaves signs in front of `[` alone (a style), so they stay as they are.
  assert.equal(tmuxFormatLiteral("/a#[b"), "/a#[b");
  assert.equal(tmuxFormatLiteral("/a##[b#(x)"), "/a##[b##(x)");
});
