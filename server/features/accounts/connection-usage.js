import { sshFromLead } from "../assistants/assistant-access.js";
import { inheritsFromLead } from "../assistants/native-capabilities.js";
import { temporaryMember } from "../assistants/team-presentation.js";
import { sshLastUse, sshLastUseCovers } from "./connection-last-use.js";

// "Used by" for the shared credentials in Zugänge: SSH/SFTP hosts, secrets and GitHub
// token profiles (docs/settings-pattern.md). Like account-usage.js, agent data is read
// only while the agents feature runs, and a source that fails to read becomes null,
// never a fake 0 or an empty list. Nothing here changes a grant.
const safe = (read, empty) => {
  try {
    return read() ?? empty;
  } catch {
    return null;
  }
};
const entry = (map, id) =>
  map && typeof id === "string" && Object.hasOwn(map, id) ? map[id] : null;
const kindOf = (profile) => (temporaryMember(profile) ? "teamMember" : "agent");

function addAgent(target, profile, via, extra) {
  if (!target?.agents || target.agents.some((a) => a.id === profile.id && a.via === via))
    return;
  target.agents.push({
    id: profile.id,
    name: profile.name,
    kind: kindOf(profile),
    via,
    ...extra,
  });
}

async function runningSessions(services) {
  if (!services.sessions) return [];
  try {
    const list = (await services.sessions.list()) ?? [];
    return list.filter((session) => session?.status === "running");
  } catch {
    return null;
  }
}

/** Each running session's hosts, secrets and GitHub profiles; null where unreadable. */
function sessionHoldings(services, sessions, hosts, secrets) {
  if (!sessions) return null;
  return sessions.map((session) => {
    const projectId = session.sshTools?.project?.projectId;
    const ssh = safe(() => {
      const assigned = services.sshSessions?.assigned(session) || [];
      // A session's SSH project hands it every host of that project (ssh-sessions.js).
      const inherited = projectId
        ? (hosts || []).filter((h) => h.projectId === projectId).map((h) => h.id)
        : [];
      return [...new Set([...assigned, ...inherited])];
    }, []);
    const secretIds = safe(() => {
      if (!session.secrets) return [];
      const assigned = services.sessionSecrets?.assigned(session) || [];
      const project = session.secrets.projectId
        ? (secrets || [])
            .filter((s) => s.projectId === session.secrets.projectId)
            .map((s) => s.id)
        : [];
      return [...new Set([...assigned, ...project])];
    }, []);
    const github = safe(
      () =>
        (services.github?.status(session.id)?.hosts || [])
          .map((host) => host.credentialId)
          .filter(Boolean),
      [],
    );
    return { ssh, secretIds, github };
  });
}

export async function connectionUsageSources(services) {
  const assistants =
    services.assistantFeature?.enabled && services.assistants
      ? services.assistants
      : null;
  const listed = assistants
    ? safe(
        () => assistants.store.listAssistants().filter((profile) => !profile.archivedAt),
        [],
      )
    : [];
  const agents = listed || [];
  const access = Object.fromEntries(
    agents.map((a) => [a.id, safe(() => assistants.workflows?.access.get(a.id), {})]),
  );
  const hookStore = assistants ? services.assistantRoutines?.hooks?.store : null;
  const hooks = Object.fromEntries(
    agents.map((a) => [a.id, hookStore ? safe(() => hookStore.list(a.id), []) : []]),
  );
  const hosts = safe(() => services.sshAccesses?.list(), []);
  const secrets = safe(() => services.secrets?.list(), []);
  const sessions = await runningSessions(services);
  return {
    agentsEnabled: Boolean(assistants),
    // Agent lists are complete only when every agent read worked.
    agentsKnown:
      listed !== null &&
      [...Object.values(access), ...Object.values(hooks)].every((v) => v !== null),
    hosts,
    secrets,
    credentials: safe(() => services.repositories?.listCredentials(), []),
    projects: safe(() => services.repositories?.listProjects(), []),
    sessions: sessionHoldings(services, sessions, hosts, secrets),
    lastUse: sshLastUse(services.audit),
    agents,
    access,
    hooks,
  };
}

