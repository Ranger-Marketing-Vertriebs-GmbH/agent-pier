// Audit rows of the SSH agents of sessions and agents. The first signature per owner
// and host is written at once; further ones within the window are counted and written
// as one row when it ends (or on flush). A refusal is written at most once per owner
// and code per window. Rows name ids, the host's catalog name and codes, never keys,
// users or signed data. A failing append never reaches the agent.
//
// A scope is `{ owner, projectId? }` with owner `{ kind: "session" | "agent", id }`,
// or 280's `{ sessionId, projectId? }`, which means the session owner. A session row
// carries `sessionId` and `source: "mcp"`; an agent row carries `details.assistantId`
// and `source: "system"`, like the agent's own SSH tool rows.
import { ownerKey } from "./ssh-agent-shared.js";

function ownerOf({ owner, sessionId }) {
  return owner ?? { kind: "session", id: sessionId };
}

function row(action, outcome, { owner, projectId }, rest) {
  const agent = owner.kind === "agent";
  return {
    action,
    resourceType: "ssh",
    ...rest.resource,
    ...(agent ? {} : { sessionId: owner.id }),
    ...(projectId === undefined ? {} : { projectId }),
    source: agent ? "system" : "mcp",
    outcome,
    details: { ...(agent ? { assistantId: owner.id } : {}), ...rest.details },
  };
}

function connectedRow(scope, host, count) {
  return row("ssh.connected", "success", scope, {
    resource: { resourceId: host.accessId },
    details: { accessId: host.accessId, hostName: host.name, count },
  });
}

function deniedRow(scope, code) {
  return row("ssh.denied", "failure", scope, { details: { code } });
}

// `flush` takes an owner key; a bare session id (280's form) means `session:<id>`.
const flushKey = (key) => (/^(session|agent):/.test(key) ? key : `session:${key}`);

export function createAgentAudit({
  append,
  windowMs = 60000,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  // `${ownerKey}\n${accessId}` -> { scope, host, pending, timer }
  const windows = new Map();
  // `${ownerKey}\n${code}` -> time the last row was written
  const denials = new Map();

  function write(event) {
    try {
      append(event);
    } catch {
      // The audit store reports its own failures; signing goes on.
    }
  }

  function close(key) {
    const open = windows.get(key);
    if (!open) return;
    windows.delete(key);
    clearTimer(open.timer);
    if (open.pending > 0) write(connectedRow(open.scope, open.host, open.pending));
  }

  function forOwner(map, key) {
    return [...map.keys()].filter((entry) => entry.startsWith(`${key}\n`));
  }

  return {
    connected({ host, ...rest }) {
      const scope = { owner: ownerOf(rest), projectId: rest.projectId };
      const key = `${ownerKey(scope.owner)}\n${host.accessId}`;
      const open = windows.get(key);
      if (open) {
        open.pending += 1;
        return;
      }
      const timer = setTimer(() => close(key), windowMs);
      timer?.unref?.();
      windows.set(key, { scope, host, pending: 0, timer });
      write(connectedRow(scope, host, 1));
    },
    denied({ code, ...rest }) {
      const scope = { owner: ownerOf(rest), projectId: rest.projectId };
      const key = `${ownerKey(scope.owner)}\n${code}`;
      const last = denials.get(key);
      const time = now();
      if (last !== undefined && time - last < windowMs) return;
      denials.set(key, time);
      write(deniedRow(scope, code));
    },
    flush(key) {
      const owner = flushKey(String(key));
      for (const entry of forOwner(windows, owner)) close(entry);
      for (const entry of forOwner(denials, owner)) denials.delete(entry);
    },
  };
}
