import test from "node:test";
import assert from "node:assert/strict";
import { readRoute, routePath, defaultSessionMode } from "../../web/app/routes.js";
import { projectsRoute } from "../../web/features/projects/routes.js";
const read = (path) => readRoute(new URL(path, "http://localhost"));
const path = (route) => routePath(route);
test("route parsing rejects malformed identifiers and action-looking paths", () => {
  for (const path of [
    "/sessions/a/stop",
    "/sessions/a/reader/extra",
    "/plugins/a%2Fb",
    "/extensions/%00",
    "/sessions/%ZZ/reader",
    "/api/state",
  ])
    assert.equal(read(path).view, "missing", path);
});
test("bare and legacy session links keep their identity until state chooses a mode", () => {
  assert.deepEqual(read("/#demo"), { view: "workspace", sessionId: "demo", mode: null });
  assert.deepEqual(read("/sessions/demo"), {
    view: "workspace",
    sessionId: "demo",
    mode: null,
  });
  assert.equal(routePath(read("/sessions/demo/reader/")), "/sessions/demo/chat");
  assert.deepEqual(read("/sessions/demo/chat"), {
    view: "workspace",
    sessionId: "demo",
    mode: "reader",
  });
  assert.equal(routePath(read("/sessions/demo/chat")), "/sessions/demo/chat");
  assert.equal(defaultSessionMode({ purpose: "login" }, true), "terminal");
  assert.equal(defaultSessionMode({}, true), "reader");
  assert.equal(defaultSessionMode({ tool: "shell" }, true), "terminal");
  assert.equal(read("/settings").view, "settings");
  assert.equal(read("/settings").settingsSection, "general");
  assert.equal(routePath(read("/settings")), "/settings");
});
test("projects routes carry tab state and old links map onto them", () => {
  assert.deepEqual(read("/projects"), {
    view: "projects",
    projectId: "",
    projectTab: "overview",
    query: "",
    archived: false,
    memoryPage: 1,
    busTab: "status",
    messagePage: 1,
    pipelineStatus: "",
    pipelinePage: 1,
  });
  assert.equal(
    read("/projects/p1?tab=knowledge&q=Build&archived=1&page=2").memoryPage,
    2,
  );
  assert.equal(
    path(read("/memory/p1?q=Build&archived=1&page=2")),
    "/projects/p1?tab=knowledge&q=Build&archived=1&page=2",
  );
  assert.equal(path(read("/memory")), "/projects?tab=knowledge");
  assert.equal(path(read("/agentbus")), "/projects?tab=agentbus");
  assert.equal(
    path(read("/agentbus/messages/b1?page=3")),
    "/projects/b1?tab=agentbus&bus=messages&page=3",
  );
  assert.equal(path(read("/repositories")), "/projects");
  assert.equal(path(read("/plugins/local-codex")), "/extensions/local-codex?tab=plugins");
  assert.equal(
    path(read("/extensions/local-codex?tab=agents")),
    "/extensions/local-codex?tab=agents",
  );
  assert.equal(path(read("/extensions/local-codex")), "/extensions/local-codex");
  assert.equal(read("/projects/a%2Fb").view, "missing");
  assert.equal(read("/projects/p1?tab=nope").projectTab, "overview");
  assert.equal(
    path(read("/projects/p1?tab=runs&status=failed&page=2")),
    "/projects/p1?tab=runs&status=failed&page=2",
  );
});
test("projects AgentBus tab routes preserve exact project selection", () => {
  for (const [urlPath, busTab, projectId] of [
    ["/agentbus", "status", ""],
    ["/agentbus/messages", "messages", ""],
    ["/agentbus/messages/project-123", "messages", "project-123"],
  ])
    assert.deepEqual(
      read(urlPath),
      projectsRoute({ projectId, projectTab: "agentbus", busTab }),
    );
  for (const p of [
    "/agentbus/messages/a%2Fb",
    "/agentbus/messages/%00",
    "/agentbus/messages/p/delete",
    "/agentbus/unknown",
  ])
    assert.equal(read(p).view, "missing");
});
test("projects AgentBus message pagination survives links and invalid pages normalize safely", () => {
  const paged = read("/agentbus/messages/project-123?page=3");
  assert.equal(paged.messagePage, 3);
  assert.equal(path(paged), "/projects/project-123?tab=agentbus&bus=messages&page=3");
  for (const page of ["0", "-1", "1.5", "nope", "Infinity", "9007199254740992"])
    assert.equal(read("/agentbus/messages/project-123?page=" + page).messagePage, 1);
  assert.equal(
    path(read("/agentbus/messages/project-123?page=1")),
    "/projects/project-123?tab=agentbus&bus=messages",
  );
});
test("projects knowledge tab deep links reject malformed scopes and normalize invalid pagination", () => {
  for (const value of ["0", "-1", "1.5", "100001", "9007199254740992", "Infinity"])
    assert.equal(read(`/memory/project?page=${value}`).memoryPage, 1);
  for (const value of ["/memory/a%2Fb", "/memory/%00", "/memory/a/delete"])
    assert.equal(read(value).view, "missing");
  assert.deepEqual(read("/memory"), projectsRoute({ projectTab: "knowledge" }));
});

