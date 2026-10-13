import { pipelineRunRoute, projectsRoute } from "./routes.js";
import { normalizePath } from "./useProjectHub.js";

// "https://github.com/acme/app.git" → "github.com/acme/app"
export function remoteDisplay(url) {
  return String(url || "")
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
    .replace(/^[^@/]+@([^:/]+):/, "$1/")
    .replace(/\.git$/, "");
}

// "https://github.com/acme/app.git" → "acme/app"; "acme/app" stays as it is.
export function remoteShort(url) {
  const display = remoteDisplay(url);
  const parts = display.split("/");
  return parts.length > 2 ? parts.slice(1).join("/") : display;
}

export function projectSessions(sessions, project) {
  return (sessions || [])
    .filter(
      (session) =>
        session.purpose !== "login" && normalizePath(session.cwd) === project.path,
    )
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
}

// Counts from a capped sweep are lower bounds and read as "100+".
export const hintCount = (count, capped) => (capped ? `${count}+` : count);

const attentionPart = (attention, kind, memoryId) => ({
  count: (memoryId && attention[kind]?.[memoryId]) || 0,
  run: (memoryId && attention.first?.[kind]?.[memoryId]) || "",
  capped: Boolean(attention.capped?.[kind]),
});

// Waiting decisions and failed runs of one project, from the hub's run sweep.
export function projectAttention(attention, memoryId) {
  return {
    decisions: attentionPart(attention, "decisions", memoryId),
    failed: attentionPart(attention, "failed", memoryId),
  };
}

// One run that is surely the only one opens directly; otherwise the filtered list.
export function attentionTarget(projectId, status, part) {
  return part.count === 1 && !part.capped && part.run
    ? pipelineRunRoute(part.run)
    : projectsRoute({ projectId, projectTab: "runs", pipelineStatus: status });
}
