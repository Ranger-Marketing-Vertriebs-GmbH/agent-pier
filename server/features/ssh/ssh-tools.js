import path from "node:path";
import { spawn } from "node:child_process";
import { authorizeSsh, capabilityFile } from "./ssh-capability.js";
import { acquireExecutionLock } from "./ssh-execution-lock.js";
import { problem } from "../../lib/storage.js";
import { sshManagementTools } from "./ssh-management-tools.js";
import { sshManagementClient } from "./ssh-management-client.js";
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
  ...sshManagementTools,
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
    this.manage = sshManagementClient(dataDir, capability);
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
    if (sshManagementTools.some((tool) => tool.name === name))
      return this.manage(name, input);
    if (name === "ssh_list_hosts") {
      if (Object.keys(input).length) throw problem("Invalid SSH arguments.");
      const inherited = new Set(await this.grants.inherited(session));
      const current = authorizeSsh(this.dataDir, this.capability);
      const explicit = new Set(this.grants.assigned(current));
      const hosts = this.store.list();
      // Discovery yields to Git; ownership and explicit grants can change meanwhile.
      for (const host of hosts)
        if (host.projectId !== current.sshTools?.project?.projectId)
          inherited.delete(host.id);
      const assigned = new Set([...explicit, ...inherited]);
      return {
        hosts: hosts
          .filter((host) => assigned.has(host.id))
          .map(({ id, name, host, port, username, hostFingerprint }) => ({
            accessId: id,
            name,
            host,
            port,
            username,
            hostFingerprint,
            assignment: { project: inherited.has(id), explicit: explicit.has(id) },
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
    const lock = path.join(
      path.dirname(capabilityFile(this.dataDir, session.id)),
      `${this.capability.generation}.lock.sqlite`,
    );
    const lease = await acquireExecutionLock(lock);
    let invocation;
    let finished;
    this.finished = new Promise((resolve) => {
      finished = resolve;
    });
    try {
      if (this.closing) throw problem("SSH transport is closing.", 409);
      invocation = await this.grants.resolve(session.id, accessId);
      authorizeSsh(this.dataDir, this.capability);
      if (
        this.closing ||
        (this.store.revision && invocation.revision !== this.store.revision(accessId))
      )
        throw problem("SSH assignment or capability revoked.", 403);
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
        let checking = false,
          ended = false;
        const authorization = setInterval(async () => {
          if (checking || ended) return;
          checking = true;
          try {
            const current = authorizeSsh(this.dataDir, this.capability);
            if (
              !(await this.grants.effective(current)).includes(accessId) ||
              (this.store.revision &&
                invocation.revision !== this.store.revision(accessId))
            )
              throw Error();
            authorizeSsh(this.dataDir, this.capability);
          } catch {
            if (!ended) {
              revoked = true;
              child.kill("SIGKILL");
            }
          } finally {
            checking = false;
          }
        }, 250);
        const clean = () => {
          ended = true;
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
        try {
          invocation?.cleanup?.();
        } finally {
          lease.release();
        }
      } finally {
        finished();
      }
    }
  }
}
