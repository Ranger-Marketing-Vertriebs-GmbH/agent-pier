import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { contractTimeout } from "../helpers/contract-timeout.js";
import { compiledShell } from "../helpers/assistant-shell-compiled.js";
import { startFakeImap } from "../helpers/fake-imap-server.js";
import { startFakeSmtp } from "../helpers/fake-smtp-server.js";
import { createGatewaySession } from "../../server/features/assistants/session-create.js";
import { routineTools } from "../../server/features/assistants/native-capabilities.js";
import { lockedTools } from "../../server/features/users/user-agent-lock.js";
import { MailAccountStore } from "../../server/features/mail/mail-account-store.js";

// agentpier_mail (AGENTPIER-264) against the pinned Gateway: AgentPier compiles the
// tool for an own agent and never for a user agent, names the granted account in its
// AGENTS.md, a model call reaches TeamBridge and AgentMail with the agent's grant on
// in-process IMAP and SMTP servers, a send outside the recipient rules returns
// awaiting_approval after the full hold inside the plugin's 125 s call timeout, and a
// routine run's toolsAllow admits the tool.
const installed = process.env.AGENTPIER_SHELL_CONTRACT_RUNTIME;
const tool = "agentpier_mail";
const mailUser = "agent@example.com";
const mailPassword = "pw-secret";
const userAccess = {
  mode: "own",
  members: [{ userId: "user-fixture", level: "extended" }],
  released: [],
};
const routineMark = "MAIL_ROUTINE_CONTRACT";
const unseen = [
  `From: Bob <bob@example.org>`,
  `To: ${mailUser}`,
  "Subject: Contract unseen",
  "Date: Tue, 27 Oct 2026 09:00:00 +0000",
  "Message-ID: <unseen@example.org>",
  "MIME-Version: 1.0",
  "Content-Type: text/plain; charset=UTF-8",
  "",
  "Hello agent.",
  "",
].join("\r\n");

