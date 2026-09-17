import { isIP } from "node:net";
import { endpoint, publicKeyValue } from "./ssh-keys.js";
import { sshProblem } from "./ssh-errors.js";

export function normalizedEndpoint(input) {
  const target = endpoint(input);
  target.host =
    isIP(target.host) === 6
      ? new URL(`http://[${target.host}]/`).hostname.slice(1, -1)
      : target.host.toLowerCase();
  return target;
}
export const hostTuple = (host) => {
  const value = normalizedEndpoint(host);
  return JSON.stringify([value.host, value.port, value.username]);
};
export function projectKey(store, keyId, projectId) {
  let key;
  try {
    key = store.keyStore.get(keyId);
  } catch {
    /* Opaque foreign/missing ID. */
  }
  if (!key || key.projectId !== projectId)
    throw sshProblem("SSH_WRONG_PROJECT", "SSH key is not owned by this project.", 403);
  return key;
}
export async function trustedHost(store, grants, session, input) {
  const trust = input.trustSource;
  if (
    !trust ||
    typeof trust !== "object" ||
    Array.isArray(trust) ||
    Object.keys(trust).some((key) => !["kind", "accessId"].includes(key)) ||
    !["existing", "provider", "user"].includes(trust.kind) ||
    (trust.kind !== "existing" && trust.accessId !== undefined)
  )
    throw sshProblem(
      "SSH_INVALID_ARGUMENT",
      "An independently verified host identity is required.",
    );
  if (trust.kind === "existing") {
    if (!(await grants.effective(session)).includes(trust.accessId))
      throw sshProblem(
        "SSH_WRONG_PROJECT",
        "Bootstrap access is not assigned to this session.",
        403,
      );
    const access = store.get(trust.accessId),
      target = normalizedEndpoint(input),
      source = normalizedEndpoint(access);
    if (
      source.host !== target.host ||
      source.port !== target.port ||
      access.hostKey !== publicKeyValue(input.hostKey)
    )
      throw sshProblem(
        "SSH_HOST_CONFLICT",
        "The host key does not match the assigned pinned endpoint.",
        409,
      );
  }
}

// Scope has already been validated asynchronously; read mutable grants again at commit.
export function trustedHostNow(store, grants, session, input, projectId) {
  if (input.trustSource.kind !== "existing") return;
  const access = store.get(input.trustSource.accessId);
  if (access.projectId !== projectId && !grants.assigned(session).includes(access.id))
    throw sshProblem(
      "SSH_WRONG_PROJECT",
      "Bootstrap access is not assigned to this session.",
      403,
    );
  const source = normalizedEndpoint(access),
    target = normalizedEndpoint(input);
  if (
    source.host !== target.host ||
    source.port !== target.port ||
    access.hostKey !== publicKeyValue(input.hostKey)
  )
    throw sshProblem(
      "SSH_HOST_CONFLICT",
      "The host key does not match the assigned pinned endpoint.",
      409,
    );
}

export function moveProject(catalog, fromProjectId, target) {
  const current = catalog.read();
  if (fromProjectId === target.id) return { ok: true };
  const keys = current.keys.filter((row) => row.projectId === fromProjectId);
  const hosts = current.hosts.filter((row) => row.projectId === fromProjectId);
  if (
    !current.projects.some((row) => row.id === fromProjectId) &&
    !keys.length &&
    !hosts.length
  )
    throw sshProblem(
      "SSH_PROJECT_UNAVAILABLE",
      "The source SSH project is unavailable.",
      404,
    );
  const targetKeys = current.keys.filter((row) => row.projectId === target.id);
  const targetHosts = current.hosts.filter((row) => row.projectId === target.id);
  const collisions = new Set();
  for (const [sources, targets, identity] of [
    [keys, targetKeys, (row) => row.publicKey],
    [hosts, targetHosts, hostTuple],
  ]) {
    for (const source of sources) {
      for (const targetRow of targets) {
        if (identity(source) === identity(targetRow)) {
          collisions.add(source.id);
          collisions.add(targetRow.id);
        }
      }
    }
  }
  if (collisions.size)
    throw Object.assign(
      sshProblem(
        "SSH_PROJECT_COLLISION",
        "The target project already contains a matching key or host.",
        409,
      ),
      {
        details: {
          resourceIds: [...collisions].slice(0, 100),
          truncated: collisions.size > 100,
        },
      },
    );
  const ids = new Set([...keys, ...hosts].map((row) => row.id));
  catalog.replacePart(
    "keys",
    current.keys.map((row) =>
      row.projectId === fromProjectId ? { ...row, projectId: target.id } : row,
    ),
  );
  catalog.replacePart(
    "hosts",
    current.hosts.map((row) =>
      row.projectId === fromProjectId ? { ...row, projectId: target.id } : row,
    ),
  );
  catalog.replacePart(
    "receipts",
    current.receipts.map((row) =>
      ids.has(row.resourceId) ? { ...row, tombstone: true } : row,
    ),
  );
  catalog.replacePart("projects", [
    ...current.projects.filter((row) => row.id !== target.id && row.id !== fromProjectId),
    target,
  ]);
  return { ok: true };
}
