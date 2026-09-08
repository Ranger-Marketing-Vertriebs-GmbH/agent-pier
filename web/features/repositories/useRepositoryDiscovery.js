import api from "../../lib/api.js";
import { useEffect, useState } from "react";
export default function useRepositoryDiscovery({ credentialId }) {
  const [query, setQuery] = useState("");
  const [organization, setOrganization] = useState("");
  const [page, setPage] = useState(1);
  const [reload, setReload] = useState(0);
  const [data, setData] = useState({
    organizations: [],
    repositories: [],
    total: 0,
  });
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    setBusy(true);
    setError("");
    const timer = setTimeout(() => {
      const params = new URLSearchParams({
        credentialId,
        q: query,
        organization,
        page: String(page),
      });
      api(`/repositories/discover?${params}`, "GET", undefined, controller.signal)
        .then((result) => {
          if (alive) setData(result);
        })
        .catch((error) => {
          if (alive) setError(error.message);
        })
        .finally(() => {
          if (alive) setBusy(false);
        });
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [credentialId, query, organization, page, reload]);
  return {
    busy,
    organization,
    setOrganization,
    setPage,
    data,
    query,
    setQuery,
    error,
    setReload,
    page,
  };
}
