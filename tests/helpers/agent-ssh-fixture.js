import { auditEvent } from "../../server/features/audit/audit-schema.js";
import { workflowFixture } from "./assistant-workflow-fixture.js";

export const hostId = "11111111-1111-4111-8111-111111111111";
export const otherHostId = "22222222-2222-4222-8222-222222222222";
export const sftpHostId = "33333333-3333-4333-8333-333333333333";
const defaultHosts = [
  {
    id: hostId,
    name: "opnsense",
    host: "opnsense.invalid",
    port: 22,
    username: "root",
    hostFingerprint: "SHA256:opnsense",
    projectId: null,
    type: "ssh",
    remoteRoot: null,
  },
  {
    id: otherHostId,
    name: "nas-01",
    host: "nas.invalid",
    port: 2222,
    username: "admin",
    hostFingerprint: "SHA256:nas",
    projectId: null,
    type: "ssh",
    remoteRoot: null,
  },
];

/**
 * An SFTP catalog row for an in-process SFTP server (tests/helpers/sftp-server.js):
 * the password and host key stay in `secret`, which only `sftpConnection` returns.
 */
export function sftpRow(server, { remoteRoot = null, password = "pw-secret" } = {}) {
  return {
    id: sftpHostId,
    name: "site",
    host: server.host,
    port: server.port,
    username: "deploy",
    hostFingerprint: "SHA256:site",
    projectId: null,
    type: "sftp",
    auth: "password",
    remoteRoot,
    secret: { hostKey: server.hostKey, password },
  };
}
const typeError = () =>
  Object.assign(Error("SSH_HOST_TYPE"), { code: "SSH_HOST_TYPE", status: 409 });

/**
 * A stand-in for SshAccessStore: catalog rows, a connection revision per host, and the
 * local Node binary as `ssh`, so a command is JavaScript and never reaches a network.
 * `failing` makes the catalog unreadable; `program` replaces the binary. SFTP rows
 * (sftpRow) answer `sftpConnection` with their in-process server's credentials and,
 * like the real store, refuse `connection`.
 */
export function fakeCatalog(cwd, hosts = defaultHosts) {
  const rows = new Map(hosts.map((h) => [h.id, { ...h, revision: "r1" }]));
  const visible = ({ revision: _revision, secret: _secret, ...h }) => ({ ...h });
  const catalog = {
    rows,
    program: process.execPath,
    failing: false,
    connections: 0,
    list() {
      if (catalog.failing) throw Object.assign(Error("unreadable"), { status: 500 });
      return [...rows.values()].map(visible);
    },
    get(id) {
      const h = rows.get(id);
      if (!h) throw Object.assign(Error("missing"), { status: 404 });
      return visible(h);
    },
    revision(id) {
      catalog.get(id);
      return rows.get(id).revision;
    },
    connection(id) {
      const revision = catalog.revision(id);
      if (rows.get(id).type === "sftp") throw typeError();
      catalog.connections++;
      return { revision, command: catalog.program, args: ["-e"], cwd, cleanup() {} };
    },
    sftpConnection(id) {
      const revision = catalog.revision(id);
      const row = rows.get(id);
      if (row.type !== "sftp") throw typeError();
      catalog.connections++;
      const { host, port, username, remoteRoot } = row;
      return { revision, host, port, username, remoteRoot, ...row.secret };
    },
  };
  return catalog;
}

export async function waitFor(check, timeoutMs = 3000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > end) throw Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const emptyPolicy = {
  projectIds: [],
  pipelineIds: [],
  memoryWrite: false,
  autonomous: false,
  publish: false,
};

/** `hosts` adds catalog rows (sftpRow) to the two SSH hosts. */
export async function agentSshFixture(t, { hosts = [] } = {}) {
  const f = await workflowFixture(t);
  // Every record passes the real audit schema, as AuditStore.append would require.
  const audit = [];
  f.services.audit = { append: (event) => audit.push(auditEvent(event)) };
  const catalog = fakeCatalog(f.dataDir, [...defaultHosts, ...hosts]);
  f.services.sshManagement = { store: catalog };
  // Follow-up turns record their trusted context next to the text.
  const followUps = [];
  const send = f.assistants.send;
  f.assistants.send = async (id, input, context) => {
    if (context) followUps.push({ conversationId: id, input, context });
    return send(id, input, context);
  };
  // Contexts of the turns this helper creates directly in the ledger.
  const contexts = new Map();
  const context = f.assistants.teams.store.context;
  f.assistants.teams.store.context = (id) => contexts.get(id) ?? context(id);
  const grant = (sshAccesses, id = f.id) =>
    f.workflows.access.save(
      id,
      { ...(id === f.id ? f.policy : emptyPolicy), sshAccesses },
      f.workflows.access.get(id).revision,
    );
  /** A turn in `conversationId` with `origin`, as the bridge hands it to AgentSsh. */
  function turn(conversationId, origin = { kind: "owner" }) {
    const key = crypto.randomUUID();
    const request = f.assistants.ledger.accept(conversationId, {
      clientRequestId: key,
      text: "Run it",
    });
    const attempt = f.assistants.ledger.recordAttempt(request.id);
    contexts.set(request.id, origin);
    let current = true;
    return {
      attemptId: attempt.id,
      toolCallId: key,
      startedAt: Date.now(),
      assertCurrent() {
        if (!current)
          throw Object.assign(Error("stale"), { status: 403, key: "invalid" });
      },
      end() {
        current = false;
      },
    };
  }
  const ownTurn = (origin) => turn(f.channel.conversationId, origin);
  /** A routine's own run session: no attempt, the bridge's routine record. */
  const routineTurn = (extra = {}) => ({
    attemptId: null,
    sessionKey: `agent:${f.store.getAssistant(f.id).runtimeAgentId}:cron:job-1:run:r1`,
    toolCallId: crypto.randomUUID(),
    startedAt: Date.now(),
    routine: {
      binding: { id: "binding-1" },
      conversation: f.store.getConversation(f.channel.conversationId),
    },
    assertCurrent() {},
    ...extra,
  });
  function member({ lifetime = "permanent", name = "Scout" } = {}) {
    const record = f.store.reserveMember({
      id: `member-${crypto.randomUUID()}`,
      parent: f.id,
      assignment: { name, role: "Ops", assignment: "Watch hosts" },
      snapshot: { model: { connectionId: "test", modelId: "fixture" }, instructions: "" },
      teamId: "team-1",
      lifetime,
    });
    const chat = f.store.saveConversation({
      assistantId: record.id,
      runtimeSessionKey: `agent:${record.runtimeAgentId}:main`,
    });
    return { ...record, conversationId: chat.id };
  }
  const call = (inv, input) => f.workflows.ssh.invoke(inv, input);
  const execute = (inv, command, accessId = hostId, extra = {}) =>
    call(inv, { action: "execute", accessId, command, ...extra });
  return {
    ...f,
    audit,
    catalog,
    followUps,
    grant,
    turn,
    ownTurn,
    routineTurn,
    member,
    call,
    execute,
  };
}
