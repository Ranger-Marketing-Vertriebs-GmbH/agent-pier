import { SMTPServer } from "smtp-server";
import { fakeMailCertificate } from "./fake-imap-server.js";

/**
 * Starts an in-process SMTP server on 127.0.0.1 (implicit TLS, STARTTLS or plain)
 * that accepts AUTH PLAIN/LOGIN for `users` and records each delivered message.
 */
export async function startFakeSmtp({ security = "tls", users = {} } = {}) {
  const { cert, key } = fakeMailCertificate();
  const messages = [];
  const accounts = { ...users };
  const server = new SMTPServer({
    secure: security === "tls",
    key,
    cert,
    minVersion: "TLSv1.2",
    logger: false,
    authMethods: ["PLAIN", "LOGIN"],
    // STARTTLS servers refuse AUTH before the upgrade; plain servers never offer it.
    allowInsecureAuth: security === "none",
    disabledCommands: security === "none" ? ["STARTTLS"] : [],
    onAuth(auth, _session, callback) {
      if (
        accounts[auth.username] !== undefined &&
        accounts[auth.username] === auth.password
      )
        return callback(null, { user: auth.username });
      return callback(new Error("Invalid credentials (fake)"));
    },
    onData(stream, session, callback) {
      const chunks = [];
      stream.on("data", (chunk) => chunks.push(chunk));
      stream.on("end", () => {
        messages.push({
          envelope: {
            from: session.envelope.mailFrom.address,
            to: session.envelope.rcptTo.map((rcpt) => rcpt.address),
          },
          raw: Buffer.concat(chunks),
        });
        callback();
      });
    },
  });
  server.on("error", () => {});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.server.address().port,
    ca: cert,
    users: accounts,
    messages,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
