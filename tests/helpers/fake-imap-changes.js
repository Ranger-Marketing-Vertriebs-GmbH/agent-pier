// The changing commands of the fake IMAP server: APPEND (UIDPLUS APPENDUID), UID STORE,
// UID MOVE and UID COPY (COPYUID). EXPUNGE and UID EXPUNGE are never carried out:
// the fake records them in `mailbox.expunges` and answers NO, and every STORE that
// would set \Deleted is recorded in `mailbox.deleteFlags`. `mailbox.noMove` and
// `mailbox.noUidplus` take the MOVE and UIDPLUS capabilities away.

const text = (token) =>
  token && typeof token === "object" && "literal" in token
    ? token.literal.toString("utf8")
    : token;

/** A UID set like `1:3,7` as a predicate over UIDs (`*` is the highest UID). */
function uidSet(set, folder) {
  const max = Math.max(0, ...folder.messages.map((m) => m.uid));
  const ranges = String(set)
    .split(",")
    .map((range) => {
      const [a, b = a] = range.split(":").map((n) => (n === "*" ? max : Number(n)));
      return [Math.min(a, b), Math.max(a, b)];
    });
  return (uid) => ranges.some(([a, b]) => uid >= a && uid <= b);
}

/** The capabilities the changing commands add. */
export function changeCapabilities(mailbox) {
  return [...(mailbox.noMove ? [] : ["MOVE"]), ...(mailbox.noUidplus ? [] : ["UIDPLUS"])];
}

function append(session, tag, args) {
  if (!session.authenticated) return session.send(`${tag} BAD Not authenticated`);
  const mailbox = session.server.mailbox;
  const folder = mailbox.folder(String(text(args[0])));
  if (!folder) return session.send(`${tag} NO [TRYCREATE] Unknown mailbox`);
  const flags = Array.isArray(args[1]) ? args[1].map(String) : [];
  const literal = args.at(-1)?.literal;
  if (!literal) return session.send(`${tag} BAD Missing message literal`);
  const stored = mailbox.append(folder.path, { raw: literal, flags });
  mailbox.appended = [...(mailbox.appended ?? []), { folder: folder.path, ...stored }];
  if (session.selected === folder) session.send(`* ${folder.messages.length} EXISTS`);
  const code = mailbox.noUidplus
    ? ""
    : `[APPENDUID ${folder.uidValidity} ${stored.uid}] `;
  session.send(`${tag} OK ${code}Append completed`);
}

function store(session, tag, [set, operation, list]) {
  const folder = session.selected;
  if (session.readOnly) return session.send(`${tag} NO [READ-ONLY] Mailbox is read-only`);
  const op = String(operation).toUpperCase();
  const flags = (Array.isArray(list) ? list : [list]).map(String);
  if (flags.some((flag) => flag.toLowerCase() === "\\deleted") && !op.startsWith("-"))
    session.server.mailbox.deleteFlags = (session.server.mailbox.deleteFlags ?? 0) + 1;
  const match = uidSet(text(set), folder);
  folder.messages.forEach((message, index) => {
    if (!match(message.uid)) return;
    if (op.startsWith("+")) for (const flag of flags) message.flags.add(flag);
    else if (op.startsWith("-")) for (const flag of flags) message.flags.delete(flag);
    else message.flags = new Set(flags);
    if (!op.endsWith(".SILENT"))
      session.send(
        `* ${index + 1} FETCH (UID ${message.uid} FLAGS (${[...message.flags].join(" ")}))`,
      );
  });
  session.send(`${tag} OK Store completed`);
}

// Copies (and for MOVE removes) the matching messages; answers COPYUID.
function transfer(session, tag, [set, destination], move) {
  const mailbox = session.server.mailbox;
  if (move && mailbox.noMove) return session.send(`${tag} BAD Unknown command`);
  const folder = session.selected;
  if (move && session.readOnly)
    return session.send(`${tag} NO [READ-ONLY] Mailbox is read-only`);
  const target = mailbox.folder(String(text(destination)));
  if (!target) return session.send(`${tag} NO [TRYCREATE] Unknown mailbox`);
  const match = uidSet(text(set), folder);
  const chosen = folder.messages.filter((m) => match(m.uid));
  const copies = chosen.map((m) =>
    mailbox.append(target.path, {
      raw: m.raw,
      flags: [...m.flags],
      internalDate: m.internalDate,
    }),
  );
  const code = chosen.length
    ? `[COPYUID ${target.uidValidity} ${chosen.map((m) => m.uid).join(",")} ${copies.map((m) => m.uid).join(",")}] `
    : "";
  if (!move) return session.send(`${tag} OK ${code}Copy completed`);
  if (code) session.send(`* OK ${code}Moved`);
  // EXPUNGE responses from the highest sequence number down.
  for (let index = folder.messages.length - 1; index >= 0; index--)
    if (chosen.includes(folder.messages[index])) {
      folder.messages.splice(index, 1);
      session.send(`* ${index + 1} EXPUNGE`);
    }
  session.send(`${tag} OK Move completed`);
}

function expunge(session, tag, command) {
  const mailbox = session.server.mailbox;
  mailbox.expunges = [...(mailbox.expunges ?? []), command];
  session.send(`${tag} NO Expunge is not carried out by this fake`);
}

/** UID subcommands that change a folder; false when `name` is none of them. */
export function uidChange(session, tag, name, rest) {
  if (name === "STORE") return (store(session, tag, rest), true);
  if (name === "MOVE") return (transfer(session, tag, rest, true), true);
  if (name === "COPY") return (transfer(session, tag, rest, false), true);
  if (name === "EXPUNGE") return (expunge(session, tag, "UID EXPUNGE"), true);
  return false;
}

export const changeCommands = {
  APPEND: append,
  EXPUNGE(session, tag) {
    expunge(session, tag, "EXPUNGE");
  },
};
