import { authorizeSsh } from "./ssh-capability.js";
import { problem } from "../../lib/storage.js";
import { sshManagementTools } from "./ssh-management-tools.js";
import { sshManagementClient } from "./ssh-management-client.js";
import { SftpSessionTools, sftpTools } from "../sftp/sftp-session-tools.js";
import { readSessionAliases } from "./ssh-session-config.js";
import { nativeSftpHost } from "./ssh-agent-policy.js";
import { helperCommand } from "./ssh-sessions.js";

// Coding sessions reach hosts natively (ssh <alias>, scp, sftp, rsync, git, tunnels)
// through their own SSH agent; there is no remote-command tool.
export const sshTools = [
  ...sshManagementTools,
  {
    name: "ssh_list_hosts",
    description:
      'List SSH and SFTP hosts currently assigned to this session. Each host\'s "use" says how to reach it: "ssh" (plain ssh/scp/sftp/rsync/git with "alias" through the session\'s SSH agent), "sftp" (plain sftp/scp with "alias"), "helper" (an interactive-shell device: run "command" in the shell, replacing <remote command>), "sftp_tools" (only the sftp_* tools) or "unavailable" (no alias in this session; "reason" says why).',
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  ...sftpTools,
];

const unavailable = {
  via: "unavailable",
  reason:
    "This session has no SSH agent alias for the host. Check the session's SSH accesses dialog; Reload & resume may help.",
};

/** How the session reaches one host: native with its alias, the helper or sftp_* tools. */
function hostUse(row, alias, helper) {
  if (row.type === "sftp") {
    if (!nativeSftpHost(row)) return { via: "sftp_tools" };
    return alias ? { via: "sftp", command: `sftp ${alias}` } : { via: "sftp_tools" };
  }
  if (row.interactiveShell)
    return { via: "helper", command: `${helper(row.id)} -- <remote command>` };
  return alias ? { via: "ssh", command: `ssh ${alias}` } : unavailable;
}

export class SshTools {
  constructor(options) {
    const { dataDir, capability, grants, store } = options;
    Object.assign(this, { dataDir, capability, grants, store });
    this.manage = sshManagementClient(dataDir, capability);
    this.sftp = new SftpSessionTools({ ...options, manage: this.manage });
  }
  async close() {
    this.closing = true;
    await this.sftp.close();
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
    if (name !== "ssh_list_hosts") throw problem("Unknown SSH tool.");
    if (Object.keys(input).length) throw problem("Invalid SSH arguments.");
    return this.listHosts(session);
  }
  async listHosts(session) {
    const inherited = new Set(await this.grants.inherited(session));
    const current = authorizeSsh(this.dataDir, this.capability);
    const explicit = new Set(this.grants.assigned(current));
    const hosts = this.store.list();
    // Discovery yields to Git; ownership and explicit grants can change meanwhile.
    for (const host of hosts)
      if (host.projectId !== current.sshTools?.project?.projectId)
        inherited.delete(host.id);
    const assigned = new Set([...explicit, ...inherited]);
    // The session agent's aliases (ssh-session-agents.js); none without an agent.
    const aliases = readSessionAliases(this.dataDir, current.id);
    const helper = (id) => helperCommand(this.dataDir, current.id, id);
    return {
      hosts: hosts
        .filter((host) => assigned.has(host.id))
        .map((row) => {
          const { id, name, host, port, username, hostFingerprint, ...rest } = row;
          const alias = Object.hasOwn(aliases, id) ? aliases[id] : undefined;
          const use = hostUse(row, alias, helper);
          return {
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
            ...(["ssh", "sftp"].includes(use.via) ? { alias } : {}),
            use,
            assignment: { project: inherited.has(id), explicit: explicit.has(id) },
          };
        }),
    };
  }
}
