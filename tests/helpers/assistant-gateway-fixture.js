import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { WebSocketServer } from "ws";
import { issueGatewayCertificate } from "../../server/features/assistants/gateway-tls.js";

// Mirrors the managed Gateway transport: loopback WSS with a certificate whose
// public half is written to a private file that the client pins.
export async function gatewayFixture({ token = "fixture", delay = 0, features } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-gateway-tls-"));
  const { cert, key } = issueGatewayCertificate();
  const certPath = path.join(directory, "gateway-cert.pem");
  fs.writeFileSync(certPath, cert, { mode: 0o600 });
  const listener = https.createServer({ cert, key, minVersion: "TLSv1.3" });
  const server = new WebSocketServer({ server: listener });
  await new Promise((r) => listener.listen(0, "127.0.0.1", r));
  const calls = [];
  server.on("connection", (ws) => {
    ws.send(
      JSON.stringify({
        type: "event",
        event: "connect.challenge",
        payload: { nonce: "fixture" },
      }),
    );
    ws.on("message", (bytes) => {
      const req = JSON.parse(bytes);
      calls.push(req);
      if (req.method === "pending") return;
      const ok =
        !["stale", "busy", "refused", "titleFailed", "degraded"].includes(req.method) &&
        (req.method !== "connect" || req.params.auth?.token === token);
      const send = () =>
        ws.readyState === 1 &&
        ws.send(
          JSON.stringify({
            type: "res",
            id: req.id,
            ok,
            ...(ok
              ? {
                  payload:
                    req.method === "connect"
                      ? { type: "hello-ok", protocol: 4, ...(features && { features }) }
                      : { value: 42 },
                }
              : req.method === "stale"
                ? {
                    error: {
                      code: "INVALID_REQUEST",
                      message: "changed since last load",
                    },
                  }
                : req.method === "busy"
                  ? // As OpenClaw 2026.10.3's bounded model-catalog wait.
                    {
                      error: {
                        code: "UNAVAILABLE",
                        message: "The model catalog is still loading; retry shortly.",
                        retryable: true,
                      },
                    }
                  : req.method === "titleFailed"
                    ? // As the product plugin's title method fails (chat-title.js).
                      {
                        error: { code: "UNAVAILABLE", message: "LLM_COMPLETION_TIMEOUT" },
                      }
                    : req.method === "degraded"
                      ? // As 2026.10.7 refuses an agent it did not admit.
                        {
                          error: {
                            code: "UNAVAILABLE",
                            message:
                              "Agent ap-1 startup preparation was superseded\nSessions remain unavailable.",
                            details: {
                              agentId: "ap-1",
                              paths: ["/secret/agents/ap-1/agent/openclaw-agent.sqlite"],
                              code: "agent-database-inspection-failed",
                              reason: "Agent ap-1 startup preparation was superseded",
                              repairHint: "Sessions remain unavailable.",
                            },
                            retryable: false,
                          },
                        }
                      : req.method === "refused"
                        ? // As OpenClaw's dispatcher answers an error a handler threw.
                          {
                            error: {
                              code: "UNAVAILABLE",
                              message:
                                "SessionMutationFactsUnavailableError: Session access facts are unavailable; retry after session storage is ready. <- Error: /secret/path is locked",
                            },
                          }
                        : {
                            error: {
                              code: "UNAUTHORIZED",
                              message: "secret must not escape",
                            },
                          }),
          }),
        );
      if (req.method === "connect") setTimeout(send, delay);
      else send();
    });
  });
  return {
    server,
    calls,
    certPath,
    url: `wss://127.0.0.1:${listener.address().port}`,
    close: async () => {
      for (const ws of server.clients) ws.terminate();
      await new Promise((r) => server.close(r));
      await new Promise((r) => listener.close(r));
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}
