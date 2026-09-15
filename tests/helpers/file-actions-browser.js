import { expect } from "@playwright/test";
import {
  explorerFixture,
  explorerContext,
  explorerEntry,
  explorerListing,
} from "./file-explorer-browser.js";

export const revision = `e1:${"a".repeat(64)}`;
export const trashRevision = `t1:${"b".repeat(64)}`;
export const actionEntry = (name, type = "file", folder = "/home/test", extra = {}) =>
  explorerEntry(name, type, folder, { revision, ...extra });
export const trashEntry = (id, extra = {}) => ({
  id,
  originalPath: `/home/test/${id}.txt`,
  type: "file",
  size: 12,
  deletedAt: "2026-09-13T10:00:00Z",
  reason: "deleted",
  availability: "recoverable",
  revision: trashRevision,
  ...extra,
});

export async function actionsFixture(page) {
  await explorerFixture(page);
  const state = {
    requests: [],
    unknown: [],
    jobs: new Map(),
    rows: new Map(),
    folders: new Map(),
    files: [
      actionEntry("docs", "directory"),
      actionEntry("a.txt"),
      actionEntry("b.txt"),
      actionEntry("c.txt"),
    ],
    trash: [trashEntry("report", { originalPath: "/home/test/report.txt" })],
    missingParents: new Set(),
    onStart: null,
    onRead: null,
    onResolve: null,
    counter: 0,
  };
  state.finish = (id, rows, status = "completed") => {
    const job = state.jobs.get(id);
    Object.assign(job, {
      status,
      conflict: null,
      completedEntries: rows.filter((row) => row.status === "completed").length,
    });
    state.rows.set(id, rows);
  };
  await page.route("**/api/files/**", async (route) => {
    const req = route.request(),
      url = new URL(req.url()),
      method = req.method();
    const suffix = url.pathname.slice("/api/files".length);
    if (["/context", "/preferences"].includes(suffix)) return route.fallback();
    const body = method === "POST" ? req.postDataJSON() : null;
    state.requests.push({
      suffix,
      method,
      body,
      query: Object.fromEntries(url.searchParams),
      scope: req.headers()["x-file-scope"],
    });
    if (method === "POST")
      expect(req.headers()["x-file-scope"]).toBe(explorerContext.scopeId);
    if (suffix === "/entries" && method === "GET") {
      const path = url.searchParams.get("path") || "/home/test";
      return route.fulfill({
        json: explorerListing(
          path,
          path === "/home/test" ? state.files : state.folders.get(path) || [],
        ),
      });
    }
    if (suffix === "/metadata" && method === "GET") {
      const path = url.searchParams.get("path");
      if (state.missingParents.has(path))
        return route.fulfill({ status: 404, json: { code: "FILE_NOT_FOUND" } });
      return route.fulfill({
        json:
          state.files.find((entry) => entry.path === path) ||
          actionEntry(
            path.split("/").at(-1),
            "directory",
            path.split("/").slice(0, -1).join("/"),
          ),
      });
    }
    if (suffix === "/preview" && method === "GET")
      return route.fulfill({ json: { type: "text", text: "fixture preview" } });
    if (suffix === "/trash" && method === "GET") {
      const offset = Number(
        url.searchParams.get("cursor")?.replace("trash-page-", "") || 0,
      );
      return route.fulfill({
        json: {
          entries: state.trash.slice(offset, offset + 200),
          nextCursor:
            state.trash.length > offset + 200 ? `trash-page-${offset + 200}` : null,
        },
      });
    }
    if (suffix === "/jobs" && method === "GET")
      return route.fulfill({
        json: { jobs: [...state.jobs.values()], nextCursor: null },
      });
    if (suffix === "/operations" && method === "POST") {
      expect(body.requestId).toMatch(/^\d+:/);
      expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThanOrEqual(64 * 1024);
      const previous = [...state.jobs.values()].find(
        (job) => job.requestId === body.requestId,
      );
      if (previous) return route.fulfill({ status: 202, json: previous });
      const job = {
        id: `job-${++state.counter}`,
        scopeId: explorerContext.scopeId,
        requestId: body.requestId,
        kind: body.kind,
        status: "running",
        completedEntries: 0,
        totalEntries: body.sources.length,
        conflict: null,
      };
      state.jobs.set(job.id, job);
      state.rows.set(job.id, []);
      if (state.onStart) await state.onStart(body, job);
      else if (body.kind === "restore") {
        Object.assign(job, {
          status: "waiting_for_conflict",
          conflict: {
            id: `conflict-${job.id}`,
            type: "restore",
            source: state.trash.find((entry) => entry.id === body.sources[0])
              .originalPath,
            target: body.target,
            sourceType: "file",
            targetType: "file",
            revision,
            targetRevision: revision,
            choices: ["replace", "skip", "keep_both", "cancel"],
          },
        });
      } else {
        if (["create_file", "create_directory"].includes(body.kind))
          state.files.push(
            actionEntry(
              body.name,
              body.kind === "create_file" ? "file" : "directory",
              body.target,
            ),
          );
        if (body.kind === "rename") {
          const item = state.files.find((entry) => entry.path === body.sources[0]);
          item.name = body.name;
          item.path = `${item.path.split("/").slice(0, -1).join("/")}/${body.name}`;
        }
        state.finish(
          job.id,
          body.sources.map((source, index) => ({
            id: String(index),
            source,
            path: ["copy", "move"].includes(body.kind)
              ? `${body.target}/${source.split("/").at(-1)}`
              : source,
            status: "completed",
            outputPublished: ["copy", "move"].includes(body.kind),
            sourceRemoved: body.kind !== "copy",
          })),
        );
      }
      return route.fulfill({ status: 202, json: job });
    }
    const jobRoute = /^\/jobs\/([^/]+)(?:\/(entries|cancel|resolve))?$/.exec(suffix);
    if (jobRoute) {
      const [, id, action] = jobRoute,
        job = state.jobs.get(id);
      expect(job, `known job ${id}`).toBeTruthy();
      if (!action && method === "GET") {
        await state.onRead?.(job);
        return route.fulfill({ json: job });
      }
      if (action === "entries" && method === "GET") {
        const offset = Number(
          url.searchParams.get("cursor")?.replace("entry-page-", "") || 0,
        );
        const rows = state.rows.get(id);
        return route.fulfill({
          json: {
            entries: rows.slice(offset, offset + 200),
            nextCursor: offset + 200 < rows.length ? `entry-page-${offset + 200}` : null,
          },
        });
      }
      if (action === "cancel" && method === "POST") {
        job.status = "cancelled";
        job.conflict = null;
        return route.fulfill({ json: job });
      }
      if (action === "resolve" && method === "POST") {
        expect(body.conflictId).toBe(job.conflict.id);
        expect(job.conflict.choices).toContain(body.decision);
        if (state.onResolve) await state.onResolve(body, job);
        else {
          const entry = state.trash[0];
          if (body.decision === "cancel") state.finish(id, [], "cancelled");
          else {
            state.finish(id, [
              {
                id: "0",
                source: entry.id,
                path: entry.originalPath.replace(".txt", " (2).txt"),
                type: "file",
                status: "completed",
                sourceRemoved: true,
                outputPublished: true,
              },
            ]);
            state.trash = state.trash.filter((item) => item.id !== entry.id);
          }
        }
        return route.fulfill({ json: job });
      }
    }
    state.unknown.push(`${method} ${suffix}`);
    return route.fulfill({ status: 500, json: { code: "FILE_INVALID_RESPONSE" } });
  });
  return state;
}
