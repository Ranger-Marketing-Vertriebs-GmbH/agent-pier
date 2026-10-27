import { readSandboxProfiles } from "../../nono/nono-profiles.js";

/** The coding CLIs an agent may start; never a shell. */
export const codingTools = ["claude", "codex", "opencode"];
/** Their product names, as session names and approval texts show them. */
export const codingToolNames = Object.freeze({
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
});
/** Launch modes per CLI, as the session dialog offers them (account-store.js). */
export const launchModes = Object.freeze({
  codex: ["default", "yolo"],
  claude: ["default", "auto", "bypass"],
  opencode: ["default", "auto"],
});
/** What an agent's start uses for every option it leaves out. */
export const launchDefaults = Object.freeze({
  launchMode: Object.freeze({ codex: "yolo", claude: "auto", opencode: "auto" }),
  agentbus: true,
  agentpierTools: true,
});

const listed = (read) => {
  try {
    return read() || [];
  } catch {
    return [];
  }
};

// A connection's model ids: an endpoint's configured models, otherwise its catalog.
function models(s, connection) {
  if (connection.endpoint)
    return (connection.endpoint.models || [])
      .filter((m) => m.contextTokens)
      .map((m) => m.modelId);
  return [
    ...new Set(
      listed(() => s.providerCatalog?.list({ providerId: connection.providerId })).map(
        (m) => m.modelId,
      ),
    ),
  ];
}

/**
 * What the agent may choose from when it starts a session: its projects with
 * sessions on, the coding CLI accounts and launchable provider connections, launch
 * modes and defaults, secrets, SSH accesses and nono profiles. Names and ids only,
 * never a secret.
 */
export async function sessionOptions(w, assistantId) {
  const s = w.s;
  const executable = listed(() => [s.nonoSandbox?.executable?.()].filter(Boolean))[0];
  return {
    projects: w.sessions.projects(assistantId).map(({ projectId, name }) => ({
      id: projectId,
      name,
      worktreeDefault: true,
    })),
    accounts: listed(() => s.accounts?.list())
      .filter((a) => !a.internal && codingTools.includes(a.tool))
      .map(({ id, name, tool }) => ({ id, name, tool })),
    connections: listed(() => s.providerConnections?.list())
      .filter((c) => c.launchable && c.tools.some((tool) => codingTools.includes(tool)))
      .map((c) => ({
        id: c.id,
        name: c.name,
        tools: c.tools.filter((tool) => codingTools.includes(tool)),
        models: models(s, c),
      })),
    launchModes: structuredClone(launchModes),
    defaults: structuredClone(launchDefaults),
    secrets: listed(() => s.secrets?.list()).map(({ id, name }) => ({ id, name })),
    sshAccesses: listed(() => s.sshAccesses?.list()).map(({ id, name }) => ({
      id,
      name,
    })),
    sandboxProfiles: executable ? await readSandboxProfiles({ executable }) : [],
  };
}
