import { useProfilePluginsCopy as copy } from "../../lib/i18n/messages/plugins.js";
import { useEffect, useRef, useState, useCallback } from "react";
import { usePagination } from "../../components/Pagination.jsx";
import { apiCopy } from "../../lib/i18n/messages/components.js";
import { timedOut } from "../../lib/visible-polling.js";
import useLiveTopic from "../../lib/live/useLiveTopic.js";
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
    [installedQuery, setInstalledQuery] = useState(""),
    [catalogAccounts, setCatalogAccounts] = useState([]),
    [catalogAccountId, setCatalogAccountId] = useState("");
  const alive = useRef(true),
    lock = useRef(false),
    confirmRef = useRef(null),
    reads = useRef(0),
    defaultCatalogId = useRef("");
  const endpoint = `/accounts/${encodeURIComponent(account.id)}/plugins`;
  const readEndpoint = catalogAccountId
    ? `${endpoint}?catalogAccountId=${encodeURIComponent(catalogAccountId)}`
    : endpoint;
  const receive = useCallback(
    (next) => {
      setData(next);
      if (Array.isArray(next.catalogAccounts)) setCatalogAccounts(next.catalogAccounts);
      if (!catalogAccountId && next.catalogAccountId)
        defaultCatalogId.current = next.catalogAccountId;
    },
    [catalogAccountId],
  );
  const read = useCallback(
    async (signal) => {
      const current = ++reads.current;
      setLoading(true);
      setError("");
      try {
        const next = await request(readEndpoint, "GET", undefined, signal);
        if (alive.current && reads.current === current) receive(next);
      } catch (e) {
        // A deadline abort reports the timeout; hiding or stopping stays silent.
        if (
          alive.current &&
          reads.current === current &&
          (!signal?.aborted || timedOut(signal))
        )
          setError(timedOut(signal) ? apiCopy.timedOut : e.message);
      } finally {
        if (alive.current && reads.current === current) setLoading(false);
      }
    },
    [request, readEndpoint, receive],
  );
  const load = useCallback(() => read(), [read]);
  useEffect(() => {
    alive.current = true;
    load();
    return () => {
      alive.current = false;
    };
  }, [load]);
  // While a plugin change runs elsewhere, the account follows the live
  // `job.plugins:<id>` topic: its end (`busy` gone) is pushed. The pushed list is the
  // default catalog's, so another catalog account reads its own list once then. A
  // read while nothing runs asks the CLI, so the topic is not followed otherwise.
  const following = Boolean(data?.busy) && !busy;
  const pushed = useLiveTopic(following ? `job.plugins:${account.id}` : null).data;
  useEffect(() => {
    if (!pushed || pushed.busy) return;
    if (catalogAccountId) void read();
    else {
      reads.current++;
      receive(pushed);
    }
  }, [pushed, catalogAccountId, read, receive]);
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
  function selectCatalogAccount(id) {
    const next = id === defaultCatalogId.current ? "" : id;
    if (lock.current || next === catalogAccountId) return;
    // Invalidate before React schedules the next read, including rapid switches.
    reads.current++;
    setCatalogAccountId(next);
    setData(null);
    setLoading(true);
    setError("");
    setNotice("");
    setConfirm(null);
  }
  async function mutate(body, message, clear) {
    if (lock.current) return;
    lock.current = true;
    const read = ++reads.current;
    setBusy(true);
    setParentBusy(true);
    setError("");
    setNotice("");
    try {
      await request(endpoint, "POST", {
        ...body,
        ...(catalogAccountId ? { catalogAccountId } : {}),
      });
      if (!alive.current || reads.current !== read) return;
      setConfirm(null);
      clear?.();
      const next = await request(readEndpoint);
      if (alive.current && reads.current === read) {
        receive(next);
        setNotice(message + copy.restartNoticeSuffix);
      }
    } catch (e) {
      if (alive.current && reads.current === read) setError(e.message);
    } finally {
      lock.current = false;
      setParentBusy(false);
      if (alive.current) setBusy(false);
    }
  }
  const disabled = loading || busy || Boolean(data?.busy) || !data?.available;
  const capabilities = data?.capabilities || {};
  const catalog = (data?.catalog || []).filter(
    (p) =>
      (!market || p.marketplace === market) &&
      `${p.name} ${p.description || ""} ${p.marketplace || ""}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const catalogPages = usePagination(
    catalog,
    query + "\0" + market + "\0" + catalogAccountId,
  );
  const installed = (data?.installed || []).filter((p) =>
    `${p.name} ${p.description || ""} ${p.marketplace || ""}`
      .toLowerCase()
      .includes(installedQuery.toLowerCase()),
  );
  const installedPages = usePagination(
    installed,
    installedQuery + "\0" + catalogAccountId,
  );
  return {
    catalogAccounts,
    catalogAccountId:
      catalogAccountId || data?.catalogAccountId || defaultCatalogId.current,
    selectCatalogAccount,
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
