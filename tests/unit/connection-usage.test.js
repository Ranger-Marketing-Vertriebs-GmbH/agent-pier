import test from "node:test";
import assert from "node:assert/strict";
import {
  connectionUsageSources,
  summarizeConnectionUsage,
} from "../../server/features/accounts/connection-usage.js";
import { sshLastUseCovers } from "../../server/features/accounts/connection-last-use.js";

const lead = { id: "lead", name: "Lead" };
const member = {
  id: "member",
  name: "Helper",
  teamMemberId: "t1",
  lifetime: "task",
  parentAssistantId: "lead",
  inherited: { ssh: true, github: { credentialId: "gh-work", level: "read" } },
};
const quiet = {
  id: "quiet",
  name: "Quiet",
  teamMemberId: "t2",
  lifetime: "task",
  parentAssistantId: "lead",
  inherited: { ssh: false, github: null },
};
const sources = {
  agentsEnabled: true,
  hosts: [
    { id: "lab", type: "ssh", projectId: "p1" },
    { id: "files", type: "sftp", projectId: null },
    { id: "idle", type: "ssh", projectId: null },
  ],
  secrets: [{ id: "s1" }, { id: "s2" }],
  credentials: [{ id: "gh-work" }, { id: "gh-idle" }],
  projects: [
    { id: "r1", name: "Website", credentialId: "gh-work" },
    { id: "r2", name: "Elsewhere", credentialId: "deleted" },
  ],
  sessions: [
    { ssh: ["lab", "files"], secretIds: ["s1"], github: ["gh-work"] },
    { ssh: ["lab"], secretIds: [], github: [] },
  ],
  lastUse: new Map([["files", "2026-10-24T08:00:00.000Z"]]),
  agents: [lead, member, quiet],
  access: {
    lead: {
      sshAccesses: [
        { accessId: "lab", mode: "routines" },
        { accessId: "gone", mode: "approval" },
      ],
      secretIds: ["s1"],
      github: { credentialId: "gh-work", level: "write" },
    },
    member: {},
    quiet: {},
  },
  hooks: {
    lead: [{ id: "h1", name: "Deploy", rights: { sshHosts: ["lab", "gone"] } }],
    member: [],
    quiet: [],
  },
};

test("usage names grants, lead shares, hooks, projects and sessions per credential", () => {
  const usage = summarizeConnectionUsage(sources);
  assert.equal(usage.agentsEnabled, true);
  assert.deepEqual(usage.lastUseCovers, sshLastUseCovers);
  assert.deepEqual(usage.ssh.lab, {
    type: "ssh",
    agents: [
      { id: "lead", name: "Lead", kind: "agent", via: "grant", mode: "routines" },
      { id: "lead", name: "Lead", kind: "agent", via: "hook", mode: null },
      {
        id: "member",
        name: "Helper",
        kind: "teamMember",
        via: "lead",
        mode: "routines",
        leadId: "lead",
      },
    ],
    hooks: [{ agentId: "lead", hookId: "h1", name: "Deploy" }],
    sessions: 2,
    lastUsedAt: null,
  });
  assert.deepEqual(usage.ssh.files, {
    type: "sftp",
    agents: [],
    hooks: [],
    sessions: 1,
    lastUsedAt: "2026-10-24T08:00:00.000Z",
  });
  assert.equal(usage.ssh.idle.sessions, 0);
  assert.equal(Object.hasOwn(usage.ssh, "gone"), false);
  assert.deepEqual(usage.secrets, {
    s1: {
      agents: [{ id: "lead", name: "Lead", kind: "agent", via: "grant", mode: null }],
      sessions: 1,
    },
    s2: { agents: [], sessions: 0 },
  });
  assert.deepEqual(usage.github["gh-work"], {
    agents: [
      { id: "lead", name: "Lead", kind: "agent", via: "grant", mode: "write" },
      {
        id: "member",
        name: "Helper",
        kind: "teamMember",
        via: "lead",
        mode: "read",
        leadId: "lead",
      },
    ],
    projects: [{ id: "r1", name: "Website" }],
    sessions: 1,
  });
  assert.deepEqual(usage.github["gh-idle"], { agents: [], projects: [], sessions: 0 });
});

