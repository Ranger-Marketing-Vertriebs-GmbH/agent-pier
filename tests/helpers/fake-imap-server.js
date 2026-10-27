import net from "node:net";
import tls from "node:tls";
import { issueGatewayCertificate } from "../../server/features/assistants/gateway-tls.js";
import { commands, createMailbox } from "./fake-imap-mailbox.js";

// An in-process IMAP server on 127.0.0.1 for tests: implicit TLS, STARTTLS or plain,
// a line protocol with synchronizing and LITERAL+ literals, and in-memory folders.

const literalMarker = /\{(\d+)(\+)?\}$/;

// One certificate per test process, so the IMAP and SMTP fakes share one CA.
let certificate;
export function fakeMailCertificate() {
  certificate ??= issueGatewayCertificate();
  return certificate;
}

// Splits a command into tokens: atoms (brackets kept whole), quoted strings,
// literals ({ literal: Buffer }) and parenthesized lists (nested arrays).
export function tokenize(text, literals) {
  let index = 0;
  const parseList = (closing) => {
    const tokens = [];
    while (index < text.length) {
      const char = text[index];
      if (char === " ") {
        index++;
      } else if (char === closing) {
        index++;
        return tokens;
      } else if (char === "(") {
        index++;
        tokens.push(parseList(")"));
      } else if (char === '"') {
        let value = "";
        for (index++; index < text.length && text[index] !== '"'; index++) {
          if (text[index] === "\\") index++;
          value += text[index];
        }
        index++;
        tokens.push(value);
      } else if (char === "\0") {
        const end = text.indexOf("\0", index + 1);
        tokens.push({ literal: literals[Number(text.slice(index + 1, end))] });
        index = end + 1;
      } else {
        let depth = 0;
        let atom = "";
        while (index < text.length) {
          const next = text[index];
          if (!depth && (next === " " || next === "(" || next === ")")) break;
          if (next === "[") depth++;
          if (next === "]") depth--;
          atom += next;
          index++;
        }
        tokens.push(atom);
      }
    }
    return tokens;
  };
  return parseList(null);
}

function createSession(server, socket, secure) {
  const session = {
    server,
    socket,
    secure,
    authenticated: false,
    user: null,
    selected: null,
    continuation: null,
    send(line) {
      if (!this.socket.destroyed) this.socket.write(`${line}\r\n`);
    },
    end() {
      this.socket.end();
    },
    upgrade() {
      const plain = this.socket;
      plain.pause();
      plain.removeListener("data", onData);
      const secured = new tls.TLSSocket(plain, {
        isServer: true,
        secureContext: server.secureContext,
      });
      secured.on("error", () => secured.destroy());
      secured.on("data", onData);
      server.sockets.add(secured);
      this.socket = secured;
      this.secure = true;
    },
  };
  let buffer = Buffer.alloc(0);
  let parts = [];
  let pendingLiteral = null;

  function dispatch() {
    const literals = [];
    const text = parts
      .map((part) => (Buffer.isBuffer(part) ? `\0${literals.push(part) - 1}\0` : part))
      .join("");
    parts = [];
    const [tag, name, ...args] = tokenize(text, literals);
    const handler = commands[String(name).toUpperCase()];
    if (!handler) return session.send(`${tag} BAD Unknown command`);
    try {
      handler(session, tag, args);
    } catch {
      session.send(`${tag} BAD Command failed`);
    }
  }

  function onData(chunk) {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (pendingLiteral !== null) {
        if (buffer.length < pendingLiteral) return;
        parts.push(buffer.subarray(0, pendingLiteral));
        buffer = buffer.subarray(pendingLiteral);
        pendingLiteral = null;
        continue;
      }
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      const line = buffer.subarray(0, end).toString("utf8").replace(/\r$/, "");
      buffer = buffer.subarray(end + 1);
      if (session.continuation && !parts.length) {
        const next = session.continuation;
        session.continuation = null;
        next(line);
        continue;
      }
      const marker = line.match(literalMarker);
      if (marker) {
        parts.push(line.slice(0, marker.index));
        pendingLiteral = Number(marker[1]);
        if (!marker[2]) session.send("+ Ready for literal data");
        continue;
      }
      parts.push(line);
      dispatch();
    }
  }

  socket.on("data", onData);
  socket.on("error", () => socket.destroy());
  session.send("* OK Fake IMAP ready");
  return session;
}

/**
 * Starts a fake IMAP server. `authMechanisms` lists the SASL mechanisms offered
 * (default PLAIN; an empty list makes imapflow use LOGIN). `silent` accepts
 * connections and never greets.
 */
export async function startFakeImap({
  security = "tls",
  users = {},
  folders,
  silent = false,
  authMechanisms = ["PLAIN"],
} = {}) {
  const { cert, key } = fakeMailCertificate();
  const state = {
    security,
    users: { ...users },
    authMechanisms,
    mailbox: createMailbox(folders),
    secureContext: tls.createSecureContext({ cert, key, minVersion: "TLSv1.2" }),
    sockets: new Set(),
    loggedOut: 0,
  };
  const accept = (socket, secure) => {
    state.sockets.add(socket);
    socket.on("close", () => state.sockets.delete(socket));
    if (silent) {
      socket.on("error", () => socket.destroy());
      return;
    }
    createSession(state, socket, secure);
  };
  const server =
    security === "tls"
      ? tls.createServer({ cert, key, minVersion: "TLSv1.2" }, (s) => accept(s, true))
      : net.createServer((s) => accept(s, false));
  server.on("tlsClientError", () => {});
  server.on("connection", (socket) => {
    state.sockets.add(socket);
    socket.on("close", () => state.sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    ca: cert,
    users: state.users,
    mailbox: state.mailbox,
    get loggedOut() {
      return state.loggedOut;
    },
    folder: (path) => state.mailbox.folder(path),
    close() {
      for (const socket of state.sockets) socket.destroy();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
