const trimmed = (value) => String(value || "").replace(/\/+$/, "");

/**
 * The project a launch in `cwd` belongs to: the innermost known project folder that
 * holds it, or null. The server decides from the folder's Git identity; this only
 * tells the dialog which secrets come with the session anyway.
 */
export function launchProject(projects, cwd) {
  const path = trimmed(cwd);
  if (!path) return null;
  let found = null;
  for (const project of projects || []) {
    const root = trimmed(project.cwd);
    if (!root || (path !== root && !path.startsWith(`${root}/`))) continue;
    if (!found || root.length > trimmed(found.cwd).length) found = project;
  }
  return found;
}

/**
 * `selected` without secrets that no longer exist or that the launch project brings
 * itself, or `selected` itself when nothing has to go.
 */
export function launchSecretSelection(selected, secrets, projectId) {
  const kept = selected.filter((id) =>
    secrets.some(
      (secret) => secret.id === id && (!projectId || secret.projectId !== projectId),
    ),
  );
  return kept.length === selected.length ? selected : kept;
}
