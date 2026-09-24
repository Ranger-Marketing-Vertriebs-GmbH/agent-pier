// Pagination state for a server-paged run listing (1-based route pages).
export function runsPaging({ data, page, setPage }) {
  const total = data?.total || 0,
    pageSize = data?.pageSize || 20,
    pageCount = Math.max(1, Math.ceil(total / pageSize));
  return {
    page: page - 1,
    pageCount,
    pageSize,
    total,
    start: total ? (page - 1) * pageSize + 1 : 0,
    end: Math.min(total, page * pageSize),
    setPage: (index) => setPage(index + 1),
  };
}
