import { useEffect, useRef, useState } from "react";
import { agencyCopy as copy } from "../../lib/i18n/de/agency.js";
export default function useAgency({ account, request, setParentBusy }) {
  const endpoint = `/accounts/${encodeURIComponent(account.id)}/agency`;
  const [query, setQuery] = useState(""),
    [category, setCategory] = useState(""),
    [page, setPage] = useState(1),
    [reload, setReload] = useState(0);
  const [data, setData] = useState(null),
    [preview, setPreview] = useState(null),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [confirm, setConfirm] = useState(null);
  const lock = useRef(false),
    alive = useRef(true),
    generation = useRef(0);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    const timer = setTimeout(() => {
      request(
        `${endpoint}?${new URLSearchParams({ q: query, category, page: String(page) })}`,
        "GET",
        undefined,
        controller.signal,
      )
        .then((result) => {
          if (!controller.signal.aborted) setData(result);
        })
        .catch((error) => {
          if (!controller.signal.aborted) setError(error.message);
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [endpoint, request, query, category, page, reload]);
  async function operation(fn) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setParentBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
    } catch (error) {
      if (alive.current) setError(error.message);
    } finally {
      lock.current = false;
      if (alive.current) {
        setBusy(false);
        setParentBusy(false);
      }
    }
  }
  async function show(item) {
    const current = ++generation.current;
    await operation(async () => {
      const result = await request(
        `${endpoint}/preview?${new URLSearchParams({ id: item.id, revision: data.revision })}`,
      );
      if (alive.current && current === generation.current) setPreview(result);
    });
  }
  async function install() {
    await operation(async () => {
      await request(endpoint, "POST", { id: preview.id, revision: preview.revision });
      if (alive.current) {
        setPreview(null);
        setReload((value) => value + 1);
        setNotice(copy.success);
      }
    });
  }
  async function remove() {
    await operation(async () => {
      await request(`${endpoint}/${encodeURIComponent(confirm.id)}`, "DELETE");
      if (alive.current) {
        setConfirm(null);
        setReload((value) => value + 1);
        setNotice(copy.removed);
      }
    });
  }
  async function refresh() {
    await operation(async () => {
      await request(`${endpoint}?refresh=1`);
      if (alive.current) {
        setPreview(null);
        setReload((value) => value + 1);
      }
    });
  }
  return {
    query,
    setQuery,
    category,
    setCategory,
    page,
    setPage,
    data,
    preview,
    setPreview,
    busy,
    loading,
    error,
    notice,
    show,
    install,
    refresh,
    confirm,
    setConfirm,
    remove,
  };
}