test("without agents the usage lists only sessions, projects and last use", () => {
  const usage = summarizeConnectionUsage({
    ...sources,
    agentsEnabled: false,
    agents: [],
    access: {},
    hooks: {},
  });
  assert.equal(usage.agentsEnabled, false);
  assert.deepEqual(usage.ssh.lab.agents, []);
  assert.deepEqual(usage.ssh.lab.hooks, []);
  assert.equal(usage.ssh.lab.sessions, 2);
  assert.deepEqual(usage.github["gh-work"].projects, [{ id: "r1", name: "Website" }]);
});

test("sources that failed to read are null, never a fake 0", () => {
  const usage = summarizeConnectionUsage({
    ...sources,
    agentsKnown: false,
    sessions: [{ ssh: null, secretIds: [], github: [] }],
    projects: null,
    lastUse: null,
  });
  assert.equal(usage.lastUseCovers, null);
  assert.equal(usage.ssh.lab.agents, null);
  assert.equal(usage.ssh.lab.hooks, null);
  assert.equal(usage.ssh.lab.sessions, null);
  assert.equal(usage.ssh.lab.lastUsedAt, null);
  assert.equal(usage.secrets.s1.sessions, 0);
  assert.equal(usage.secrets.s1.agents, null);
  assert.equal(usage.github["gh-work"].projects, null);
  const noLists = summarizeConnectionUsage({
    ...sources,
    hosts: null,
    secrets: null,
    credentials: null,
    sessions: null,
  });
  assert.equal(noLists.ssh, null);
  assert.equal(noLists.secrets, null);
  assert.equal(noLists.github, null);
});

test("a failing read marks only its own source unknown", async () => {
  const fail = () => {
    throw new Error("unreadable");
  };
  const services = {
    assistantFeature: { enabled: true },
    assistants: {
      store: { listAssistants: () => [lead, { ...quiet, archivedAt: "x" }] },
      workflows: { access: { get: () => sources.access.lead } },
    },
    assistantRoutines: { hooks: { store: { list: fail } } },
    sshAccesses: { list: () => sources.hosts },
    secrets: { list: fail },
    repositories: { listCredentials: () => sources.credentials, listProjects: fail },
    sessions: {
      list: async () => [
        { id: "a", status: "running", sshTools: { project: { projectId: "p1" } } },
        { id: "b", status: "stopped" },
      ],
    },
    sshSessions: { assigned: () => ["files"] },
    github: { status: fail },
    audit: { latestByResource: fail },
  };
  const read = await connectionUsageSources(services);
  assert.equal(read.agentsKnown, false);
  assert.deepEqual(
    read.agents.map((a) => a.id),
    ["lead"],
  );
  assert.equal(read.secrets, null);
  assert.equal(read.projects, null);
  assert.equal(read.lastUse, null);
  assert.equal(read.sessions.length, 1);
  assert.deepEqual(read.sessions[0].ssh.sort(), ["files", "lab"]);
  assert.equal(read.sessions[0].github, null);
  const usage = summarizeConnectionUsage(read);
  assert.equal(usage.ssh.lab.sessions, 1);
  assert.equal(usage.ssh.lab.agents, null);
  assert.equal(usage.github["gh-work"].sessions, null);
  assert.equal(usage.secrets, null);

  const off = await connectionUsageSources({
    ...services,
    assistantFeature: { enabled: false },
    sessions: { list: async () => Promise.reject(new Error("tmux")) },
  });
  assert.equal(off.agentsEnabled, false);
  assert.equal(off.agentsKnown, true);
  assert.deepEqual(off.agents, []);
  assert.equal(off.sessions, null);
});
