import path from "node:path";
import { privateFolder } from "../../runtime-paths.js";

/**
 * AgentPier's private Hermes folder, `<data>/assistants/hermes/`, shaped like
 * runtime-paths.js so the update journal (runtime-updates.js) snapshots and restores
 * it: `home`, `state` and `workspaces` hold one folder per agent (its HOME, its
 * HERMES_HOME and, for an id AgentPier did not make, its work directory), `runtimes`
 * the pinned installations, `tmp` and `logs` per-agent scratch and process logs.
 * `agentWorkspaces` is AgentPier's own agent workspace root (runtime-paths.js
 * `workspaces`), shared with OpenClaw agents. Never `~/.hermes`, never a global Python.
 */
export function hermesPaths(dataDir) {
  const assistants = privateFolder(path.join(dataDir, "assistants"));
  const root = privateFolder(path.join(assistants, "hermes"));
  const paths = {
    root,
    agentWorkspaces: privateFolder(path.join(assistants, "workspaces")),
  };
  for (const name of ["home", "state", "workspaces", "logs", "runtimes", "tmp"])
    paths[name] = privateFolder(path.join(root, name));
  return paths;
}

// Agent ids become folder names; anything else is refused before it reaches a path.
const agentId = (id) => {
  if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id))
    throw Object.assign(Error("Invalid Hermes agent id."), { code: "HERMES_AGENT_ID" });
  return id;
};

/**
 * The work folder of runtime agent id `id` below `paths` (hermesPaths), not created:
 * an agent AgentPier made (`ap-<assistant id>`, assistant-store.js) works in its own
 * agent workspace `<data>/assistants/workspaces/<assistant id>`, the folder OpenClaw
 * agents work in, so its chat attachments, shared files, secrets and transfers are
 * where its commands run; any other id in `hermes/workspaces/<id>`.
 */
export function hermesWorkspace(paths, id) {
  const name = agentId(id);
  return /^ap-[A-Za-z0-9-]{1,100}$/.test(name)
    ? path.join(paths.agentWorkspaces, name.slice(3))
    : path.join(paths.workspaces, name);
}

/**
 * One agent's private folders (created 0700): `home` (HOME), `hermesHome`
 * (HERMES_HOME), `workspace` (its work directory, hermesWorkspace), `tmp` (TMPDIR)
 * and `logs`.
 */
export function hermesAgentPaths(paths, id) {
  const name = agentId(id);
  return {
    home: privateFolder(path.join(paths.home, name)),
    hermesHome: privateFolder(path.join(paths.state, name)),
    workspace: privateFolder(hermesWorkspace(paths, name)),
    tmp: privateFolder(path.join(paths.tmp, name)),
    logs: privateFolder(path.join(paths.logs, name)),
  };
}

/**
 * The executables of an installed runtime directory (hermes-install.js): uv's
 * project environment `venv/` with Hermes's own `python` and `hermes` entry points,
 * and `tools/`, the folder on Hermes's PATH with the agent-browser binary its browser
 * tools run (`agentBrowser`).
 * The native Hermes contracts receive such a directory as
 * AGENTPIER_HERMES_CONTRACT_RUNTIME.
 */
export function hermesExecutables(runtimeDirectory) {
  const bin = path.join(runtimeDirectory, "venv", "bin");
  return {
    python: path.join(bin, "python"),
    hermes: path.join(bin, "hermes"),
    uv: path.join(runtimeDirectory, "uv", "uv"),
    source: path.join(runtimeDirectory, "src"),
    tools: path.join(runtimeDirectory, "tools"),
    agentBrowser: path.join(runtimeDirectory, "tools", "agent-browser"),
  };
}
