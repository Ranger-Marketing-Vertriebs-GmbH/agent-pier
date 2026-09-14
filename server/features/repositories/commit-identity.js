import fs from "node:fs";
import path from "node:path";
import { problem } from "../../lib/storage.js";

export function commitIdentity(value) {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== "object" ||
    typeof value.name !== "string" ||
    typeof value.email !== "string" ||
    !value.name.trim() ||
    value.name.length > 100 ||
    /[<>\x00-\x1f\x7f]/.test(value.name) ||
    value.email.length > 254 ||
    /[\x00-\x1f\x7f]/.test(value.email) ||
    !/^[^\s<>@]+@[^\s<>@]+$/.test(value.email)
  )
    throw problem("INVALID_COMMIT_IDENTITY");
  return { name: value.name.trim(), email: value.email };
}

export function selectedCommitIdentity(repositories, cwd, selections) {
  const projects = repositories
    .listProjects()
    .flatMap((project) => {
      try {
        const root = fs.realpathSync(project.path);
        return cwd === root || cwd.startsWith(root + path.sep)
          ? [{ ...project, root }]
          : [];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.root.length - a.root.length);
  const id =
    projects[0]?.credentialId ||
    (selections.length === 1 ? selections[0].credentialId : null);
  if (!id || !selections.some((entry) => entry.credentialId === id)) return null;
  const credential = repositories.listCredentials().find((entry) => entry.id === id);
  if (projects[0]) {
    try {
      if (new URL(projects[0].url).origin !== credential?.host) return null;
    } catch {
      return null;
    }
  }
  return commitIdentity(credential?.commitIdentity);
}
