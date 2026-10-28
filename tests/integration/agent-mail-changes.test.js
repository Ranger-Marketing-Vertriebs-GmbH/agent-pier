import test from "node:test";
import assert from "node:assert/strict";
import { mailFixture } from "../helpers/agent-mail-fixture.js";
import { toolError } from "../../server/features/assistants/tool-errors.js";

const raw = (subject, headers = "") =>
  `From: Sender <sender@example.org>\r\nTo: agent@example.com\r\nSubject: ${subject}\r\nDate: Tue, 27 Oct 2026 08:00:00 +0000\r\n${headers}MIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\nHello.\r\n`;
const withAttachment = (subject) =>
  `From: agent@example.com\r\nTo: bob@example.org\r\nSubject: ${subject}\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="b1"\r\n\r\n--b1\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\nSee attached.\r\n--b1\r\nContent-Type: application/pdf; name="a.pdf"\r\nContent-Disposition: attachment; filename="a.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\nJVBERi0=\r\n--b1--\r\n`;

const standard = {
  Drafts: { specialUse: "\\Drafts" },
  Trash: { specialUse: "\\Trash" },
  Archive: { specialUse: "\\Archive" },
};

async function code(promise) {
  try {
    await promise;
  } catch (error) {
    return toolError(error).code;
  }
  assert.fail("the call succeeded");
}

async function changesFixture(t, folders = standard) {
  const f = await mailFixture(t);
  f.grant("read");
  for (const [path, folder] of Object.entries(folders)) f.imap.mailbox.add(path, folder);
  const seed = (subject, { folder = "INBOX", flags = [], message } = {}) =>
    f.imap.mailbox.append(folder, {
      raw: Buffer.from(message ?? raw(subject), "latin1"),
      flags,
    }).uid;
  const mail = (input, inv = f.ownTurn()) =>
    f.call(inv, { accountId: f.account.id, ...input });
  const subjects = (path) =>
    f.imap
      .folder(path)
      .messages.map((m) => m.raw.toString("latin1").match(/^Subject: (.*)$/m)?.[1]);
  const flags = (path, uid) => [
    ...f.imap.folder(path).messages.find((m) => m.uid === uid).flags,
  ];
  const untouched = () => {
    assert.deepEqual(f.imap.mailbox.expunges ?? [], []);
    assert.equal(f.imap.mailbox.deleteFlags ?? 0, 0);
  };
  return { ...f, seed, mail, subjects, flags, untouched };
}

test("mark toggles read, unread, flagged and unflagged", async (t) => {
  const f = await changesFixture(t);
  const a = f.seed("One");
  const b = f.seed("Two");
  assert.deepEqual(await f.mail({ action: "mark", uids: [a, b], flag: "read" }), {
    accountId: f.account.id,
    account: "Private",
    folder: "INBOX",
    marked: 2,
  });
  assert.deepEqual(f.flags("INBOX", a), ["\\Seen"]);
  assert.deepEqual(f.flags("INBOX", b), ["\\Seen"]);
  await f.mail({ action: "mark", uid: a, flag: "unread" });
  assert.deepEqual(f.flags("INBOX", a), []);
  await f.mail({ action: "mark", uid: b, flag: "flagged" });
  assert.deepEqual(f.flags("INBOX", b).sort(), ["\\Flagged", "\\Seen"]);
  await f.mail({ action: "mark", uid: b, flag: "unflagged" });
  assert.deepEqual(f.flags("INBOX", b), ["\\Seen"]);
  // Unknown messages, folders and incomplete input.
  assert.equal(
    await code(f.mail({ action: "mark", uid: 99, flag: "read" })),
    "MAIL_NOT_FOUND",
  );
  assert.equal(
    await code(f.mail({ action: "mark", uid: a, flag: "read", folder: "Nope" })),
    "MAIL_NOT_FOUND",
  );
  assert.equal(await code(f.mail({ action: "mark", uid: a })), "INVALID_INPUT");
  assert.equal(await code(f.mail({ action: "mark", flag: "read" })), "INVALID_INPUT");
  assert.equal(
    await code(f.mail({ action: "mark", uid: a, uids: [b], flag: "read" })),
    "INVALID_INPUT",
  );
  assert.equal(
    await code(f.mail({ action: "mark", uid: a, flag: "read", destination: "Archive" })),
    "INVALID_INPUT",
  );
  f.untouched();
});

