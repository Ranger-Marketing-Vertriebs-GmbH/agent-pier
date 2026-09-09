import { auditId } from "./audit-schema.js";
const collection = new Map([
  ["accounts", "account"],
  ["ssh-accesses", "ssh"],
  ["ssh-keys", "ssh"],
  ["provider-connections", "provider"],
  ["git-credentials", "repository"],
  ["sessions", "session"],
  ["pipeline-profiles", "profile"],
  ["pipelines", "pipeline"],
  ["pipeline-runs", "pipeline"],
]);
function identity(value) {
  try {
    return auditId(value);
  } catch {
    return undefined;
  }
}
export function requestAudit(req) {
  if (!["POST", "PATCH", "PUT", "DELETE"].includes(req.method)) return null;
  const segments = req.path.split("/").filter(Boolean);
  if (segments.shift() !== "api") return null;
  const [area, id, operation] = segments;
  const verb =
    req.method === "DELETE" ? "deleted" : req.method === "POST" ? "created" : "updated";
  let resourceType = collection.get(area),
    action = verb,
    resourceId = identity(id),
    sessionId,
    projectId;
  if (area === "operations") {
    resourceType = {
      backups: "backup",
      restore: "restore",
      releases: "release",
      doctor: "diagnostic",
    }[id];
    if (!resourceType || ["plan", "inspect", "check"].includes(operation)) return null;
    if (req.method === "DELETE" && id === "backups") {
      action = "deleted";
      resourceId = identity(operation);
    } else {
      action = "started";
      resourceId = undefined;
    }
  } else if (area === "sessions") {
    sessionId = resourceId;
    if (operation === "input") return null;
    if (operation === "stop") action = "stopped";
    else if (
      operation === "models" ||
      operation === "chat" ||
      operation === "ssh-accesses"
    )
      action = "updated";
    else if (operation) return null;
    else if (!id) action = "started";
  } else if (area === "ssh-accesses") {
    if (id === "scan") return null;
    if (operation === "test") action = "tested";
  } else if (area === "accounts" && operation) {
    if (operation === "login") {
      resourceType = "session";
      action = "started";
    } else if (operation === "extensions") resourceType = "extension";
    else if (operation === "plugins") {
      resourceType = "plugin";
      action = "updated";
    } else return null;
  } else if (area === "pipeline-profiles" && operation === "launch") {
    resourceType = "session";
    action = "started";
  } else if (area === "pipeline-runs") {
    if (!id) action = "started";
    else if (operation)
      action = {
        cancel: "cancelled",
        "retry-stage": "retried",
        gate: "updated",
        "pull-request": "updated",
      }[operation];
  } else if (area === "preferences") {
    resourceType = "setting";
    resourceId = "preferences";
  } else if (area === "repositories" && id === "clone") {
    resourceType = "repository";
    action = "created";
    resourceId = undefined;
  } else if (area === "memory") {
    if (id !== "projects") return null;
    resourceType = segments.length === 2 ? "project" : "memory";
    projectId = identity(operation);
    resourceId = identity(segments[4]);
    if (segments.at(-1) === "archive") action = "archived";
  } else if (area === "pipeline-verification") {
    resourceType = "pipeline";
    action = "updated";
  } else if (area === "tools") {
    resourceType = "tool";
    action = "installed";
  } else if (area === "providers") {
    resourceType = "account";
    action = "refreshed";
  }
  if (!resourceType || !action) return null;
  return {
    resourceType,
    action: `${resourceType}.${action}`,
    ...(resourceId ? { resourceId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(projectId ? { projectId } : {}),
  };
}

/** Capture explicit action metadata only; never retain the response or request body. */
export function auditHttp(audit, { onError = () => {} } = {}) {
  return (req, res, next) => {
    const event = requestAudit(req);
    if (!event) return next();
    let returnedId;
    const json = res.json;
    res.json = function (body) {
      returnedId = identity(
        body?.id ||
          body?.session?.id ||
          body?.profile?.id ||
          body?.pipeline?.id ||
          body?.run?.id ||
          body?.entry?.id ||
          body?.project?.id ||
          body?.job?.id,
      );
      return json.call(this, body);
    };
    res.once("finish", () => {
      try {
        const resourceId = returnedId || event.resourceId;
        audit.append({
          ...event,
          ...(resourceId ? { resourceId } : {}),
          ...(event.resourceType === "session" && resourceId
            ? { sessionId: resourceId }
            : {}),
          ...(event.resourceType === "project" && resourceId
            ? { projectId: resourceId }
            : {}),
          source: "user",
          outcome: res.statusCode < 400 ? "success" : "failure",
          details: { statusCode: res.statusCode },
        });
      } catch {
        onError();
      }
    });
    next();
  };
}
