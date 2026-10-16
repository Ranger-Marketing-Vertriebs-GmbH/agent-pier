// Artifacts page: /artifacts[/<projectId>]?session=<id>&q=<term>&page=<n>&tab=pinned&artifact=<id>
const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
export const artifactTabs = ["all", "pinned"];

// The server accepts up to 200 characters without control characters. A pasted tab or
// line break becomes a space, so the search box, the address and the request agree.
export function artifactSearchTerm(value) {
  return typeof value === "string"
    ? value
        .replace(/[\x00-\x1f\x7f]/g, " ")
        .trim()
        .slice(0, 200)
        .trim()
    : "";
}

function searchTerm(value) {
  return typeof value === "string" && value.trim().length <= 200
    ? artifactSearchTerm(value)
    : "";
}

function pageNumber(value) {
  return /^[1-9]\d{0,5}$/.test(value || "") && Number(value) <= 100000
    ? Number(value)
    : 1;
}

export function readArtifactsQuery(search) {
  const query = new URLSearchParams(search);
  const artifact = query.get("artifact") || "";
  const session = query.get("session") || "";
  return {
    artifactTab: query.get("tab") === "pinned" ? "pinned" : "all",
    artifact: idPattern.test(artifact) ? artifact : "",
    session: idPattern.test(session) ? session : "",
    q: searchTerm(query.get("q")),
    page: pageNumber(query.get("page")),
  };
}

export function artifactsRoutePath(route) {
  const query = new URLSearchParams();
  if (route.session && idPattern.test(route.session)) query.set("session", route.session);
  const term = searchTerm(route.q);
  if (term) query.set("q", term);
  if (Number.isSafeInteger(route.page) && route.page > 1 && route.page <= 100000)
    query.set("page", String(route.page));
  if (route.artifactTab === "pinned") query.set("tab", "pinned");
  if (route.artifact && idPattern.test(route.artifact))
    query.set("artifact", route.artifact);
  const project = route.projectId ? `/${encodeURIComponent(route.projectId)}` : "";
  return `/artifacts${project}${query.size ? `?${query}` : ""}`;
}

export function artifactsRoute(fields = {}) {
  return {
    view: "artifacts",
    projectId: "",
    session: "",
    q: "",
    page: 1,
    artifactTab: "all",
    artifact: "",
    ...fields,
  };
}
