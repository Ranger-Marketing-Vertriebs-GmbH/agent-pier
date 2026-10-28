import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { contractTimeout } from "../helpers/contract-timeout.js";
import { compiledShell } from "../helpers/assistant-shell-compiled.js";
import { startFakeImap } from "../helpers/fake-imap-server.js";
import { startFakeSmtp } from "../helpers/fake-smtp-server.js";
import { docxWith, mimeWith, pdfWith } from "../helpers/mail-documents.js";
import { mailDefinition } from "../../server/features/assistants/team-plugin/mail-tool.js";
import { MailAccountStore } from "../../server/features/mail/mail-account-store.js";

// agentpier_mail's attachments and forwarding (AGENTPIER-265) against the pinned
// Gateway: one owner turn per call through the compiled tool, each asserted on the
// result the Gateway hands back, plus the saved file, the card's row and the fake
// SMTP message. The full approval hold is covered by assistant-mail-contract.test.js;
// here a short hold keeps the run lean.
const installed = process.env.AGENTPIER_SHELL_CONTRACT_RUNTIME;
const tool = "agentpier_mail";
const mailUser = "agent@example.com";
const mailPassword = "pw-secret";
const pdfType = "application/pdf";
const docxType =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

test(
  "pinned Gateway: an own agent reads, saves, searches, attaches and forwards mail attachments",
  {
    skip: !installed && "set AGENTPIER_SHELL_CONTRACT_RUNTIME",
    timeout: contractTimeout(240000),
  },
  async (t) => {
    // The model calls the tool with the arguments registered for `[cmd:<label>]`.
    const calls = new Map();
    const h = await compiledShell(t, installed, {
      prefix: "mail-attachments-contract-",
      tool: (input) => {
        const text = JSON.stringify(input.messages);
        const label = [...calls.keys()].find((l) => text.includes(`[cmd:${l}]`));
        return label ? { name: tool, arguments: calls.get(label) } : null;
      },
    });
    const { workflows, runtime, config } = h;
    // One owner turn that calls the tool with `args`; returns the settled turn.
    const call = async (label, args) => {
      calls.set(label, args);
      const turn = await h.settle(await h.send(owner, label, "unused"));
      t.diagnostic(`${label}=${turn.result?.slice(0, 600)}`);
      assert.equal(turn.status, "ok", `${label} turn`);
      assert.ok(turn.result, `${label} returned a tool result`);
      return { ...turn, json: JSON.parse(turn.result) };
    };

    // One account on in-process IMAP and SMTP servers: no account of the developer.
    const users = { [mailUser]: mailPassword };
    const imap = await startFakeImap({ security: "tls", users });
    const smtp = await startFakeSmtp({ security: "tls", users });
    t.after(() => Promise.all([imap.close(), smtp.close()]));
    for (const [name, specialUse] of [
      ["Drafts", "\\Drafts"],
      ["Trash", "\\Trash"],
      ["Sent", "\\Sent"],
    ])
      imap.mailbox.add(name, { specialUse });
    const pdf = pdfWith("Rechnung 49,99");
    const raw = mimeWith({
      subject: "Rechnung Oktober",
      text: "Ihre Rechnung liegt bei.",
      attachments: [
        { name: "rechnung.pdf", type: pdfType, content: pdf },
        { name: "vertrag.docx", type: docxType, content: await docxWith("Telekom") },
      ],
    }).replace("From: owner@example.com", "From: Telekom <rechnung@telekom.de>");
    const { uid } = imap.mailbox.append("INBOX", {
      raw: Buffer.from(raw, "latin1"),
      flags: [],
      internalDate: "2026-10-27T13:00:00Z",
    });
    // The PDF part as the original carries it, to find it unchanged in the forward.
    const pdfPart = raw.match(
      /Content-Type: application\/pdf; name="rechnung.pdf"\r\n[^]*?(?=\r\n--mix)/,
    )[0];
    const mailAccounts = new MailAccountStore({
      dataDir: h.at("mail-data"),
      tlsCa: [imap.ca, smtp.ca],
      audit: { append: (entry) => h.audit.push(entry) },
    });
    await mailAccounts.ready;
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
    // A short approval hold: the call returns awaiting_approval after 2 s.
    workflows.mail.sends.holdMs = 2000;
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
    await runtime.start();
    await config.apply(owner.id);
    // The write guard is live, as on an installed host: a save may write mail/.
    config.writeGuard = () => true;
    const workspace = path.join(runtime.paths.workspaces, owner.id);
    const offer = pdfWith("Angebot");
    fs.writeFileSync(path.join(workspace, "offer.pdf"), offer);
    const base = { accountId: account.id, folder: "INBOX", uid };

    // 1. read lists each attachment's part, name and type, never its content.
    const read = await call("read", { action: "read", ...base });
    // The Gateway offers the tool with its whole description.
    const offered = h.model.requests
      .find((r) => JSON.stringify(r.messages).includes("[cmd:read]"))
      ?.tools?.find((d) => d.function.name === tool);
    const description = mailDefinition.mail.description;
    t.diagnostic(
      `description=${offered?.function.description?.length}/${description.length}`,
    );
    assert.equal(offered?.function.description, description, "description intact");
    const parts = Object.fromEntries(
      read.json.message.attachments.map((a) => [a.name, a.part]),
    );
    assert.ok(parts["rechnung.pdf"] && parts["vertrag.docx"], "both parts listed");
    assert.ok(!read.result.includes(pdf.toString("base64").slice(0, 40)));

    // 2. attachment mode save writes the PDF below mail/Private/ in the workspace.
    const saved = await call("save", {
      action: "attachment",
      ...base,
      part: parts["rechnung.pdf"],
      mode: "save",
    });
    assert.equal(saved.json.untrusted, true);
    assert.equal(saved.json.saved.workspace, true);
    assert.match(saved.json.saved.path, /^mail\/Private\/rechnung\.pdf$/);
    assert.deepEqual(
      fs.readFileSync(path.join(workspace, saved.json.saved.path)),
      pdf,
      "the saved file holds the attachment",
    );

    // 3. attachment mode text returns the PDF's text, marked untrusted.
    const text = await call("text", {
      action: "attachment",
      ...base,
      part: parts["rechnung.pdf"],
      mode: "text",
    });
    assert.equal(text.json.untrusted, true);
    assert.ok(text.json.text.includes("49,99"), "the PDF's text");

    // 4. search by attachmentText finds the mail through its DOCX.
    const search = await call("search", {
      action: "search",
      accountId: account.id,
      query: { attachmentText: "Telekom" },
    });
    assert.deepEqual(
      search.json.messages.map((m) => m.uid),
      [uid],
    );
    assert.deepEqual(search.json.messages[0].attachmentMatches, [
      { part: parts["vertrag.docx"], name: "vertrag.docx" },
    ]);

    // 5. A send with a workspace file outside the rules waits for a card.
    const send = await call("send", {
      action: "send",
      accountId: account.id,
      to: ["eve@evil.net"],
      subject: "Angebot",
      body: "Anbei.",
      attachments: [{ path: "offer.pdf" }],
    });
    assert.equal(send.json.status, "awaiting_approval");
    const card = workflows.store.get(send.json.actionId);
    assert.equal(card.payload.action, "mail_send");
    assert.equal(card.state, "awaiting_approval");
    assert.equal(card.payload.trusted, false);
    assert.equal(card.payload.attachments.length, 1);
    assert.equal(card.payload.attachments[0].name, "offer.pdf");
    assert.equal(card.payload.attachments[0].size, offer.length);
    assert.deepEqual(card.payload.attachments[0].source, {
      kind: "workspace",
      path: "offer.pdf",
    });
    assert.equal(smtp.messages.length, 0, "nothing went out");

    // 6. A forward to a recipient the rule allows goes out at once with the PDF.
    const forward = await call("forward", {
      action: "forward",
      ...base,
      to: ["bob@example.org"],
      body: "FYI",
    });
    assert.equal(forward.json.status, "sent");
    const row = workflows.store.get(forward.json.actionId);
    assert.equal(row.payload.trusted, true);
    assert.equal(row.state, "completed");
    assert.equal(smtp.messages.length, 1, "one message went out");
    const sent = smtp.messages[0].raw.toString("latin1");
    assert.ok(sent.includes(pdfPart), "the original PDF part goes out unchanged");
    assert.match(sent, /^Subject: Fwd: Rechnung Oktober\r$/m);
    assert.match(sent, /^To: bob@example\.org\r$/m);
  },
);