test("move to archive uses \\Archive, else \\All, else MAIL_NO_ARCHIVE", async (t) => {
  const f = await changesFixture(t);
  const a = f.seed("Keep");
  f.seed("Stay");
  const result = await f.mail({ action: "move", uid: a, destination: "archive" });
  assert.deepEqual(result, {
    accountId: f.account.id,
    account: "Private",
    folder: "INBOX",
    destination: "Archive",
    moved: 1,
  });
  assert.deepEqual(f.subjects("Archive"), ["Keep"]);
  assert.deepEqual(f.subjects("INBOX"), ["Stay"]);
  // A named folder; an unknown destination changes nothing.
  f.imap.mailbox.add("Projects");
  const [stay] = f.imap.folder("INBOX").messages;
  await f.mail({ action: "move", uids: [stay.uid], destination: "Projects" });
  assert.deepEqual(f.subjects("Projects"), ["Stay"]);
  const back = f.imap.folder("Projects").messages[0].uid;
  assert.equal(
    await code(
      f.mail({ action: "move", uid: back, folder: "Projects", destination: "Gone" }),
    ),
    "MAIL_NOT_FOUND",
  );
  assert.deepEqual(f.subjects("Projects"), ["Stay"]);
  assert.equal(await code(f.mail({ action: "move", uid: back })), "INVALID_INPUT");
  f.untouched();

  const gmail = await changesFixture(t, {
    "[Gmail]/All Mail": { specialUse: "\\All" },
    "[Gmail]/Trash": { specialUse: "\\Trash" },
  });
  const g = gmail.seed("Gmail");
  const moved = await gmail.mail({ action: "move", uid: g, destination: "archive" });
  assert.equal(moved.destination, "[Gmail]/All Mail");
  assert.deepEqual(gmail.subjects("[Gmail]/All Mail"), ["Gmail"]);

  const bare = await changesFixture(t, { Trash: { specialUse: "\\Trash" } });
  const n = bare.seed("Nowhere");
  assert.equal(
    await code(bare.mail({ action: "move", uid: n, destination: "archive" })),
    "MAIL_NO_ARCHIVE",
  );
  assert.deepEqual(bare.subjects("INBOX"), ["Nowhere"]);
});

test("delete only moves to Trash, never expunges, and is audited without content", async (t) => {
  const f = await changesFixture(t);
  const a = f.seed("Secret subject one");
  const b = f.seed("Secret subject two");
  f.seed("Survivor");
  const result = await f.mail({ action: "delete", uids: [a, b] });
  assert.deepEqual(result, {
    accountId: f.account.id,
    account: "Private",
    folder: "INBOX",
    moved: 2,
    alreadyInTrash: 0,
  });
  assert.deepEqual(f.subjects("Trash"), ["Secret subject one", "Secret subject two"]);
  assert.deepEqual(f.subjects("INBOX"), ["Survivor"]);
  f.untouched();
  const records = f.audit.filter((e) => e.action === "mail.deleted");
  assert.equal(records.length, 1);
  assert.equal(records[0].resourceType, "mail");
  assert.equal(records[0].resourceId, f.account.id);
  assert.deepEqual(records[0].details, { kind: "message", assistantId: f.id, count: 2 });

  // Already in Trash: stays there and counts as such.
  const trashed = f.imap.folder("Trash").messages[0].uid;
  assert.deepEqual(await f.mail({ action: "delete", uid: trashed, folder: "Trash" }), {
    accountId: f.account.id,
    account: "Private",
    folder: "Trash",
    moved: 0,
    alreadyInTrash: 1,
  });
  assert.equal(f.subjects("Trash").length, 2);
  assert.equal(await code(f.mail({ action: "delete", uid: 99 })), "MAIL_NOT_FOUND");
  f.untouched();
  const all = JSON.stringify(f.audit);
  assert.doesNotMatch(all, /Secret|example\.(com|org)/);
});

