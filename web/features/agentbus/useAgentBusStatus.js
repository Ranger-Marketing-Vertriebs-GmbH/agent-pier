import { useEffect, useState } from "react";
export default function useAgentBusStatus({
  request,
  tab = "status",
  projectId = "",
  page = 1,
  onNavigate = () => {},
}) {
  const [data, setData] = useState(null),
    [error, setError] = useState(""),
    [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true,
      timer;
    async function read() {
      try {
        const result = await request("/agentbus");
        if (active) {
          setData(result);
          setError("");
        }
      } catch (e) {
        if (active) setError(e.message);
      } finally {
        if (active) timer = setTimeout(read, 4000);
      }
    }
    read();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [request, reload]);
  const projects = data?.projects || [],
    sessions = projects.flatMap((p) => p.sessions || []),
    project =
      projects.find((p) => p.id === projectId) || (!projectId ? projects[0] : null);
  useEffect(() => {
    if (tab === "messages" && !projectId && project)
      onNavigate("messages", project.id, true, page);
  }, [tab, projectId, project, page, onNavigate]);
  return {
    error,
    setReload,
    data,
    sessions,
    projects,
    project,
  };
}
