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