test("delete without a Trash folder or without MOVE changes nothing", async (t) => {
  const f = await changesFixture(t, { Drafts: { specialUse: "\\Drafts" } });
  const a = f.seed("Keep me");
  assert.equal(await code(f.mail({ action: "delete", uid: a })), "MAIL_NO_TRASH");
  assert.deepEqual(f.subjects("INBOX"), ["Keep me"]);
  assert.deepEqual(f.flags("INBOX", a), []);
  assert.equal(f.audit.filter((e) => e.action === "mail.deleted").length, 0);
  f.untouched();

  // A server without MOVE: no COPY + \Deleted + EXPUNGE fallback.
  const old = await changesFixture(t);
  old.imap.mailbox.noMove = true;
  const b = old.seed("Old server");
  assert.equal(
    await code(old.mail({ action: "delete", uid: b })),
    "MAIL_MOVE_UNSUPPORTED",
  );
  assert.equal(
    await code(old.mail({ action: "move", uid: b, destination: "archive" })),
    "MAIL_MOVE_UNSUPPORTED",
  );
  assert.deepEqual(old.subjects("INBOX"), ["Old server"]);
  assert.deepEqual(old.subjects("Trash"), []);
  old.untouched();
});

test("a routine run and a hook run with the Email tick may delete", async (t) => {
  const f = await changesFixture(t);
  const a = f.seed("Routine");
  const b = f.seed("Hook");
  assert.equal((await f.mail({ action: "delete", uid: a }, f.routineTurn())).moved, 1);
  assert.equal((await f.mail({ action: "delete", uid: b }, f.hookTurn())).moved, 1);
  assert.deepEqual(f.subjects("Trash"), ["Routine", "Hook"]);
  // Without the tick the hook is refused before anything changes.
  const c = f.seed("Untouched");
  f.hook.mail = false;
  assert.equal(
    await code(f.mail({ action: "delete", uid: c }, f.hookTurn())),
    "MAIL_ORIGIN_REFUSED",
  );
  assert.deepEqual(f.subjects("INBOX"), ["Untouched"]);
  f.untouched();
});

test("draft saves to Drafts, threads replies and refuses its own thread headers", async (t) => {
  const f = await changesFixture(t);
  const parent = f.seed("Question", {
    message: raw(
      "Question",
      "Message-ID: <parent@example.org>\r\nReferences: <root@example.org>\r\n",
    ),
  });
  const saved = await f.mail({
    action: "draft",
    to: ['"Sender" <sender@example.org>'],
    bcc: ["boss@example.com"],
    subject: "Re: Question",
    body: "Antwort mit Umlauten: äöü",
    replyToUid: parent,
    replyToFolder: "INBOX",
  });
  assert.equal(saved.folder, "Drafts");
  assert.equal(saved.draftUid, 1);
  assert.match(saved.messageId, /^<[0-9a-f-]{36}@example\.com>$/);
  const [draft] = f.imap.folder("Drafts").messages;
  assert.deepEqual([...draft.flags].sort(), ["\\Draft", "\\Seen"]);
  const text = draft.raw.toString("utf8");
  const head = text.split("\r\n\r\n")[0];
  assert.match(head, /^In-Reply-To: <parent@example\.org>$/m);
  assert.match(head, /^References: <root@example\.org> <parent@example\.org>$/m);
  assert.match(head, /^Bcc: boss@example\.com$/m);
  assert.match(head, /^From: agent@example\.com$/m);
  assert.match(head, /^Message-ID: <[0-9a-f-]{36}@example\.com>$/m);
  assert.match(head, /^Content-Type: text\/plain; charset=utf-8$/m);
  // The agent cannot set thread or other headers itself.
  for (const key of ["inReplyTo", "references", "headers", "messageId", "from"])
    assert.equal(
      await code(
        f.mail({ action: "draft", subject: "x", [key]: "<forged@evil.example>" }),
      ),
      "INVALID_INPUT",
    );
  assert.equal(
    await code(f.mail({ action: "draft", subject: "Hi\r\nBcc: x@evil.example" })),
    "INVALID_INPUT",
  );
  assert.equal(
    await code(f.mail({ action: "draft", subject: "x", replyToUid: 99 })),
    "MAIL_NOT_FOUND",
  );
  assert.equal(f.imap.folder("Drafts").messages.length, 1);
  // Not audited.
  assert.equal(f.audit.filter((e) => e.details?.kind === "message").length, 0);
});

