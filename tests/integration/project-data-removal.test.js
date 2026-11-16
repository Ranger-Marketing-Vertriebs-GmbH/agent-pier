import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { applicationFixture, enabledAssistants } from "../helpers/application.js";
import { auditRows, projectHost } from "../helpers/project-rebind.js";
import { ruleInput, SESSION } from "../helpers/rule-monitor-fixture.js";
import {
  projectDataLeft,
  removeProjectData,
} from "../../server/application/project-data-removal.js";

const timeout = 60000;
const steps = [{ name: "Test", command: "npm test", timeoutMs: 60000, blocking: true }];

/** A project folder with something in every store AgentPier keeps per project. */
async function seed(f, name, agent) {
  const a = f.application;
  const cwd = path.join(f.root, name);
  fs.mkdirSync(cwd);
  const older = await a.memory.register(cwd);
  a.memory.write(older.id, { title: "Older", content: `Older knowledge of ${name}` });
  // The folder was replaced once: the older row keeps the same path (duplicateOf).
  fs.renameSync(cwd, `${cwd}-previous`);
  fs.mkdirSync(cwd);
  const project = await a.memory.register(cwd);
  assert.notEqual(project.id, older.id);
  const id = project.id;
  a.memory.write(id, { title: "Note", content: `Knowledge of ${name}` });
  await projectHost(f, id);
  a.secrets.create({ name: `${name.toUpperCase()}_TOKEN`, value: "x", projectId: id });
  await a.artifacts.serial(async () => {
    const next = structuredClone(a.artifacts.store.state);
    next.records[`art-${name}`] = {
      id: `art-${name}`,
      sessionId: `session-${name}`,
      projectId: id,
      title: "Report",
      generation: `gen-${name}`,
      pinned: true,
    };
    next.receipts[`receipt-${name}`] = { fingerprint: "f", result: { projectId: id } };
    a.artifacts.store.save(next);
  });
  a.pipelineDefinitions.saveVerification(id, { steps });
  a.pipelineDefinitions.saveRisk(id, { globs: ["infra/**"], newDependency: false });
  a.pipelineDefinitions.saveQueueSettings(id, { limit: 3, countParked: true });
  a.pipelineQueue.store.insert({
    id: `queued-${name}`,
    projectId: id,
    state: "failed",
    task: "Item",
  });
  const runId = `run-${name}`;
  a.pipelines.store.create({
    id: runId,
    projectId: id,
    cwd,
    status: "completed",
    nodes: [],
    executionLog: [],
  });
  fs.writeFileSync(a.pipelineWorkspace.file(runId), "{}");
  a.ticketStore.setProjectLink(id, cwd, { github: { inProgressLabel: "doing" } });
  a.ticketRuleStore.create(id, ruleInput());
  a.ticketSequenceStore.append(id, cwd, [
    {
      source: "github",
      key: `acme/${name}#1`,
      title: "T",
      url: "",
      kind: "session",
      options: { allowMerge: false, session: SESSION },
    },
  ]);
  a.requests.approvals.rules.push({
    id: randomUUID(),
    scope: "project",
    target: id,
    cli: "codex",
    tool: "Bash",
    program: "ls",
    createdAt: new Date().toISOString(),
  });
  a.requests.approvals.save();
  const w = a.assistantWorkflows;
  w.projects.store.add({ projectId: id, assistantId: agent.id, createdAt: "2026-11-16" });
  w.store.reserve({
    assistantId: agent.id,
    key: `approval-${name}`,
    state: "awaiting_approval",
    payload: { action: "coding_start", projectId: id },
  });
  const rebuildId = `rb-${name}`;
  a.craftRebuilds.records.set(rebuildId, {
    id: rebuildId,
    folder: path.join(cwd, "rebuild"),
    status: "paused",
    running: false,
    createdAt: "2026-11-16T00:00:00Z",
  });
  const session = await a.sessions.create({
    id: `session-${name}`,
    name: `Session ${name}`,
    tool: "claude",
    accountId: "fixture",
    cwd,
    command: "/bin/cat",
    args: [],
    env: { PATH: "/usr/bin:/bin", HOME: f.home },
  });
  await a.sessions.stop(session.id);
  w.sessions.store.insert({
    sessionId: session.id,
    assistantId: agent.id,
    projectId: id,
  });
  const busId = `bus-${name}`;
  fs.mkdirSync(path.join(a.agentbus.root, "projects", busId, "launches"), {
    recursive: true,
  });
  a.repositories.projects.push({ id: `repo-${name}`, name, path: cwd, url: "" });
  a.repositories.save();
  return {
    cwd,
    id,
    olderId: older.id,
    body: {
      name,
      folderMissing: false,
      dev: "",
      ino: "",
      projectIds: [id, older.id],
      repositoryIds: [`repo-${name}`],
      busIds: [busId],
      sessionIds: [session.id],
      runIds: [runId],
      rebuildIds: [rebuildId],
      nested: [],
      report: { unsavedGitWork: false, endedSessionIds: [], endedProcesses: [] },
    },
  };
}