test("pipeline deep links retain tabs identities and bounded filters", () => {
  for (const tab of ["definitions", "profiles", "runs", "verification"]) {
    const route = read(`/pipelines/${tab}/item-one`);
    assert.equal(route.view, "pipelines");
    assert.equal(route.pipelineTab, tab);
    assert.equal(route.pipelineItem, "item-one");
    assert.equal(routePath(route), `/pipelines/${tab}/item-one`);
  }
  const route = read("/pipelines?page=3&status=awaiting-human&project=project-one");
  assert.equal(route.pipelinePage, 3);
  assert.equal(route.pipelineStatus, "awaiting-human");
  assert.equal(route.projectId, "project-one");
  assert.deepEqual(read(routePath(route)), route);
  for (const path of [
    "/pipelines/nope",
    "/pipelines/runs/a%2Fb",
    "/pipelines/profiles/%00",
    "/pipelines/runs/a/delete",
  ])
    assert.equal(read(path).view, "missing");
  for (const value of ["0", "-1", "Infinity", "100001"])
    assert.equal(read("/pipelines?page=" + value).pipelinePage, 1);
});

test("settings deep links preserve durable jobs and bounded audit filters", () => {
  for (const section of [
    "notifications",
    "diagnostics",
    "backups",
    "updates",
    "audit",
    "ssh",
  ]) {
    const route = read(`/settings/${section}`);
    assert.equal(route.view, "settings");
    assert.equal(route.settingsSection, section);
    assert.equal(routePath(route), `/settings/${section}`);
  }
  const job = read("/settings/updates?job=job-one");
  assert.equal(job.operationId, "job-one");
  assert.equal(routePath(job), "/settings/updates?job=job-one");
  const audit = read(
    "/settings/audit?page=2&action=session.start&outcome=failure&sessionId=session-one&projectId=project-one&before=123",
  );
  assert.deepEqual(read(routePath(audit)), audit);
  assert.equal(audit.auditBefore, "123");
  for (const path of [
    "/settings/unknown",
    "/settings/updates/activate",
    "/settings/%00",
    "/settings/audit%2Fdelete",
  ])
    assert.equal(read(path).view, "missing");
  for (const page of ["0", "-1", "1.5", "Infinity", "100001", "9007199254740992"])
    assert.equal(read(`/settings/audit?page=${page}`).auditPage, 1);
  for (const before of ["0", "-1", "1.5", "9".repeat(1000)])
    assert.equal(read(`/settings/audit?before=${before}`).auditBefore, "");
  assert.equal(read("/settings/backups?job=..%2Fprivate").operationId, "");
  assert.equal(read("/settings/audit?outcome=unknown").auditOutcome, "");
});

test("file explorer links retain Unicode paths, preview and pagination", () => {
  const route = {
    view: "workspace",
    sessionId: "demo",
    mode: "files",
    filePath: "src/space folder",
    file: "src/space folder/ä.txt",
    fileSort: "name",
    fileDirection: "asc",
    fileHidden: false,
    fileHiddenExplicit: false,
    fileFilter: "",
    filePage: 2,
    filePageInvalid: null,
  };
  assert.deepEqual(read(routePath(route)), route);
  assert.equal(read("/sessions/demo/files?page=-1").filePage, 1);
});
