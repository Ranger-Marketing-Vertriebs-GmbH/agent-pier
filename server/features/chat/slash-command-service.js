import fs from "node:fs/promises";
import path from "node:path";
import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";
import { DiscoveryScan } from "./slash-discovery-files.js";
import { discoverClaude } from "./slash-discovery-claude.js";
import { discoverCodex, discoverOpenCode } from "./slash-discovery-others.js";

// The slash commands a session's CLI offers beyond its built-ins (the chat keeps the
// built-in list itself). Discovery reads the account's config folder and the session's
// project folder; a result is reused until one of the paths it read changes.

const discoverers = {
  claude: {
    root: (env) => env.CLAUDE_CONFIG_DIR || path.join(env.HOME, ".claude"),
    discover: discoverClaude,
  },
  codex: {
    root: (env) => env.CODEX_HOME || path.join(env.HOME, ".codex"),
    discover: discoverCodex,
  },
  opencode: {
    root: (env) =>
      path.join(env.XDG_CONFIG_HOME || path.join(env.HOME, ".config"), "opencode"),
    discover: discoverOpenCode,
  },
};

/** One discovery without a cache: the deduplicated entries and the paths it read. */
export async function discoverSlashCommands({ tool, env, cwd }) {
  const discoverer = discoverers[tool];
  if (!discoverer || !env?.HOME) return { commands: [], watched: [] };
  const scan = new DiscoveryScan();
  const root = discoverer.root(env);
  await discoverer.discover(scan, {
    root,
    cwd: typeof cwd === "string" && path.isAbsolute(cwd) ? cwd : null,
  });
  const seen = new Set();
  const commands = scan.entries.filter((entry) => {
    const key = entry.name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { commands, watched: [...scan.watched] };
}

async function signature(paths) {
  const parts = await Promise.all(
    paths.map((file) =>
      fs.stat(file).then(
        (stat) => `${stat.mtimeMs}:${stat.size}`,
        () => "-",
      ),
    ),
  );
  return parts.join("|");
}

export class SlashCommandService {
  constructor({
    sessions,
    accounts,
    now = Date.now,
    recheckMs = 3000,
    maxAgeMs = 5 * 60 * 1000,
    maxEntries = 64,
  }) {
    Object.assign(this, { sessions, accounts, now, recheckMs, maxAgeMs, maxEntries });
    this.cache = new Map();
    this.pending = new Map();
  }
  /** The discovered commands of a running coding-CLI session. */
  async list(sessionId) {
    const session = await this.sessions.get(sessionId);
    if (!Object.hasOwn(discoverers, session.tool) || session.purpose === "login")
      throw problem(serverMessages.chat.slashCommandsUnavailable, 409);
    const account = this.accounts.get(session.accountId);
    if (account.tool !== session.tool)
      throw problem(serverMessages.chat.sessionToolMismatch);
    const key = JSON.stringify([session.tool, account.id, session.cwd || ""]);
    if (this.pending.has(key)) return this.pending.get(key);
    const work = this.read(key, () => ({
      tool: session.tool,
      env: this.accounts.environment(account.id),
      cwd: session.cwd,
    })).finally(() => this.pending.delete(key));
    this.pending.set(key, work);
    return work;
  }
  async read(key, input) {
    const now = this.now();
    const cached = this.cache.get(key);
    if (cached && now - cached.at < this.maxAgeMs) {
      if (now - cached.checkedAt < this.recheckMs) return cached.value;
      if ((await signature(cached.watched)) === cached.signature) {
        cached.checkedAt = now;
        return cached.value;
      }
    }
    const { tool, env, cwd } = input();
    const { commands, watched } = await discoverSlashCommands({ tool, env, cwd });
    const value = { tool, commands };
    this.cache.delete(key);
    this.cache.set(key, {
      at: now,
      checkedAt: now,
      watched,
      signature: await signature(watched),
      value,
    });
    while (this.cache.size > this.maxEntries)
      this.cache.delete(this.cache.keys().next().value);
    return value;
  }
}
