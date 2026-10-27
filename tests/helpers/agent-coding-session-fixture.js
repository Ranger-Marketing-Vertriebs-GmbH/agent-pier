import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { workflowFixture } from "./assistant-workflow-fixture.js";
import { PipelineWorkspace } from "../../server/features/pipelines/workspace-manager.js";

const git = (cwd, args) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
  });
const notFound = () => Object.assign(Error("Session not found"), { status: 404 });
const stale = () => Object.assign(Error("Request changed"), { status: 409 });

/**
 * The workflow fixture with a git project (one commit, a bare `origin`), coding
 * sessions switched on for it (unless `sessionProjects` is false) and fakes for
 * everything an agent's coding session touches: launches, the session store, its
 * activity, chat replies, chat delivery and the request broker.
 */
export async function agentSessionFixture(t, { sessionProjects = true } = {}) {
  const f = await workflowFixture(t);
  const cwd = path.join(f.dataDir, "project"),
    remote = path.join(f.dataDir, "origin.git");
  git(f.dataDir, ["init", "--bare", "-q", "-b", "main", remote]);
  git(cwd, ["init", "-q", "-b", "main"]);
  fs.writeFileSync(path.join(cwd, "README.md"), "fixture\n");
  git(cwd, ["add", "README.md"]);
  git(cwd, ["commit", "-q", "-m", "initial"]);
  git(cwd, ["remote", "add", "origin", remote]);
  git(cwd, ["push", "-q", "origin", "main"]);
  // The folder became a Git work tree after the workflow fixture registered it:
  // registering it again moves its row to the Git identity now, as AgentPier would
  // on its next look at the folder (project-memory.js), so the ids stay stable.
  const project = await f.memory.register(cwd);
  const policy = { ...f.policy, projectIds: [project.id] };
  f.workflows.access.save(
    f.id,
    { ...policy, sessionProjectIds: sessionProjects ? [project.id] : [] },
    0,
  );

  const s = f.services,
    launches = [],
    sessions = new Map(),
    activity = new Map(),
    replies = new Map(),
    requests = new Map(),
    receipts = new Map();
  s.launch = async (body, login, trusted = {}) => {
    launches.push({ body: structuredClone(body), trusted: structuredClone(trusted) });
    const session = {
      id: trusted.id || crypto.randomUUID(),
      status: "running",
      tool: body.tool,
      accountId: body.accountId || `local-${body.tool}`,
      cwd: body.cwd,
      ...(trusted.startedBy ? { startedBy: structuredClone(trusted.startedBy) } : {}),
      createdAt: new Date().toISOString(),
    };
    sessions.set(session.id, session);
    return structuredClone(session);
  };
  s.sessions = {
    async get(id) {
      if (!sessions.has(id)) throw notFound();
      return structuredClone(sessions.get(id));
    },
    async list() {
      return [...sessions.values()].map((x) => structuredClone(x));
    },
    async stop(id) {
      if (!sessions.has(id)) throw notFound();
      sessions.get(id).status = "stopped";
      return structuredClone(sessions.get(id));
    },
  };
  s.reload = null;
  s.activity = {
    async read(session) {
      return { state: activity.get(session.id) || "idle", source: "fixture" };
    },
  };
  // At most once per deliveryId, as ChatDelivery: a retry returns the first receipt.
  s.chatDelivery = {
    receipts,
    sent: [],
    async status(id, deliveryId) {
      if (!sessions.has(id)) throw notFound();
      return receipts.get(deliveryId) || { deliveryId, status: "absent" };
    },
    async send(id, body) {
      if (!sessions.has(id)) throw notFound();
      if (receipts.has(body.deliveryId))
        return structuredClone(receipts.get(body.deliveryId));
      s.chatDelivery.sent.push({ sessionId: id, body: structuredClone(body) });
      const receipt = { deliveryId: body.deliveryId, status: "handed-off" };
      receipts.set(body.deliveryId, receipt);
      return structuredClone(receipt);
    },
  };
  s.chat = {
    async read(id) {
      return { messages: structuredClone(replies.get(id) || []) };
    },
  };
  const strip = ({ sessionId: _s, ...entry }) => entry;
  s.requests = {
    async list(sessionId) {
      if (!sessions.has(sessionId)) throw notFound();
      return {
        requests: [...requests.values()]
          .filter((e) => e.sessionId === sessionId)
          .map((e) => ({ ...strip(e), sessionId })),
      };
    },
    listAll() {
      return [...requests.values()].map((e) => structuredClone(e));
    },
    answers: [],
    async answer(sessionId, id, input, handoff = false, actor = null) {
      const entry = requests.get(id);
      if (
        !entry ||
        entry.sessionId !== sessionId ||
        entry.status !== "pending" ||
        entry.revision !== input?.expectedRevision
      )
        throw stale();
      s.requests.answers.push({ sessionId, id, input, handoff, actor });
      requests.delete(id);
      return s.requests.list(sessionId);
    },
  };
  s.github = { status: async () => ({ configured: false, hosts: [] }) };
  s.accounts = {
    list: () => [
      ...["codex", "claude", "opencode", "shell"].map((tool) => ({
        id: `local-${tool}`,
        name: `Local ${tool}`,
        tool,
        kind: "local",
      })),
      { id: "work-claude", name: "Work", tool: "claude", kind: "oauth" },
    ],
  };
  s.providerConnections = {
    list: () => [
      {
        id: "router",
        name: "Router",
        providerId: "endpoint",
        launchable: true,
        tools: ["codex", "claude"],
        endpoint: { models: [{ modelId: "local-model", contextTokens: 32000 }] },
      },
      {
        id: "keyless",
        name: "Keyless",
        providerId: "endpoint",
        launchable: false,
        tools: ["codex"],
        endpoint: { models: [] },
      },
    ],
  };
  s.secrets = { list: () => [{ id: "secret-1", name: "Token", kind: "env" }] };
  s.sshAccesses = { list: () => [{ id: "ssh-1", name: "Box", host: "box.invalid" }] };
  s.nonoSandbox = { executable: () => null };
  s.pipelineWorkspace = new PipelineWorkspace({
    dataDir: f.dataDir,
    github: s.github,
    memory: f.memory,
    sessions: s.sessions,
  });

  return {
    ...f,
    project,
    policy,
    cwd,
    remote,
    launches,
    sessions,
    setActivity: (id, state) => activity.set(id, state),
    setReplies: (id, messages) => replies.set(id, structuredClone(messages)),
    addRequest: (sessionId, entry) =>
      requests.set(entry.id, {
        status: "pending",
        revision: 1,
        ...structuredClone(entry),
        sessionId,
      }),
    call: (inv, input) => f.workflows.sessions.invoke(inv, input),
  };
}
