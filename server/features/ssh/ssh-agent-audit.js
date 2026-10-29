// Audit rows of the session SSH agents. The first signature per session and host is
// written at once; further ones within the window are counted and written as one row
// when it ends (or on flush). A refusal is written at most once per session and code
// per window. Rows name ids, the host's catalog name and codes, never keys, users or
// signed data. A failing append never reaches the agent.

function row(action, outcome, { sessionId, projectId }, rest) {
  return {
    action,
    resourceType: "ssh",
    ...rest.resource,
    sessionId,
    ...(projectId === undefined ? {} : { projectId }),
    source: "mcp",
    outcome,
    details: rest.details,
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

export function createAgentAudit({
  append,
  windowMs = 60000,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  // `${sessionId}\n${accessId}` -> { scope, host, pending, timer }
  const windows = new Map();
  // `${sessionId}\n${code}` -> time the last row was written
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

  function forSession(map, sessionId) {
    return [...map.keys()].filter((key) => key.startsWith(`${sessionId}\n`));
  }

  return {
    connected({ sessionId, projectId, host }) {
      const key = `${sessionId}\n${host.accessId}`;
      const open = windows.get(key);
      if (open) {
        open.pending += 1;
        return;
      }
      const scope = { sessionId, projectId };
      const timer = setTimer(() => close(key), windowMs);
      timer?.unref?.();
      windows.set(key, { scope, host, pending: 0, timer });
      write(connectedRow(scope, host, 1));
    },
    denied({ sessionId, projectId, code }) {
      const key = `${sessionId}\n${code}`;
      const last = denials.get(key);
      const time = now();
      if (last !== undefined && time - last < windowMs) return;
      denials.set(key, time);
      write(deniedRow({ sessionId, projectId }, code));
    },
    flush(sessionId) {
      for (const key of forSession(windows, sessionId)) close(key);
      for (const key of forSession(denials, sessionId)) denials.delete(key);
    },
  };
}
