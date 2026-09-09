import { observeClaude, observeCodex, observeOpenCode } from "./chat-observability.js";
import { serverMessages } from "../../lib/i18n/de.js";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { detectTools } from "../accounts/account-store.js";
import { toolBinDirectories } from "../tools/tool-paths.js";
import { problem } from "../../lib/storage.js";
import {
  normalizeClaude,
  normalizeCodex,
  normalizeCodexRecords,
  normalizeOpenCode,
} from "./history-parsers.js";
const execute = promisify(execFile);
const MAX_HISTORY = 64 * 1024 * 1024;
export function providerId(value) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/.test(value))
    throw problem(serverMessages.chat.invalidHistoryId);
  return value;
}
export async function readJsonLines(file, limit = MAX_HISTORY) {
  const handle = await fs.open(file, "r");
  try {
    if ((await handle.stat()).size > limit)
      throw problem(serverMessages.chat.historyTooLarge, 413);
    const text = await handle.readFile("utf8");
    const lines = text.split("\n");
    if (!text.endsWith("\n")) lines.pop(); // The CLI may be in the middle of appending a record.
    return lines.filter(Boolean).flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  } finally {
    await handle.close();
  }
}
async function inside(file, root) {
  const [realFile, realRoot] = await Promise.all([fs.realpath(file), fs.realpath(root)]);
  if (!realFile.startsWith(realRoot + path.sep))
    throw problem(serverMessages.chat.historyOutsideProfile);
  return realFile;
}

