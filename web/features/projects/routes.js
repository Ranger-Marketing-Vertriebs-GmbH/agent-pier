const valid = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
const tabs = ["overview", "knowledge", "agentbus", "runs"];
const statuses = ["running", "awaiting-human", "completed", "failed", "cancelled"];
function pageNumber(value) {
  const number = Number(value || 1);
  return /^[1-9]\d*$/.test(String(value || 1)) &&
    Number.isSafeInteger(number) &&
    number <= 100000
    ? number
    : 1;
}
export function projectsRoute(fields = {}) {
  return {
    view: "projects",
    projectId: "",
    projectTab: "overview",
    query: "",
    archived: false,
    memoryPage: 1,
    busTab: "status",
    messagePage: 1,
    pipelineStatus: "",
    pipelinePage: 1,
    ...fields,
  };
}
export function readProjectsRoute(pathname, search) {
  const match = /^\/projects(?:\/([^/]+))?$/.exec(pathname);
  if (!match) return null;
  if (match[1] && !valid.test(match[1])) return { view: "missing" };
  const query = new URLSearchParams(search);
  const tab = tabs.includes(query.get("tab")) ? query.get("tab") : "overview";
  const page = pageNumber(query.get("page"));
  return projectsRoute({
    projectId: match[1] || "",
    projectTab: tab,
    ...(tab === "knowledge" && {
      query: (query.get("q") || "").slice(0, 300),
      archived: query.get("archived") === "1",
      memoryPage: page,
    }),
    ...(tab === "agentbus" &&
      query.get("bus") === "messages" && {
        busTab: "messages",
        messagePage: page,
      }),
    ...(tab === "runs" && {
      pipelineStatus: statuses.includes(query.get("status")) ? query.get("status") : "",
      pipelinePage: page,
    }),
  });
}
export function projectsRoutePath(route) {
  const query = new URLSearchParams();
  if (route.projectTab && route.projectTab !== "overview")
    query.set("tab", route.projectTab);
  if (route.projectTab === "knowledge") {
    if (route.query) query.set("q", route.query);
    if (route.archived) query.set("archived", "1");
    if (route.memoryPage > 1) query.set("page", String(route.memoryPage));
  }
  if (route.projectTab === "agentbus" && route.busTab === "messages") {
    query.set("bus", "messages");
    if (route.messagePage > 1) query.set("page", String(route.messagePage));
  }
  if (route.projectTab === "runs") {
    if (route.pipelineStatus) query.set("status", route.pipelineStatus);
    if (route.pipelinePage > 1) query.set("page", String(route.pipelinePage));
  }
  return `/projects${route.projectId ? `/${encodeURIComponent(route.projectId)}` : ""}${query.size ? `?${query}` : ""}`;
}