test("updating a draft leaves one draft in Drafts and the old one in Trash", async (t) => {
  const f = await changesFixture(t);
  const first = await f.mail({ action: "draft", to: ["bob@example.org"], subject: "V1" });
  const second = await f.mail({
    action: "draft",
    draftUid: first.draftUid,
    to: ["bob@example.org"],
    subject: "V2",
  });
  assert.notEqual(second.draftUid, first.draftUid);
  assert.notEqual(second.messageId, first.messageId);
  assert.deepEqual(f.subjects("Drafts"), ["V2"]);
  assert.deepEqual(f.subjects("Trash"), ["V1"]);
  f.untouched();
  // A replaced draft that is gone stays as it is.
  assert.equal(
    await code(f.mail({ action: "draft", draftUid: first.draftUid, subject: "V3" })),
    "MAIL_NOT_FOUND",
  );
  assert.deepEqual(second.attachments, []);
  // A draft with an attachment is replaced with its attachment kept unchanged.
  const attached = f.seed("With file", {
    folder: "Drafts",
    flags: ["\\Draft"],
    message: withAttachment("With file"),
  });
  const replaced = await f.mail({
    action: "draft",
    draftUid: attached,
    to: ["bob@example.org"],
    subject: "Replace",
  });
  assert.deepEqual(replaced.attachments, [
    { name: "a.pdf", size: 5, type: "application/pdf" },
  ]);
  assert.equal(replaced.replaced, true);
  assert.equal(replaced.htmlPart, undefined);
  assert.deepEqual(f.subjects("Drafts"), ["V2", "Replace"]);
  assert.deepEqual(f.subjects("Trash"), ["V1", "With file"]);
  const stored = f.imap.folder("Drafts").messages.at(-1).raw.toString("latin1");
  assert.ok(
    stored.includes(
      'Content-Type: application/pdf; name="a.pdf"\r\nContent-Disposition: attachment; filename="a.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\nJVBERi0=\r\n',
    ),
    "the kept part is stored byte for byte",
  );
  f.untouched();
});

test("draft needs a Drafts folder, and Trash to replace one; UIDs without UIDPLUS", async (t) => {
  const none = await changesFixture(t, { Trash: { specialUse: "\\Trash" } });
  assert.equal(
    await code(none.mail({ action: "draft", subject: "x" })),
    "MAIL_NO_DRAFTS",
  );

  const noTrash = await changesFixture(t, { Drafts: { specialUse: "\\Drafts" } });
  const kept = await noTrash.mail({ action: "draft", subject: "Keep" });
  assert.equal(
    await code(
      noTrash.mail({ action: "draft", draftUid: kept.draftUid, subject: "New" }),
    ),
    "MAIL_NO_TRASH",
  );
  assert.deepEqual(noTrash.subjects("Drafts"), ["Keep"]);

  const plain = await changesFixture(t);
  plain.imap.mailbox.noUidplus = true;
  plain.seed("Older draft", { folder: "Drafts", flags: ["\\Draft"] });
  const saved = await plain.mail({ action: "draft", subject: "Found" });
  assert.equal(saved.draftUid, 2);
  const replaced = await plain.mail({ action: "draft", draftUid: 2, subject: "Again" });
  assert.equal(replaced.draftUid, 3);
  assert.deepEqual(plain.subjects("Drafts"), ["Older draft", "Again"]);
  plain.untouched();
});

