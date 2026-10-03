import { serverMessages } from "../../lib/i18n/de.js";
import { projectScope } from "../memory/project-scope.js";
import {
  directoryProjectId,
  folderIdentity,
  isGitInitOf,
  sameFolder,
} from "../memory/project-rebind.js";
import { problem } from "../../lib/storage.js";
function unavailable() {
  return Object.assign(problem(serverMessages.ssh.projectDirectoryUnavailable, 409), {
    code: "SSH_PROJECT_UNAVAILABLE",
  });
}
function changed() {
  return Object.assign(problem(serverMessages.ssh.projectChangedReload, 409), {
    code: "SSH_PROJECT_CHANGED",
  });
}
export async function createSshProjectBinding(cwd) {
  let launch, scope, after;
  try {
    launch = folderIdentity(cwd);
    scope = await projectScope(cwd);
    after = folderIdentity(cwd);
  } catch {
    throw unavailable();
  }
  if (!sameFolder(launch, after)) throw changed();
  const { id: projectId, ...metadata } = scope;
  return { projectId, ...metadata, launch };
}
/**
 * A plain launch folder that became the root of its own Git work tree is still
 * the session's project. Validation then keeps the launch project ID, so no
 * access is added, and reports `rebind` so the server process can move the
 * project to its Git identity. Every other identity change is rejected.
 */
function initialized(binding, current) {
  return (
    binding.kind === "directory" &&
    binding.projectId === directoryProjectId(binding.launch) &&
    isGitInitOf(binding.launch, current)
  );
}
export async function validateSshProjectBinding(binding) {
  if (!binding?.launch?.path || !binding.projectId) throw unavailable();
  const current = await createSshProjectBinding(binding.launch.path);
  if (!sameFolder(binding.launch, current.launch)) throw changed();
  if (current.projectId === binding.projectId && current.identity === binding.identity)
    return current;
  if (!initialized(binding, current)) throw changed();
  const { projectId, name, cwd, kind, identity } = binding;
  return {
    projectId,
    name,
    cwd,
    kind,
    identity,
    launch: current.launch,
    rebind: { fromId: projectId, toId: current.projectId },
  };
}