test(
  "pinned Gateway: an own agent handles granted email through the compiled tool",
  {
    skip: !installed && "set AGENTPIER_SHELL_CONTRACT_RUNTIME",
    timeout: contractTimeout(330000),
  },
  async (t) => {
    // The model calls the tool with the arguments registered for `[cmd:<label>]`.
    const calls = new Map();
    const h = await compiledShell(t, installed, {
      prefix: "mail-contract-",
      tool: (input) => {
        const text = JSON.stringify(input.messages);
        const label = [...calls.keys()].find((l) => text.includes(`[cmd:${l}]`));
        return label ? { name: tool, arguments: calls.get(label) } : null;
      },
    });
    const { store, workflows, runtime, config } = h;

    // One account on in-process IMAP and SMTP servers, wired as services.js and
    // workflow-instruction-wiring.js wire it: no account of the developer.
    const users = { [mailUser]: mailPassword };
    const imap = await startFakeImap({ security: "tls", users });
    const smtp = await startFakeSmtp({ security: "tls", users });
    t.after(() => Promise.all([imap.close(), smtp.close()]));
    imap.mailbox.add("Drafts", { specialUse: "\\Drafts" });
    imap.mailbox.add("Trash", { specialUse: "\\Trash" });
    imap.mailbox.append("INBOX", {
      raw: Buffer.from(unseen, "utf8"),
      flags: [],
      internalDate: "2026-10-27T09:00:00Z",
    });
    const mailAccounts = new MailAccountStore({
      dataDir: h.at("mail-data"),
      tlsCa: [imap.ca, smtp.ca],
      audit: { append: (entry) => h.audit.push(entry) },
    });
    await mailAccounts.ready;
    // The services an access save and the compile read: none of the developer's.
    Object.assign(workflows.s, {
      pipelineDefinitions: { listPipelines: () => [] },
      accounts: { list: () => [] },
      providerConnections: { list: () => [] },
      secrets: { list: () => [] },
      sshAccesses: { list: () => [] },
      nonoSandbox: { executable: () => null },
      requests: { listAll: () => [] },
      mailAccounts,
    });
    mailAccounts.onRemoved = workflows.mail.hook;
    const account = mailAccounts.create(
      {
        name: "Private",
        address: mailUser,
        preset: "generic",
        imap: { host: "127.0.0.1", port: imap.port, security: "tls" },
        smtp: { host: "127.0.0.1", port: smtp.port, security: "tls" },
        password: mailPassword,
      },
      { role: "owner" },
    );
    config.mailAccounts = (agent) =>
      workflows.mail
        .accounts(agent.id)
        .map(({ accountId, name }) => ({ accountId, name }));

    const owner = h.create("Owner");
    workflows.access.save(
      owner.id,
      {
        projectIds: [],
        pipelineIds: [],
        memoryWrite: false,
        autonomous: false,
        publish: false,
        mailAccesses: [
          { accountId: account.id, level: "send", recipients: ["example.org"] },
        ],
      },
      0,
    );
    const user = h.create("User");
    store.changeUserAgent(user.id, { userAccess });
    await runtime.start();
    for (const agent of [owner, user]) await config.apply(agent.id);

    // 1. The compiled entries: the own agent holds the tool, the user agent denies it.
    const entries = (await h.running()).agents.entries;
    const entryOf = (agent) => entries[store.getAssistant(agent.id).runtimeAgentId];
    assert.ok(entryOf(owner).tools.allow.includes(tool), "own agent holds the tool");
    assert.ok(!entryOf(user).tools.allow.includes(tool), "user agent never holds it");
    assert.ok(lockedTools.includes(tool));
    assert.ok(entryOf(user).tools.deny.includes(tool));
    const ownerAgentId = store.getAssistant(owner.id).runtimeAgentId;
    const instructions = fs.readFileSync(
      path.join(runtime.paths.workspaces, owner.id, "AGENTS.md"),
      "utf8",
    );
    assert.match(instructions, /\n## Email\n/);
    assert.ok(instructions.includes(`(accountId ${JSON.stringify(account.id)})`));
    assert.ok(!instructions.includes(mailPassword));

    // 2. An owner turn's accounts call reaches AgentMail through the bridge and
    // returns the granted account with its level and rules.
    calls.set("accounts", { action: "accounts" });
    const accounts = await h.settle(await h.send(owner, "accounts", "unused"));
    t.diagnostic(`accounts=${accounts.result?.slice(0, 600)}`);
    assert.equal(accounts.status, "ok");
    assert.ok(accounts.offered.includes(tool));
    assert.ok(accounts.result.includes(account.id), "the granted account");
    assert.match(accounts.result, /"level":\s*"send"/);
    assert.match(accounts.result, /"example\.org"/);

    // 3. list with new: true returns the fake's unseen message, marked untrusted.
    calls.set("list", { action: "list", accountId: account.id, new: true });
    const list = await h.settle(await h.send(owner, "list", "unused"));
    t.diagnostic(`list=${list.result?.slice(0, 600)}`);
    assert.equal(list.status, "ok");
    assert.match(list.result, /"untrusted":\s*true/);
    assert.ok(list.result.includes("Contract unseen"), "the unseen message");
    assert.match(list.result, /"unseen":\s*true/);

    // 4. A send outside the rules holds the call for the full approval hold and
    // returns awaiting_approval inside the plugin's call timeout; one card waits.
    calls.set("send", {
      action: "send",
      accountId: account.id,
      to: ["eve@elsewhere.net"],
      subject: "Contract send",
      body: "Hi there.",
    });
    // The clock starts before the turn, so the whole call counts toward the timeout.
    const started = Date.now();
    const turn = await h.send(owner, "send", "unused");
    const runId =
      h.assistants.ledger.getAttempt(turn.attempt.id).runtimeRunId || turn.attempt.id;
    const done = await runtime.client.call(
      "agent.wait",
      { runId, timeoutMs: 180000 },
      { timeoutMs: 185000 },
    );
    const elapsed = Date.now() - started;
    const result = h.model.requests
      .filter((r) => JSON.stringify(r.messages).includes("[cmd:send]"))
      .flatMap((r) => r.messages || [])
      .filter((m) => m.role === "tool")
      .map((m) => String(m.content))
      .at(-1);
    t.diagnostic(`send=${done.status} after ${elapsed} ms: ${result?.slice(0, 600)}`);
    assert.equal(done.status, "ok");
    assert.match(result, /"status":\s*"awaiting_approval"/);
    assert.ok(elapsed < 125000, "inside the plugin's call timeout");
    const cards = workflows.store
      .list(owner.id)
      .filter((a) => a.payload?.action === "mail_send");
    assert.equal(cards.length, 1, "one mail_send row");
    assert.equal(cards[0].state, "awaiting_approval");
    assert.equal(cards[0].payload.trusted, false);
    assert.ok(result.includes(cards[0].id));
    assert.equal(smtp.messages.length, 0, "nothing went out");
    assert.equal(imap.folder("Drafts").messages.length, 1, "the draft is saved");

    // 5. A routine run's toolsAllow admits the tool: the model is offered it.
    const session = await createGatewaySession(runtime.client, {
      agentId: ownerAgentId,
      label: "Routine target",
    });
    const job = await runtime.client.call("cron.add", {
      name: "Mail routine",
      agentId: ownerAgentId,
      enabled: false,
      deleteAfterRun: false,
      schedule: { kind: "every", everyMs: 3600000 },
      wakeMode: "now",
      sessionTarget: "current",
      sessionKey: session.key,
      payload: {
        kind: "agentTurn",
        message: `Check the mail. ${routineMark}`,
        timeoutSeconds: 120,
        lightContext: false,
        toolsAllow: [...routineTools],
      },
      delivery: { mode: "none" },
    });
    await runtime.client.call("cron.run", { id: job.id, mode: "force" });
    let routine;
    for (let n = 0; n < 300 && !routine; n++) {
      routine = h.model.requests.find((r) =>
        JSON.stringify(r.messages).includes(routineMark),
      );
      if (!routine) await delay(200);
    }
    assert.ok(routine, "the routine run reached the model");
    const routineOffered = routine.tools?.map((d) => d.function.name) ?? [];
    t.diagnostic(`routine tools=${JSON.stringify(routineOffered)}`);
    assert.ok(routineOffered.includes(tool), "toolsAllow admits the tool");
    assert.ok(!routineOffered.includes("exec"), "the run stays capped");
  },
);
