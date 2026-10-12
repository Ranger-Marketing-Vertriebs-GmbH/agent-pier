import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const profileAccounts = [
  { id: "codex-work", name: "Work", tool: "codex", kind: "managed" },
  { id: "claude-home", name: "Home", tool: "claude", kind: "managed" },
  {
    id: "opencode-zai",
    name: "Z",
    tool: "opencode",
    kind: "managed",
    provider: { id: "zai" },
  },
];
/** Credential files by member path: they belong only into the sealed capsule. */
export const credentialFiles = {
  "profiles/codex-work/secret.json": '{"apiKey":"sk-codex-secret"}',
  "profiles/codex-work/codex/auth.json":
    '{"tokens":{"access_token":"codex-oauth-secret"}}',
  "profiles/codex-work/codex/config.toml": 'model = "gpt"\n',
  "profiles/codex-work/codex/.credentials.json": '{"mcp":"codex-mcp-oauth-secret"}',
  "profiles/codex-work/codex/AGENTS.md": "Be brief.\n",
  "profiles/codex-work/codex/prompts/review.md": "Review.\n",
  "profiles/codex-work/codex/skills/mine/SKILL.md": "---\nname: mine\n---\n",
  "profiles/codex-work/codex/rules/default.rules": "allow\n",
  "profiles/claude-home/claude/.claude.json": '{"oauthAccount":{"emailAddress":"x"}}',
  "profiles/claude-home/claude/.credentials.json":
    '{"claudeAiOauth":{"accessToken":"claude-oauth-secret"}}',
  "profiles/claude-home/claude/settings.json": '{"model":"opus"}',
  "profiles/claude-home/claude/CLAUDE.md": "Hello\n",
  "profiles/claude-home/claude/agents/helper.md": "agent\n",
  "profiles/claude-home/claude/commands/go.md": "go\n",
  "profiles/claude-home/claude/hooks/pre-tool.sh": "#!/bin/sh\n",
  "profiles/claude-home/claude/plugins/installed_plugins.json": '{"plugins":{}}',
  "profiles/opencode-zai/providers/zai/config/opencode/opencode.json": '{"model":"z"}',
  "profiles/opencode-zai/providers/zai/data/opencode/auth.json":
    '{"zai":{"key":"opencode-api-secret"}}',
};
/** History files by member path: public, and only with history. */
export const historyFiles = {
  "profiles/codex-work/codex/sessions/2026/10/12/rollout-a.jsonl":
    '{"type":"session_meta","payload":{"cwd":"/w"}}\n',
  "profiles/codex-work/codex/archived_sessions/rollout-old.jsonl": "{}\n",
  "profiles/codex-work/codex/history.jsonl": '{"text":"hi"}\n',
  "profiles/codex-work/codex/session_index.jsonl": '{"id":"a"}\n',
  "profiles/codex-work/codex/generated_images/a/img.png": "PNG",
  "profiles/claude-home/claude/projects/-w/session.jsonl": '{"type":"user"}\n',
  "profiles/claude-home/claude/todos/a.json": "[]",
  "profiles/claude-home/claude/file-history/a/v1": "old",
  "profiles/claude-home/claude/history.jsonl": "{}\n",
  "profiles/opencode-zai/providers/zai/data/opencode/storage/session/a.json": "{}",
};
/** Files no backup may ever hold. */
export const excludedFiles = {
  "profiles/codex-work/codex/log/codex-tui.log": "log-sentinel",
  "profiles/codex-work/codex/logs_2.sqlite": "log-sentinel",
  "profiles/codex-work/codex/cache/x.json": "cache-sentinel",
  "profiles/codex-work/codex/models_cache.json": "cache-sentinel",
  "profiles/codex-work/codex/state_5.sqlite": "state-sentinel",
  "profiles/codex-work/codex/plugins.before-sharing-1/x": "copy-sentinel",
  "profiles/codex-work/codex/skills/.system/builtin/SKILL.md": "system-sentinel",
  "profiles/codex-work/codex/skills/mine/node_modules/x.js": "module-sentinel",
  "profiles/codex-work/codex/shell_snapshots/a.sh": "shell-sentinel",
  "profiles/codex-work/codex/future-cache/blob": "unknown-sentinel",
  "profiles/claude-home/claude/debug/a.txt": "debug-sentinel",
  "profiles/claude-home/claude/statsig/a": "telemetry-sentinel",
  "profiles/claude-home/claude/telemetry/a": "telemetry-sentinel",
  "profiles/claude-home/claude/shell-snapshots/a.sh": "shell-sentinel",
  "profiles/claude-home/claude/plugins/cache/x/y": "cache-sentinel",
  "profiles/claude-home/claude/plugins/marketplaces/m/z": "clone-sentinel",
  "profiles/opencode-zai/providers/zai/cache/opencode/x": "cache-sentinel",
  "profiles/opencode-zai/providers/zai/data/opencode/log/a.log": "log-sentinel",
  "profiles/orphan/codex/auth.json": "orphan-sentinel",
  "clis/codex/bin/codex": "cli-sentinel",
};
export const threadHistory = "profiles/codex-work/codex/thread_history_1.sqlite";

/** A data folder with three managed CLI profiles in their native layouts. */
export function writeCliProfiles(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dataDir, "accounts.json"), JSON.stringify(profileAccounts));
  for (const [name, content] of Object.entries({
    ...credentialFiles,
    ...historyFiles,
    ...excludedFiles,
  })) {
    fs.mkdirSync(path.dirname(path.join(dataDir, name)), { recursive: true });
    fs.writeFileSync(path.join(dataDir, name), content, { mode: 0o600 });
  }
  const db = new DatabaseSync(path.join(dataDir, threadHistory));
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE threads(id TEXT, title TEXT)");
  db.prepare("INSERT INTO threads VALUES (?, ?)").run("a", "First thread");
  // The open connection keeps a WAL with the row, like a running CLI.
  return db;
}
