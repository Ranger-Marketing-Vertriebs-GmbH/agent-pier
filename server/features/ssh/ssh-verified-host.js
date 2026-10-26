import { hostTuple } from "./ssh-management-records.js";

/**
 * Hosts the owner confirmed from an agent's SSH access proposal
 * (assistants/agent-ssh-proposals.js), through the SSH catalog's own paths: the
 * owner's host creation (a managed key when none is chosen, the host-key pin) under
 * the catalog's mutation lock, with the pin's provenance "user" as a coding session's
 * ssh_register_host records it for an owner-verified fingerprint.
 */

/** The SSH catalog row with the same host, port and user, or null. */
export function existingHost(management, endpoint) {
  const tuple = hostTuple({ ...endpoint, type: "ssh" });
  return (
    management.store
      .list()
      .find((row) => row.type !== "sftp" && hostTuple(row) === tuple) || null
  );
}

/**
 * Registers the host with the pinned `hostKey`; `keyId` picks a key of the host's
 * project, otherwise a managed key is generated. Returns the host and whether its
 * key was generated for it.
 */
export function registerVerifiedHost(management, input) {
  const { name, host, port, username, hostKey, projectId = null, keyId } = input;
  return management.track(async () => {
    await management.ready;
    return management.mutation(async () => {
      const project = await management.project(projectId);
      if (project) management.rememberProject(project);
      const created = await management.store.create({
        name,
        host,
        port,
        username,
        hostKey,
        ...(projectId ? { projectId } : {}),
        ...(keyId ? { keyId } : {}),
      });
      management.catalog.replacePart(
        "hosts",
        management.catalog
          .read()
          .hosts.map((row) =>
            row.id === created.id ? { ...row, trustSource: "user" } : row,
          ),
      );
      management.catalog.afterCommit(() => management.emit("ssh.created", created.id));
      return { host: management.store.get(created.id), keyCreated: !keyId };
    });
  });
}

/** Undoes registerVerifiedHost: the host, then the key generated for it. */
export async function removeVerifiedHost(management, { host, keyCreated }) {
  await management.ui("removeHost", { id: host.id });
  if (keyCreated && host.keyId) await management.ui("removeKey", { id: host.keyId });
}
