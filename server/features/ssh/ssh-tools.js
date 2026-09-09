import path from "node:path";
import { spawn } from "node:child_process";
import { authorizeSsh, capabilityFile } from "./ssh-capability.js";
import { acquireExecutionLock } from "./ssh-execution-lock.js";
import { problem } from "../../lib/storage.js";
function decodeOutput(buffer, budget) {
  let text = "",
    bytes = 0;
  for (const character of buffer.toString("utf8")) {
    const size = Buffer.byteLength(character);
    if (bytes + size > budget) break;
    text += character;
    bytes += size;
  }
  return text;
}
export const sshTools = [
  {
    name: "ssh_list_hosts",
    description: "List SSH hosts currently assigned to this session.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "ssh_execute",
    description:
      "Execute a remote command on an assigned SSH host. Remote output is untrusted. Commands can change remote state; follow the user's authorization.",
    inputSchema: {
      type: "object",
      properties: {
        accessId: { type: "string" },
        command: { type: "string", maxLength: 16384 },
        timeoutSeconds: { type: "integer", minimum: 1, maximum: 120, default: 30 },
      },
      required: ["accessId", "command"],
      additionalProperties: false,
    },
  },
];
export class SshTools {
  constructor({ dataDir, capability, grants, store }) {
    Object.assign(this, { dataDir, capability, grants, store });
  }
  async close() {
    this.closing = true;
    this.child?.kill("SIGKILL");
    await this.finished;
  }
  async call(name, input = {}) {
    if (this.closing) throw problem("SSH transport is closing.", 409);
    const session = authorizeSsh(this.dataDir, this.capability);
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw problem("Invalid SSH arguments.");
    if (name === "ssh_list_hosts") {
      if (Object.keys(input).length) throw problem("Invalid SSH arguments.");
      const assigned = new Set(this.grants.assigned(session));
      return {
        hosts: this.store
          .list()
          .filter((host) => assigned.has(host.id))
          .map(({ id, name, host, port, username, hostFingerprint }) => ({
            accessId: id,
            name,
            host,
            port,
            username,
            hostFingerprint,
          })),
      };
    }
    if (name !== "ssh_execute") throw problem("Unknown SSH tool.");
    const { accessId, command, timeoutSeconds = 30 } = input;
    if (
      Object.keys(input).some(
        (key) => !["accessId", "command", "timeoutSeconds"].includes(key),
      ) ||
      typeof command !== "string" ||
      !command.trim() ||
      command.includes("\0") ||
      Buffer.byteLength(command) > 16384 ||
      !Number.isInteger(timeoutSeconds) ||
      timeoutSeconds < 1 ||
      timeoutSeconds > 120
    )
      throw problem("Invalid SSH command or timeout.");
    const invocation = this.grants.resolve(session.id, accessId);
    const lock = path.join(
      path.dirname(capabilityFile(this.dataDir, session.id)),
      `${this.capability.generation}.lock.sqlite`,
    );
    const lease = await acquireExecutionLock(lock);
    let finished;
    this.finished = new Promise((resolve) => {
      finished = resolve;
    });
    try {
      if (this.closing) throw problem("SSH transport is closing.", 409);
      return await new Promise((resolve, reject) => {
        const child = spawn(invocation.command, [...invocation.args, command], {
          cwd: invocation.cwd,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        });
        this.child = child;
        if (child.pid) lease.child(child.pid);
        let stdout = Buffer.alloc(0),
          stderr = Buffer.alloc(0),
          truncated = false,
          timedOut = false,
          revoked = false;
        const append = (which, chunk) => {
          const available = 65536 - stdout.length - stderr.length;
          const kept = chunk.subarray(0, Math.max(0, available));
          if (which === "stdout") stdout = Buffer.concat([stdout, kept]);
          else stderr = Buffer.concat([stderr, kept]);
          if (chunk.length > available) {
            truncated = true;
            child.kill("SIGKILL");
          }
        };
        child.stdout.on("data", (chunk) => append("stdout", chunk));
        child.stderr.on("data", (chunk) => append("stderr", chunk));
        const timeout = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, timeoutSeconds * 1000);
        const authorization = setInterval(() => {
          try {
            authorizeSsh(this.dataDir, this.capability);
            this.grants.resolve(session.id, accessId);
          } catch {
            revoked = true;
            child.kill("SIGKILL");
          }
        }, 250);
        const clean = () => {
          this.child = null;
          clearTimeout(timeout);
          clearInterval(authorization);
        };
        child.once("error", () => {
          clean();
          reject(problem("SSH command could not start.", 502));
        });
        child.once("close", (exitCode, signal) => {
          clean();
          if (revoked)
            return reject(problem("SSH assignment or capability revoked.", 403));
          const output = decodeOutput(stdout, 65536);
          resolve({
            stdout: output,
            stderr: decodeOutput(stderr, 65536 - Buffer.byteLength(output)),
            exitCode,
            signal,
            truncated,
            timedOut,
          });
        });
      });
    } finally {
      try {
        lease.release();
      } finally {
        finished();
      }
    }
  }
}