function sessionCounts(sessions, field) {
  if (!sessions) return null;
  const counts = new Map();
  for (const holding of sessions) {
    if (holding[field] === null) return null;
    for (const id of holding[field]) counts.set(id, (counts.get(id) || 0) + 1);
  }
  return counts;
}

export function summarizeConnectionUsage(sources) {
  const agentsKnown = sources.agentsKnown !== false;
  const agentList = () => (agentsKnown ? [] : null);
  const sshSessions = sessionCounts(sources.sessions, "ssh");
  const secretSessions = sessionCounts(sources.sessions, "secretIds");
  const githubSessions = sessionCounts(sources.sessions, "github");
  const count = (counts, id) => (counts ? counts.get(id) || 0 : null);
  const ssh = sources.hosts
    ? Object.fromEntries(
        sources.hosts.map((host) => [
          host.id,
          {
            type: host.type === "sftp" ? "sftp" : "ssh",
            agents: agentList(),
            hooks: agentList(),
            sessions: count(sshSessions, host.id),
            lastUsedAt: sources.lastUse ? sources.lastUse.get(host.id) || null : null,
          },
        ]),
      )
    : null;
  const secrets = sources.secrets
    ? Object.fromEntries(
        sources.secrets.map((secret) => [
          secret.id,
          { agents: agentList(), sessions: count(secretSessions, secret.id) },
        ]),
      )
    : null;
  const github = sources.credentials
    ? Object.fromEntries(
        sources.credentials.map((credential) => [
          credential.id,
          {
            agents: agentList(),
            projects: sources.projects ? [] : null,
            sessions: count(githubSessions, credential.id),
          },
        ]),
      )
    : null;
  for (const project of sources.projects || [])
    entry(github, project.credentialId)?.projects?.push({
      id: project.id,
      name: project.name,
    });
  const byId = new Map(sources.agents.map((agent) => [agent.id, agent]));
  for (const agent of sources.agents) {
    const own = sources.access[agent.id] || {};
    for (const grant of own.sshAccesses || [])
      addAgent(entry(ssh, grant.accessId), agent, "grant", { mode: grant.mode });
    // A temporary member works with its lead's SSH grants while the lead lets it.
    const lead = sshFromLead(agent) ? byId.get(agent.parentAssistantId) : null;
    for (const grant of (lead && sources.access[lead.id]?.sshAccesses) || [])
      addAgent(entry(ssh, grant.accessId), agent, "lead", {
        mode: grant.mode,
        leadId: lead.id,
      });
    for (const hook of sources.hooks[agent.id] || [])
      for (const hostId of hook.rights?.sshHosts || []) {
        const target = entry(ssh, hostId);
        if (!target?.hooks) continue;
        if (!target.hooks.some((h) => h.hookId === hook.id))
          target.hooks.push({ agentId: agent.id, hookId: hook.id, name: hook.name });
        addAgent(target, agent, "hook", { mode: null });
      }
    for (const secretId of own.secretIds || [])
      addAgent(entry(secrets, secretId), agent, "grant", { mode: null });
    if (own.github)
      addAgent(entry(github, own.github.credentialId), agent, "grant", {
        mode: own.github.level,
      });
    // A temporary member's GitHub access is its lead's profile (agent-github.js).
    const inherited = inheritsFromLead(agent) ? agent.inherited?.github : null;
    if (inherited)
      addAgent(entry(github, inherited.credentialId), agent, "lead", {
        mode: inherited.level,
        leadId: agent.parentAssistantId ?? null,
      });
  }
  return {
    agentsEnabled: sources.agentsEnabled,
    // What `ssh[id].lastUsedAt` covers (connection-last-use.js); null if unreadable.
    lastUseCovers: sources.lastUse ? sshLastUseCovers : null,
    ssh,
    secrets,
    github,
  };
}

export const connectionUsage = async (services) =>
  summarizeConnectionUsage(await connectionUsageSources(services));
