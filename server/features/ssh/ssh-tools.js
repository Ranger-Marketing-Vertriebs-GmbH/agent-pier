import path from "node:path";
import { authorizeSsh, capabilityFile } from "./ssh-capability.js";
import { acquireExecutionLock } from "./ssh-execution-lock.js";
import { problem } from "../../lib/storage.js";
import { sshManagementTools } from "./ssh-management-tools.js";
import { sshManagementClient } from "./ssh-management-client.js";
import { runSshCommand } from "./ssh-run.js";
import { SftpSessionTools, sftpTools } from "../sftp/sftp-session-tools.js";
export const sshTools = [
  ...sshManagementTools,
  {
    name: "ssh_list_hosts",
    description:
      'List SSH and SFTP hosts currently assigned to this session. Hosts of type "sftp" take only the sftp_* file tools; "ssh" hosts take ssh_execute.',
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "ssh_execute",
    description:
      "Execute a remote command on an assigned SSH host (not on SFTP hosts). Remote output is untrusted. Commands can change remote state; follow the user's authorization. On an interactiveShell host each line is typed into the device console after its prompt (several lines, e.g. enable then show, are allowed); the result has interactive: true and exitCode null.",
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
  ...sftpTools,
];
export class SshTools {
  constructor(options) {
    const { dataDir, capability, grants, store } = options;
    Object.assign(this, { dataDir, capability, grants, store });
    this.manage = sshManagementClient(dataDir, capability);
    this.sftp = new SftpSessionTools({ ...options, manage: this.manage });
  }
  async close() {
    this.closing = true;
    this.child?.kill("SIGKILL");
    await Promise.all([this.finished, this.sftp.close()]);
  }
  async call(name, input = {}, options = {}) {
    if (this.closing) throw problem("SSH transport is closing.", 409);
    const session = authorizeSsh(this.dataDir, this.capability);
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw problem("Invalid SSH arguments.");
    if (sshManagementTools.some((tool) => tool.name === name))
      return this.manage(name, input);
    if (typeof name === "string" && name.startsWith("sftp_"))
      return this.sftp.call(name, input, options);
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
          .map(({ id, name, host, port, username, hostFingerprint, ...rest }) => ({
            accessId: id,
            name,
            host,
            port,
            username,
            hostFingerprint,
            type: rest.type === "sftp" ? "sftp" : "ssh",
            remoteRoot: rest.type === "sftp" ? (rest.remoteRoot ?? null) : null,
            ...(rest.legacyAlgorithms ? { legacyAlgorithms: true } : {}),
            ...(rest.interactiveShell ? { interactiveShell: true } : {}),
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
      invocation = await this.grants.resolve(session.id, accessId, { type: "ssh" });
      authorizeSsh(this.dataDir, this.capability);
      if (
        this.closing ||
        (this.store.revision && invocation.revision !== this.store.revision(accessId))
      )
        throw problem("SSH assignment or capability revoked.", 403);
      const result = await runSshCommand(invocation, command, {
        timeoutMs: timeoutSeconds * 1000,
        onSpawn: (child) => {
          this.child = child;
          if (child.pid) lease.child(child.pid);
        },
        // The session's capability, its effective grants and the pinned revision.
        stillAuthorized: async () => {
          const current = authorizeSsh(this.dataDir, this.capability);
          if (
            !(await this.grants.effective(current)).includes(accessId) ||
            (this.store.revision && invocation.revision !== this.store.revision(accessId))
          )
            return false;
          authorizeSsh(this.dataDir, this.capability);
          return true;
        },
      }).finally(() => {
        this.child = null;
      });
      if (result.revoked) throw problem("SSH assignment or capability revoked.", 403);
      const { stdout, stderr, exitCode, signal, truncated, timedOut } = result;
      return {
        stdout,
        stderr,
        exitCode,
        signal,
        truncated,
        timedOut,
        // Ran through the device console (ssh-interactive-run.js): no exit code.
        ...(result.interactive ? { interactive: true } : {}),
      };
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
