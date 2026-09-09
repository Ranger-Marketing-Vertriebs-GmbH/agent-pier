import { commonCopy } from "../lib/i18n/messages/common.js";
import { paginationCopy as copy } from "../lib/i18n/messages/components.js";
import React, { useEffect, useState, useRef } from "react";
export function usePagination(items, resetKey = "") {
  const [page, setPage] = useState(0),
    pageSize = 20;
  const total = items.length,
    pageCount = Math.max(1, Math.ceil(total / pageSize)),
    current = Math.min(page, pageCount - 1);
  useEffect(() => {
    setPage(0);
  }, [resetKey]);
  useEffect(() => {
    if (page >= pageCount) setPage(pageCount - 1);
  }, [page, pageCount]);
  return {
    items: items.slice(current * pageSize, (current + 1) * pageSize),
    page: current,
    pageCount,
    total,
    start: total ? current * pageSize + 1 : 0,
    end: Math.min(total, (current + 1) * pageSize),
    pageSize,
    setPage,
  };
}
export function Pagination({ paging, label }) {
  const root = useRef(null);
  function go(page) {
    paging.setPage(page);
    root.current?.closest("section")?.scrollIntoView({
      block: "start",
    });
  }
  if (paging.total <= paging.pageSize) return null;
  return (
    <nav
      ref={root}
      className="list-pagination"
      aria-label={copy.listPaginationAriaLabel(label)}
    >
      <span>
        {paging.start}–{paging.end}
        {copy.totalCountPrefix}
        {paging.total}
      </span>
      <div>
        <button
          type="button"
          className="button secondary compact"
          aria-label={copy.previousPageLabel(label)}
          disabled={paging.page === 0}
          onClick={() => go(paging.page - 1)}
        >
          {commonCopy.back}
        </button>
        <span role="status" aria-live="polite">
          {copy.pageNumberPrefix}
          {paging.page + 1} / {paging.pageCount}
        </span>
        <button
          type="button"
          className="button secondary compact"
          aria-label={copy.nextPageLabel(label)}
          disabled={paging.page === paging.pageCount - 1}
          onClick={() => go(paging.page + 1)}
        >
          {commonCopy.next}
        </button>
      </div>
    </nav>
  );
}
