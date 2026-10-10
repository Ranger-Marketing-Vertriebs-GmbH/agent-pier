import fs from "node:fs";
import https from "node:https";
import { WebSocketServer } from "ws";
import { issueGatewayCertificate } from "../../server/features/assistants/gateway-tls.js";

// Child-process stand-in for `openclaw gateway run`: reads the config the supervisor
// prepared and serves the protocol-4 handshake over the configured TLS material.
// An impostor serves its own certificate on the same port instead.
export async function runFakeGateway({ impostor = false, record } = {}) {
  const config = JSON.parse(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH, "utf8"));
  const { port, auth, tls } = config.gateway;
  const material = impostor
    ? issueGatewayCertificate()
    : { cert: fs.readFileSync(tls.certPath), key: fs.readFileSync(tls.keyPath) };
  const listener = https.createServer({ ...material, minVersion: "TLSv1.3" });
  const server = new WebSocketServer({ server: listener });
  server.on("connection", (ws) => {
    if (record) fs.appendFileSync(record, "connection\n");
    ws.send(
      JSON.stringify({
        type: "event",
        event: "connect.challenge",
        payload: { nonce: "fake" },
      }),
    );
    ws.on("message", (bytes) => {
      if (record) fs.appendFileSync(record, `${bytes}\n`);
      const req = JSON.parse(bytes);
      const ok = req.method !== "connect" || req.params.auth?.token === auth.token;
      ws.send(
        JSON.stringify({
          type: "res",
          id: req.id,
          ok,
          ...(ok
            ? {
                payload:
                  req.method === "connect"
                    ? { type: "hello-ok", protocol: 4 }
                    : { value: 42 },
              }
            : { error: { code: "UNAUTHORIZED" } }),
        }),
      );
    });
  });
  process.on("SIGTERM", () => process.exit(0));
  listener.listen(port, "127.0.0.1");
}
