// Agents (OpenClaw) with shell and SSH grants on top of the real OpenSSH fixture
// (ssh-openssh-fixture.js): the real AgentShellSsh on the registry the sessions use,
// fake agent profiles whose temporary members resolve `inherited` live from their lead
// (memberInheritance), an access mirroring AssistantAccess (sshHolder, hasSshGrants,
// sshAgents, get), and the real exec shell wrapper. `run` executes a command the way
// OpenClaw's exec does: the wrapper as the shell, the agent's PATH entries in
// OPENCLAW_PREPEND_PATH exported inside the command string, no SSH_AUTH_SOCK.
import { randomUUID } from "node:crypto";
import path from "node:path";
import { cleanEnvironment } from "../../server/features/accounts/account-store.js";
import { AgentShellSsh } from "../../server/features/assistants/agent-ssh-shell.js";
import { sshFromLead } from "../../server/features/assistants/assistant-access.js";
import { writeExecShell } from "../../server/features/assistants/exec-shell.js";
import { memberInheritance } from "../../server/features/assistants/member-grants.js";
import { personalEligible } from "../../server/features/assistants/native-capabilities.js";
import { SshAgentRegistry } from "../../server/features/ssh/ssh-agent-registry.js";
import { AGENT_FOLDER } from "../../server/features/ssh/ssh-agent-shared.js";
import { ownerFolder } from "../../server/features/ssh/ssh-session-config.js";
import { SshUserConfig } from "../../server/features/ssh/ssh-user-config-sync.js";
import { started } from "./ssh-openssh-fixture.js";

const runTimeoutMs = 30_000;
const owner = (id) => ({ kind: "agent", id });

/** The agent side of the fixture `f` (openSshFixture); closed by `close()`. */
export async function agentShellFixture(f) {
  const profiles = new Map();
  const grants = new Map();
  const registries = [];
  // As the store reads it: a temporary member's `inherited` from its lead right now.
  const get = (id) => {
    const a = profiles.get(id);
    if (!a?.teamMemberId || a.lifetime === "permanent") return a;
    const lead = profiles.get(a.parentAssistantId);
    return {
      ...a,
      inherited: memberInheritance(lead, a.memberGrants, lead?.teamShellSsh === true),
    };
  };
  const eligible = (id) => {
    const a = get(id);
    if (!a || !personalEligible(a)) throw new Error("invalid");
    return a;
  };
  // Mirrors AssistantAccess (assistant-access.js: sshHolder, hasSshGrants, sshAgents,
  // get) over the fake profiles; the real one is tested in
  // tests/integration/assistant-ssh-access.test.js and the unit fixture
  // tests/helpers/agent-ssh-shell-fixture.js mirrors it the same way.
  const access = {
    sshHolder(id) {
      const a = get(id);
      return a && sshFromLead(a) ? eligible(a.parentAssistantId) : eligible(id);
    },
    get: (id) => ({ sshAccesses: grants.get(id) ?? [] }),
    hasSshGrants(id) {
      try {
        return (grants.get(access.sshHolder(id).id) ?? []).length > 0;
      } catch {
        return false;
      }
    },
    sshAgents: () => new Set([...profiles.keys()].filter(access.hasSshGrants)),
  };
  const build = (registry) =>
    new AgentShellSsh({
      registry,
      agents: { list: () => [...profiles.keys()].map(get), get },
      store: f.store,
      access,
      restored: Promise.resolve(),
      log: f.log,
    });

  // The ~/.ssh/config block of the stand-in home, for programs calling the real ssh.
  f.registry.userConfig = new SshUserConfig({
    home: f.home,
    dataDir: f.dataDir,
    log: f.log,
  });
  const ownerPath = cleanEnvironment().PATH;
  const wrapper = writeExecShell({ root: path.join(f.root, "assistant") }, f.home, {
    sshAgentRoot: path.join(f.dataDir, "ssh-agents", AGENT_FOLDER),
  });
  const g = { registry: f.registry, shell: build(f.registry), wrapper };

  /**
   * Spawns `command` as OpenClaw's exec would for agent `id`, with its PATH entries
   * as compiled now or, with `compiled`, as an earlier apply compiled them.
   */
  function spawnAs(id, command, { env: extraEnv = {}, compiled } = {}) {
    const entries = compiled ?? g.shell.shellPath(get(id));
    const prepend = [...entries, ownerPath].join(path.delimiter);
    const script = `export PATH="\${OPENCLAW_PREPEND_PATH}\${PATH:+:$PATH}"; unset OPENCLAW_PREPEND_PATH; ${command}`;
    return started(wrapper, ["-c", script], {
      cwd: f.root,
      env: { PATH: ownerPath, HOME: f.home, OPENCLAW_PREPEND_PATH: prepend, ...extraEnv },
    });
  }

  async function runAs(id, command, options) {
    const child = spawnAs(id, command, options);
    const timer = setTimeout(() => child.kill("SIGKILL"), runTimeoutMs);
    try {
      const code = await child.exited;
      return { stdout: child.out, stderr: child.err, code };
    } finally {
      clearTimeout(timer);
    }
  }

  g.refresh = () => g.shell.refresh();

  /**
   * An agent with `grants` (of itself, or nothing for a temporary member of `lead`
   * that gets `memberGrants`); refreshed once, removed again after the test.
   */
  g.agent = async (
    t,
    { shell = "full", grants: own = [], lead, memberGrants, ...extra } = {},
  ) => {
    const id = randomUUID();
    const profile = lead
      ? {
          id,
          teamMemberId: "team-1",
          lifetime: "temporary",
          parentAssistantId: lead.id,
          memberGrants: memberGrants ?? {},
          ...extra,
        }
      : { id, shell, teamShellSsh: true, ...extra };
    profiles.set(id, profile);
    if (!lead) grants.set(id, own);
    t.after(async () => {
      profiles.delete(id);
      grants.delete(id);
      await g.shell.refresh();
    });
    await g.shell.refresh();
    const folder = ownerFolder(f.dataDir, owner(id));
    return {
      id,
      folder,
      bin: path.join(folder, "bin"),
      profile: () => get(id),
      socketPath: () => g.registry.get(owner(id))?.location.socketPath,
      run: (command, options) => runAs(id, command, options),
      start: (command, options) => spawnAs(id, command, options),
      audit: () => f.audit.filter((row) => row.details?.assistantId === id),
    };
  };

  /** Replaces the grants of agent `id`; signatures read them live. */
  g.setGrants = (id, list) => grants.set(id, list);

  /** Changes agent `id`'s profile (shell, teamShellSsh, archivedAt, ...). */
  g.update = (id, patch) => profiles.set(id, { ...profiles.get(id), ...patch });

  g.archive = (id) => g.update(id, { archivedAt: new Date().toISOString() });

  /**
   * An AgentPier restart of the agents' side: sockets close, folders and tokens stay;
   * a new registry and adapter on the same data dir start them again.
   */
  g.restart = async () => {
    await g.shell.close();
    const registry = new SshAgentRegistry({
      dataDir: f.dataDir,
      audit: { append: (row) => f.audit.push(row) },
      openssh: f.registry.openssh,
      home: f.home,
      log: f.log,
    });
    registries.push(registry);
    Object.assign(g, { registry, shell: build(registry) });
    await g.shell.refresh();
  };

  g.close = async () => {
    await g.shell.discardAll();
    for (const registry of registries) await registry.close();
  };
  return g;
}
