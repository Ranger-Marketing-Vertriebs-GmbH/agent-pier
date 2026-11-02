import { spawn } from "node:child_process";
import { serverMessages } from "../../../lib/i18n/de.js";
import { problem } from "../../../lib/storage.js";
import { MAX_HISTORY } from "../../chat/history-files.js";

/** Read-only JSON-RPC client. Never resumes a thread, submits a turn or answers approvals. */
export class CodexHistoryClient {
  constructor(command, env, cwd, configArgs = []) {
    this.pending = new Map();
    this.sequence = 0;
    this.buffer = "";
    this.child = spawn(command, [...configArgs, "app-server", "--listen", "stdio://"], {
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
      ![
        "initialize",
        "thread/list",
        "thread/read",
        "thread/turns/list",
        "model/list",
      ].includes(method)
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
