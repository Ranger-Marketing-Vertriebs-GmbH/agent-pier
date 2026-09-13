import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { AccountStore } from "../../server/features/accounts/account-store.js";
import { ProviderHistory } from "../../server/features/chat/provider-history.js";

/**
 * Claude Code relocates a session transcript into the project directory of its
 * new working directory when the CLI enters or leaves a worktree. The AgentPier
 * session keeps its original cwd, so the transcript must be found by session id.
 */
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "claude-moved-")));
  const dataDir = path.join(root, "data"),
    home = path.join(root, "home"),
    cwd = path.join(root, "project");
  fs.mkdirSync(home);
  fs.mkdirSync(cwd);
  const accounts = new AccountStore({ dataDir, home });
  const history = new ProviderHistory({ accounts, home });
  const session = {
    id: "native-session",
    accountId: "local-claude",
    tool: "claude",
    cwd,
    status: "running",
  };
  const projects = path.join(home, ".claude", "projects");
  const slug = (directory) => directory.replace(/[^a-zA-Z0-9]/g, "-");
  const write = (directory, id, rows) => {
    const folder = path.join(projects, slug(directory));
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(
      path.join(folder, `${id}.jsonl`),
      rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
    );
    return path.join(folder, `${id}.jsonl`);
  };
  t.after(async () => {
    await history.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, home, cwd, history, session, projects, slug, write };
}
const rows = (cwd, id, text, worktree) => [
  { type: "user", cwd, sessionId: id, message: { content: text } },
  {
    type: "assistant",
    cwd: worktree || cwd,
    sessionId: id,
    uuid: `${id}-reply`,
    message: { id: `${id}-reply`, content: [{ type: "text", text: `${text} reply` }] },
  },
];

test("a transcript moved into a worktree project directory is still read by session id", async (t) => {
  const f = fixture(t);
  const worktree = path.join(f.cwd, ".claude", "worktrees", "feature");
  const moved = f.write(
    worktree,
    f.session.id,
    rows(f.cwd, f.session.id, "Hello", worktree),
  );
  const history = await f.history.read(f.session, f.session.id);
  assert.equal(
    history.messages.some((m) => m.text?.includes("Hello reply")),
    true,
  );
  assert.equal(await f.history.claudeFile(f.session, f.session.id), moved);
  // Leaving the worktree moves the file back; resolution must follow it.
  const original = path.join(f.projects, f.slug(f.cwd), `${f.session.id}.jsonl`);
  fs.mkdirSync(path.dirname(original), { recursive: true });
  fs.renameSync(moved, original);
  assert.equal(await f.history.claudeFile(f.session, f.session.id), original);
});
test("transcripts of other projects or sessions are never adopted", async (t) => {
  const f = fixture(t);
  const other = path.join(f.root, "elsewhere");
  f.write(other, f.session.id, rows(other, f.session.id, "Foreign project"));
  await assert.rejects(f.history.read(f.session, f.session.id), { status: 409 });
  f.write(other, "different-session", rows(f.cwd, "different-session", "Other"));
  await assert.rejects(f.history.read(f.session, "missing-session"), { status: 404 });
});
