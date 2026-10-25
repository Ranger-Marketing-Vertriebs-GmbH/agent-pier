import { missingScopes } from "../assistants/agent-github.js";
import { inheritsFromLead } from "../assistants/native-capabilities.js";
import { directoryUpdate } from "../mcp-directory/updates.js";
import { decoratedMcpServers } from "../mcp-servers/mcp-server-list.js";

// "Mit Problemen" and the Zugänge menu hint (docs/settings-pattern.md). Reads stored
// state only: no connection test, token check, registry request or CLI sign-in probe
// runs here. Each category is `{ total, problems, warnings, unknown }`, where problems
// and warnings list `{ id, reasons }` and `unknown` names checks that could not be
// read; a category whose source fails is null, never an empty list.
const attempt = async (read) => {
  try {
    return (await read()) ?? null;
  } catch {
    return null;
  }
};
const category = (total, items = [], unknown = []) => ({
  total,
  problems: items
    .filter((item) => item.problem.length)
    .map(({ id, problem }) => ({
      id,
      reasons: problem,
    })),
  warnings: items
    .filter((item) => item.warning.length)
    .map(({ id, warning }) => ({
      id,
      reasons: warning,
    })),
  unknown,
});

function sshProblems(services) {
  const store = services.sshAccesses;
  if (!store) return null;
  const hosts = store.withLastTests(store.list());
  return category(
    hosts.length,
    hosts.map((host) => ({
      id: host.id,
      problem:
        host.lastTest?.ok === false
          ? [host.lastTest.hostKeyMismatch ? "hostKeyMismatch" : "testFailed"]
          : [],
      warning: [],
    })),
  );
}

const cliTrouble = new Set(["error", "conflict", "name-taken"]);
const signInTrouble = new Set(["login-required", "failed"]);

async function mcpProblems(services) {
  if (!services.mcpServerChanges) return null;
  const servers = await decoratedMcpServers(services, services.mcpServerChanges.list());
  const directory = services.mcpDirectory;
  let updatesKnown = true;
  const items = servers.map((server) => {
    const problem = [];
    if (["failed", "missing"].includes(server.source?.status))
      problem.push("installFailed");
    const clis = Object.values(server.cliStatus || {});
    if (clis.some((status) => cliTrouble.has(status.status))) problem.push("cliError");
    const cliSignIn = clis.some(
      (status) =>
        signInTrouble.has(status.oauth?.state) ||
        (status.oauth?.accounts || []).some((account) =>
          signInTrouble.has(account.state),
        ),
    );
    if (server.oauthStatus === "login-required" || cliSignIn)
      problem.push("loginRequired");
    const warning = [];
    if (server.directoryOrigin && directory) {
      // Only an answer an earlier update check left in the cache; never a request.
      const detail = (() => {
        try {
          return directory.cachedDetail(server.directoryOrigin.name);
        } catch {
          return undefined;
        }
      })();
      if (detail === undefined) updatesKnown = false;
      else if (directoryUpdate(server, detail)?.version) warning.push("updateAvailable");
    }
    return { id: server.id, problem, warning };
  });
  return category(servers.length, items, updatesKnown ? [] : ["updates"]);
}

const chatgptStatus = {
  expired: ["problem", "signInExpired"],
  missing: ["problem", "signInMissing"],
  invalid: ["problem", "signInInvalid"],
  expiring: ["warning", "signInExpiring"],
};

function modelProblems(services, agentsOn) {
  const connections = services.providerConnections.list();
  const accounts = services.accounts.list();
  const items = connections.map((connection) => ({
    id: connection.id,
    problem: connection.launchable === false ? ["keyMissing"] : [],
    warning: [],
  }));
  const unknown = accounts.length ? ["cliAccountSignIn"] : [];
  // ChatGPT for agents: the stored sign-in state, never a Gateway read.
  if (agentsOn && services.assistantModelAccounts) {
    for (const account of services.assistantModelAccounts.capabilities()) {
      const [kind, reason] = chatgptStatus[account.status] || [];
      items.push({
        id: account.id,
        problem: kind === "problem" ? [reason] : [],
        warning: kind === "warning" ? [reason] : [],
      });
    }
  }
  return category(connections.length + accounts.length, items, unknown);
}

const tokenTrouble = {
  invalid: ["problem", "tokenInvalid"],
  expired: ["problem", "tokenExpired"],
  error: ["problem", "checkFailed"],
  expiring: ["warning", "tokenExpiring"],
};

// Highest GitHub level agents use per profile, from their own and inherited access.
function githubLevelsInUse(services) {
  const assistants = services.assistants;
  const levels = new Map();
  const raise = (access) => {
    if (!access?.credentialId) return;
    if (access.level === "write" || !levels.has(access.credentialId))
      levels.set(access.credentialId, access.level);
  };
  for (const agent of assistants.store.listAssistants()) {
    if (agent.archivedAt) continue;
    if (inheritsFromLead(agent)) raise(agent.inherited?.github);
    else raise(assistants.workflows?.access.get(agent.id)?.github);
  }
  return levels;
}

function githubProblems(services, agentsOn) {
  if (!services.repositories) return null;
  const credentials = services.repositories.listCredentials();
  let levels = null;
  if (agentsOn) {
    try {
      levels = githubLevelsInUse(services);
    } catch {
      levels = null;
    }
  }
  const items = credentials.map((credential) => {
    const problem = [];
    const warning = [];
    const [kind, reason] = tokenTrouble[credential.tokenCheck?.state] || [];
    if (kind === "problem") problem.push(reason);
    if (kind === "warning") warning.push(reason);
    const level = levels?.get(credential.id);
    if (level && missingScopes(credential.tokenCheck?.scopes, level)?.length)
      problem.push("missingScopes");
    return { id: credential.id, problem, warning };
  });
  return category(credentials.length, items, agentsOn && !levels ? ["scopes"] : []);
}

function secretProblems(services) {
  if (!services.secrets) return null;
  return category(services.secrets.list().length);
}

function serviceProblems(services, agentsOn) {
  if (!agentsOn) return null;
  const webSearch = services.assistantWebSearch?.get();
  if (!webSearch) return null;
  return category(1, [
    {
      id: "webSearch",
      problem: [],
      warning: webSearch.ready === false ? ["notConfigured"] : [],
    },
  ]);
}

export async function connectionProblems(services) {
  const agentsOn = Boolean(services.assistantFeature?.enabled && services.assistants);
  return {
    agentsEnabled: agentsOn,
    models: await attempt(() => modelProblems(services, agentsOn)),
    services: await attempt(() => serviceProblems(services, agentsOn)),
    mcp: await attempt(() => mcpProblems(services)),
    ssh: await attempt(() => sshProblems(services)),
    secrets: await attempt(() => secretProblems(services)),
    github: await attempt(() => githubProblems(services, agentsOn)),
  };
}
