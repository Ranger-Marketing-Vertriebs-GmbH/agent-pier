import { agentSshFixture } from "./agent-ssh-fixture.js";
import { startFakeImap } from "./fake-imap-server.js";
import { startFakeSmtp } from "./fake-smtp-server.js";
import { MailAccountStore } from "../../server/features/mail/mail-account-store.js";

export const mailUser = "agent@example.com";
export const mailPassword = "pw-secret";
const owner = { role: "owner" };
const emptyPolicy = {
  projectIds: [],
  pipelineIds: [],
  memoryWrite: false,
  autonomous: false,
  publish: false,
};

/**
 * The agent SSH fixture with a real MailAccountStore on in-process IMAP and SMTP
 * servers (`security` for both), one account, and the hook wiring the application
 * graph sets up (`services.mailAccounts.onRemoved = workflows.mail.hook`).
 * `routineTurn` and `hookTurn` are bridge invocations without an attempt; a hook
 * run's live Email tick is `hook.mail` (AgentHooks.runOrigin, re-read every call).
 */
export async function mailFixture(t, { security = "tls" } = {}) {
  const f = await agentSshFixture(t);
  const users = { [mailUser]: mailPassword };
  const imap = await startFakeImap({ security, users });
  const smtp = await startFakeSmtp({ security, users });
  t.after(() => Promise.all([imap.close(), smtp.close()]));
  const store = new MailAccountStore({
    dataDir: f.dataDir,
    tlsCa: [imap.ca, smtp.ca],
    audit: f.services.audit,
  });
  await store.ready;
  f.services.mailAccounts = store;
  store.onRemoved = f.workflows.mail.hook;
  const account = store.create(
    {
      name: "Private",
      address: mailUser,
      preset: "generic",
      imap: { host: "127.0.0.1", port: imap.port, security },
      smtp: { host: "127.0.0.1", port: smtp.port, security },
      ...(security === "none" ? { allowPlaintext: true } : {}),
      password: mailPassword,
    },
    owner,
  );
  // Routine refusal notes and the hook run's live origin.
  const notes = [];
  const hook = { mail: true, running: true };
  f.assistants.routines = {
    ...f.assistants.routines,
    noteRefusal: (sessionKey, note) => notes.push({ sessionKey, note }),
    hooks: {
      runOrigin: (agent, sessionKey) =>
        hook.running && sessionKey === hookSession(agent)
          ? {
              hook: { id: "hook-1" },
              event: { id: "event-1" },
              effective: { mail: hook.mail },
            }
          : null,
    },
  };
  const hookSession = (agent) => `agent:${agent.runtimeAgentId}:cron:hook-job:run:h1`;
  const grant = (level, recipients, id = f.id, accountId = account.id) =>
    f.workflows.access.save(
      id,
      {
        ...(id === f.id ? f.policy : emptyPolicy),
        mailAccesses: level
          ? [{ accountId, level, ...(recipients && { recipients }) }]
          : [],
      },
      f.workflows.access.get(id).revision,
    );
  const call = (inv, input) => f.workflows.mail.invoke(inv, input);
  /** A hook run of `assistantId`'s agent, as the bridge hands it to AgentMail. */
  const hookTurn = (assistantId = f.id) => {
    const agent = f.store.getAssistant(assistantId);
    const conversation = { id: f.channel.conversationId, assistantId };
    return {
      attemptId: null,
      sessionKey: hookSession(agent),
      toolCallId: crypto.randomUUID(),
      startedAt: Date.now(),
      hook: { hook: { id: "hook-1" }, event: { id: "event-1" }, conversation },
      assertCurrent() {},
    };
  };
  return {
    ...f,
    imap,
    smtp,
    mailStore: store,
    account,
    notes,
    hook,
    grant,
    call,
    hookTurn,
  };
}
