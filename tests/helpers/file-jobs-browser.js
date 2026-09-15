import { actionsFixture, actionEntry } from "./file-actions-browser.js";
import { explorerContext } from "./file-explorer-browser.js";

export async function jobsFixture(page, { readOnly = false } = {}) {
  const f = await actionsFixture(page);
  await page.routeWebSocket("**/api/**", (socket) => socket.close());
  await page.route("**/api/files/context", (route) =>
    route.fulfill({
      json: {
        ...explorerContext,
        readOnly,
        limits: {
          ...explorerContext.limits,
          jobEntries: 50000,
          jobBytes: 107374182400,
          depth: 128,
        },
      },
    }),
  );
  f.files.push(actionEntry("input.zip"));
  f.entryPages = [];
  f.addJob = (extra, rows = []) => {
    const job = {
      id: `history-${f.jobs.size}`,
      scopeId: explorerContext.scopeId,
      kind: "extract",
      status: "interrupted",
      completedEntries: 0,
      totalEntries: null,
      completedBytes: 0,
      totalBytes: null,
      conflict: null,
      ...extra,
    };
    f.jobs.set(job.id, job);
    f.rows.set(job.id, rows);
    return job;
  };
  await page.route(/\/api\/files\/jobs\/[^/]+\/entries(?:\?.*)?$/, async (route) => {
    const url = new URL(route.request().url()),
      id = url.pathname.split("/").at(-2);
    const cursor = url.searchParams.get("cursor"),
      offset = Number(cursor?.replace("entries-", "") || 0);
    f.entryPages.push({ id, cursor });
    if (f.onPage) {
      const result = await f.onPage({ id, cursor, offset });
      if (result) return route.fulfill({ json: result });
    }
    const rows = f.rows.get(id) || [];
    return route.fulfill({
      json: {
        entries: rows.slice(offset, offset + 200),
        nextCursor: offset + 200 < rows.length ? `entries-${offset + 200}` : null,
      },
    });
  });
  return f;
}

export function omissionRows(count = 201, manifestVersion = "a".repeat(64)) {
  return Array.from({ length: count }, (_, index) => ({
    id: String(index),
    path: `/home/test/docs/link-${index}`,
    source: `/home/test/docs/link-${index}`,
    name: `docs/link-${index}`,
    type: "symlink",
    status: "skipped",
    manifestVersion,
    issue: { code: "FILE_ARCHIVE_LINKS", args: {} },
  }));
}
export function omissionConflict(version = "a".repeat(64), id = "links-1") {
  return {
    id,
    type: "archive_links",
    manifestVersion: version,
    choices: ["skip_links", "cancel"],
  };
}
