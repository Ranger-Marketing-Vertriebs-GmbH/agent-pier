const valid = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
export function readPipelineRoute(pathname, search) {
  const match =
    /^\/pipelines(?:\/(runs|definitions|profiles|verification)(?:\/([^/]+))?)?$/.exec(
      pathname,
    );
  if (!match) return null;
  if (match[2] && !valid.test(match[2])) return { view: "missing" };
  const query = new URLSearchParams(search),
    number = Number(query.get("page") || 1),
    project = query.get("project") || "",
    status = query.get("status") || "";
  return {
    view: "pipelines",
    pipelineTab: match[1] || "runs",
    pipelineItem: match[2] || "",
    pipelinePage:
      Number.isSafeInteger(number) && number >= 1 && number <= 100000 ? number : 1,
    projectId: valid.test(project) ? project : "",
    pipelineStatus: [
      "running",
      "awaiting-human",
      "completed",
      "failed",
      "cancelled",
    ].includes(status)
      ? status
      : "",
  };
}
export function pipelineRoutePath(route) {
  const tab = route.pipelineTab || "runs";
  const query = new URLSearchParams();
  if (route.projectId) query.set("project", route.projectId);
  if (route.pipelineStatus) query.set("status", route.pipelineStatus);
  if (route.pipelinePage > 1) query.set("page", String(route.pipelinePage));
  return `/pipelines${tab === "runs" && !route.pipelineItem ? "" : `/${tab}`}${route.pipelineItem ? `/${encodeURIComponent(route.pipelineItem)}` : ""}${query.size ? "?" + query : ""}`;
}