/** Read-only JSON-RPC client. Never resumes a thread, submits a turn or answers approvals. */
export class CodexHistoryClient {
  constructor(command, env, cwd) {
    this.pending = new Map();
    this.sequence = 0;
    this.buffer = "";
    this.child = spawn(command, ["app-server", "--listen", "stdio://"], {
      env,
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stderr.resume();
    this.child.stdout.setEncoding("utf8");
    this.child.stdin.on("error", () => {});
    this.child.stdout.on("data", (chunk) => {
      this.buffer += chunk.toString("utf8");
      if (this.buffer.length > MAX_HISTORY) {
        this.close();
        return;
      }
      let newline;
      while ((newline = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        const entry = this.pending.get(message.id);
        if (!entry || message.method) continue;
        this.pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.error)
          entry.reject(problem(serverMessages.chat.codexVersionUnsupported, 409));
        else entry.resolve(message.result);
      }
    });
    const failed = () => {
      this.closed = true;
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(problem(serverMessages.chat.codexHistoryUnavailable, 503));
      }
      this.pending.clear();
    };
    this.child.on("error", failed);
    this.child.on("exit", failed);
    this.ready = this.rpc("initialize", {
      clientInfo: {
        name: "agentpier_history",
        title: "AgentPier history",
        version: "1.0.0",
      },
      capabilities: { experimentalApi: true },
    }).then(() =>
      this.child.stdin.write(
        JSON.stringify({ method: "initialized", params: {} }) + "\n",
      ),
    );
    this.ready.catch(() => {});
  }
  rpc(method, params) {
    if (
      !["initialize", "thread/list", "thread/read", "thread/turns/list"].includes(method)
    )
      throw problem(serverMessages.chat.readOnlyHistoryRequired);
    return new Promise((resolve, reject) => {
      if (this.closed)
        return reject(problem(serverMessages.chat.codexHistoryUnavailable, 503));
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(problem(serverMessages.chat.codexReadTimeout, 504));
        this.close();
      }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }
  async request(method, params) {
    await this.ready;
    return this.rpc(method, params);
  }
  close() {
    if (this.closing) return this.closing;
    this.closed = true;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(problem(serverMessages.chat.codexDisconnected, 503));
    }
    this.pending.clear();
    this.closing = new Promise((resolve) => {
      if (this.child.exitCode !== null || this.child.signalCode !== null)
        return resolve();
      const timer = setTimeout(() => this.child.kill("SIGKILL"), 1500);
      this.child.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      this.child.kill();
    });
    return this.closing;
  }
}

export class ProviderHistory {
  constructor({ accounts, home }) {
    this.accounts = accounts;
    this.home = home;
    this.codexClients = new Map();
    this.openCodeJobs = new Set();
  }
  environment(session) {
    if (this.closed) throw problem(serverMessages.chat.serviceStopping, 503);
    if (session.tool === "shell" || session.purpose === "login")
      throw problem(serverMessages.chat.historyUnavailable, 409);
    const account = this.accounts.get(session.accountId);
    if (account.tool !== session.tool)
      throw problem(serverMessages.chat.sessionToolMismatch);
    return this.accounts.environment(account.id);
  }
  executable(tool) {
    const executable = detectTools(
      { ...process.env, HOME: this.home },
      true,
      toolBinDirectories(this.accounts.dataDir),
    ).find((item) => item.id === tool)?.path;
    if (!executable) throw problem(serverMessages.chat.cliUnavailableOnHost(tool), 409);
    return executable;
  }
  async claudeDirectory(session) {
    const env = this.environment(session);
    const root = env.CLAUDE_CONFIG_DIR || path.join(env.HOME || this.home, ".claude");
    const slug = session.cwd.replace(/[^a-zA-Z0-9]/g, "-");
    const projects = path.join(root, "projects");
    let directories = [path.join(projects, slug)];
    if (slug.length > 200) {
      const entries = await fs.readdir(projects, { withFileTypes: true }).catch(() => []);
      directories = entries
        .filter((e) => e.isDirectory() && e.name.startsWith(slug.slice(0, 200)))
        .map((e) => path.join(projects, e.name));
    }
    return { root, directories };
  }
  async claudeFile(session, id) {
    providerId(id);
    const { root, directories } = await this.claudeDirectory(session);
    for (const directory of directories) {
      const file = path.join(directory, id + ".jsonl");
      try {
        return await inside(file, root);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    throw problem(serverMessages.chat.sessionHistoryPending, 404);
  }
  claudeMatches(records, session, id) {
    const metadata = records.find((r) => r?.cwd && r.sessionId && !r.isSidechain);
    return metadata?.cwd === session.cwd && metadata.sessionId === id;
  }
  codex(session) {
    const env = this.environment(session);
    let client = this.codexClients.get(session.accountId);
    if (!client || client.closed) {
      client = new CodexHistoryClient(this.executable("codex"), env, this.home);
      this.codexClients.set(session.accountId, client);
    }
    return client;
  }
  async queue(session, nativeId, text) {
    if (session.tool !== "codex") throw problem(serverMessages.chat.sessionToolMismatch);
    providerId(nativeId);
    if (typeof text !== "string") throw new TypeError("Invalid queue message");
    await execute(
      this.executable("codex"),
      ["queue", "--thread", nativeId, "--message", text],
      {
        cwd: session.cwd,
        env: this.environment(session),
        timeout: 15000,
        maxBuffer: 64 * 1024,
      },
    );
  }
  async opencode(session, args) {
    const env = this.environment(session);
    let job;
    try {
      const operation = execute(this.executable("opencode"), args, {
        env,
        cwd: session.cwd,
        timeout: 15000,
        killSignal: "SIGKILL",
        maxBuffer: MAX_HISTORY,
      });
      job = {
        child: operation.child,
        done: new Promise((resolve) => operation.child.once("close", resolve)),
      };
      this.openCodeJobs.add(job);
      const { stdout } = await operation;
      return JSON.parse(stdout);
    } catch {
      throw problem(
        this.closed
          ? serverMessages.chat.serviceStopping
          : serverMessages.chat.openCodeHistoryUnavailable,
        this.closed ? 503 : 409,
      );
    } finally {
      if (job) this.openCodeJobs.delete(job);
    }
  }
  async list(session) {
    if (session.tool === "shell" || session.purpose === "login")
      throw problem(serverMessages.chat.historyUnavailable, 409);
    if (session.tool === "claude") {
      const { directories } = await this.claudeDirectory(session);
      const choices = [];
      for (const directory of directories) {
        const entries = await fs
          .readdir(directory, { withFileTypes: true })
          .catch(() => []);
        for (const entry of entries) {
          if (!entry.isFile() || !/^[a-zA-Z0-9_-]+\.jsonl$/.test(entry.name)) continue;
          const id = entry.name.slice(0, -6);
          const file = await this.claudeFile(session, id);
          const handle = await fs.open(file, "r");
          let head;
          try {
            const buffer = Buffer.alloc(128 * 1024);
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
            head = buffer.subarray(0, bytesRead).toString("utf8");
          } finally {
            await handle.close();
          }
          const records = head.split("\n").flatMap((line) => {
            try {
              return [JSON.parse(line)];
            } catch {
              return [];
            }
          });
          if (!this.claudeMatches(records, session, id)) continue;
          const first = records.find(
            (r) =>
              r?.type === "user" && typeof r.message?.content === "string" && !r.isMeta,
          )?.message.content;
          const info = await fs.stat(file);
          choices.push({
            id,
            title: first?.slice(0, 100) || `Claude · ${id.slice(0, 8)}`,
            updatedAt: info.mtime.toISOString(),
          });
        }
      }
      return choices.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 100);
    }
    if (session.tool === "codex") {
      const result = await this.codex(session).request("thread/list", {
        cwd: session.cwd,
        limit: 100,
        sortKey: "updated_at",
        sourceKinds: ["cli", "appServer"],
      });
      return (result.data || [])
        .filter((t) => t.cwd === session.cwd)
        .map((t) => ({
          id: t.id,
          title: t.name || t.preview?.slice(0, 100) || `Codex · ${t.id.slice(0, 8)}`,
          updatedAt: new Date(t.updatedAt * 1000).toISOString(),
        }));
    }
    const result = await this.opencode(session, ["session", "list", "--format", "json"]);
    return (Array.isArray(result) ? result : result.sessions || [])
      .filter((s) => s.directory === session.cwd && !s.parentID)
      .map((s) => ({
        id: s.id,
        title: s.title || s.id,
        updatedAt: new Date(s.time?.updated || Date.now()).toISOString(),
      }));
  }
  async read(session, id) {
    providerId(id);
    this.environment(session);
    if (session.tool === "claude") {
      const records = await readJsonLines(await this.claudeFile(session, id));
      if (!records.some((r) => r?.cwd && r.sessionId && !r.isSidechain))
        throw problem(serverMessages.chat.sessionHistoryBeingWritten, 404);
      if (!this.claudeMatches(records, session, id))
        throw problem(serverMessages.chat.sessionHistoryMismatch, 409);
      return { ...normalizeClaude(records), observability: observeClaude(records) };
    }
    if (session.tool === "codex") {
      const client = this.codex(session);
      // Fetch metadata first: paginated stores cannot include turns in thread/read.
      const { thread } = await client.request("thread/read", {
        threadId: id,
        includeTurns: false,
      });
      if (thread?.cwd !== session.cwd)
        throw problem(serverMessages.chat.historyProjectMismatch, 409);
      let full;
      try {
        full = (
          await client.request("thread/read", {
            threadId: id,
            includeTurns: true,
          })
        ).thread;
      } catch (error) {
        if (error.status !== 409) throw error;
        const turns = [];
        let cursor;
        do {
          const page = await client.request("thread/turns/list", {
            threadId: id,
            limit: 100,
            itemsView: "full",
            sortDirection: "desc",
            ...(cursor ? { cursor } : {}),
          });
          turns.push(...(page.data || []));
          cursor = page.nextCursor;
        } while (cursor && turns.length < 1000);
        full = { ...thread, turns: turns.reverse() };
      }
      const result = { ...normalizeCodex(full), observability: observeCodex(full) };
      if (thread.path) {
        const env = this.environment(session),
          root = env.CODEX_HOME || path.join(env.HOME, ".codex");
        try {
          const records = await readJsonLines(await inside(thread.path, root));
          const meta = records.find((r) => r?.type === "session_meta")?.payload;
          if (meta?.id === id && meta.cwd === session.cwd) {
            result.tasks = normalizeCodexRecords(records).tasks;
            result.observability = observeCodex(full, records);
          }
        } catch {
          /* Structured thread messages remain readable when legacy rollout storage is unavailable. */
        }
      }
      return result;
    }
    const exported = await this.opencode(session, ["export", id]);
    if (exported.info?.id !== id || exported.info?.directory !== session.cwd)
      throw problem(serverMessages.chat.historyProjectMismatch, 409);
    return { ...normalizeOpenCode(exported), observability: observeOpenCode(exported) };
  }
  async codexRolloutIdentity(session, file) {
    if (session.tool !== "codex") return null;
    const env = this.environment(session),
      root = env.CODEX_HOME || path.join(env.HOME, ".codex");
    const verified = await inside(file, root);
    const handle = await fs.open(verified, "r");
    try {
      const buffer = Buffer.alloc(128 * 1024);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const text = buffer.subarray(0, bytesRead).toString("utf8");
      const end = text.lastIndexOf("\n");
      if (end < 0) return null;
      const complete = text.slice(0, end);
      const records = complete.split("\n").flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
      const meta = records.find((record) => record?.type === "session_meta")?.payload;
      if (
        !meta?.id ||
        !meta.cwd ||
        (await fs.realpath(meta.cwd)) !== (await fs.realpath(session.cwd))
      )
        return null;
      return providerId(meta.id);
    } finally {
      await handle.close();
    }
  }
  async close() {
    if (this.closing) return this.closing;
    this.closed = true;
    const jobs = [...this.openCodeJobs];
    for (const job of jobs) job.child.kill("SIGKILL");
    this.closing = Promise.all(
      [...this.codexClients.values()]
        .map((client) => client.close())
        .concat(jobs.map((job) => job.done)),
    ).then(() => this.codexClients.clear());
    return this.closing;
  }
}
