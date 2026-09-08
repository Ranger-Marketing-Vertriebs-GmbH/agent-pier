import { useProfilePluginsCopy as copy } from "../../lib/i18n/de/plugins.js";
import { useEffect, useRef, useState, useCallback } from "react";
import { usePagination } from "../../components/Pagination.jsx";
export default function useProfilePlugins({ account, request, setParentBusy }) {
  const [data, setData] = useState(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false),
    [source, setSource] = useState(""),
    [pkg, setPkg] = useState(""),
    [query, setQuery] = useState(""),
    [market, setMarket] = useState(""),
    [confirm, setConfirm] = useState(null),
    [installedQuery, setInstalledQuery] = useState("");
  const alive = useRef(true),
    lock = useRef(false),
    confirmRef = useRef(null);
  const endpoint = `/accounts/${encodeURIComponent(account.id)}/plugins`;
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const next = await request(endpoint);
      if (alive.current) setData(next);
    } catch (e) {
      if (alive.current) setError(e.message);
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [request, endpoint]);
  useEffect(() => {
    alive.current = true;
    load();
    return () => {
      alive.current = false;
    };
  }, [load]);
  useEffect(() => {
    if (!data?.busy || busy) return;
    const timer = setTimeout(() => load(), 2000);
    return () => clearTimeout(timer);
  }, [data, busy, load]);
  useEffect(() => {
    if (market && data && !data.marketplaces.some((m) => m.name === market))
      setMarket("");
  }, [data, market]);
  useEffect(() => {
    if (confirm) {
      confirmRef.current?.focus({
        preventScroll: true,
      });
      confirmRef.current?.scrollIntoView({
        block: "nearest",
      });
    }
  }, [confirm]);
  async function mutate(body, message, clear) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setParentBusy(true);
    setError("");
    setNotice("");
    try {
      await request(endpoint, "POST", body);
      if (!alive.current) return;
      setConfirm(null);
      clear?.();
      const next = await request(endpoint);
      if (alive.current) {
        setData(next);
        setNotice(message + copy.restartNoticeSuffix);
      }
    } catch (e) {
      if (alive.current) setError(e.message);
    } finally {
      lock.current = false;
      setParentBusy(false);
      if (alive.current) setBusy(false);
    }
  }
  const disabled = busy || Boolean(data?.busy) || !data?.available;
  const capabilities = data?.capabilities || {};
  const catalog = (data?.catalog || []).filter(
    (p) =>
      (!market || p.marketplace === market) &&
      `${p.name} ${p.description || ""} ${p.marketplace || ""}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const catalogPages = usePagination(catalog, query + "\0" + market);
  const installed = (data?.installed || []).filter((p) =>
    `${p.name} ${p.description || ""} ${p.marketplace || ""}`
      .toLowerCase()
      .includes(installedQuery.toLowerCase()),
  );
  const installedPages = usePagination(installed, installedQuery);
  return {
    error,
    notice,
    loading,
    data,
    load,
    busy,
    confirm,
    confirmRef,
    disabled,
    setConfirm,
    mutate,
    installed,
    installedQuery,
    setInstalledQuery,
    installedPages,
    capabilities,
    source,
    setSource,
    catalog,
    query,
    setQuery,
    market,
    setMarket,
    catalogPages,
    pkg,
    setPkg,
  };
}
