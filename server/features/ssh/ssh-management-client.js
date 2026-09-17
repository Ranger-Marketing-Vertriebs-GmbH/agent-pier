import http from "node:http";
import { sshPhysicalRoot } from "./ssh-root.js";
import { createHash } from "node:crypto";
import { sshProblem } from "./ssh-errors.js";

export function sshManagementSocket(dataDir) {
  const root = sshPhysicalRoot(dataDir);
  const hash = createHash("sha256").update(root).digest("hex").slice(0, 20);
  return `/tmp/agentpier-ssh-${process.getuid?.() ?? "user"}-${hash}/mcp.sock`;
}

export function sshManagementClient(dataDir, capability) {
  return (name, args = {}) =>
    new Promise((resolve, reject) => {
      const unavailable = () =>
        sshProblem(
          "SSH_UNAVAILABLE",
          "SSH management unavailable. Retry with the same request ID after reconnecting.",
          503,
        );
      const body = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: name,
        params: args,
        generation: capability.generation,
      });
      if (Buffer.byteLength(body) > 65536) {
        reject(sshProblem("SSH_INVALID_ARGUMENT", "SSH request is too large.", 413));
        return;
      }
      const request = http.request(
        {
          socketPath: sshManagementSocket(dataDir),
          path: "/mcp",
          method: "POST",
          agent: false,
          timeout: 31000,
          headers: {
            authorization: `Bearer ${capability.sessionId}.${capability.token}`,
            connection: "keep-alive",
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
          },
        },
        (response) => {
          const chunks = [];
          let size = 0;
          response.on("data", (chunk) => {
            size += chunk.length;
            if (size > 524288) response.destroy(unavailable());
            else chunks.push(chunk);
          });
          response.once("error", () => reject(unavailable()));
          response.once("end", () => {
            try {
              if (response.statusCode !== 200) throw unavailable();
              const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
              if (parsed.error) {
                reject(
                  sshProblem(parsed.error.code, parsed.error.error, parsed.error.status),
                );
                return;
              }
              resolve(parsed.result);
            } catch {
              reject(unavailable());
            }
          });
        },
      );
      request.once("error", () => reject(unavailable()));
      request.once("timeout", () => request.destroy(unavailable()));
      request.end(body);
    });
}