test("moves into, within and out of Trash: only a move into Trash is audited", async (t) => {
  const f = await changesFixture(t);
  const a = f.seed("To trash");
  const deleted = () => f.audit.filter((e) => e.action === "mail.deleted");
  const into = await f.mail({ action: "move", uid: a, destination: "Trash" });
  assert.equal(into.moved, 1);
  assert.equal(into.destination, "Trash");
  assert.deepEqual(deleted().at(-1).details, {
    kind: "message",
    assistantId: f.id,
    count: 1,
  });
  const inTrash = f.imap.folder("Trash").messages[0].uid;
  // Within Trash (named in another case): nothing moves and nothing is audited.
  const within = await f.mail({
    action: "move",
    uid: inTrash,
    folder: "trash",
    destination: "TRASH",
  });
  assert.equal(within.moved, 0);
  assert.equal(within.folder, "trash");
  assert.equal(within.destination, "Trash");
  assert.equal(deleted().length, 1);
  // Out of Trash: restored, not audited as a delete.
  const out = await f.mail({
    action: "move",
    uid: inTrash,
    folder: "Trash",
    destination: "inbox",
  });
  assert.equal(out.moved, 1);
  assert.equal(out.destination, "INBOX");
  assert.deepEqual(f.subjects("INBOX"), ["To trash"]);
  assert.deepEqual(f.subjects("Trash"), []);
  assert.equal(deleted().length, 1);
  f.untouched();
});

test("folder names resolve to the server's listed path, ambiguous case is refused", async (t) => {
  const f = await changesFixture(t, {
    ...standard,
    Projects: {},
    Team: {},
    TEAM: {},
  });
  const a = f.seed("Case");
  assert.equal(
    (await f.mail({ action: "move", uid: a, destination: "projects" })).destination,
    "Projects",
  );
  const p = f.imap.folder("Projects").messages[0].uid;
  assert.equal(
    (await f.mail({ action: "mark", uid: p, folder: "PROJECTS", flag: "flagged" }))
      .marked,
    1,
  );
  assert.equal(
    await code(
      f.mail({ action: "move", uid: p, folder: "Projects", destination: "team" }),
    ),
    "MAIL_NOT_FOUND",
  );
  assert.equal(
    (await f.mail({ action: "move", uid: p, folder: "Projects", destination: "TEAM" }))
      .destination,
    "TEAM",
  );
  // Deleting from a Trash named in another case keeps the message where it is.
  const g = f.seed("Gone");
  await f.mail({ action: "delete", uid: g });
  const tr = f.imap.folder("Trash").messages[0].uid;
  assert.deepEqual(
    (await f.mail({ action: "delete", uid: tr, folder: "TRASH" })).alreadyInTrash,
    1,
  );
  f.untouched();
});

test("draft replacement: audited as a delete, the old draft survives a failed APPEND", async (t) => {
  const f = await changesFixture(t);
  const deleted = () => f.audit.filter((e) => e.action === "mail.deleted");
  const first = await f.mail({ action: "draft", subject: "V1" });
  assert.equal(first.replaced, undefined);
  const second = await f.mail({
    action: "draft",
    draftUid: first.draftUid,
    subject: "V2",
  });
  assert.equal(second.replaced, true);
  assert.deepEqual(deleted().at(-1).details, {
    kind: "message",
    assistantId: f.id,
    count: 1,
  });
  // APPEND refused: nothing new, the old draft stays and no server text leaks.
  f.imap.mailbox.failAppend = true;
  let error;
  try {
    await f.mail({ action: "draft", draftUid: second.draftUid, subject: "V3" });
  } catch (caught) {
    error = caught;
  }
  assert.equal(toolError(error).code, "MAIL_PROTOCOL");
  assert.doesNotMatch(JSON.stringify(toolError(error)), /fake-secret|OVERQUOTA/);
  assert.deepEqual(f.subjects("Drafts"), ["V2"]);
  assert.deepEqual(f.subjects("Trash"), ["V1"]);
  assert.equal(deleted().length, 1);
  f.imap.mailbox.failAppend = false;
  // The move to Trash fails after the APPEND: the new draft is returned, both stay.
  f.imap.mailbox.failMove = true;
  const third = await f.mail({
    action: "draft",
    draftUid: second.draftUid,
    subject: "V4",
  });
  assert.equal(third.replaced, false);
  assert.equal(third.folder, "Drafts");
  assert.equal(
    f.imap.folder("Drafts").messages.find((m) => m.uid === third.draftUid) !== undefined,
    true,
  );
  assert.deepEqual(f.subjects("Drafts"), ["V2", "V4"]);
  assert.deepEqual(f.subjects("Trash"), ["V1"]);
  assert.equal(deleted().length, 1);
  f.untouched();
});
