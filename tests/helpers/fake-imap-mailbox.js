import { messageCommands } from "./fake-imap-messages.js";

// In-memory folders and the command handlers of the fake IMAP server. Only what
// imapflow sends is implemented; later mail tasks add their commands to `commands`
// (the selected-mailbox commands live in fake-imap-messages.js).

function normalizeMessage(message, uid) {
  const source =
    typeof message === "string" || Buffer.isBuffer(message) ? { raw: message } : message;
  return {
    uid,
    raw: Buffer.from(source.raw),
    flags: new Set(source.flags ?? []),
    internalDate: source.internalDate ? new Date(source.internalDate) : new Date(),
  };
}

/** Builds the folder store; INBOX always exists and is `\Inbox`. */
export function createMailbox(folders = {}) {
  const store = new Map();
  const add = (path, { specialUse, messages = [] } = {}) => {
    const folder = {
      path,
      specialUse: path.toUpperCase() === "INBOX" ? "\\Inbox" : specialUse,
      uidValidity: 1000 + store.size,
      uidNext: 1,
      messages: [],
    };
    for (const message of messages)
      folder.messages.push(normalizeMessage(message, folder.uidNext++));
    store.set(path, folder);
    return folder;
  };
  if (!Object.keys(folders).some((path) => path.toUpperCase() === "INBOX")) add("INBOX");
  for (const [path, folder] of Object.entries(folders)) add(path, folder);
  return {
    folders: store,
    add,
    folder(path) {
      if (path.toUpperCase() === "INBOX")
        return [...store.values()].find((f) => f.path.toUpperCase() === "INBOX");
      return store.get(path);
    },
    append(path, message) {
      const folder = this.folder(path);
      const stored = normalizeMessage(message, folder.uidNext++);
      folder.messages.push(stored);
      return stored;
    },
  };
}

/** Quotes a string for an IMAP response. */
export function quote(text) {
  return `"${String(text).replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}

const text = (token) =>
  token && typeof token === "object" && "literal" in token
    ? token.literal.toString("utf8")
    : token;

function capabilities(session) {
  const list = ["IMAP4rev1", "ID", "ENABLE", "NAMESPACE", "SPECIAL-USE", "LITERAL+"];
  if (!session.authenticated) {
    if (session.server.security === "starttls" && !session.secure) list.push("STARTTLS");
    else list.push(...session.server.authMechanisms.map((name) => `AUTH=${name}`));
  }
  return list.join(" ");
}

function login(session, tag, user, password) {
  const expected = session.server.users[user];
  if (expected === undefined || expected !== password) {
    session.send(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials (fake)`);
    return;
  }
  session.authenticated = true;
  session.user = user;
  session.send(`${tag} OK [CAPABILITY ${capabilities(session)}] Logged in`);
}

function requireAuth(session, tag) {
  if (session.authenticated) return true;
  session.send(`${tag} BAD Not authenticated`);
  return false;
}

// Matches an IMAP LIST pattern: `*` spans the hierarchy, `%` stays on one level.
function patternMatch(pattern, path) {
  const source = [...pattern]
    .map((c) =>
      c === "*" ? ".*" : c === "%" ? "[^/]*" : c.replace(/[.+?^${}()|[\]\\]/g, "\\$&"),
    )
    .join("");
  return new RegExp(`^${source}$`, "i").test(path);
}

export const commands = {
  CAPABILITY(session, tag) {
    session.send(`* CAPABILITY ${capabilities(session)}`);
    session.send(`${tag} OK Capability completed`);
  },
  NOOP(session, tag) {
    session.send(`${tag} OK Noop completed`);
  },
  ID(session, tag) {
    session.send(`* ID ("name" "fake-imap" "version" "1")`);
    session.send(`${tag} OK ID completed`);
  },
  STARTTLS(session, tag) {
    if (session.server.security !== "starttls" || session.secure) {
      session.send(`${tag} BAD STARTTLS not available`);
      return;
    }
    session.send(`${tag} OK Begin TLS negotiation now`);
    session.upgrade();
  },
  LOGIN(session, tag, args) {
    if (session.server.security === "starttls" && !session.secure) {
      session.send(`${tag} NO [PRIVACYREQUIRED] Use STARTTLS first`);
      return;
    }
    login(session, tag, text(args[0]), text(args[1]));
  },
  AUTHENTICATE(session, tag, args) {
    const mechanism = String(text(args[0])).toUpperCase();
    if (mechanism !== "PLAIN" || !session.server.authMechanisms.includes("PLAIN")) {
      session.send(`${tag} NO Unsupported mechanism`);
      return;
    }
    const finish = (line) => {
      const [, user, password] = Buffer.from(line.trim(), "base64")
        .toString("utf8")
        .split("\0");
      login(session, tag, user, password);
    };
    if (args[1] !== undefined) return finish(text(args[1]));
    session.send("+ ");
    session.continuation = finish;
  },
  ENABLE(session, tag, args) {
    if (!requireAuth(session, tag)) return;
    const enabled = args
      .map(text)
      .filter((name) => /^(UTF8=ACCEPT|CONDSTORE)$/i.test(name));
    session.send(`* ENABLED${enabled.map((name) => ` ${name}`).join("")}`);
    session.send(`${tag} OK Enable completed`);
  },
  NAMESPACE(session, tag) {
    if (!requireAuth(session, tag)) return;
    session.send(`* NAMESPACE (("" "/")) NIL NIL`);
    session.send(`${tag} OK Namespace completed`);
  },
  LIST(session, tag, args) {
    if (!requireAuth(session, tag)) return;
    // LIST [selection] reference pattern [RETURN (...)]
    const plain = args.filter((arg) => !Array.isArray(arg));
    const returnAt = plain.findIndex(
      (arg) => String(text(arg)).toUpperCase() === "RETURN",
    );
    const [reference, pattern] = (returnAt >= 0 ? plain.slice(0, returnAt) : plain).map(
      text,
    );
    if (pattern === "") {
      session.send(`* LIST (\\Noselect) "/" ""`);
    } else {
      for (const folder of session.server.mailbox.folders.values()) {
        if (!patternMatch(`${reference}${pattern}`, folder.path)) continue;
        const flags = [
          "\\HasNoChildren",
          ...(folder.specialUse && folder.specialUse !== "\\Inbox"
            ? [folder.specialUse]
            : []),
        ];
        session.send(`* LIST (${flags.join(" ")}) "/" ${quote(folder.path)}`);
      }
    }
    session.send(`${tag} OK List completed`);
  },
  // imapflow's list() asks LSUB for subscriptions; every fake folder is subscribed.
  LSUB(session, tag, args) {
    if (!requireAuth(session, tag)) return;
    const [reference, pattern] = args.map(text);
    for (const folder of session.server.mailbox.folders.values()) {
      if (patternMatch(`${reference}${pattern}`, folder.path))
        session.send(`* LSUB () "/" ${quote(folder.path)}`);
    }
    session.send(`${tag} OK Lsub completed`);
  },
  ...messageCommands,
  LOGOUT(session, tag) {
    session.server.loggedOut++;
    session.send("* BYE Logging out");
    session.send(`${tag} OK Logout completed`);
    session.end();
  },
};
