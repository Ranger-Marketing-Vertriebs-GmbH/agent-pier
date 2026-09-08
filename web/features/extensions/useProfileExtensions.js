import { normalizeSearch } from "../../lib/i18n/index.js";
import { useEffect, useRef, useState } from "react";
import { usePagination } from "../../components/Pagination.jsx";
export default function useProfileExtensions({ account, request, setParentBusy }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [confirm, setConfirm] = useState(null);
  const [reload, setReload] = useState(0);
  const [skillQuery, setSkillQuery] = useState("");
  const skillSearch = normalizeSearch(skillQuery.trim());
  const skills = (data?.skills.items || []).filter((skill) =>
    [skill.name, skill.description, skill.scope].some((value) =>
      normalizeSearch(value).includes(skillSearch),
    ),
  );
  const skillPaging = usePagination(skills, skillQuery);
  const lock = useRef(false);
  const alive = useRef(true);
  const endpoint = `/accounts/${encodeURIComponent(account.id)}/extensions`;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    let current = true;
    setLoading(true);
    setLoadError("");
    request(endpoint)
      .then((result) => {
        if (current) setData(result);
      })
      .catch((error) => {
        if (current) setLoadError(error.message);
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [endpoint, request, reload]);
  async function mutate(kind, action, success) {
    if (lock.current) return;
    lock.current = true;
    setBusy(kind);
    setParentBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      if (!alive.current) return;
      const next = await request(endpoint);
      if (!alive.current) return;
      setData(next);
      setConfirm(null);
      setNotice(success);
    } catch (error) {
      if (alive.current) setError(error.message);
    } finally {
      lock.current = false;
      if (alive.current) setBusy("");
      setParentBusy(false);
    }
  }
  return {
    loading,
    loadError,
    setReload,
    error,
    notice,
    confirm,
    busy,
    setConfirm,
    mutate,
    endpoint,
    data,
    alive,
    skillQuery,
    setSkillQuery,
    skillPaging,
    skillSearch,
    setError,
  };
}
