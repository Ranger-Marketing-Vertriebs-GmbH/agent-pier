// Fixtures of the agent SSH agent tests (agent-ssh-shell.js): a temp data dir per
// test, fake agents whose temporary members resolve `inherited` live from their lead
// the way the store does (memberInheritance), a fake access mirroring AssistantAccess
// (sshHolder, hasSshGrants, sshAgents, get), a recorded dispatcher, listeners and
// session token reads. The home is the /tmp stand-in, never the real one.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AgentShellSsh } from "../../server/features/assistants/agent-ssh-shell.js";
import { sshFromLead } from "../../server/features/assistants/assistant-access.js";
import { memberInheritance } from "../../server/features/assistants/member-grants.js";
import { personalEligible } from "../../server/features/assistants/native-capabilities.js";
import { SshAgentRegistry } from "../../server/features/ssh/ssh-agent-registry.js";
import { agentSocketLocation } from "../../server/features/ssh/ssh-agent-socket.js";
import { ownerFolder } from "../../server/features/ssh/ssh-session-config.js";
import { home, hostA, hostB, root } from "./ssh-session-agents-fixture.js";

export const owner = (agent) => ({ kind: "agent", id: agent.id });
export const personal = (extra = {}) => ({
  id: randomUUID(),
  shell: "approval",
  teamShellSsh: true,
  ...extra,
});
export const trusted = (access) => ({ accessId: access.id, mode: "trusted" });

/** A temporary member of `lead` granted `memberGrants` (shell, ssh). */
export const member = (lead, memberGrants, extra = {}) => ({
  id: randomUUID(),
  teamMemberId: "team-1",
  lifetime: "temporary",
  parentAssistantId: lead.id,
  memberGrants,
  ...extra,
});

let counter = 0;

export function setup(t, { openssh = { major: 10, minor: 2 }, pathEnv, restored } = {}) {
  counter += 1;
  const dataDir = path.join(root, `agent-shell-${counter}`);
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const s = {
    dataDir,
    agents: new Map(),
    grants: new Map(),
    maintenance: false,
    accessFails: false,
    sessionTokens: [],
    sessionReads: 0,
    heard: [],
    updates: 0,
    logs: [],
    instances: [],
  };
  // As the store reads it: a temporary member's `inherited` from its lead right now.
  s.get = (id) => {
    const a = s.agents.get(id);
    if (!a?.teamMemberId || a.lifetime === "permanent") return a;
    const lead = s.agents.get(a.parentAssistantId);
    return {
      ...a,
      inherited: memberInheritance(
        lead,
        a.memberGrants ?? {},
        lead?.teamShellSsh === true,
      ),
    };
  };
  const eligible = (id) => {
    const a = s.get(id);
    if (!a || !personalEligible(a)) throw new Error("invalid");
    return a;
  };
  s.access = {
    sshHolder(id) {
      const a = s.get(id);
      return a && sshFromLead(a) ? eligible(a.parentAssistantId) : eligible(id);
    },
    get: (id) => ({ sshAccesses: s.grants.get(id) ?? [] }),
    hasSshGrants(id) {
      if (s.accessFails) throw new Error("database is locked");
      try {
        return (s.grants.get(s.access.sshHolder(id).id) ?? []).length > 0;
      } catch {
        return false;
      }
    },
    sshAgents({ strict = false } = {}) {
      if (s.accessFails) {
        if (strict) throw new Error("database is locked");
        return new Set();
      }
      return new Set([...s.agents.keys()].filter((id) => s.access.hasSshGrants(id)));
    },
  };
  s.add = (agent, grants) => {
    s.agents.set(agent.id, agent);
    if (grants) s.grants.set(agent.id, grants);
    return agent;
  };
  s.build = ({ registry: shared } = {}) => {
    const log = {
      warn: (...args) => s.logs.push(["warn", ...args]),
      error: (...args) => s.logs.push(["error", ...args]),
    };
    const registry =
      shared ??
      new SshAgentRegistry({
        dataDir,
        audit: { append() {} },
        openssh,
        home,
        log,
        userConfig: { update: () => (s.updates += 1), problemFor: () => null },
      });
    if (!shared) {
      registry.tokenSource("session", () => {
        s.sessionReads += 1;
        return s.sessionTokens;
      });
      registry.listen("agent", (id) => s.heard.push(id));
    }
    const shell = new AgentShellSsh({
      registry,
      agents: { list: () => [...s.agents.keys()].map(s.get), get: s.get },
      store: { list: () => [hostA, hostB] },
      access: s.access,
      maintenance: () => s.maintenance,
      restored,
      pathEnv,
      log,
    });
    s.instances.push({ registry, shell });
    Object.assign(s, { registry, shell });
    return s;
  };
  s.folder = (agent) => ownerFolder(dataDir, owner(agent));
  s.socketPath = (agent) => s.registry.get(owner(agent))?.location.socketPath;
  s.tokenFolder = (agent, token) =>
    path.dirname(agentSocketLocation(dataDir, agent.id, token, { home }).socketPath);
  s.state = (agent) => path.join(s.folder(agent), "state.json");
  t.after(async () => {
    for (const { shell, registry } of s.instances) {
      await shell.close();
      await registry.close();
    }
    s.accessFails = false;
    const last = s.build();
    await last.shell.discardAll();
  });
  return s.build();
}
