// Artifacts page: /artifacts[/<projectId>]?tab=pinned&artifact=<id>
const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
export const artifactTabs = ["all", "pinned"];

export function readArtifactsQuery(search) {
  const query = new URLSearchParams(search);
  const artifact = query.get("artifact") || "";
  return {
    artifactTab: query.get("tab") === "pinned" ? "pinned" : "all",
    artifact: idPattern.test(artifact) ? artifact : "",
  };
}

export function artifactsRoutePath(route) {
  const query = new URLSearchParams();
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
    artifactTab: "all",
    artifact: "",
    ...fields,
  };
}
