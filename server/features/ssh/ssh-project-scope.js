import { serverMessages } from "../../lib/i18n/de.js";
import fs from "node:fs";
import { projectScope } from "../memory/project-scope.js";
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
function launchIdentity(cwd) {
  const path = fs.realpathSync(cwd);
  const stat = fs.statSync(path, { bigint: true });
  if (!stat.isDirectory()) throw unavailable();
  return { path, dev: String(stat.dev), ino: String(stat.ino) };
}
function same(a, b) {
  return a?.path === b?.path && a?.dev === b?.dev && a?.ino === b?.ino;
}
export async function createSshProjectBinding(cwd) {
  let launch, scope, after;
  try {
    launch = launchIdentity(cwd);
    scope = await projectScope(cwd);
    after = launchIdentity(cwd);
  } catch {
    throw unavailable();
  }
  if (!same(launch, after)) throw changed();
  const { id: projectId, ...metadata } = scope;
  return { projectId, ...metadata, launch };
}
export async function validateSshProjectBinding(binding) {
  if (!binding?.launch?.path || !binding.projectId) throw unavailable();
  const current = await createSshProjectBinding(binding.launch.path);
  if (
    !same(binding.launch, current.launch) ||
    current.projectId !== binding.projectId ||
    current.identity !== binding.identity
  )
    throw changed();
  return current;
}
