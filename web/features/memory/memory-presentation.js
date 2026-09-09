import { names } from "../../lib/providers.js";
import { memoryCopy as copy } from "../../lib/i18n/messages/memory.js";

export function memoryPageCount(data) {
  return Math.max(1, Math.ceil(data.total / data.pageSize));
}

export function memoryPaging(data, page, setPage) {
  return {
    page: page - 1,
    pageCount: memoryPageCount(data),
    pageSize: data.pageSize,
    total: data.total,
    start: data.total ? (page - 1) * data.pageSize + 1 : 0,
    end: Math.min(page * data.pageSize, data.total),
    setPage: (index) => setPage(index + 1),
  };
}
export function entryAuthor(entry) {
  return entry.provenance?.kind === "session"
    ? copy.savedByAgent(names[entry.provenance.tool] || entry.provenance.tool)
    : copy.savedByUser;
}
