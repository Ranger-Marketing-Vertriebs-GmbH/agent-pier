import { expect } from "@playwright/test";
import http from "node:http";
import { explorerFixture, explorerContext } from "./file-explorer-browser.js";
import { baseURL } from "./browser.js";

export async function uploadsFixture(page) {
  const base = await explorerFixture(page);
  const scopeId = explorerContext.scopeId;
  let next = 0;
  const state = {
    jobs: new Map(),
    groups: new Map(),
    attempts: new Map(),
    requests: [],
    raw: [],
    held: new Map(),
    failures: new Set(),
    reset: new Set(),
    lose: new Set(),
    hold: false,
    active: 0,
    peak: 0,
  };
  const job = (kind, extra = {}) => ({
    id: `job-${++next}`,
    kind,
    scopeId,
    status: "queued",
    completedEntries: 0,
    totalEntries: 0,
    completedBytes: 0,
    totalBytes: 0,
    conflict: null,
    issue: null,
    ...extra,
  });
  state.seed = (entries, extra = {}) => {
    const groupJob = job("upload_group", extra);
    const group = {
      job: groupJob,
      entries: new Map(entries.map((entry) => [entry.id, { ...entry }])),
      children: new Map(),
      path: "/home/test",
    };
    state.jobs.set(groupJob.id, groupJob);
    state.groups.set(groupJob.id, group);
    return group;
  };
  state.child = (group, entryId, extra = {}) => {
    const child = job(
      group.entries.get(entryId).type === "file" ? "upload" : "create_directory",
      extra,
    );
    state.jobs.set(child.id, child);
    group.children.set(entryId, child);
    return child;
  };
  state.oldJobs = (count) => {
    for (let n = 0; n < count; n++) {
      const old = job("create_file", { status: "completed" });
      state.jobs.set(old.id, old);
    }
  };
  const updateGroup = (group) => {
    const rows = [...group.entries.values()];
    group.job.status = rows.every((row) => ["completed", "skipped"].includes(row.status))
      ? "completed"
      : rows.some((row) => row.status === "failed")
        ? "partially_completed"
        : "queued";
    group.job.completedEntries = rows.filter((row) => row.status === "completed").length;
  };
  state.finish = (id) => state.held.get(id)?.();
  state.release = () => {
    state.hold = false;
    for (const release of [...state.held.values()]) release();
  };
  const paged = (values, cursor, key) => {
    const offset = cursor ? Number(cursor.slice(7)) : 0;
    return {
      [key]: values.slice(offset, offset + 200),
      nextCursor: offset + 200 < values.length ? `opaque:${offset + 200}` : null,
    };
  };
  // Native File bodies are opaque to Playwright in WebKit. Observe actual bytes
  // at a disposable loopback receiver instead of fabricating postDataBuffer data.
  const receive = async (request, response) => {
    response.setHeader("Access-Control-Allow-Origin", baseURL);
    response.setHeader("Access-Control-Allow-Headers", "Content-Type, X-File-Scope");
    response.setHeader("Access-Control-Allow-Methods", "PUT, OPTIONS");
    if (request.method === "OPTIONS") {
      response.end();
      return;
    }
    const id = request.url.split("/").at(-2),
      attempt = state.attempts.get(id);
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const record = {
      id,
      body: Buffer.concat(chunks),
      declaration: attempt.body,
      aborted: false,
    };
    expect(request.headers["x-file-scope"]).toBe(scopeId);
    expect(record.body.length).toBe(attempt.body.bytes);
    state.raw.push(record);
    response.on("close", () => {
      record.aborted = !response.writableEnded;
    });
    state.active++;
    state.peak = Math.max(state.peak, state.active);
    attempt.job.status = attempt.row.status = "running";
    await new Promise((resolve) => {
      state.held.set(id, resolve);
      if (!state.hold) resolve();
    });
    state.held.delete(id);
    state.active--;
    response.setHeader("Content-Type", "application/json");
    if (state.lose.delete("auth")) {
      response.writeHead(401);
      response.end(JSON.stringify({ code: "FILE_ACCESS_DENIED" }));
      return;
    }
    const failed =
      state.failures.delete(attempt.body.name) || state.reset.has(attempt.body.name);
    if (attempt.job.status !== "cancelled") {
      attempt.job.status = attempt.row.status = failed ? "failed" : "completed";
      if (failed)
        attempt.job.issue = attempt.row.issue = { code: "FILE_IO_ERROR", args: {} };
      else {
        attempt.row.issue = attempt.job.issue = null;
        attempt.row.outputPublished = true;
        attempt.row.completedBytes = attempt.row.bytes;
      }
    }
    updateGroup(attempt.group);
    if (state.reset.delete(attempt.body.name)) response.destroy();
    else response.end(JSON.stringify(attempt.job));
  };
  const receiver = http.createServer((request, response) => {
    receive(request, response).catch((error) => {
      state.receiverError = error;
      response.destroy();
    });
  });
  await new Promise((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  const receiverURL = `http://127.0.0.1:${receiver.address().port}`;
  receiver.unref();
  page.once("close", () => {
    state.release();
    receiver.closeAllConnections();
    receiver.close();
  });
  await page.route("**/api/files/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    const suffix = url.pathname.slice(10),
      method = request.method();
    const body = method === "POST" ? request.postDataJSON() : null;
    state.requests.push({
      suffix,
      method,
      body,
      scope: request.headers()["x-file-scope"],
      cursor: url.searchParams.get("cursor"),
    });
    const reply = (json, key, status = 200) =>
      state.lose.delete(key)
        ? route.abort("failed")
        : route.fulfill({ status, json }).catch(() => {});
    if (suffix === "/context")
      return reply({
        ...explorerContext,
        limits: {
          ...explorerContext.limits,
          jobEntries: 50000,
          maxDepth: 128,
          uploadBytes: 10 * 1024 ** 3,
          jobBytes: 50 * 1024 ** 3,
        },
      });
    if (suffix === "/jobs")
      return reply(
        paged([...state.jobs.values()], url.searchParams.get("cursor"), "jobs"),
      );
    if (suffix === "/upload-groups") {
      let group = [...state.groups.values()].find(
        (item) => item.requestId === body.requestId,
      );
      if (!group) {
        group = state.seed([]);
        Object.assign(group, { requestId: body.requestId, path: body.path, body });
      } else expect(body).toEqual(group.body);
      return reply({ groupId: group.job.id, job: group.job }, "create", 201);
    }
    const manifest = /^\/upload-groups\/([^/]+)\/(entries|commit)$/.exec(suffix);
    if (manifest) {
      const group = state.groups.get(manifest[1]);
      if (manifest[2] === "entries") {
        expect(Buffer.byteLength(request.postData())).toBeLessThan(60 * 1024);
        for (const entry of body.entries)
          group.entries.set(entry.id, {
            ...entry,
            path: `${group.path}/${entry.relativePath}`,
            status: "pending",
            completedBytes: 0,
          });
        return reply(
          {
            batchId: body.batchId,
            totalEntries: group.entries.size,
            totalBytes: [...group.entries.values()].reduce(
              (sum, row) => sum + row.bytes,
              0,
            ),
          },
          "append",
        );
      }
      for (const row of group.entries.values())
        row.status = row.type === "directory" ? "completed" : "ready";
      updateGroup(group);
      return reply(group.job, "commit", 202);
    }
    if (suffix === "/uploads") {
      let attempt = [...state.attempts.values()].find(
        (item) => item.body.requestId === body.requestId,
      );
      if (!attempt) {
        const group = state.groups.get(body.groupId),
          row = group.entries.get(body.entryId),
          previous = group.children.get(body.entryId);
        if (
          ["completed", "skipped", "published"].includes(row.status) ||
          (previous &&
            ["queued", "running", "waiting_for_conflict"].includes(previous.status))
        )
          return reply({ code: "FILE_UPLOAD_PENDING" }, null, 409);
        const child = state.child(group, row.id);
        attempt = { body, group, row, job: child };
        state.attempts.set(child.id, attempt);
        row.status = "queued";
      } else expect(body).toEqual(attempt.body);
      return reply({ uploadId: attempt.job.id, job: attempt.job }, "child", 201);
    }
    const raw = /^\/uploads\/([^/]+)\/content$/.exec(suffix);
    if (raw) {
      return route.continue({
        url: receiverURL + suffix,
        headers: { ...request.headers(), cookie: undefined },
      });
    }
    const match = /^\/jobs\/([^/]+)(?:\/(entries|upload-children|cancel|resolve))?$/.exec(
      suffix,
    );
    if (match) {
      const [, id, action] = match,
        selected = state.jobs.get(id),
        group = state.groups.get(id);
      if (!selected) return reply({ code: "FILE_NOT_FOUND" }, null, 404);
      if (action === "entries")
        return reply(
          paged(
            group ? [...group.entries.values()] : [],
            url.searchParams.get("cursor"),
            "entries",
          ),
        );
      if (action === "upload-children")
        return reply(
          paged(
            [...group.children].map(([entryId, job]) => ({ entryId, job })),
            url.searchParams.get("cursor"),
            "children",
          ),
        );
      if (action === "cancel") {
        selected.status = "cancelled";
        selected.conflict = null;
        for (const candidate of state.groups.values())
          for (const [entryId, child] of candidate.children) {
            if (!child) continue;
            if (child.id !== id && candidate.job.id !== id) continue;
            if (child.status !== "completed") {
              child.status = "cancelled";
              child.conflict = null;
              candidate.entries.get(entryId).status = "cancelled";
            }
            state.finish(child.id);
          }
      }
      if (action === "resolve") {
        expect(body.conflictId).toBe(selected.conflict.id);
        selected.conflict = null;
        selected.status = "completed";
        for (const candidate of state.groups.values())
          for (const [entryId, child] of candidate.children)
            if (child?.id === id) candidate.entries.get(entryId).status = "completed";
      }
      return reply(selected);
    }
    return route.fallback();
  });
  return { ...base, state };
}
