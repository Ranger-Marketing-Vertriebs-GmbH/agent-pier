import { useMemo } from "react";
import useLiveTopic from "../../lib/live/useLiveTopic.js";
import useResource from "../../lib/useResource.js";
import { listedProjectsPath } from "../../lib/project-list.js";

const list = (value, key) => (Array.isArray(value?.[key]) ? value[key] : []);

/**
 * What the owner's search reads while it is open, from the routes and live topics his
 * pages use (so the same authorization applies): the inbox and the first page of the
 * run list (pushed), the project list and the pipeline definitions (read once per
 * open). A source that fails stays empty; `loading` while any is on its way.
 */
export default function useQuickOpenSources() {
  const inbox = useLiveTopic("inbox");
  const runs = useLiveTopic("pipeline.runs:*:*");
  const projects = useResource(listedProjectsPath);
  const pipelines = useResource("/pipelines");
  const loading = [inbox, runs, projects, pipelines].some(
    (source) => source.loading && !source.error,
  );
  return useMemo(
    () => ({
      inbox: list(inbox.data, "items"),
      runs: list(runs.data, "runs"),
      projects: list(projects.data, "projects"),
      pipelines: list(pipelines.data, "pipelines"),
      loading,
    }),
    [inbox.data, runs.data, projects.data, pipelines.data, loading],
  );
}