/** Two seeded projects, A to delete and B to keep, sharing one agent and one group. */
async function fixture(t) {
  const f = await applicationFixture(t, enabledAssistants);
  const a = f.application;
  assert.ok(a.assistantWorkflows, "the agent feature runs");
  const agent = a.assistants.store.createAssistant({
    name: "Coder",
    model: { connectionId: "c", modelId: "m" },
  });
  const doomed = await seed(f, "doomed", agent);
  const kept = await seed(f, "kept", agent);
  const w = a.assistantWorkflows;
  w.access.save(
    agent.id,
    {
      projectIds: [doomed.id, kept.id],
      pipelineIds: [],
      memoryWrite: false,
      autonomous: false,
      publish: false,
      sessionProjectIds: [doomed.id, kept.id],
      talkProjectIds: [doomed.id, kept.id],
      projectFiles: { [doomed.id]: "read", [kept.id]: "read" },
    },
    w.access.get(agent.id).revision ?? 0,
  );
  a.projectGroups.replace({ version: 0, groups: [{ name: "Work" }], assignments: {} });
  const group = a.projectGroups.get();
  a.projectGroups.replace({
    version: group.version,
    groups: group.groups,
    assignments: { [doomed.cwd]: group.groups[0].id, [kept.cwd]: group.groups[0].id },
  });
  return { f, a, agent, doomed, kept };
}

const everything = [
  "sessions",
  "agentbus",
  "runs",
  "workspaces",
  "queue",
  "pipelineSettings",
  "tickets",
  "ssh",
  "secrets",
  "artifacts",
  "approvals",
  "agentGrants",
  "agentSessions",
  "craftRebuilds",
  "repositories",
  "projectGroups",
  "memory",
];

test(
  "the walk removes every row of the folder and leaves other projects alone",
  { timeout },
  async (t) => {
    const { f, a, agent, doomed, kept } = await fixture(t);
    assert.deepEqual(projectDataLeft(a, doomed.body, doomed.cwd), everything);
    const secretsBefore = auditRows(f, "secret.deleted").length;

    await removeProjectData(a, doomed.body, doomed.cwd);

    assert.deepEqual(projectDataLeft(a, doomed.body, doomed.cwd), []);
    assert.equal(a.memory.hasProject(doomed.olderId), false);
    assert.equal(a.memory.hasProject(doomed.id), false);
    assert.equal(
      fs.existsSync(path.join(a.agentbus.root, "projects", "bus-doomed")),
      false,
    );
    assert.equal(a.sshManagement.knowsProject(doomed.id), false);
    const access = a.assistantWorkflows.access.get(agent.id);
    for (const field of ["projectIds", "sessionProjectIds", "talkProjectIds"])
      assert.deepEqual(access[field], [kept.id], field);
    assert.deepEqual(Object.keys(access.projectFiles), [kept.id]);
    assert.equal(a.assistantWorkflows.store.unstarted(doomed.id).length, 0);
    // Audit history stays, and each secret's deletion is audited.
    assert.equal(auditRows(f, "secret.deleted").length, secretsBefore + 1);

    // B still has everything; only its agent grant fields are checked above.
    assert.deepEqual(projectDataLeft(a, kept.body, kept.cwd), everything);
    assert.equal(a.memory.hasProject(kept.olderId), true);
  },
);

test("a second walk changes nothing and does not throw", { timeout }, async (t) => {
  const { a, doomed, kept } = await fixture(t);
  await removeProjectData(a, doomed.body, doomed.cwd);
  const audited = a.audit.list({}).events.length;
  await removeProjectData(a, doomed.body, doomed.cwd);
  assert.deepEqual(projectDataLeft(a, doomed.body, doomed.cwd), []);
  assert.equal(a.audit.list({}).events.length, audited);
  assert.deepEqual(projectDataLeft(a, kept.body, kept.cwd), everything);
});

test(
  "a walk with the agent feature off finishes once it is on",
  { timeout },
  async (t) => {
    const { a, agent, doomed, kept } = await fixture(t);
    await a.assistantFeature.disable();
    assert.equal(a.assistantWorkflows, null);
    await removeProjectData(a, doomed.body, doomed.cwd);
    assert.deepEqual(projectDataLeft(a, doomed.body, doomed.cwd), ["agentGrants"]);

    await a.assistantFeature.enable();
    assert.ok(a.assistantWorkflows);
    assert.deepEqual(projectDataLeft(a, doomed.body, doomed.cwd), [
      "agentGrants",
      "agentSessions",
    ]);
    await removeProjectData(a, doomed.body, doomed.cwd);
    assert.deepEqual(projectDataLeft(a, doomed.body, doomed.cwd), []);
    assert.deepEqual(a.assistantWorkflows.access.get(agent.id).projectIds, [kept.id]);
  },
);

test(
  "a clone saved under another spelling of the folder goes by its id",
  { timeout },
  async (t) => {
    const { f, a, doomed, kept } = await fixture(t);
    // The scope joined this entry by its real path; it was saved through a link.
    const link = path.join(f.home, "linked-root");
    fs.symlinkSync(f.root, link);
    a.repositories.projects.push({
      id: "repo-linked",
      name: "linked",
      path: path.join(link, "doomed"),
      url: "",
    });
    a.repositories.save();
    const body = { ...doomed.body, repositoryIds: ["repo-doomed", "repo-linked"] };
    // A rebuild removed meanwhile (another tab) reads 404; the walk still finishes.
    const remove = a.craftRebuilds.remove.bind(a.craftRebuilds);
    a.craftRebuilds.remove = async (id) => {
      await remove(id);
      throw Object.assign(new Error("gone"), { status: 404 });
    };

    await removeProjectData(a, body, doomed.cwd);
    assert.deepEqual(projectDataLeft(a, body, doomed.cwd), []);
    const ids = () => a.repositories.listProjects().map((item) => item.id);
    assert.deepEqual(ids(), ["repo-kept"]);
    await removeProjectData(a, body, doomed.cwd);
    assert.deepEqual(projectDataLeft(a, body, doomed.cwd), []);
    assert.deepEqual(ids(), ["repo-kept"]);
    assert.deepEqual(projectDataLeft(a, kept.body, kept.cwd), everything);
  },
);
