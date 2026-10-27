import {
  bodyStructure,
  decodeWords,
  envelope,
  parsed,
  partOf,
  searchable,
} from "./fake-imap-mime.js";
import { uidChange } from "./fake-imap-changes.js";

// SELECT/EXAMINE, STATUS, UID SEARCH and UID FETCH of the fake IMAP server, over the
// folders of fake-imap-mailbox.js. `mailbox.served` counts the body bytes FETCH sent;
// `mailbox.rejectCharset` makes SEARCH refuse every charset but US-ASCII, and
// `mailbox.failFetch(items)` makes a FETCH answer NO.

const text = (token) =>
  token && typeof token === "object" && "literal" in token
    ? token.literal.toString("utf8")
    : token;
const quote = (value) => `"${String(value).replace(/[\\"]/g, (c) => `\\${c}`)}"`;
const months = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");

function open(session, tag, args, readOnly) {
  if (!session.authenticated) return session.send(`${tag} BAD Not authenticated`);
  const folder = session.server.mailbox.folder(String(text(args[0])));
  if (!folder) {
    session.selected = null;
    return session.send(`${tag} NO [NONEXISTENT] Unknown mailbox`);
  }
  session.selected = folder;
  session.readOnly = readOnly;
  session.send("* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)");
  session.send(
    "* OK [PERMANENTFLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft \\*)] Flags",
  );
  session.send(`* ${folder.messages.length} EXISTS`);
  session.send("* 0 RECENT");
  session.send(`* OK [UIDVALIDITY ${folder.uidValidity}] UIDs valid`);
  session.send(`* OK [UIDNEXT ${folder.uidNext}] Predicted next UID`);
  session.send(`${tag} OK [${readOnly ? "READ-ONLY" : "READ-WRITE"}] Opened`);
}

/** A UID or sequence set like `1:3,7,9:*` as a predicate over numbers. */
function inSet(set, max) {
  const ranges = String(set)
    .split(",")
    .map((range) => {
      const [a, b = a] = range.split(":").map((n) => (n === "*" ? max : Number(n)));
      return [Math.min(a, b), Math.max(a, b)];
    });
  return (n) => ranges.some(([a, b]) => n >= a && n <= b);
}

const imapDate = (value) => {
  const [day, month, year] = value.split("-");
  return Date.UTC(Number(year), months.indexOf(month), Number(day));
};

const contains = (haystack, needle) =>
  haystack.toLowerCase().includes(String(needle).toLowerCase());

// Each key consumes its arguments and returns a predicate over a message.
function criteria(tokens, folder) {
  const tests = [];
  const maxUid = Math.max(0, ...folder.messages.map((m) => m.uid));
  while (tokens.length) {
    const key = String(text(tokens.shift())).toUpperCase();
    if (key === "ALL") continue;
    else if (key === "UNSEEN") tests.push((m) => !m.flags.has("\\Seen"));
    else if (key === "SEEN") tests.push((m) => m.flags.has("\\Seen"));
    else if (["FROM", "TO", "SUBJECT", "CC"].includes(key)) {
      const name = key.toLowerCase();
      const value = text(tokens.shift());
      tests.push((m) => contains(decodeWords(parsed(m).headers.get(name) || ""), value));
    } else if (key === "TEXT") {
      const value = text(tokens.shift());
      tests.push((m) => {
        const s = searchable(m);
        return contains(s.headers, value) || contains(s.body, value);
      });
    } else if (key === "BODY") {
      const value = text(tokens.shift());
      tests.push((m) => contains(searchable(m).body, value));
    } else if (key === "SINCE") {
      const since = imapDate(text(tokens.shift()));
      tests.push((m) => m.internalDate.getTime() >= since);
    } else if (key === "UID") {
      const match = inSet(text(tokens.shift()), maxUid);
      tests.push((m) => match(m.uid));
    } else if (/^[\d:*,]+$/.test(key)) {
      // A sequence set (imapflow looks up an appended message's UID this way).
      const match = inSet(key, folder.messages.length);
      tests.push((m) => match(folder.messages.indexOf(m) + 1));
    } else throw new Error(`unsupported search key ${key}`);
  }
  return (m) => tests.every((t) => t(m));
}

function search(session, tag, args) {
  const tokens = [...args];
  if (String(text(tokens[0])).toUpperCase() === "CHARSET") {
    tokens.shift();
    const charset = String(text(tokens.shift())).toUpperCase();
    if (session.server.mailbox.rejectCharset && charset !== "US-ASCII")
      return session.send(`${tag} NO [BADCHARSET (US-ASCII)] Charset not supported`);
  }
  const folder = session.selected;
  const match = criteria(tokens, folder);
  const uids = folder.messages.filter(match).map((m) => m.uid);
  session.send(`* SEARCH${uids.map((uid) => ` ${uid}`).join("")}`);
  session.send(`${tag} OK Search completed`);
}

const flagList = (message) => `(${[...message.flags].join(" ")})`;
const internal = (date) => {
  const d = new Date(date);
  const pad = (n) => String(n).padStart(2, "0");
  return `"${pad(d.getUTCDate())}-${months[d.getUTCMonth()]}-${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} +0000"`;
};

