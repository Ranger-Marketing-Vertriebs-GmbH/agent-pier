import { CodexRolloutMetadata } from "./codex-rollout-metadata.js";
import { CodexChildUsage } from "./codex-child-usage.js";
import { ClaudeHistoryPages } from "./claude-history-pages.js";
import { ClaudeSubagentUsage } from "./claude-subagent-usage.js";
import { readHistoryPage } from "./history-page.js";
import { serverMessages } from "../../lib/i18n/de.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { detectTools } from "../accounts/account-store.js";
import { toolBinDirectories } from "../tools/tool-paths.js";
import { problem } from "../../lib/storage.js";
import { MAX_HISTORY, providerId } from "./history-files.js";
import { CodexHistoryClient } from "../clis/codex/history-client.js";
import * as claudeHistory from "../clis/claude/history.js";
import * as codexHistory from "../clis/codex/history.js";
import { cliDriver } from "../clis/drivers.js";
import { isCodingCli } from "../clis/catalog.js";
export { providerId, readJsonLines } from "./history-files.js";
export { CodexHistoryClient } from "../clis/codex/history-client.js";
const execute = promisify(execFile);
// Other tools fail in environment(), as they did when they fell through to OpenCode.
const historyOf = (tool) => cliDriver(isCodingCli(tool) ? tool : "opencode").history;

/**
 * Reads a session's native CLI history through its driver (`cliDriver(tool).history`)
 * and owns the state those readers share: Codex app-server clients, running OpenCode
 * calls, Claude page indexes and usage scans.
 */
export class ProviderHistory {
  constructor({
    accounts,
    home,
    codexClientFactory = (command, env, cwd, configArgs) =>
      new CodexHistoryClient(command, env, cwd, configArgs),
  }) {
    this.accounts = accounts;
    this.home = home;
    this.codexClientFactory = codexClientFactory;
    this.codexClients = new Map();
    this.codexMetadata = new CodexRolloutMetadata();
    this.codexChildren = new CodexChildUsage();
    this.openCodeJobs = new Set();
    this.claudePages = new ClaudeHistoryPages({
      onIndexed: (event) => this.onIndexed?.(event),
    });
    // A finished background scan re-reads the chat like a finished index does.
    this.claudeUsage = new ClaudeSubagentUsage({
      root: async (session) => (await this.claudeDirectory(session)).root,
      onUpdated: (event) => this.onIndexed?.({ ...event, replaced: false }),
    });
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
  claudeDirectory(session) {
    return claudeHistory.directory(this, session);
  }
  claudeFile(session, id) {
    return claudeHistory.file(this, session, id);
  }
  claudeMatches(records, session, id) {
    return claudeHistory.matches(records, session, id);
  }
  codex(session) {
    const env = this.environment(session);
    const key = `${session.accountId}\0${session.cwd}`;
    let client = this.codexClients.get(key);
    if (!client || client.closed) {
      client = this.codexClientFactory(
        this.executable("codex"),
        env,
        this.home,
        this.accounts.credentialArgs(session.accountId),
      );
      this.codexClients.set(key, client);
    }
    return client;
  }
  async codexRequest(session, operation) {
    const client = this.codex(session);
    try {
      return await operation(client);
    } catch (error) {
      if (!client.closed || error.status !== 503) throw error;
      const key = `${session.accountId}\0${session.cwd}`;
      if (this.codexClients.get(key) === client) this.codexClients.delete(key);
      if (client.close) await client.close().catch(() => {});
      return operation(this.codex(session));
    }
  }
  readCodexModels(session) {
    return codexHistory.readModels(this, session);
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
    return historyOf(session.tool).list(this, session);
  }
  async readPage(session, id, state = null) {
    providerId(id);
    this.environment(session);
    return readHistoryPage(this, session, id, state);
  }
  async readReloadContext(session, id) {
    if (!isCodingCli(session.tool)) return this.read(session, id);
    return cliDriver(session.tool).history.readReloadContext(this, session, id);
  }
  async read(session, id) {
    providerId(id);
    this.environment(session);
    return historyOf(session.tool).read(this, session, id);
  }
  codexRolloutIdentity(session, file) {
    return codexHistory.rolloutIdentity(this, session, file);
  }
  async close() {
    if (this.closing) return this.closing;
    this.closed = true;
    this.claudeUsage.close();
    const jobs = [...this.openCodeJobs];
    for (const job of jobs) job.child.kill("SIGKILL");
    this.closing = Promise.all(
      [...this.codexClients.values()]
        .map((client) => client.close())
        .concat(
          jobs.map((job) => job.done),
          this.claudePages.close(),
        ),
    ).then(() => this.codexClients.clear());
    return this.closing;
  }
}