// The named header fields with their folded lines, and the blank line that ends them.
function headerFields(header, names) {
  const wanted = new Set(names.map((n) => n.toLowerCase()));
  const lines = header.split(/\r\n(?![ \t])/).filter((line) => {
    const colon = line.indexOf(":");
    return colon > 0 && wanted.has(line.slice(0, colon).trim().toLowerCase());
  });
  return `${lines.map((line) => `${line}\r\n`).join("")}\r\n`;
}

// BODY[section]<start.length> and BODY.PEEK[...]: the section's bytes as latin1.
function section(message, spec) {
  const upper = spec.toUpperCase();
  const root = parsed(message);
  if (upper === "") return message.raw.toString("latin1");
  if (upper === "HEADER") return root.header;
  if (upper === "TEXT") return root.body;
  const fields = upper.match(/^HEADER\.FIELDS \(([^)]*)\)$/);
  if (fields) return headerFields(root.header, fields[1].split(" "));
  const mime = upper.endsWith(".MIME");
  const part = partOf(message, mime ? upper.slice(0, -5) : upper);
  if (!part) return "";
  return mime ? part.header : part.body;
}

function item(session, message, atom) {
  const name = String(atom).toUpperCase();
  if (name === "UID") return `UID ${message.uid}`;
  if (name === "FLAGS") return `FLAGS ${flagList(message)}`;
  if (name === "ENVELOPE") return `ENVELOPE ${envelope(message)}`;
  if (name === "BODYSTRUCTURE") return `BODYSTRUCTURE ${bodyStructure(message)}`;
  if (name === "INTERNALDATE") return `INTERNALDATE ${internal(message.internalDate)}`;
  if (name === "RFC822.SIZE") return `RFC822.SIZE ${message.raw.length}`;
  const body = String(atom).match(/^BODY(\.PEEK)?\[([^\]]*)\](?:<(\d+)(?:\.(\d+))?>)?$/i);
  if (!body) throw new Error(`unsupported fetch item ${atom}`);
  if (!body[1] && !session.readOnly) message.flags.add("\\Seen");
  let data = section(message, body[2]);
  const start = body[3] === undefined ? null : Number(body[3]);
  if (start !== null)
    data = data.slice(start, body[4] === undefined ? undefined : start + Number(body[4]));
  session.server.mailbox.served = (session.server.mailbox.served || 0) + data.length;
  return `BODY[${body[2]}]${start === null ? "" : `<${start}>`} {${data.length}}\r\n${data}`;
}

function fetch(session, tag, args, byUid) {
  const folder = session.selected;
  const max = byUid
    ? Math.max(0, ...folder.messages.map((m) => m.uid))
    : folder.messages.length;
  const match = inSet(text(args[0]), max);
  const items = Array.isArray(args[1]) ? args[1] : [args[1]];
  // A server failing the FETCH, with text that must never reach the agent.
  if (session.server.mailbox.failFetch?.(items.map(String).join(" ")))
    return session.send(`${tag} NO [SERVERBUG] internal detail fake-secret-7`);
  folder.messages.forEach((message, index) => {
    if (!match(byUid ? message.uid : index + 1)) return;
    const wanted =
      byUid && !items.some((i) => String(i).toUpperCase() === "UID")
        ? ["UID", ...items]
        : items;
    const line = `* ${index + 1} FETCH (${wanted.map((i) => item(session, message, i)).join(" ")})\r\n`;
    if (!session.socket.destroyed) session.socket.write(Buffer.from(line, "latin1"));
  });
  session.send(`${tag} OK Fetch completed`);
}

export const messageCommands = {
  SELECT(session, tag, args) {
    open(session, tag, args, false);
  },
  EXAMINE(session, tag, args) {
    open(session, tag, args, true);
  },
  STATUS(session, tag, args) {
    if (!session.authenticated) return session.send(`${tag} BAD Not authenticated`);
    const path = String(text(args[0]));
    const folder = session.server.mailbox.folder(path);
    if (!folder) return session.send(`${tag} NO [NONEXISTENT] Unknown mailbox`);
    const values = {
      MESSAGES: folder.messages.length,
      UIDNEXT: folder.uidNext,
      UIDVALIDITY: folder.uidValidity,
      UNSEEN: folder.messages.filter((m) => !m.flags.has("\\Seen")).length,
      RECENT: 0,
    };
    const asked = (args[1] || []).map((a) => String(a).toUpperCase());
    session.send(
      `* STATUS ${quote(folder.path)} (${asked.map((k) => `${k} ${values[k] ?? 0}`).join(" ")})`,
    );
    session.send(`${tag} OK Status completed`);
  },
  SEARCH(session, tag, args) {
    if (!session.selected) return session.send(`${tag} BAD No mailbox selected`);
    search(session, tag, args);
  },
  FETCH(session, tag, args) {
    if (!session.selected) return session.send(`${tag} BAD No mailbox selected`);
    fetch(session, tag, args, false);
  },
  UID(session, tag, args) {
    if (!session.selected) return session.send(`${tag} BAD No mailbox selected`);
    const [command, ...rest] = args;
    const name = String(text(command)).toUpperCase();
    if (name === "SEARCH") return search(session, tag, rest);
    if (name === "FETCH") return fetch(session, tag, rest, true);
    if (uidChange(session, tag, name, rest)) return;
    session.send(`${tag} BAD Unsupported UID command`);
  },
};
